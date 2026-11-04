/**
 * The reader for chart-forge's candidate-discrimination payload. The fixture
 * is a trimmed copy of a real payload (data/workspace/.tdease/tmp/fig5pub/
 * ekn_317_M02_11831.data.json + its `_compare.json` sibling), so a
 * producer-side shape change shows up here instead of as a viewer that
 * silently renders nothing. The derived `discriminating` map is the viewer's
 * central claim — which ions tell the models apart — and is computed here,
 * not read from either file.
 */
import { describe, expect, it } from 'vitest'
import {
  compareSiblingPath,
  ionResidues,
  isDiscriminationPayload,
  parseDiscrimination,
  parseIonLabel,
} from './ms2Discrimination'

const payload = {
  meta: {
    title: 'EKN (Q2KMJ4) +317.39 Da — dual lipidation model discrimination (M02 scan 11831, HCD)',
    source: 'raw mzML MS2 scan 11831 - per-candidate exact isotope-envelope matching',
    thresholds: '10 ppm; Pearson >= 0.7; display >= 0.01 base peak',
    tool: 'chart-forge',
  },
  data: {
    sequence: 'MGSSHHHHHHSSGLVPRGSH',
    scan: '11831',
    activation: null,
    tol: 10,
    precursorCharge: 6,
    peaks: [{ mz: 423.2240295410156, i: 10266.126953125 }, { mz: 268.2271056198009, i: 4200 }],
    candidates: [
      {
        id: 'dual_myr', label: 'N-myristoyl(Gly2) + S-palmitoyl(Cys4)', coverage: 0.92, color: '#2a9d8f',
        counts: { b: 13, y: 44 },
        matches: [
          { ion: 'b', n: 1, q: 1, cleav: 1, mz: 268.2271056198009, ppm: 1.2, i: 4200 },
          { ion: 'y', n: 3, q: 1, cleav: 1, mz: 723.5107421875, ppm: 2.5688648655361885, i: 9320.8173828125 },
        ],
        mods: [{ pos: 1, tag: 'Myristoyl', nTerm: true }],
      },
      {
        id: 'myr_only', label: 'N-myristoyl(Gly2)', coverage: 0.71, color: '#e76f51',
        counts: { b: 9, y: 30 },
        // y3 is shared with the other model → matched under two models, so it
        // discriminates nothing.
        matches: [{ ion: 'y', n: 3, q: 1, cleav: 1, mz: 723.5107421875, ppm: 2.6, i: 9000 }],
        mods: [],
      },
    ],
  },
}

/** `fragment-compare` output, trimmed: `fragmentStatuses` per model. */
const compare = {
  comparisons: [{
    result: {
      discriminatingIonCount: 22,
      candidates: [
        { candidateId: 'dual_myr', fragmentStatuses: [
          { ion: 'b', number: 1, charge: 1, state: 'matched', theoreticalApexMz: 268.2271056198009 },
          { ion: 'y', number: 3, charge: 1, state: 'missingApex', theoreticalApexMz: 723.5107421875 },
        ] },
        { candidateId: 'myr_only', fragmentStatuses: [
          { ion: 'b', number: 1, charge: 1, state: 'unreasonableCharge', theoreticalApexMz: 268.2271056198009 },
        ] },
      ],
    },
  }],
}

describe('parseDiscrimination', () => {
  it('reads the payload envelope and derives which ions tell the models apart', () => {
    const model = parseDiscrimination(payload, compare)
    expect(model.title).toBe(payload.meta.title)
    expect(model.scan).toBe('11831')
    expect(model.precursorCharge).toBe(6)
    expect(model.tolerancePpm).toBe(10)
    expect(model.sequence).toBe('MGSSHHHHHHSSGLVPRGSH')
    expect(model.candidates.map((c) => c.id)).toEqual(['dual_myr', 'myr_only'])
    // b1 matched under exactly one model; y3 under both → not discriminating.
    expect([...model.discriminating]).toEqual([['b:1:1', 'dual_myr']])
  })

  it('draws ghosts only for discriminating ions the other model predicted but did not match', () => {
    const model = parseDiscrimination(payload, compare)
    // The owner's own status is skipped, and y3 (not discriminating) is not a
    // ghost — only the rival model's "was predicted, absent" b1 survives.
    expect(model.ghosts).toEqual([
      { candidateId: 'myr_only', ion: 'b', n: 1, q: 1, mz: 268.2271056198009 },
    ])
  })

  it('claims no discrimination for a single candidate, and drops no ghosts without a sibling', () => {
    const single = parseDiscrimination({ meta: {}, data: { ...payload.data, candidates: [payload.data.candidates[0]] } })
    expect(single.discriminating.size).toBe(0)
    expect(single.ghosts).toEqual([])
    expect(parseDiscrimination(payload).ghosts).toEqual([])
  })
})

describe('isDiscriminationPayload', () => {
  it('accepts the payload and rejects every other JSON the Workbench may open', () => {
    expect(isDiscriminationPayload(payload)).toBe(true)
    // The fragment-compare sibling carries no `data`/`peaks`/`sequence`.
    expect(isDiscriminationPayload(compare)).toBe(false)
    expect(isDiscriminationPayload({ meta: { tool: 'chart-forge' }, data: { peaks: [] } })).toBe(false)
    expect(isDiscriminationPayload(null)).toBe(false)
    expect(isDiscriminationPayload([])).toBe(false)
    expect(() => parseDiscrimination(compare)).toThrow()
  })
})

describe('compareSiblingPath', () => {
  it('names the `_compare.json` sibling of a `.data.json`, and nothing else', () => {
    expect(compareSiblingPath('a/b/scan.data.json')).toBe('a/b/scan_compare.json')
    expect(compareSiblingPath('a/b/scan.json')).toBeNull()
    expect(compareSiblingPath('a/b/scan_compare.json')).toBeNull()
  })
})

describe('ion geometry', () => {
  it('parses ion labels with and without charge', () => {
    expect(parseIonLabel('b2')).toEqual({ ion: 'b', n: 2, q: undefined })
    expect(parseIonLabel('y12+2')).toEqual({ ion: 'y', n: 12, q: 2 })
    expect(parseIonLabel('PEP')).toBeNull()
    expect(parseIonLabel('b')).toBeNull()
  })

  it('spans b-series from the N-terminus and y-series from the C-terminus', () => {
    // y1 is the C-terminal residue alone — the direction that is easy to get
    // backwards, and the one the sequence row lights up.
    expect(ionResidues('b', 2, 20)).toEqual([1, 2])
    expect(ionResidues('y', 1, 20)).toEqual([20, 20])
    expect(ionResidues('y', 3, 20)).toEqual([18, 20])
  })
})
