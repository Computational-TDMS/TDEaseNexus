/**
 * Pack the installer's node-catalog seed (`nodes.zip`) from a deployed catalog,
 * pinned to the committed ship-set manifest.
 *
 * The manifest (`node-seed.manifest.json`, beside this script) is the single
 * authority for what ships: `entries` is an explicit INCLUDE list (the archive
 * can only ever contain those), `localOnly` names entries that may legitimately
 * sit in the live catalog but never ship, and `required` lists the
 * definition-layer files whose absence means the deployment is broken. The
 * manifest pins the SET, not the bytes — vendor binaries still come from the
 * local deployment (`data/` stays a simulated install, never a source of truth;
 * a same-commit build is reproducible in its entry set).
 *
 * Why a JS packer and not the host's zip/tar: the runtime contract needs a REAL
 * zip (extract-zip in electron/node_catalog_seed.cjs reads it), and neither
 * `zip` (Linux) nor `tar.exe` (Windows) exists on every build host. This writer
 * is ~80 lines of zlib, produces byte-identical archives for identical trees
 * (fixed timestamps, sorted entries, deflate level 6), and runs the same way on
 * every platform — so the same commit yields the same seed fingerprint and an
 * update with unchanged nodes does not re-seed the user's catalog.
 *
 * Archive layout: `nodes/<entry>/…` — node_catalog_seed extracts and reads
 * `<tmp>/nodes`, so the prefix is part of the contract.
 *
 * Run: `node scripts/release/node-seed.mjs --repo . --out .scratch/runtime/nodes.zip`
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_MANIFEST = path.join(scriptDir, 'node-seed.manifest.json')

// 1980-01-01 00:00:00, the earliest DOS timestamp. Fixed so the archive bytes
// (and therefore the seed fingerprint) depend on content only, never on mtimes.
const DOS_TIME = 0
const DOS_DATE = 0x0021
const UTF8_FLAG = 0x0800
const MAX_ENTRIES = 0xffff
const MAX_ARCHIVE = 0xffffffff

function readManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error(`unsupported node-seed manifest: ${manifestPath}`)
  }
  return manifest
}

/** Every file under `dir`, relative to it, sorted for deterministic output. */
function walkFiles(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`node catalog contains a symlink (not shippable as a seed entry): ${path.relative(base, full)}`)
    }
    if (entry.isDirectory()) out.push(...walkFiles(full, base))
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'))
    else throw new Error(`node catalog contains a special file: ${path.relative(base, full)}`)
  }
  return out
}

