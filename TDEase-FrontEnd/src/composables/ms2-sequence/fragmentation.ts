/**
 * Fragmentation calculator - performance-optimized
 * Computes theoretical fragment ions of a peptide and matches them to MS2 peaks
 */

// Amino acid masses (monoisotopic, Da)
export const AA_MASSES: Record<string, number> = {
  A: 71.03711, // Alanine
  C: 103.00919, // Cysteine
  D: 115.02694, // Aspartic acid
  E: 129.04259, // Glutamic acid
  F: 147.06841, // Phenylalanine
  G: 57.02146, // Glycine
  H: 137.05891, // Histidine
  I: 113.08406, // Isoleucine
  K: 128.09496, // Lysine
  L: 113.08406, // Leucine
  M: 131.04049, // Methionine
  N: 114.04293, // Asparagine
  P: 97.05276, // Proline
  Q: 128.05858, // Glutamine
  R: 156.10111, // Arginine
  S: 87.03203, // Serine
  T: 101.04768, // Threonine
  V: 99.06841, // Valine
  W: 186.07931, // Tryptophan
  Y: 163.06333, // Tyrosine
}

// Chemical constants (IPSA standard - MONOISOTOPIC masses)
export const PROTON_MASS = 1.007276466879 // proton mass (Da)
export const H2O_MASS = 18.01056468 // water molecule mass (Da)
export const ELECTRON_MASS = 0.00054858 // electron mass (Da)
export const CO_MASS = 27.994915 // carbon monoxide mass (Da)
export const NH3_MASS = 17.026549 // ammonia mass (Da)

// Neutral loss constants
export const NEUTRAL_LOSS_H2O = 18.01056 // -H2O (dehydration)
export const NEUTRAL_LOSS_NH3 = 17.026549 // -NH3 (deamination)
export const NEUTRAL_LOSS_CO = 27.994915 // -CO (decarbonylation)

// Ion type offsets (based on the IPSA standard)
export const ION_OFFSETS: Record<string, number> = {
  // N-terminal fragments (prefix ions)
  a: -27.994915, // b - CO
  b: 0.0, // base b ion (peptide-bond cleavage, charge retained on N-terminus)
  c: 17.026549, // b + NH3

  // C-terminal fragments (suffix ions)
  x: 43.989829, // y + CO - H2O (relative to y ion)
  y: 0.0, // base y ion (peptide-bond cleavage, charge retained on C-terminus, H2O must be added)
  z: -17.026549, // y - NH3 (relative to y ion)
}

export type IonType = 'a' | 'b' | 'c' | 'x' | 'y' | 'z'
export type NeutralLoss = 'H2O' | 'NH3'

export interface Modification {
  id: string
  name: string
  type: 'ptm' | 'massShift' | 'label'
  position: number // 1-based
  positionEnd?: number
  massShift: number // Da
  unimodId?: string
  composition?: string
}

export interface TheoreticalFragment {
  ionType: IonType
  position: number // cleavage site (1-based)
  charge: number
  theoreticalMass: number // Da
  theoreticalMz: number
  sequenceRange: [number, number] // [start, end], 1-based
  hasModification?: boolean
  neutralLoss?: NeutralLoss
}

export interface SpectrumPeak {
  index: number
  mz: number
  intensity: number
  charge?: number
  isDeconvoluted?: boolean
}

export interface MatchedFragment extends TheoreticalFragment {
  matchedPeak?: SpectrumPeak
  matchErrorDa?: number
  matchErrorPpm?: number
  isMatched: boolean
  peakIntensity?: number
  relativeIntensity?: number
}

export interface SequenceAnalysisInput {
  sequence: string
  peaks: SpectrumPeak[]
  ionTypes?: IonType[]
  maxCharge?: number
  precursorCharge?: number
  precursorMz?: number
  mzRange?: { min: number; max: number }
  breakpointHints?: number[]
  modifications?: Modification[]
  includeNeutralLosses?: boolean
  tolerancePpm?: number
  toleranceDa?: number
  matchType?: 'best' | 'all'
  minIntensity?: number
  minRelativeIntensity?: number
}

