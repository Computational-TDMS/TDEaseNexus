import type { PromptSkillCollision, PromptSkillScope, PromptSkillText } from '@/agent/prompt'

export interface LocalSkillEntry {
  name: string
  scope: PromptSkillScope
  description?: string
}

export interface SharedLocalSkillCatalog {
  list(): Promise<LocalSkillEntry[]>
  read(id: string): Promise<PromptSkillText>
  collisions(): Promise<ReadonlyArray<PromptSkillCollision>>
  invalidate(): void
}

interface SkillBridgeSet {
  system?: {
    listFiles?(relative: string): Promise<readonly string[]>
    readText(relative: string): Promise<string>
  }
  workspace?: {
    listDir?(root: string, relative: string): Promise<readonly { name: string; isDir: boolean }[]>
    readText(root: string, relative: string): Promise<string>
  }
}

const catalogs = new Map<string, SharedLocalSkillCatalog>()
const SKILL_NAME = /^[A-Za-z0-9_-]+$/

export function sharedLocalSkillCatalog(root: string, bridges: SkillBridgeSet): SharedLocalSkillCatalog {
  const key = root || '<unbound>'
  const existing = catalogs.get(key)
  if (existing) return existing

  let cachedEntries: Promise<ReadonlyArray<LocalSkillEntry>> | undefined
  const cachedSkills = new Map<string, Promise<PromptSkillText>>()

  const entries = async (): Promise<ReadonlyArray<LocalSkillEntry>> => {
    if (cachedEntries) return cachedEntries
    cachedEntries = loadEntries(root, bridges)
    return cachedEntries
  }

  const catalog: SharedLocalSkillCatalog = {
    async list() {
      return (await entries()).map((entry) => ({ ...entry }))
    },
    async read(id) {
      const found = resolveSkillEntry(await entries(), id)
      const cached = cachedSkills.get(found.name)
      if (cached) return cached
      const loading = readSkill(root, bridges, found)
      cachedSkills.set(found.name, loading)
      return loading
    },
    async collisions() {
      const scopesByName = new Map<string, PromptSkillScope[]>()
      for (const entry of await entries()) {
        const bare = entry.name.split(':')[1]
        const scopes = scopesByName.get(bare) ?? []
        scopes.push(entry.scope)
        scopesByName.set(bare, scopes)
      }
      return [...scopesByName.entries()]
        .filter(([, scopes]) => scopes.length > 1)
        .map(([name, sources]) => Object.freeze({ name, sources: Object.freeze(sources) }))
    },
    invalidate() {
      cachedEntries = undefined
      cachedSkills.clear()
    },
  }
  catalogs.set(key, catalog)
  return catalog
}

async function loadEntries(root: string, bridges: SkillBridgeSet): Promise<ReadonlyArray<LocalSkillEntry>> {
  const systemNames = (await bridges.system?.listFiles?.('skills') ?? [])
    .filter((path) => path.endsWith('/SKILL.md'))
    .map((path) => path.split('/')[0])
    .filter(validName)
  const workspaceNames = (await bridges.workspace?.listDir?.(root, '.tdease/skills').catch(() => []) ?? [])
    .filter((entry) => entry.isDir && validName(entry.name))
    .map((entry) => entry.name)

  return Object.freeze([
    ...unique(systemNames).map((name): LocalSkillEntry => ({ name: `system:${name}`, scope: 'system' })),
    ...unique(workspaceNames).map((name): LocalSkillEntry => ({ name: `workspace:${name}`, scope: 'workspace' })),
  ])
}

/** Extract `description:` from leading YAML frontmatter; anything else yields undefined. */
export function frontmatterDescription(content: string | undefined): string | undefined {
  if (!content || !content.startsWith('---')) return undefined
  const end = content.indexOf('\n---', 3)
  if (end < 0) return undefined
  for (const line of content.slice(3, end).split('\n')) {
    const match = /^\s*description\s*:\s*(.+?)\s*$/.exec(line)
    if (match) return match[1].replace(/^["']|["']$/g, '')
  }
  return undefined
}

function resolveSkillEntry(entries: ReadonlyArray<LocalSkillEntry>, id: string): LocalSkillEntry {
  if (typeof id !== 'string' || !id.trim()) throw new Error('Skill id must be non-empty text')
  const exact = entries.find((entry) => entry.name === id)
  if (exact) return exact
  if (id.includes(':')) throw new Error(`Skill not found: ${id}`)
  const matches = entries.filter((entry) => entry.name.endsWith(`:${id}`))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new Error(`Skill ${id} is ambiguous; use ${matches.map((entry) => entry.name).join(' or ')}`)
  throw new Error(`Skill not found: ${id}`)
}

async function readSkill(
  root: string,
  bridges: SkillBridgeSet,
  entry: LocalSkillEntry,
): Promise<PromptSkillText> {
  const name = entry.name.split(':')[1]
  const content = entry.scope === 'system'
    ? await bridges.system?.readText(`skills/${name}/SKILL.md`)
    : await bridges.workspace?.readText(root, `.tdease/skills/${name}/SKILL.md`)
  if (typeof content !== 'string' || !content.trim()) throw new Error(`Skill ${entry.name} has no readable SKILL.md`)
  return Object.freeze({ id: entry.name, scope: entry.scope, content })
}

function validName(value: string): boolean {
  return SKILL_NAME.test(value)
}

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)].sort()
}
