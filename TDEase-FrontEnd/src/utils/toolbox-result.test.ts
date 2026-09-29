/**
 * The typed toolbox card reads the kernel's real JSON envelope. Fixtures are
 * trimmed copies of actual `tdnexus-toolbox` outputs from the H4 +121.96 Da
 * analysis (data/workspace/runs/histone48-mouse/analysis/h4-121.9-fresh), so a
 * kernel-side envelope change shows up here, not as a silently blank card.
 */
import { describe, expect, it } from 'vitest'
import { toolboxSummary } from './toolbox-result'

const bash = (command: string, text: string, truncated = false) => ({
  name: 'tdease.bash', status: 'succeeded' as const,
  args: { command },
  resultPreview: { text, truncated, totalChars: text.length },
})

describe('toolboxSummary', () => {
  it('summarizes a complete unimod-solve envelope: verdict + top candidates with ppm', () => {
    const envelope = {
      schemaVersion: 1, tool: 'tdnexus-toolbox', command: 'unimod-solve', elapsedMs: 13, warnings: [],
      params: { targetMass: 121.961, tolerance: 0.03, toleranceUnit: 'da' },
      result: { matchCount: 2, truncated: false, candidates: [
        { absoluteErrorPpm: 52.31, modifications: [{ count: 1, title: 'Acetyl' }, { count: 1, title: 'Sulfo' }] },
        { absoluteErrorPpm: 130.2, modifications: [{ count: 1, title: 'Acetyl' }, { count: 1, title: 'Phospho' }] },
      ] },
    }
    const s = toolboxSummary(bash('tdnexus-toolbox unimod-solve --target-mass 121.961 --tol 0.03', JSON.stringify(envelope)))!
    expect(s.command).toBe('unimod-solve')
    expect(s.params[0]).toBe('121.961 Da ± 0.03 Da')
    expect(s.verdict).toEqual({ text: '2 matches', tone: 'positive' })
    expect(s.rows[0]).toEqual({ label: 'Acetyl + Sulfo', value: '52.3 ppm' })
    expect(s.partial).toBe(false)
  })

  it('says "cannot close" for an empty resolve-shift, and never guesses a verdict from a cut envelope', () => {
    const empty = { tool: 'tdnexus-toolbox', command: 'resolve-shift', warnings: [], params: {}, result: { observedShift: 317.39, candidates: [] } }
    expect(toolboxSummary(bash('tdeasenexus-toolbox resolve-shift --library builtin', JSON.stringify(empty)))!.verdict)
      .toEqual({ text: 'cannot close the shift', tone: 'negative' })

    const cut = toolboxSummary(bash('tdeasenexus-toolbox unimod-search --mass 317.39', '{"schemaVersion":1,"tool":"tdnexus-toolbox","command":"unimod-search","params":{', true))!
    expect(cut.partial).toBe(true)
    expect(cut.verdict).toBeUndefined()
    expect(cut.params).toEqual(['317.39 Da'])
  })

  it('leaves ordinary shell calls alone', () => {
    expect(toolboxSummary(bash('npm test -- --run', 'ok'))).toBeNull()
  })
})
