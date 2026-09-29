/**
 * ms2-sequence-helpers.ts
 *
 * Pure sequence analysis and annotation normalization functions for MS2
 * sequence viewers.  Zero Vue dependencies -- all functions are side-effect
 * free transforms of their inputs.
 *
 * Extracted from MS2SequenceViewer.vue to enable unit testing and reuse
 * across components without coupling to Vue reactivity or DOM.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical 20 standard amino acid one-letter codes. */
export const VALID_AMINO_ACIDS = 'ACDEFGHIKLMNPQRSTVWY'

/** Regex that matches a string composed entirely of valid amino acids. */
export const VALID_AA_REGEX = /^[ACDEFGHIKLMNPQRSTVWY]*$/

/**
 * Canonical activation-method names mapped from common input variants.
 * Keys are uppercased-and-trimmed input; values are the display form.
 */
export const ACTIVATION_METHOD_ALIASES: Record<string, string> = {
  'ETD': 'ETD',
  'ECD': 'ECD',
  'HCD': 'HCD',
  'CID': 'CID',
  'ETHCD': 'EThcD',
  'E-THCD': 'EThcD',
  'UVPD': 'UVPD',
  'PQD': 'PQD',
  'IRMPD': 'IRMPD',
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SequenceValidationResult {
  valid: boolean
  error?: string
  length: number
}

export interface DisplayChar {
  char: string
  mod?: string
}

// ---------------------------------------------------------------------------
// Amino acid validation
// ---------------------------------------------------------------------------

/**
 * Validate an amino acid sequence string.
 *
 * Returns a `SequenceValidationResult` indicating whether the sequence is
 * valid, an error message for invalid input, and the sequence length.
 *
 * @example
 *   validateAASequence('ACDEF')      // => { valid: true, length: 5 }
 *   validateAASequence('')           // => { valid: false, error: '...', length: 0 }
 *   validateAASequence('ACBX')       // => { valid: false, error: '...', length: 4 }
 */
export function validateAASequence(seq: string): SequenceValidationResult {
  const upper = seq.toUpperCase()

  if (!upper) {
    return { valid: false, error: 'Sequence is empty', length: 0 }
  }

  if (!VALID_AA_REGEX.test(upper)) {
    const invalidChars = upper
      .split('')
      .filter((c) => !VALID_AMINO_ACIDS.includes(c))
    const unique = Array.from(new Set(invalidChars))
    return {
      valid: false,
      error: `Invalid amino acid${unique.length > 1 ? 's' : ''}: ${unique.join(', ')}`,
      length: upper.length,
    }
  }

  return { valid: true, error: undefined, length: upper.length }
}

// ---------------------------------------------------------------------------
// Matched-position counting
// ---------------------------------------------------------------------------

/**
 * Count the number of unique positions in a sequence that have at least one
 * modification applied.
 *
 * Each modification's `position` is treated as a 1-based index.
 * Modifications with positions outside `[1, sequence.length]` are ignored.
 *
 * @example
 *   computeMatchedCount('PEPTIDE', [{ position: 2 }, { position: 5 }])
 *   // => 2
 */
export function computeMatchedCount(
  sequence: string,
  modifications: Array<{ position: number }>,
): number {
  if (!sequence || modifications.length === 0) return 0

  const positions = new Set<number>()
  for (const mod of modifications) {
    if (mod.position >= 1 && mod.position <= sequence.length) {
      positions.add(mod.position)
    }
  }
  return positions.size
}

// ---------------------------------------------------------------------------
// Activation method normalization
// ---------------------------------------------------------------------------

/**
 * Normalize an activation-method string to its canonical display form.
 *
 * - Trims whitespace and uppercases for alias lookup.
 * - Returns `null` for nullish, empty, or unrecognised values.
 *
 * @example
 *   normalizeActivationMethod('hcd')      // => 'HCD'
 *   normalizeActivationMethod('EThcD')     // => 'EThcD'
 *   normalizeActivationMethod('E-THCD')    // => 'EThcD'
 *   normalizeActivationMethod('')          // => null
 *   normalizeActivationMethod(null)        // => null
 *   normalizeActivationMethod('FANCY')     // => null
 */
export function normalizeActivationMethod(
  method: string | null | undefined,
): string | null {
  if (!method) return null

  const key = method.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!key) return null

  return ACTIVATION_METHOD_ALIASES[key] ?? null
}

// ---------------------------------------------------------------------------
// Sequence display formatter
// ---------------------------------------------------------------------------

/**
 * Format a sequence for character-level display, annotating each position
 * that has a modification.
 *
 * Returns an array the same length as `sequence`.  Each element has:
 *   - `char`: the amino acid character
 *   - `mod` (optional): the modification label if a modification exists at
 *     this position
 *
 * When multiple modifications exist at the same position, only the **last**
 * one's label is used (so callers should pre-merge if they need combined
 * labels).
 *
 * Positions outside `[1, sequence.length]` are silently ignored.
 *
 * @example
 *   formatSequenceForDisplay('ATK', [
 *     { position: 1, label: 'Acetyl' },
 *   ])
 *   // => [
 *   //   { char: 'A', mod: 'Acetyl' },
 *   //   { char: 'T' },
 *   //   { char: 'K' },
 *   // ]
 */
export function formatSequenceForDisplay(
  sequence: string,
  modifications: Array<{ position: number; label: string }>,
): DisplayChar[] {
  if (!sequence) return []

  const result: DisplayChar[] = new Array(sequence.length)
  for (let i = 0; i < sequence.length; i++) {
    result[i] = { char: sequence[i] }
  }

  for (const mod of modifications) {
    if (mod.position >= 1 && mod.position <= sequence.length) {
      const entry = result[mod.position - 1]
      if (entry) {
        entry.mod = mod.label
      }
    }
  }

  return result
}