function createZipWriter(fd) {
  const central = []
  let offset = 0

  const write = (buffer) => {
    fs.writeSync(fd, buffer)
    offset += buffer.length
  }

  return {
    addFile(name, absolutePath) {
      const data = fs.readFileSync(absolutePath)
      const deflated = deflateRawSync(data, { level: 6 })
      // Storing incompressible bytes beats deflating them larger.
      const store = deflated.length >= data.length
      const payload = store ? data : deflated
      const method = store ? 0 : 8
      const mode = fs.statSync(absolutePath).mode & 0o777
      const nameBuffer = Buffer.from(name, 'utf8')
      if (nameBuffer.length > 0xffff) throw new Error(`zip entry name too long: ${name}`)

      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(UTF8_FLAG, 6)
      local.writeUInt16LE(method, 8)
      local.writeUInt16LE(DOS_TIME, 10)
      local.writeUInt16LE(DOS_DATE, 12)
      local.writeUInt32LE(crc32(data) >>> 0, 14)
      local.writeUInt32LE(payload.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(nameBuffer.length, 26)
      local.writeUInt16LE(0, 28)
      write(local)
      write(nameBuffer)
      write(payload)
      central.push({
        nameBuffer,
        method,
        crc: crc32(data) >>> 0,
        compressedSize: payload.length,
        uncompressedSize: data.length,
        // external attributes: unix mode in the high word (extract-zip chmods
        // from it, so node executables stay executable after provisioning).
        externalAttributes: ((0o100000 | mode) << 16) >>> 0,
        localOffset: offset - payload.length - nameBuffer.length - 30,
      })
    },
    finish() {
      if (central.length > MAX_ENTRIES) throw new Error(`zip would exceed ${MAX_ENTRIES} entries`)
      const centralOffset = offset
      for (const entry of central) {
        const header = Buffer.alloc(46)
        header.writeUInt32LE(0x02014b50, 0)
        header.writeUInt16LE(0x0314, 4) // made by: unix, zip spec 2.0
        header.writeUInt16LE(20, 6)
        header.writeUInt16LE(UTF8_FLAG, 8)
        header.writeUInt16LE(entry.method, 10)
        header.writeUInt16LE(DOS_TIME, 12)
        header.writeUInt16LE(DOS_DATE, 14)
        header.writeUInt32LE(entry.crc, 16)
        header.writeUInt32LE(entry.compressedSize, 20)
        header.writeUInt32LE(entry.uncompressedSize, 24)
        header.writeUInt16LE(entry.nameBuffer.length, 28)
        header.writeUInt16LE(0, 30)
        header.writeUInt16LE(0, 32)
        header.writeUInt16LE(0, 34)
        header.writeUInt16LE(0, 36)
        header.writeUInt32LE(entry.externalAttributes, 38)
        header.writeUInt32LE(entry.localOffset, 42)
        write(header)
        write(entry.nameBuffer)
      }
      const centralSize = offset - centralOffset
      if (offset > MAX_ARCHIVE) throw new Error('zip would exceed 4 GiB (zip64 is not implemented)')
      const end = Buffer.alloc(22)
      end.writeUInt32LE(0x06054b50, 0)
      end.writeUInt16LE(0, 4)
      end.writeUInt16LE(0, 6)
      end.writeUInt16LE(central.length, 8)
      end.writeUInt16LE(central.length, 10)
      end.writeUInt32LE(centralSize, 12)
      end.writeUInt32LE(centralOffset, 16)
      end.writeUInt16LE(0, 20)
      write(end)
    },
  }
}

/**
 * Pack `nodesDir` into `outZip` following `manifestPath`. Throws on a manifest
 * entry that is missing from the deployment, a missing required file, or any
 * catalog residue the manifest does not classify — a crippled or over-wide
 * seed must fail the build, never ship.
 */
export function packNodeSeed({ nodesDir, outZip, manifestPath = DEFAULT_MANIFEST, log = console.log }) {
  const manifest = readManifest(manifestPath)
  if (!fs.existsSync(nodesDir) || !fs.statSync(nodesDir).isDirectory()) {
    throw new Error(`node catalog source missing: ${nodesDir}`)
  }
  const listed = manifest.entries.map((entry) => entry.name)
  const localOnly = manifest.localOnly ?? []

  for (const entry of manifest.entries) {
    const entryPath = path.join(nodesDir, entry.name)
    if (!fs.existsSync(entryPath)) {
      throw new Error(`manifest-listed seed entry missing from the catalog: ${entry.name}`)
    }
    for (const required of entry.required ?? []) {
      if (!fs.existsSync(path.join(entryPath, required))) {
        throw new Error(`seed entry '${entry.name}' is missing required file: ${required}`)
      }
    }
  }

  const residue = fs.readdirSync(nodesDir).filter((name) => !listed.includes(name) && !localOnly.includes(name))
  if (residue.length > 0) {
    throw new Error(`unlisted entries in the node catalog (add them to node-seed.manifest.json or remove them): ${residue.join(', ')}`)
  }

  const prefix = path.basename(nodesDir)
  const files = []
  for (const name of listed) {
    const entryPath = path.join(nodesDir, name)
    if (fs.statSync(entryPath).isDirectory()) {
      for (const rel of walkFiles(entryPath)) {
        files.push({ name: `${prefix}/${name}/${rel}`, absolute: path.join(entryPath, rel) })
      }
    } else {
      files.push({ name: `${prefix}/${name}`, absolute: entryPath })
    }
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  fs.mkdirSync(path.dirname(outZip), { recursive: true })
  fs.rmSync(outZip, { force: true })
  const fd = fs.openSync(outZip, 'w')
  try {
    const writer = createZipWriter(fd)
    for (const file of files) writer.addFile(file.name, file.absolute)
    writer.finish()
  } finally {
    fs.closeSync(fd)
  }

  const sizeMb = fs.statSync(outZip).size / 1024 / 1024
  log(`  node seed: packed ${listed.length} manifest entries -> ${outZip} (${sizeMb.toFixed(1)} MB)`)
  for (const name of listed) log(`    ${prefix}/${name}`)
  return { outZip, entries: listed, files: files.length, bytes: fs.statSync(outZip).size }
}

function parseArgs(argv) {
  const args = { repo: path.resolve(scriptDir, '..', '..'), nodes: '', out: '', manifest: DEFAULT_MANIFEST }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--repo') { args.repo = path.resolve(value); i += 1 } else if (flag === '--nodes') { args.nodes = value; i += 1 } else if (flag === '--out') { args.out = value; i += 1 } else if (flag === '--manifest') { args.manifest = path.resolve(value); i += 1 } else {
      throw new Error(`unknown argument: ${flag}`)
    }
  }
  if (!args.out) throw new Error('missing --out <zip path>')
  const nodesDir = path.resolve(args.repo, args.nodes || 'data/backend/nodes')
  const outZip = path.isAbsolute(args.out) ? args.out : path.resolve(args.repo, args.out)
  return { nodesDir, outZip, manifestPath: args.manifest }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { nodesDir, outZip, manifestPath } = parseArgs(process.argv.slice(2))
    packNodeSeed({ nodesDir, outZip, manifestPath })
  } catch (error) {
    console.error(`node-seed: ${error.message}`)
    process.exit(1)
  }
}
