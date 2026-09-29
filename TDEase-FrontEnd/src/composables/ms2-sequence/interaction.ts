/**
 * Interaction management
 * Cross-highlighting logic between sequence, spectrum, and fragments
 */

import type { MatchedFragment, SpectrumPeak } from './fragmentation'

export interface InteractionState {
  // Hover state
  hoveredFragment?: MatchedFragment
  hoveredPeak?: SpectrumPeak
  hoveredResidue?: number // hovered residue position (1-based)

  // Selection state
  selectedFragment?: MatchedFragment
  selectedPeakIndex?: number
  selectedResidue?: number

  // Highlight state (derived)
  highlightedFragments: MatchedFragment[]
  highlightedPeaks: number[] // peak indices
  highlightedResidues: number[] // residue positions (1-based)
}

/**
 * Interaction manager
 */
export class InteractionManager {
  /**
   * On residue hover, highlight all fragments covering that residue
   */
  highlightByResidue(
    residuePosition: number,
    fragments: MatchedFragment[]
  ): InteractionState {
    const highlightedFragments = fragments.filter((f) => {
      const [start, end] = f.sequenceRange
      return residuePosition >= start && residuePosition <= end
    })

    const highlightedPeaks = highlightedFragments
      .filter((f) => f.isMatched && f.matchedPeak)
      .map((f) => f.matchedPeak!.index)

    return {
      hoveredResidue: residuePosition,
      highlightedFragments,
      highlightedPeaks,
      highlightedResidues: [residuePosition],
    }
  }

  /**
   * On peak hover, highlight the corresponding fragments and sequence positions
   */
  highlightByPeak(
    peak: SpectrumPeak,
    fragments: MatchedFragment[]
  ): InteractionState {
    const matchedFragments = fragments.filter(
      (f) => f.isMatched && f.matchedPeak?.index === peak.index
    )

    if (matchedFragments.length === 0) {
      return {
        hoveredPeak: peak,
        highlightedFragments: [],
        highlightedPeaks: [peak.index],
        highlightedResidues: [],
      }
    }

    // Collect the sequence positions covered by all matched fragments
    const highlightedResidues: number[] = []
    for (const fragment of matchedFragments) {
      const [start, end] = fragment.sequenceRange
      for (let i = start; i <= end; i++) {
        if (!highlightedResidues.includes(i)) {
          highlightedResidues.push(i)
        }
      }
    }

    return {
      hoveredPeak: peak,
      highlightedFragments: matchedFragments,
      highlightedPeaks: [peak.index],
      highlightedResidues,
    }
  }

  /**
   * On fragment hover, highlight both the sequence and the spectrum
   */
  highlightByFragment(fragment: MatchedFragment): InteractionState {
    const [start, end] = fragment.sequenceRange
    const highlightedResidues: number[] = []
    for (let i = start; i <= end; i++) {
      highlightedResidues.push(i)
    }

    const highlightedPeaks =
      fragment.isMatched && fragment.matchedPeak ? [fragment.matchedPeak.index] : []

    return {
      hoveredFragment: fragment,
      highlightedFragments: [fragment],
      highlightedPeaks,
      highlightedResidues,
    }
  }

  /**
   * Clear all highlights
   */
  clearHighlight(): InteractionState {
    return {
      highlightedFragments: [],
      highlightedPeaks: [],
      highlightedResidues: [],
    }
  }
}