export interface CleavageScore {
  position: number
  score: number
  matchedFragmentCount: number
  matchedIonTypes: IonType[]
  hasComplementaryMatch: boolean
}

export interface SequenceAnalysisResult {
  matchedFragments: MatchedFragment[]
  breakpoints: number[]
  cleavageScores: CleavageScore[]
}

interface SequenceGraphNode {
  modificationIds: string[]
  prevNodeIndices: number[]
}

interface CleavageEvaluation {
  matchedFragments: MatchedFragment[]
  cleavageScore: CleavageScore
}

/**
 * LRU cache
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>()

  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.cache.get(key)
    if (value !== undefined) {
      // Mark as most recently used
      this.cache.delete(key)
      this.cache.set(key, value)
    }
    return value
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      // Evict the least recently used
      const keysIterator = this.cache.keys()
      const firstKey = keysIterator.next().value
      if (firstKey !== undefined) {
        this.cache.delete(firstKey)
      }
    }
    this.cache.set(key, value)
  }

  clear(): void {
    this.cache.clear()
  }
}

/**
 * Whether the ion type is an N-terminal (prefix) fragment
 */
export function isPrefixIon(ionType: IonType): boolean {
  return ['a', 'b', 'c'].includes(ionType)
}

/**
 * Precompute cumulative amino acid masses (performance optimization)
 */
function computePrefixMasses(sequence: string): number[] {
  const masses: number[] = new Array(sequence.length + 1)
  masses[0] = 0
  for (let i = 0; i < sequence.length; i++) {
    masses[i + 1] = masses[i] + (AA_MASSES[sequence[i]] || 0)
  }
  return masses
}

function getGraphSignature(modificationIds: string[]): string {
  if (modificationIds.length === 0) return '__root__'
  return [...modificationIds].sort().join('|')
}

/**
 * Fragmentation calculator - performance-optimized
 */
export class FragmentationCalculator {
  // LRU cache holding up to 100 computation results
  private cache = new LRUCache<string, TheoreticalFragment[]>(100)
  // Peak index for fast matching
  private peakIndex: Map<number, SpectrumPeak[]> = new Map()

  /**
   * Compute theoretical fragment ions - IPSA standard
   * Uses precomputed cumulative masses to avoid redundant work
   */
  computeFragments(
    sequence: string,
    ionTypes: IonType[] = ['b', 'y'],
    maxCharge: number = 2,
    modifications: Modification[] = [],
    includeNeutralLosses: boolean = false
  ): TheoreticalFragment[] {
    if (!sequence || sequence.length === 0) return []

    if (sequence.length > 1000) {
      console.warn(`Sequence length ${sequence.length} exceeds recommended maximum (1000)`)
    }

    const cacheKey = this.getCacheKey(sequence, ionTypes, maxCharge, modifications, includeNeutralLosses)
    const cached = this.cache.get(cacheKey)
    if (cached) {
      return cached
    }

    // Precompute cumulative masses
    const prefixMasses = computePrefixMasses(sequence)
    const totalMass = prefixMasses[sequence.length]

    const fragments: TheoreticalFragment[] = []

    for (const ionType of ionTypes) {
      // Iterate cleavage sites
      for (let position = 1; position < sequence.length; position++) {
        fragments.push(
          ...this.computeFragmentsAtPosition(
            sequence,
            prefixMasses,
            totalMass,
            position,
            [ionType],
            maxCharge,
            modifications,
            includeNeutralLosses
          )
        )
      }
    }

    this.cache.set(cacheKey, fragments)
    return fragments
  }

