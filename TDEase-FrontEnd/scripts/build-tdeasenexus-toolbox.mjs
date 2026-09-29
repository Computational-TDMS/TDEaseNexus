/**
 * Build the `tdeasenexus-toolbox` native CLI into the canonical system toolchain.
 *
 * Development and packaged builds consume the same canonical system artifact.
 *
 * Run: `node scripts/build-tdeasenexus-toolbox.mjs`
 */
import { cp, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRustRoot } from './resolve-toolkit.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ws = resolveRustRoot()
if (!ws) {
  console.error('Could not locate tdease-ai-capability/rust. Initialize the submodule.')
  process.exit(1)
}
const crate = path.join(ws, 'toolbox')
const output = path.join(ws, '..', 'system', 'tools')
const binary = process.platform === 'win32' ? 'tdeasenexus-toolbox.exe' : 'tdeasenexus-toolbox'

await mkdir(output, { recursive: true })
const built = spawnSync('cargo', ['build', '--release', '--manifest-path', path.join(crate, 'Cargo.toml'), '--bin', 'tdeasenexus-toolbox'], {
  cwd: root,
  stdio: 'inherit',
})
if (built.status !== 0) process.exit(built.status ?? 1)

// In a workspace, cargo's target/ lives at the workspace root, not per-crate.
const source = path.join(ws, 'target', 'release', binary)
const target = path.join(output, binary)
await cp(source, target)

function runPackaged(args) {
  const result = spawnSync(target, args, {
    cwd: os.tmpdir(),
    encoding: 'utf8',
  })
  if (result.status !== 0 || result.stderr !== '') {
    process.stderr.write(result.stderr || `tdeasenexus-toolbox ${args[0]} failed with exit ${result.status}\n`)
    process.exit(result.status ?? 1)
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    console.error(`tdeasenexus-toolbox ${args[0]} returned invalid JSON:`, error)
    process.exit(1)
  }
}

// Exercise the copied release artifact, outside the repository cwd. This is
// the binary electron-builder will package, so a stale .scratch copy cannot
// pass merely because the source-tree debug binary is correct.
runPackaged(['schema', 'fragment-theoretical'])
const unimod = runPackaged(['unimod-search', '--text', 'phosph', '--limit', '1'])
if (unimod.result?.matches?.[0]?.title !== 'Phospho') {
  console.error('packaged UniMod smoke failed: embedded database did not resolve Phospho')
  process.exit(1)
}
const smoke = runPackaged([
  'fragment-theoretical',
  '--proforma', 'M.(S)[Acetyl]ESSSK.K',
  '--ion-types', 'C',
  '--max-charge', '1',
])
const c1 = smoke.result?.fragments?.find(
  fragment => fragment.ion === 'c' && fragment.number === 1 && fragment.charge === 1,
)
const expectedC1 = 147.07641863724893
if (!c1 || Math.abs(c1.mz - expectedC1) > 1e-9) {
  console.error(`packaged TopPIC smoke mismatch: expected c1 ${expectedC1}, got ${c1?.mz}`)
  process.exit(1)
}

const plainRange = runPackaged([
  'fragment-theoretical', '--proforma', 'PEPTIDE', '--ion-types', 'C', '--max-charge', '1',
])
const ambiguousRange = runPackaged([
  'fragment-theoretical', '--proforma', 'PEP(TID)[Formula:CH2]E',
  '--ion-types', 'C', '--max-charge', '1',
])
const plainC6 = plainRange.result.fragments.find(fragment => fragment.ion === 'c' && fragment.number === 6)
const rangeC6 = ambiguousRange.result.fragments.find(fragment => fragment.ion === 'c' && fragment.number === 6)
const hasAmbiguousCleavage = ambiguousRange.result.fragments.some(
  fragment => fragment.ion === 'c' && (fragment.number === 4 || fragment.number === 5),
)
if (!plainC6 || !rangeC6 || hasAmbiguousCleavage || Math.abs((rangeC6.mz - plainC6.mz) - 14.015650064) > 1e-9) {
  console.error('packaged TopPIC range smoke failed: ambiguous cleavages must be omitted and c6 shifted once')
  process.exit(1)
}
console.log(`tdeasenexus-toolbox -> ${path.relative(root, target)}`)
