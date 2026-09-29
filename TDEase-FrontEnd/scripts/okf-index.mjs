/**
 * OKF progressive-disclosure index generator.
 *
 * For each directory that contains concept `.md` files, emit an `index.md` that
 * lists them so a human or agent can see what is available before opening any
 * single document (OKF v0.2 §12, GoogleCloudPlatform/knowledge-catalog). This is
 * the same progressive-disclosure seam AGENTS.md asks for ("open on demand; do not read everything at once"),
 * made machine-readable instead of prose.
 *
 * Conventions followed:
 *   - `index.md` and `log.md` are reserved filenames (§3.1): never listed as
 *     concepts, never touched as content. `log.md` is preserved verbatim.
 *   - Concepts carry a flat front-matter block (the same `---` + `key: value`
 *     style `workspace-knowledge.ts` parses — deliberately NOT a YAML parser).
 *     `title`, `description`, `type` are extracted; everything else is ignored.
 *   - Concepts with no front matter are still indexed: title falls back to the
 *     first `#` heading, then the filename; description to the first sentence.
 *   - The body groups concepts under `# <type>` headings (concepts without a
 *     type go under `# Concepts`), then `# Subdirectories` for child dirs.
 *   - Deterministic: the same tree yields byte-identical output (idempotent).
 *
 * Run: `node scripts/okf-index.mjs --root <dir> [--root <dir> ...]`
 * Defaults to `../docs`.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const RESERVED = new Set(['index.md', 'log.md'])
const FRONT_MATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

/** Parse a flat front-matter block into a string map (mirrors workspace-knowledge). */
export function parseOkfFrontMatter(text) {
  const match = FRONT_MATTER.exec(text)
  if (!match) return {}
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    data[key] = value.startsWith('[') && value.endsWith(']')
      ? value.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
      : value.replace(/^['"]|['"]$/g, '')
  }
  return data
}

/** Title: front-matter title, then first `# ` heading, then filename stem. */
function titleOf(data, body, filename) {
  if (typeof data.title === 'string' && data.title.trim()) return data.title.trim()
  const heading = body.match(/^#\s+(.+?)\s*$/m)
  if (heading) return heading[1].trim()
  return filename.replace(/\.md$/, '')
}

/** Description: front-matter description, then the first sentence of the body. */
function descriptionOf(data, body) {
  if (typeof data.description === 'string' && data.description.trim()) return data.description.trim()
  // First non-heading paragraph, line-wrapped prose joined into one sentence
  // (a sentence split across two lines has no period on its first line).
  const firstParagraph = body
    .replace(/^#.*$/gm, '')
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s*\n\s*/g, ' ').trim())
    .find((block) => block)
  if (!firstParagraph) return ''
  const sentence = firstParagraph.replace(/\.\s*$/, '')
  // Cut at a sentence boundary when possible so a description never ends mid-clause.
  const cut = sentence.length > 120 ? sentence.slice(0, sentence.lastIndexOf('.', 120) + 1) : sentence
  return (cut && cut.trim().length > 1 ? cut : sentence).slice(0, 140)
}

/** Recursively collect `{ dir, md: [filename], subdirs: [name] }` for every dir with concepts. */
async function collectDirs(root) {
  const out = []
  async function walk(dir, rel) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    const files = []
    const subdirs = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        subdirs.push(entry.name)
        await walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name)
      } else if (entry.isFile() && entry.name.endsWith('.md') && !RESERVED.has(entry.name)) {
        files.push(entry.name)
      }
    }
    if (files.length || subdirs.length) out.push({ dir, rel, files, subdirs })
  }
  await walk(root, '')
  return out
}

/** Build the index.md body for one directory. */
async function buildIndex(entry, root) {
  const concepts = []
  for (const filename of entry.files) {
    const text = await readFile(path.join(entry.dir, filename), 'utf8')
    const data = parseOkfFrontMatter(text)
    const body = FRONT_MATTER.test(text) ? text.replace(FRONT_MATTER, '') : text
    const title = titleOf(data, body, filename)
    const description = descriptionOf(data, body)
    const type = typeof data.type === 'string' && data.type.trim() ? data.type.trim() : 'Concepts'
    concepts.push({ filename, title, description, type })
  }

  const groups = new Map()
  for (const concept of concepts) {
    if (!groups.has(concept.type)) groups.set(concept.type, [])
    groups.get(concept.type).push(concept)
  }

  const lines = [`# ${entry.rel ? path.basename(entry.rel) : 'Knowledge'}`, '']
  const ordered = [...groups.keys()].sort((a, b) => a.localeCompare(b))
  for (const type of ordered) {
    lines.push(`# ${type}`, '')
    for (const concept of groups.get(type)) {
      const desc = concept.description ? ` - ${concept.description}` : ''
      lines.push(`* [${concept.title}](${concept.filename})${desc}`)
    }
    lines.push('')
  }

  if (entry.subdirs.length) {
    lines.push('# Subdirectories', '')
    for (const subdir of entry.subdirs) {
      // Only link subdirectories that contain concepts.
      lines.push(`* [${subdir}](${subdir}/)`)
    }
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

export async function generateIndexes(root) {
  const dirs = await collectDirs(root)
  const written = []
  for (const entry of dirs) {
    const target = path.join(entry.dir, 'index.md')
    const body = await buildIndex(entry, root)
    const existing = await readFile(target, 'utf8').catch(() => null)
    if (existing !== body) {
      await writeFile(target, body, 'utf8')
      written.push(path.relative(root, target).split(path.sep).join('/'))
    }
  }
  return written
}

function parseArgs(argv) {
  const roots = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) {
      roots.push(path.resolve(REPO_ROOT, argv[i + 1]))
      i += 1
    }
  }
  return roots.length ? roots : [path.join(REPO_ROOT, 'docs')]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const roots = parseArgs(process.argv.slice(2))
  for (const root of roots) {
    const written = await generateIndexes(root)
    console.log(`okf:index ${path.relative(REPO_ROOT, root)} — ${written.length ? `${written.length} updated` : 'no change'}`)
  }
}