  analyzeSequence(input: SequenceAnalysisInput): SequenceAnalysisResult {
    const sequence = input.sequence
    if (!sequence || sequence.length < 2) {
      return { matchedFragments: [], breakpoints: [], cleavageScores: [] }
    }

    const ionTypes = input.ionTypes ?? ['b', 'y']
    const precursorCharge = input.precursorCharge ?? 0
    const maxCharge = precursorCharge > 0
      ? Math.min(input.maxCharge ?? precursorCharge, precursorCharge)
      : (input.maxCharge ?? 2)
    const modifications = input.modifications ?? []
    const includeNeutralLosses = input.includeNeutralLosses ?? false
    const tolerancePpm = input.tolerancePpm ?? 10
    const toleranceDa = input.toleranceDa
    const matchType = input.matchType ?? 'best'
    const mzRange = input.mzRange
    const breakpointHints = new Set(input.breakpointHints ?? [])
    const peaks = this.filterPeaks(input.peaks ?? [], input.minIntensity, input.minRelativeIntensity)
    const prefixMasses = computePrefixMasses(sequence)
    const totalMass = prefixMasses[sequence.length]
    const graph = this.buildSequenceGraph(sequence.length, modifications)
    const modificationLookup = new Map(modifications.map(mod => [mod.id, mod]))
    const evaluationCache = new Map<string, CleavageEvaluation>()
    const scoreLayers: number[][] = graph.map(layer => layer.map(() => Number.NEGATIVE_INFINITY))
    const pathLayers: number[][] = graph.map(layer => layer.map(() => -1))

    scoreLayers[0] = graph[0].map(() => 0)

    for (let position = 1; position < sequence.length; position++) {
      const layer = graph[position]
      const prevScores = scoreLayers[position - 1]

      layer.forEach((node, nodeIndex) => {
        const key = `${position}:${getGraphSignature(node.modificationIds)}`
        let evaluation = evaluationCache.get(key)
        if (!evaluation) {
          const selectedMods = node.modificationIds
            .map(id => modificationLookup.get(id))
            .filter((mod): mod is Modification => mod !== undefined)
          evaluation = this.evaluateCleavage(
            sequence,
            prefixMasses,
            totalMass,
            position,
            ionTypes,
            maxCharge,
            selectedMods,
            includeNeutralLosses,
            peaks,
            tolerancePpm,
            toleranceDa,
            matchType,
            mzRange,
            breakpointHints.has(position)
          )
          evaluationCache.set(key, evaluation)
        }

        let bestPrevScore = 0
        let bestPrevIndex = 0
        for (const prevNodeIndex of node.prevNodeIndices) {
          const prevScore = prevScores[prevNodeIndex] ?? Number.NEGATIVE_INFINITY
          if (prevScore > bestPrevScore || bestPrevIndex === 0) {
            bestPrevScore = prevScore
            bestPrevIndex = prevNodeIndex
          }
        }

        scoreLayers[position][nodeIndex] = bestPrevScore + evaluation.cleavageScore.score
        pathLayers[position][nodeIndex] = bestPrevIndex
      })
    }

    const finalPosition = sequence.length - 1
    let bestNodeIndex = 0
    let bestScore = Number.NEGATIVE_INFINITY
    scoreLayers[finalPosition].forEach((score, nodeIndex) => {
      if (score > bestScore) {
        bestScore = score
        bestNodeIndex = nodeIndex
      }
    })

    const bestPath = new Map<number, number>()
    let currentNodeIndex = bestNodeIndex
    for (let position = finalPosition; position >= 1; position--) {
      bestPath.set(position, currentNodeIndex)
      currentNodeIndex = pathLayers[position][currentNodeIndex] ?? 0
    }

    const matchedFragments: MatchedFragment[] = []
    const breakpoints: number[] = []
    const cleavageScores: CleavageScore[] = []

    for (let position = 1; position < sequence.length; position++) {
      const nodeIndex = bestPath.get(position) ?? 0
      const node = graph[position][nodeIndex]
      const key = `${position}:${getGraphSignature(node.modificationIds)}`
      const evaluation = evaluationCache.get(key)
      if (!evaluation) continue

      matchedFragments.push(...evaluation.matchedFragments)
      cleavageScores.push(evaluation.cleavageScore)
      if (evaluation.cleavageScore.matchedFragmentCount > 0) {
        breakpoints.push(position)
      }
    }

    return {
      matchedFragments,
      breakpoints,
      cleavageScores,
    }
  }

