import { describe, expect, it } from 'vitest'
import type { MatchedFragment, SpectrumPeak } from '@/composables/ms2-sequence/fragmentation'
import {
  getSpectrumMzRange,
  getCleavageLineX,
  pickFragmentForInteraction,
} from '@/components/visualization/ms2-sequence/layout'

function createPeak(overrides: Partial<SpectrumPeak> = {}): SpectrumPeak {
  return {
    index: 0,
    mz: 100,
    intensity: 1000,
    ...overrides,
  }
}

function createFragment(overrides: Partial<MatchedFragment> = {}): MatchedFragment {
  return {
    ionType: 'b',
    position: 3,
    charge: 1,
    theoreticalMass: 300,
    theoreticalMz: 301,
    sequenceRange: [1, 3],
    isMatched: false,
    ...overrides,
  }
}

describe('ms2 sequence layout helpers', () => {
  it('returns the default mz range when peaks are empty', () => {
    expect(getSpectrumMzRange([])).toEqual([0, 1000])
  })

  it('computes the padded mz range from peaks immediately', () => {
    const peaks = [createPeak({ mz: 100 }), createPeak({ mz: 200 }), createPeak({ mz: 250 })]

    expect(getSpectrumMzRange(peaks)).toEqual([92.5, 257.5])
  })

  it('ignores invalid mz values when computing the spectrum range', () => {
    const peaks = [
      createPeak({ mz: 100 }),
      createPeak({ mz: Number.NaN }),
      createPeak({ mz: 250 }),
    ]

    expect(getSpectrumMzRange(peaks)).toEqual([92.5, 257.5])
  })

  it('maps cleavage positions to fixed-width sequence boundaries', () => {
    expect(getCleavageLineX(1, 0, 20)).toBe(20)
    expect(getCleavageLineX(4, 0, 20)).toBe(80)
    expect(getCleavageLineX(4, 2, 20)).toBe(40)
  })

  it('prefers a matched fragment for hover interactions', () => {
    const unmatched = createFragment({ charge: 1, isMatched: false })
    const matched = createFragment({ charge: 2, isMatched: true })

    expect(pickFragmentForInteraction([unmatched, matched])).toBe(matched)
  })

  it('returns null when no fragments exist for a hover interaction', () => {
    expect(pickFragmentForInteraction([])).toBeNull()
  })
})
