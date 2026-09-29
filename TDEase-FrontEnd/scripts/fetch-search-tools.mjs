/**
 * Fetch the pinned rg/fd search binaries into `<repo>/.scratch/vendor/search-tools/`.
 *
 * Packaged builds ship them under `resources/vendor/search-tools/` (electron-builder
 * extraResources `../.scratch/vendor/search-tools -> vendor/search-tools`; the repo-root
 * `.scratch/` is the release staging convention `build-desktop.ps1` and the backend
 * runtime mapping already use). Startup provisions them into the managed bash PATH
 * (`managedBinDir`, D16) so the `rg`/`fd` short names resolve, and Pi's grep/find
 * builtins resolve them through the main-process PATH instead of attempting a runtime
 * GitHub download (`PI_OFFLINE=1` forbids that fallback entirely).
 *
 * Versions and both SHA-256s are pinned: the zip hash verifies the download, the
 * extracted-exe hash is the shipping authority and makes reruns idempotent.
 *
 * Run: `node scripts/fetch-search-tools.mjs`
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(frontend, '..')
const output = path.join(repo, '.scratch', 'vendor', 'search-tools')

// Win-x64 is the only packaging target today (electron-builder.json win.nsis x64).
// Extend this table when a second target exists; do not guess asset names.
const TOOLS = [
  {
    name: 'rg',
    version: '15.2.0',
    repo: 'BurntSushi/ripgrep',
    tag: '15.2.0',
    zipName: (v) => `ripgrep-${v}-x86_64-pc-windows-msvc.zip`,
    zipDir: (v) => `ripgrep-${v}-x86_64-pc-windows-msvc`,
    zipSha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5',
    exeSha256: '14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680',
  },
  {
    name: 'fd',
    version: '10.4.2',
    repo: 'sharkdp/fd',
    tag: 'v10.4.2',
    zipName: (v) => `fd-v${v}-x86_64-pc-windows-msvc.zip`,
    zipDir: (v) => `fd-v${v}-x86_64-pc-windows-msvc`,
    zipSha256: 'b2816e506390a89941c63c9187d58a3cc10e9a55f2ef0685f9ea0eccaf7c98c8',
    exeSha256: '4c9d082ee20f0d9e44881ac4e92adf765efc314d82103c53d7f576bd78dc5761',
  },
]

const DOWNLOAD_TIMEOUT_MS = 180_000
const API_TIMEOUT_MS = 20_000
const USER_AGENT = 'tdease-fetch-search-tools'

if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error(`fetch-search-tools: ${process.platform}-${process.arch} is not a vendored target (only win-x64)`)
  process.exit(1)
}

const sha256File = async (file) => createHash('sha256').update(await readFile(file)).digest('hex')

async function fetchToBuffer(url, timeoutMs, headers = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': USER_AGENT, ...headers },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Canonical release URL first. Restricted networks that cannot reach the release
 * CDN often still reach api.github.com, which serves the same bytes through its
 * asset endpoint (`Accept: application/octet-stream`).
 */
async function downloadZip(tool) {
  const canonical = `https://github.com/${tool.repo}/releases/download/${tool.tag}/${tool.zipName(tool.version)}`
  try {
    return await fetchToBuffer(canonical, DOWNLOAD_TIMEOUT_MS)
  } catch (canonicalError) {
    console.warn(`  canonical download failed (${canonicalError.message}); retrying via api.github.com`)
    const release = await fetchToBuffer(
      `https://api.github.com/repos/${tool.repo}/releases/tags/${tool.tag}`,
      API_TIMEOUT_MS,
      { Accept: 'application/vnd.github+json' },
    ).then((body) => JSON.parse(body.toString('utf8')))
    const asset = release.assets?.find((candidate) => candidate.name === tool.zipName(tool.version))
    if (!asset?.id) throw new Error(`release asset not found: ${tool.zipName(tool.version)}`)
    return await fetchToBuffer(
      `https://api.github.com/repos/${tool.repo}/releases/assets/${asset.id}`,
      DOWNLOAD_TIMEOUT_MS,
      { Accept: 'application/octet-stream' },
    )
  }
}

function extractZip(zipPath, dir) {
  const failures = []
  // Windows ships bsdtar as tar.exe, which reads zip; System32 beats Git Bash's
  // GNU tar on PATH, which rejects zip archives.
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  const systemTar = systemRoot ? path.join(systemRoot, 'System32', 'tar.exe') : null
  const tar = systemTar && existsSync(systemTar) ? systemTar : 'tar.exe'
  let result = spawnSync(tar, ['xf', zipPath, '-C', dir], { stdio: 'pipe' })
  if (!result.error && result.status === 0) return
  failures.push(`tar: ${result.error?.message ?? result.stderr?.toString().trim() ?? `exit ${result.status}`}`)
  result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    '& { param($archive, $destination) $ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }',
    zipPath, dir,
  ], { stdio: 'pipe' })
  if (!result.error && result.status === 0) return
  failures.push(`powershell: ${result.error?.message ?? result.stderr?.toString().trim() ?? `exit ${result.status}`}`)
  throw new Error(`failed to extract archive: ${failures.join('; ')}`)
}

await mkdir(output, { recursive: true })
for (const tool of TOOLS) {
  const exeName = `${tool.name}.exe`
  const target = path.join(output, exeName)
  // Idempotent: the pinned exe hash is the shipping authority.
  if (existsSync(target) && (await sha256File(target)) === tool.exeSha256) {
    console.log(`${tool.name} ${tool.version}: already present, skipping`)
    continue
  }
  console.log(`${tool.name} ${tool.version}: downloading...`)
  const buffer = await downloadZip(tool)
  const zipHash = createHash('sha256').update(buffer).digest('hex')
  if (zipHash !== tool.zipSha256) {
    console.error(`${tool.name}: zip sha256 mismatch (expected ${tool.zipSha256}, got ${zipHash})`)
    process.exit(1)
  }
  const temp = await mkdtemp(path.join(tmpdir(), 'tdease-search-tools-'))
  try {
    const zipPath = path.join(temp, 'archive.zip')
    await writeFile(zipPath, buffer)
    const extractDir = path.join(temp, 'extracted')
    await mkdir(extractDir)
    extractZip(zipPath, extractDir)
    const extracted = path.join(extractDir, tool.zipDir(tool.version), exeName)
    if (!existsSync(extracted)) throw new Error(`binary not found in archive: ${extracted}`)
    if ((await sha256File(extracted)) !== tool.exeSha256) {
      throw new Error(`extracted ${exeName} sha256 mismatch for ${tool.name} ${tool.version}`)
    }
    await copyFile(extracted, target)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
  const smoke = spawnSync(target, ['--version'], { stdio: 'pipe', encoding: 'utf8' })
  if (smoke.status !== 0 || !String(smoke.stdout).includes(tool.version)) {
    console.error(`${tool.name}: smoke test failed (exit ${smoke.status}): ${smoke.stderr ?? smoke.error?.message ?? String(smoke.stdout)}`)
    process.exit(1)
  }
  console.log(`${tool.name} ${tool.version} -> ${target} (${String(smoke.stdout).split('\n')[0].trim()})`)
}