  /**
   * Build the peak index for fast matching
   */
  private buildPeakIndex(peaks: SpectrumPeak[]): void {
    this.peakIndex.clear()
    for (const peak of peaks) {
      // Group by the integer part of m/z
      const key = Math.floor(peak.mz)
      if (!this.peakIndex.has(key)) {
        this.peakIndex.set(key, [])
      }
      this.peakIndex.get(key)!.push(peak)
    }
  }

  /**
   * Match spectrum peaks to theoretical fragments - IPSA best-match strategy
   * Uses an index to accelerate matching; each peak matches only one best fragment
   */
  matchPeaks(
    peaks: SpectrumPeak[],
    theoreticalFragments: TheoreticalFragment[],
    tolerancePpm: number = 10,
    toleranceDa?: number,
    matchType: 'best' | 'all' = 'best'
  ): MatchedFragment[] {
    if (peaks.length === 0 || theoreticalFragments.length === 0) {
      return theoreticalFragments.map(f => ({ ...f, isMatched: false }))
    }

    // Build the peak index
    this.buildPeakIndex(peaks)

    const maxIntensity = this.getMaxIntensity(peaks)

    if (matchType === 'best') {
      // IPSA standard: each experimental peak matches only one best theoretical fragment
      return this.matchPeaksBestStrategy(peaks, theoreticalFragments, tolerancePpm, toleranceDa, maxIntensity)
    } else {
      // Traditional strategy: each theoretical fragment tries to match its nearest peak
      return this.matchPeaksAllStrategy(peaks, theoreticalFragments, tolerancePpm, toleranceDa, maxIntensity)
    }
  }

  /**
   * IPSA best-match strategy: each experimental peak matches only one best theoretical fragment
   */
  private matchPeaksBestStrategy(
    peaks: SpectrumPeak[],
    theoreticalFragments: TheoreticalFragment[],
    tolerancePpm: number,
    toleranceDa: number | undefined,
    maxIntensity: number
  ): MatchedFragment[] {
    // Find the best-matching fragment for each peak
    const peakToFragment = new Map<number, { fragment: TheoreticalFragment; errorDa: number; errorPpm: number }>()

    for (const peak of peaks) {
      let bestFragment: TheoreticalFragment | null = null
      let bestErrorDa = Infinity

      // Tolerance window for this peak
      const toleranceInDa = toleranceDa ?? (peak.mz * tolerancePpm / 1e6)
      const minMz = peak.mz - toleranceInDa
      const maxMz = peak.mz + toleranceInDa

      // Scan all theoretical fragments for the closest one
      for (const fragment of theoreticalFragments) {
        if (fragment.theoreticalMz < minMz || fragment.theoreticalMz > maxMz) continue

        const errorDa = Math.abs(peak.mz - fragment.theoreticalMz)
        const errorPpm = (errorDa / fragment.theoreticalMz) * 1e6

        // Check whether it is within tolerance
        const withinTolerance = toleranceDa !== undefined
          ? errorDa <= toleranceDa
          : errorPpm <= tolerancePpm

        if (withinTolerance && errorDa < bestErrorDa) {
          bestFragment = fragment
          bestErrorDa = errorDa
        }
      }

      // Record the best match
      if (bestFragment) {
        const errorPpm = (bestErrorDa / bestFragment.theoreticalMz) * 1e6
        peakToFragment.set(peak.index, {
          fragment: bestFragment,
          errorDa: bestErrorDa,
          errorPpm,
        })
      }
    }

    // Build the result: mark which fragments were matched
    return theoreticalFragments.map((fragment) => {
      // Look up whether a peak matched this fragment
      let matchedPeak: SpectrumPeak | undefined
      let matchErrorDa: number | undefined
      let matchErrorPpm: number | undefined

      for (const [peakIndex, match] of peakToFragment.entries()) {
        if (match.fragment === fragment) {
          matchedPeak = peaks.find(p => p.index === peakIndex)
          matchErrorDa = match.errorDa
          matchErrorPpm = match.errorPpm
          break
        }
      }

      return {
        ...fragment,
        matchedPeak,
        matchErrorDa,
        matchErrorPpm,
        isMatched: matchedPeak !== undefined,
        peakIntensity: matchedPeak?.intensity,
        relativeIntensity: matchedPeak ? (matchedPeak.intensity / maxIntensity) * 100 : undefined,
      }
    })
  }

