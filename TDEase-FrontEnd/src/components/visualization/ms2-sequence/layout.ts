import type { MatchedFragment, SpectrumPeak } from '@/composables/ms2-sequence/fragmentation'

export const DEFAULT_MZ_RANGE: [number, number] = [0, 1000]
export const SEQUENCE_CELL_WIDTH = 20

export function getSpectrumMzRange(peaks: SpectrumPeak[]): [number, number] {
  if (peaks.length === 0) {
    return DEFAULT_MZ_RANGE
  }

  const mzs = peaks
    .map(peak => Number(peak.mz))
    .filter(mz => Number.isFinite(mz))

  if (mzs.length === 0) {
    return DEFAULT_MZ_RANGE
  }

  const min = Math.min(...mzs)
  const max = Math.max(...mzs)
  const span = max - min
  const padding = span === 0 ? Math.max(min * 0.05, 1) : span * 0.05

  return [min - padding, max + padding]
}

export function getCleavageLineX(
  position: number,
  visibleStart: number,
  cellWidth: number = SEQUENCE_CELL_WIDTH,
): number {
  return (position - visibleStart) * cellWidth
}

export function pickFragmentForInteraction(
  fragments: MatchedFragment[],
): MatchedFragment | null {
  return fragments.find(fragment => fragment.isMatched) || fragments[0] || null
}
