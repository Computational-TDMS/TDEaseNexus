/**
 * Fetch the pinned rg/fd search binaries into `<repo>/.scratch/vendor/search-tools/`.
 *
 * Packaged builds ship them under `resources/vendor/search-tools/` (electron-builder
 * extraResources `../.scratch/vendor/search-tools -> vendor/search-tools`; the repo-root
 * `.scratch/` is the release staging convention the desktop build scripts and the backend
 * runtime mapping already use). Startup provisions them into the managed bash PATH
 * (`managedBinDir`, D16) so the `rg`/`fd` short names resolve, and Pi's grep/find
 * builtins resolve them through the main-process PATH instead of attempting a runtime
 * GitHub download (`PI_OFFLINE=1` forbids that fallback entirely).
 *
 * One table entry per packaging target (electron-builder.json: win nsis x64, linux
 * AppImage x64). Versions and BOTH SHA-256s are pinned per target: the archive hash
 * verifies the download, the extracted-binary hash is the shipping authority and makes
 * reruns idempotent. Linux uses the musl builds — statically linked, so the binary runs
 * on any glibc version instead of the build machine's.
 *
 * Run: `node scripts/fetch-search-tools.mjs`
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.resolve(frontend, '..')
const output = path.join(repo, '.scratch', 'vendor', 'search-tools')

const TOOLS = [
  {
    name: 'rg',
    version: '15.2.0',
    repo: 'BurntSushi/ripgrep',
    tag: '15.2.0',
    assets: {
      'win32-x64': {
        file: (v) => `ripgrep-${v}-x86_64-pc-windows-msvc.zip`,
        dir: (v) => `ripgrep-${v}-x86_64-pc-windows-msvc`,
        fileSha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5',
        binarySha256: '14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680',
      },
      'linux-x64': {
        file: (v) => `ripgrep-${v}-x86_64-unknown-linux-musl.tar.gz`,
        dir: (v) => `ripgrep-${v}-x86_64-unknown-linux-musl`,
        fileSha256: '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c',
        binarySha256: 'e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849',
      },
    },
  },
  {
    name: 'fd',
    version: '10.4.2',
    repo: 'sharkdp/fd',
    tag: 'v10.4.2',
    assets: {
      'win32-x64': {
        file: (v) => `fd-v${v}-x86_64-pc-windows-msvc.zip`,
        dir: (v) => `fd-v${v}-x86_64-pc-windows-msvc`,
        fileSha256: 'b2816e506390a89941c63c9187d58a3cc10e9a55f2ef0685f9ea0eccaf7c98c8',
        binarySha256: '4c9d082ee20f0d9e44881ac4e92adf765efc314d82103c53d7f576bd78dc5761',
      },
      'linux-x64': {
        file: (v) => `fd-v${v}-x86_64-unknown-linux-musl.tar.gz`,
        dir: (v) => `fd-v${v}-x86_64-unknown-linux-musl`,
        fileSha256: 'e3257d48e29a6be965187dbd24ce9af564e0fe67b3e73c9bdcd180f4ec11bdde',
        binarySha256: '78d315b3ed7bb8cc42052880c7be02454ad5324c7c853c291c53b0aaf6f4367b',
      },
    },
  },
]

const DOWNLOAD_TIMEOUT_MS = 180_000
const API_TIMEOUT_MS = 20_000
const USER_AGENT = 'tdease-fetch-search-tools'
const TARGET = `${process.platform}-${process.arch}`

const toolForTarget = (tool) => {
  const asset = tool.assets[TARGET]
  if (!asset) {
    console.error(`fetch-search-tools: ${tool.name} has no ${TARGET} artifact (only ${Object.keys(tool.assets).join(', ')})`)
    process.exit(1)
  }
  return asset
}

const BINARY_EXT = process.platform === 'win32' ? '.exe' : ''
const ARCHIVE_KIND = process.platform === 'win32' ? 'zip' : 'tar.gz'

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
async function downloadArchive(tool, asset) {
  const canonical = `https://github.com/${tool.repo}/releases/download/${tool.tag}/${asset.file(tool.version)}`
  try {
    return await fetchToBuffer(canonical, DOWNLOAD_TIMEOUT_MS)
  } catch (canonicalError) {
    console.warn(`  canonical download failed (${canonicalError.message}); retrying via api.github.com`)
    const release = await fetchToBuffer(
      `https://api.github.com/repos/${tool.repo}/releases/tags/${tool.tag}`,
      API_TIMEOUT_MS,
      { Accept: 'application/vnd.github+json' },
    ).then((body) => JSON.parse(body.toString('utf8')))
    const remote = release.assets?.find((candidate) => candidate.name === asset.file(tool.version))
    if (!remote?.id) throw new Error(`release asset not found: ${asset.file(tool.version)}`)
    return await fetchToBuffer(
      `https://api.github.com/repos/${tool.repo}/releases/assets/${remote.id}`,
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

function extractTarGz(archivePath, dir) {
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', dir], { stdio: 'pipe' })
  if (result.error || result.status !== 0) {
    throw new Error(`failed to extract archive: ${result.error?.message ?? result.stderr?.toString().trim() ?? `exit ${result.status}`}`)
  }
}

const archiveName = ARCHIVE_KIND === 'zip' ? 'archive.zip' : 'archive.tar.gz'

await mkdir(output, { recursive: true })
for (const tool of TOOLS) {
  const asset = toolForTarget(tool)
  const binaryName = `${tool.name}${BINARY_EXT}`
  const target = path.join(output, binaryName)
  // Idempotent: the pinned binary hash is the shipping authority.
  if (existsSync(target) && (await sha256File(target)) === asset.binarySha256) {
    console.log(`${tool.name} ${tool.version}: already present, skipping`)
    continue
  }
  console.log(`${tool.name} ${tool.version}: downloading...`)
  const buffer = await downloadArchive(tool, asset)
  const archiveHash = createHash('sha256').update(buffer).digest('hex')
  if (archiveHash !== asset.fileSha256) {
    console.error(`${tool.name}: archive sha256 mismatch (expected ${asset.fileSha256}, got ${archiveHash})`)
    process.exit(1)
  }
  const temp = await mkdtemp(path.join(tmpdir(), 'tdease-search-tools-'))
  try {
    const archivePath = path.join(temp, archiveName)
    await writeFile(archivePath, buffer)
    const extractDir = path.join(temp, 'extracted')
    await mkdir(extractDir)
    if (ARCHIVE_KIND === 'zip') extractZip(archivePath, extractDir)
    else extractTarGz(archivePath, extractDir)
    const extracted = path.join(extractDir, asset.dir(tool.version), binaryName)
    if (!existsSync(extracted)) throw new Error(`binary not found in archive: ${extracted}`)
    if ((await sha256File(extracted)) !== asset.binarySha256) {
      throw new Error(`extracted ${binaryName} sha256 mismatch for ${tool.name} ${tool.version}`)
    }
    await copyFile(extracted, target)
    await chmod(target, 0o755)
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