  /**
   * Traditional matching strategy: each theoretical fragment tries to match its nearest peak
   */
  private matchPeaksAllStrategy(
    _peaks: SpectrumPeak[],
    theoreticalFragments: TheoreticalFragment[],
    tolerancePpm: number,
    toleranceDa: number | undefined,
    maxIntensity: number
  ): MatchedFragment[] {
    return theoreticalFragments.map((fragment) => {
      let bestMatch: SpectrumPeak | null = null
      let bestErrorDa = Infinity

      // Compute the tolerance window
      const toleranceInDa = toleranceDa ?? (fragment.theoreticalMz * tolerancePpm / 1e6)
      const minMz = fragment.theoreticalMz - toleranceInDa
      const maxMz = fragment.theoreticalMz + toleranceInDa
      const minKey = Math.floor(minMz)
      const maxKey = Math.floor(maxMz)

      for (let key = minKey; key <= maxKey; key++) {
        const group = this.peakIndex.get(key)
        if (!group) continue

        for (const peak of group) {
          if (peak.mz < minMz || peak.mz > maxMz) continue

          const errorDa = Math.abs(peak.mz - fragment.theoreticalMz)
          const errorPpm = (errorDa / fragment.theoreticalMz) * 1e6

          const withinTolerance = toleranceDa !== undefined
            ? errorDa <= toleranceDa
            : errorPpm <= tolerancePpm

          if (withinTolerance && errorDa < bestErrorDa) {
            bestMatch = peak
            bestErrorDa = errorDa
          }
        }
      }

      const bestErrorPpm = bestMatch
        ? (bestErrorDa / fragment.theoreticalMz) * 1e6
        : undefined

      return {
        ...fragment,
        matchedPeak: bestMatch ?? undefined,
        matchErrorDa: bestMatch ? bestErrorDa : undefined,
        matchErrorPpm: bestErrorPpm,
        isMatched: bestMatch !== null,
        peakIntensity: bestMatch?.intensity,
        relativeIntensity: bestMatch ? (bestMatch.intensity / maxIntensity) * 100 : undefined,
      }
    })
  }

  /**
   * Compute fragments for multiple sequences in one batch (for high-throughput scenarios)
   */
  computeFragmentsBatch(
    sequences: Array<{
      id: string
      sequence: string
      ionTypes?: IonType[]
      maxCharge?: number
      modifications?: Modification[]
    }>
  ): Map<string, TheoreticalFragment[]> {
    const results = new Map<string, TheoreticalFragment[]>()

    for (const item of sequences) {
      const fragments = this.computeFragments(
        item.sequence,
        item.ionTypes ?? ['b', 'y'],
        item.maxCharge ?? 2,
        item.modifications ?? []
      )
      results.set(item.id, fragments)
    }

    return results
  }

  private getMaxIntensity(peaks: SpectrumPeak[]): number {
    let max = 1
    for (const peak of peaks) {
      if (peak.intensity > max) max = peak.intensity
    }
    return max
  }

  private getCacheKey(...args: any[]): string {
    return args.map(a => {
      if (Array.isArray(a)) {
        return a.map(i => typeof i === 'object' ? i.id || JSON.stringify(i) : i).join(',')
      }
      return String(a)
    }).join('|')
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear()
    this.peakIndex.clear()
  }

  /**
   * Cache statistics
   */
  getCacheStats(): { size: number; maxSize: number } {
    return { size: (this.cache as any).cache?.size || 0, maxSize: 100 }
  }

  private filterPeaks(
    peaks: SpectrumPeak[],
    minIntensity?: number,
    minRelativeIntensity?: number
  ): SpectrumPeak[] {
    if (!peaks.length) return []

    const maxIntensity = this.getMaxIntensity(peaks)
    return peaks.filter(peak => {
      if (minIntensity !== undefined && peak.intensity < minIntensity) return false
      if (minRelativeIntensity !== undefined && (peak.intensity / maxIntensity) * 100 < minRelativeIntensity) return false
      return true
    })
  }

