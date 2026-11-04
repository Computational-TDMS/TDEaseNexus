import { describe, expect, it } from 'vitest'

import { createCostGuard } from './cost-guard'

/** Harness: a guard with a fake stat table, 1 KB file threshold, 3-slice budget. */
function guard(files: Record<string, number>, options?: { slices?: number }) {
  const denials: string[] = []
  const instance = createCostGuard({
    statSize: async (path) => (path in files ? files[path] : null),
    maxReadFileBytes: 1024,
    maxReadSlicesPerFile: options?.slices ?? 3,
    maxRules: 2,
  })
  return {
    instance,
    denials,
    async read(path: string): Promise<void> {
      await instance.checkReadSize(path)
      instance.checkReadSlice(path)
    },
  }
}

describe('cost-guard', () => {
  it('denies an oversized read with model-facing guidance and promotes the rule', async () => {
    const g = guard({ 'C:/ws/spectra/huge.mzML': 2 * 1024 * 1024 * 1024 })
    // Raw acquisitions get the domain path (toolbox), not generic grep advice.
    await expect(g.read('C:/ws/spectra/huge.mzML')).rejects.toThrow(/\[cost\].*2\.0 GB.*tdeasenexus-toolbox/)
    expect(g.read('C:/ws/spectra/huge.mzML')).rejects.toThrow(/never opened as text/)
    expect(g.instance.rules()).toHaveLength(1)
    expect(g.instance.rules()[0]).toContain('huge.mzML')
    expect(g.instance.rules()[0]).toContain('2.0 GB')
    expect(g.instance.rules()[0]).toContain('tdeasenexus-toolbox')
  })

  it('routes generic oversized files to query guidance, not the toolbox', async () => {
    const g = guard({ 'C:/ws/data/huge.csv': 2 * 1024 * 1024 * 1024 })
    await expect(g.read('C:/ws/data/huge.csv')).rejects.toThrow(/\[cost\].*2\.0 GB.*grep/)
    expect(g.instance.rules()[0]).not.toContain('tdeasenexus-toolbox')
  })

  it('allows small and unreadable files without promoting anything', async () => {
    const g = guard({ 'C:/ws/notes.md': 40, 'C:/ws/gone.tmp': 0 })
    await g.read('C:/ws/notes.md')
    // Unreadable (stat throws / missing) → allow, never block on doubt.
    await g.read('C:/ws/absent.bin')
    expect(g.instance.rules()).toEqual([])
  })

  it('stops the slice mill at the budget and keeps it stopped within the turn', async () => {
    const g = guard({ 'C:/ws/data/msalign.tsv': 800 }, { slices: 3 })
    await g.read('C:/ws/data/msalign.tsv')
    await g.read('C:/ws/data/msalign.tsv')
    await expect(g.read('C:/ws/data/msalign.tsv')).rejects.toThrow(/\[cost\].*3 slices/)
    // The budget stays spent — retrying the same read cannot page around it.
    await expect(g.read('C:/ws/data/msalign.tsv')).rejects.toThrow(/\[cost\] Still blocked/)
    expect(g.instance.rules()).toHaveLength(1)
  })

  it('clears per-turn ledgers on beginTurn while promoted rules survive', async () => {
    const g = guard({ 'C:/ws/a.tsv': 800 }, { slices: 2 })
    await g.read('C:/ws/a.tsv')
    // Second slice trips the budget within the turn.
    await expect(g.read('C:/ws/a.tsv')).rejects.toThrow(/\[cost\].*2 slices/)
    expect(g.instance.rules()).toHaveLength(1)
    g.instance.beginTurn()
    // The slice ledger reset: the same read goes through now…
    await g.read('C:/ws/a.tsv')
    // …while the promoted rule stays (session-scoped, compaction survives it).
    expect(g.instance.rules()).toHaveLength(1)
  })

  it('keeps the rule list bounded and deduplicated', async () => {
    const instance = createCostGuard({ statSize: async () => 999_999, maxReadFileBytes: 10, maxRules: 2 })
    await instance.checkReadSize('C:/ws/one.bin').catch(() => undefined)
    await instance.checkReadSize('C:/ws/two.bin').catch(() => undefined)
    expect(instance.rules()).toHaveLength(2)
    // A third rule evicts the oldest (FIFO), and re-tripping one.does not duplicate.
    await instance.checkReadSize('C:/ws/three.bin').catch(() => undefined)
    expect(instance.rules()).toHaveLength(2)
    expect(instance.rules().some((rule) => rule.includes('three.bin'))).toBe(true)
    await instance.checkReadSize('C:/ws/three.bin').catch(() => undefined)
    expect(instance.rules().filter((rule) => rule.includes('three.bin'))).toHaveLength(1)
  })
})
