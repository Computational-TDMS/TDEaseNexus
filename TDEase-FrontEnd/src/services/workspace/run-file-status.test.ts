import { describe, expect, it } from 'vitest'
import {
  probeRunFileStatuses,
  runIdFromWorkspacePath,
  runResultsDir,
  workspacePathForManifestEntry,
  type RunFileStatusSources,
  type RunManifestEntry,
} from './run-file-status'

function sources(overrides: Partial<RunFileStatusSources> & { manifest?: RunManifestEntry[] } = {}): RunFileStatusSources {
  const manifest = overrides.manifest ?? []
  return {
    listRunFiles: overrides.listRunFiles ?? (async () => manifest),
    localDigest: overrides.localDigest ?? (async () => undefined),
    isKnownLocally: overrides.isKnownLocally ?? (() => false),
  }
}

describe('the mapped Workspace Run convention', () => {
  it('names a Run output directory', () => {
    expect(runResultsDir('runs/soybean-all/')).toBe('runs/soybean-all')
  })

  it('recovers the owning Run from a Workspace path', () => {
    expect(runIdFromWorkspacePath('runs/run_abc/features.csv')).toBe('run_abc')
    expect(runIdFromWorkspacePath('runs/run_abc')).toBe('run_abc')
  })

  it('reports no owner for a path outside any Run directory', () => {
    expect(runIdFromWorkspacePath('raw/sample.mzML')).toBeUndefined()
    expect(runIdFromWorkspacePath('runs/')).toBeUndefined()
    expect(runIdFromWorkspacePath('')).toBeUndefined()
  })

  it('preserves the exact Run-relative output path', () => {
    expect(workspacePathForManifestEntry('runs/soybean-all', 'results/features.csv'))
      .toBe('runs/soybean-all/results/features.csv')
  })

  it('still places an entry that carries no prefix', () => {
    expect(workspacePathForManifestEntry('runs/soybean-all', 'logs/engine.log'))
      .toBe('runs/soybean-all/logs/engine.log')
  })
})

describe('probeRunFileStatuses', () => {
  const manifest: RunManifestEntry[] = [{ path: 'results/features.csv', sha256: 'aaa' }]

  it('reports a matching local copy as cached', async () => {
    const statuses = await probeRunFileStatuses('run_abc', 'runs/soybean-all', sources({
      manifest,
      localDigest: async () => 'aaa',
    }))
    expect(statuses.get('runs/soybean-all/results/features.csv')).toBe('cached')
  })

  it('reports a diverged local copy as a conflict', async () => {
    const statuses = await probeRunFileStatuses('run_abc', 'runs/soybean-all', sources({
      manifest,
      localDigest: async () => 'bbb',
    }))
    expect(statuses.get('runs/soybean-all/results/features.csv')).toBe('conflict')
  })

  it('reports a file the Workspace does not hold as cloud', async () => {
    const statuses = await probeRunFileStatuses('run_abc', 'runs/soybean-all', sources({
      manifest,
      localDigest: async () => undefined,
      isKnownLocally: () => false,
    }))
    expect(statuses.get('runs/soybean-all/results/features.csv')).toBe('cloud')
  })

  /**
   * The subtle one, and the reason this is worth a test at all. No digest means
   * either "absent locally" or "no bridge to compute one with". Badging the
   * second case `cloud` would put a download arrow on a file the user already
   * has, so an undeterminable file is left out of the map entirely.
   */
  it('declines to badge a file it holds but cannot digest', async () => {
    const statuses = await probeRunFileStatuses('run_abc', 'runs/soybean-all', sources({
      manifest,
      localDigest: async () => undefined,
      isKnownLocally: () => true,
    }))
    expect(statuses.has('runs/soybean-all/results/features.csv')).toBe(false)
  })

  it('does not report a conflict while the Backend file has no stable digest', async () => {
    const statuses = await probeRunFileStatuses('run_abc', 'runs/soybean-all', sources({
      manifest: [{ path: 'sample.tsv', sha256: null }],
      localDigest: async () => 'local-digest',
      isKnownLocally: () => true,
    }))
    expect(statuses.has('runs/soybean-all/sample.tsv')).toBe(false)
  })

  it('yields nothing rather than throwing when the Backend is unreachable', async () => {
    const statuses = await probeRunFileStatuses('run_abc', 'runs/soybean-all', sources({
      listRunFiles: async () => { throw new Error('ECONNREFUSED') },
    }))
    expect(statuses.size).toBe(0)
  })

  it('classifies a mixed manifest entry by entry', async () => {
    const local: Record<string, string | undefined> = {
      'runs/soybean-all/results/kept.csv': 'aaa',
      'runs/soybean-all/results/edited.csv': 'zzz',
    }
    const statuses = await probeRunFileStatuses('run_abc', 'runs/soybean-all', sources({
      manifest: [
        { path: 'results/kept.csv', sha256: 'aaa' },
        { path: 'results/edited.csv', sha256: 'bbb' },
        { path: 'results/never-pulled.csv', sha256: 'ccc' },
      ],
      localDigest: async (path) => local[path],
      isKnownLocally: (path) => path in local,
    }))
    expect(Object.fromEntries(statuses)).toEqual({
      'runs/soybean-all/results/kept.csv': 'cached',
      'runs/soybean-all/results/edited.csv': 'conflict',
      'runs/soybean-all/results/never-pulled.csv': 'cloud',
    })
  })
})