  private buildSequenceGraph(sequenceLength: number, modifications: Modification[]): SequenceGraphNode[][] {
    const graph: SequenceGraphNode[][] = Array.from({ length: sequenceLength + 1 }, () => [])
    graph[0] = [{ modificationIds: [], prevNodeIndices: [] }]

    const modsByPosition = new Map<number, Modification[]>()
    for (const mod of modifications) {
      const position = mod.position
      if (!modsByPosition.has(position)) {
        modsByPosition.set(position, [])
      }
      modsByPosition.get(position)!.push(mod)
    }

    for (let position = 1; position <= sequenceLength; position++) {
      const previousLayer = graph[position - 1]
      const startingMods = modsByPosition.get(position) ?? []
      const layer = new Map<string, SequenceGraphNode>()

      previousLayer.forEach((prevNode, prevNodeIndex) => {
        const modificationIds = Array.from(new Set([
          ...prevNode.modificationIds,
          ...startingMods.map(mod => mod.id),
        ])).sort()
        const signature = getGraphSignature(modificationIds)
        const existing = layer.get(signature)
        if (existing) {
          if (!existing.prevNodeIndices.includes(prevNodeIndex)) {
            existing.prevNodeIndices.push(prevNodeIndex)
          }
          return
        }

        layer.set(signature, {
          modificationIds,
          prevNodeIndices: [prevNodeIndex],
        })
      })

      graph[position] = Array.from(layer.values())
    }

    return graph
  }

  private evaluateCleavage(
    sequence: string,
    prefixMasses: number[],
    totalMass: number,
    position: number,
    ionTypes: IonType[],
    maxCharge: number,
    modifications: Modification[],
    includeNeutralLosses: boolean,
    peaks: SpectrumPeak[],
    tolerancePpm: number,
    toleranceDa: number | undefined,
    matchType: 'best' | 'all',
    mzRange: { min: number; max: number } | undefined,
    hasBreakpointHint: boolean
  ): CleavageEvaluation {
    const theoreticalFragments = this.computeFragmentsAtPosition(
      sequence,
      prefixMasses,
      totalMass,
      position,
      ionTypes,
      maxCharge,
      modifications,
      includeNeutralLosses,
      mzRange
    )
    const matchedFragments = this.matchPeaks(peaks, theoreticalFragments, tolerancePpm, toleranceDa, matchType)
    const matchedOnly = matchedFragments.filter(fragment => fragment.isMatched)
    const matchedIonTypes = Array.from(new Set(matchedOnly.map(fragment => fragment.ionType)))
    const hasPrefix = matchedOnly.some(fragment => isPrefixIon(fragment.ionType))
    const hasSuffix = matchedOnly.some(fragment => !isPrefixIon(fragment.ionType))

    let score = 0
    for (const fragment of matchedOnly) {
      const relativeIntensity = fragment.relativeIntensity ?? 0
      const accuracyWeight = toleranceDa !== undefined
        ? Math.max(0, 1 - ((fragment.matchErrorDa ?? toleranceDa) / Math.max(toleranceDa, 1e-6)))
        : Math.max(0, 1 - (Math.abs(fragment.matchErrorPpm ?? tolerancePpm) / Math.max(tolerancePpm, 1)))

      score += 1
      score += relativeIntensity / 100
      score += accuracyWeight
      if (fragment.charge > 1) score += 0.1
      if (fragment.neutralLoss) score += 0.05
    }

    if (hasPrefix && hasSuffix) {
      score += 1.5
    }
    if (hasBreakpointHint && matchedOnly.length > 0) {
      score += 0.25
    }

    return {
      matchedFragments,
      cleavageScore: {
        position,
        score,
        matchedFragmentCount: matchedOnly.length,
        matchedIonTypes,
        hasComplementaryMatch: hasPrefix && hasSuffix,
      },
    }
  }

  private computeFragmentsAtPosition(
    sequence: string,
    prefixMasses: number[],
    totalMass: number,
    position: number,
    ionTypes: IonType[],
    maxCharge: number,
    modifications: Modification[],
    includeNeutralLosses: boolean,
    mzRange?: { min: number; max: number }
  ): TheoreticalFragment[] {
    const fragments: TheoreticalFragment[] = []
    const effects = this.getModificationEffectsAtPosition(position, modifications)

    for (const ionType of ionTypes) {
      const isPrefix = isPrefixIon(ionType)
      const baseOffset = ION_OFFSETS[ionType]
      let neutralMass: number

      if (isPrefix) {
        neutralMass = prefixMasses[position] + baseOffset + effects.prefix
      } else {
        neutralMass = (totalMass - prefixMasses[position]) + H2O_MASS + baseOffset + effects.suffix
      }

      const range: [number, number] = isPrefix ? [1, position] : [position + 1, sequence.length]
      const hasModification = (isPrefix ? effects.prefix : effects.suffix) !== 0

      for (let charge = 1; charge <= maxCharge; charge++) {
        const theoreticalMz = (neutralMass + charge * PROTON_MASS) / charge
        if (mzRange && (theoreticalMz < mzRange.min || theoreticalMz > mzRange.max)) {
          continue
        }
        fragments.push({
          ionType,
          position,
          charge,
          theoreticalMass: neutralMass,
          theoreticalMz,
          sequenceRange: range,
          hasModification,
        })

        if (!includeNeutralLosses) continue

        const subseq = isPrefix
          ? sequence.substring(0, position)
          : sequence.substring(position)
        const hasSTEDQ = /[STEDQ]/.test(subseq)
        const hasRKNQ = /[RKNQ]/.test(subseq)

        if (hasSTEDQ) {
          const lossMz = (neutralMass - NEUTRAL_LOSS_H2O + charge * PROTON_MASS) / charge
          if (!mzRange || (lossMz >= mzRange.min && lossMz <= mzRange.max)) {
            fragments.push({
              ionType,
              position,
              charge,
              theoreticalMass: neutralMass - NEUTRAL_LOSS_H2O,
              theoreticalMz: lossMz,
              sequenceRange: range,
              hasModification,
              neutralLoss: 'H2O',
            })
          }
        }

        if (hasRKNQ) {
          const lossMz = (neutralMass - NEUTRAL_LOSS_NH3 + charge * PROTON_MASS) / charge
          if (!mzRange || (lossMz >= mzRange.min && lossMz <= mzRange.max)) {
            fragments.push({
              ionType,
              position,
              charge,
              theoreticalMass: neutralMass - NEUTRAL_LOSS_NH3,
              theoreticalMz: lossMz,
              sequenceRange: range,
              hasModification,
              neutralLoss: 'NH3',
            })
          }
        }
      }
    }

    return fragments
  }

  private getModificationEffectsAtPosition(
    position: number,
    modifications: Modification[]
  ): { prefix: number; suffix: number } {
    let prefix = 0
    let suffix = 0

    for (const mod of modifications) {
      const modStart = mod.position
      const modEnd = mod.positionEnd ?? modStart
      if (modStart <= position) {
        prefix += mod.massShift
      }
      if (modEnd > position) {
        suffix += mod.massShift
      }
    }

    return { prefix, suffix }
  }
}

/**
 * Activation method -> default ion type mapping.
 * Mirrors the Domain layer's raw_ms2_matcher.py _ACTIVATION_IONS and the
 * equivalent mapping in neutral_fragment_matcher.py.
 */
export const ACTIVATION_IONS: Record<string, IonType[]> = {
  ETD: ['c', 'z'],
  ECD: ['c', 'z'],
  HCD: ['b', 'y'],
  CID: ['b', 'y'],
  ETHCD: ['b', 'y', 'c', 'z'],
  ETHCDSA: ['b', 'y', 'c', 'z'],
  UVPD: ['a', 'x'],
}

/**
 * Return the recommended default ion types for an activation method.
 * Falls back to ['b', 'y'] for unknown methods.
 */
export function activationToIonTypes(activation: string): IonType[] {
  const key = activation.toUpperCase().trim()
  return ACTIVATION_IONS[key] ?? ['b', 'y']
}

/**
 * Factory for creating a calculator
 */
export function createFragmentationCalculator(): FragmentationCalculator {
  return new FragmentationCalculator()
}
