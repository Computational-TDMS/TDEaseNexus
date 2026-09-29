import { describe, expect, it } from 'vitest'

import {
  validateAASequence,
  computeMatchedCount,
  normalizeActivationMethod,
  formatSequenceForDisplay,
  VALID_AMINO_ACIDS,
} from './ms2-sequence-helpers'
import { activationToIonTypes } from '@/composables/ms2-sequence'

// ---------------------------------------------------------------------------
// validateAASequence
// ---------------------------------------------------------------------------

describe('validateAASequence', () => {
  it('returns valid for every canonical amino acid', () => {
    for (const aa of VALID_AMINO_ACIDS) {
      const result = validateAASequence(aa)
      expect(result).toMatchObject({ valid: true, error: undefined, length: 1 })
    }
  })

  it('returns valid for a 20-char sequence using all standard amino acids', () => {
    const result = validateAASequence('ACDEFGHIKLMNPQRSTVWY')
    expect(result).toMatchObject({ valid: true, error: undefined, length: 20 })
  })

  it('returns invalid for an empty sequence', () => {
    const result = validateAASequence('')
    expect(result).toMatchObject({ valid: false, length: 0 })
    expect(result.error).toContain('empty')
  })

  it('returns invalid for a sequence with non-standard characters', () => {
    const result = validateAASequence('ACBX')
    expect(result).toMatchObject({ valid: false, length: 4 })
    expect(result.error).toContain('B')
  })

  it('reports all unique invalid characters in the error message', () => {
    const result = validateAASequence('ZOBX')
    expect(result).toMatchObject({ valid: false, length: 4 })
    expect(result.error).toContain('Z')
    expect(result.error).toContain('O')
    expect(result.error).toContain('B')
    expect(result.error).toContain('X')
  })

  it('uses plural "acids" when multiple invalid chars are found', () => {
    const result = validateAASequence('AB1')
    expect(result.error).toContain('acids')
  })

  it('uses singular "acid" when exactly one invalid char is found', () => {
    const result = validateAASequence('AB')
    expect(result.error).toContain('acid')
    expect(result.error).not.toContain('acids')
  })

  it('accepts lowercase input as valid', () => {
    expect(validateAASequence('acdef')).toMatchObject({ valid: true, length: 5 })
  })
})

// ---------------------------------------------------------------------------
// computeMatchedCount
// ---------------------------------------------------------------------------

describe('computeMatchedCount', () => {
  it('counts unique modified positions', () => {
    const result = computeMatchedCount('PEPTIDE', [
      { position: 2 },
      { position: 5 },
    ])
    expect(result).toBe(2)
  })

  it('returns 0 for an empty sequence', () => {
    expect(computeMatchedCount('', [{ position: 1 }])).toBe(0)
  })

  it('returns 0 for an empty modifications array', () => {
    expect(computeMatchedCount('PEPTIDE', [])).toBe(0)
  })

  it('ignores positions outside the sequence range', () => {
    const result = computeMatchedCount('PEP', [
      { position: 0 },
      { position: 4 },
    ])
    expect(result).toBe(0)
  })

  it('counts duplicate positions only once', () => {
    const result = computeMatchedCount('PEPTIDE', [
      { position: 2 },
      { position: 2 },
      { position: 2 },
    ])
    expect(result).toBe(1)
  })

  it('handles mixed valid and out-of-range positions', () => {
    const result = computeMatchedCount('ABC', [
      { position: 1 },
      { position: 5 },
      { position: 3 },
      { position: -1 },
    ])
    expect(result).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// normalizeActivationMethod
// ---------------------------------------------------------------------------

describe('normalizeActivationMethod', () => {
  it('normalizes lowercase "cid" to "CID"', () => {
    expect(normalizeActivationMethod('cid')).toBe('CID')
  })

  it('normalizes lowercase "hcd" to "HCD"', () => {
    expect(normalizeActivationMethod('hcd')).toBe('HCD')
  })

  it('normalizes "EThcD" to "EThcD" (canonical form)', () => {
    expect(normalizeActivationMethod('EThcD')).toBe('EThcD')
  })

  it('normalizes "E-THCD" to "EThcD" via hyphen stripping', () => {
    expect(normalizeActivationMethod('E-THCD')).toBe('EThcD')
  })

  it('normalizes mixed casing "eThcD" to "EThcD"', () => {
    expect(normalizeActivationMethod('eThcD')).toBe('EThcD')
  })

  it('maps EThcD activation to b/y/c/z ions', () => {
    expect(activationToIonTypes('EThcD')).toEqual(['b', 'y', 'c', 'z'])
    expect(activationToIonTypes('ETHCD')).toEqual(['b', 'y', 'c', 'z'])
  })

  it('returns null for null input', () => {
    expect(normalizeActivationMethod(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(normalizeActivationMethod(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(normalizeActivationMethod('')).toBeNull()
  })

  it('returns null for whitespace-only string', () => {
    expect(normalizeActivationMethod('   ')).toBeNull()
  })

  it('returns null for an unknown activation method', () => {
    expect(normalizeActivationMethod('FANCY')).toBeNull()
  })

  it('trims surrounding whitespace before lookup', () => {
    expect(normalizeActivationMethod('  HCD  ')).toBe('HCD')
  })

  it('recognises all known aliases', () => {
    const known = ['ETD', 'ECD', 'HCD', 'CID', 'UVPD', 'PQD', 'IRMPD']
    for (const method of known) {
      expect(normalizeActivationMethod(method)).toBe(method)
    }
  })
})

// ---------------------------------------------------------------------------
// formatSequenceForDisplay
// ---------------------------------------------------------------------------

describe('formatSequenceForDisplay', () => {
  it('returns characters with no mods when no modifications given', () => {
    const result = formatSequenceForDisplay('ATK', [])
    expect(result).toEqual([
      { char: 'A' },
      { char: 'T' },
      { char: 'K' },
    ])
  })

  it('annotates modified positions with the mod label', () => {
    const result = formatSequenceForDisplay('ATK', [
      { position: 1, label: 'Acetyl' },
    ])
    expect(result).toEqual([
      { char: 'A', mod: 'Acetyl' },
      { char: 'T' },
      { char: 'K' },
    ])
  })

  it('returns empty array for empty sequence', () => {
    expect(formatSequenceForDisplay('', [{ position: 1, label: 'Acetyl' }])).toEqual([])
  })

  it('ignores modifications with positions outside the sequence range', () => {
    const result = formatSequenceForDisplay('ATK', [
      { position: 0, label: 'N-term' },
      { position: 5, label: 'C-term' },
    ])
    expect(result).toEqual([
      { char: 'A' },
      { char: 'T' },
      { char: 'K' },
    ])
  })

  it('uses the last modification label when multiple mods share a position', () => {
    const result = formatSequenceForDisplay('ATK', [
      { position: 2, label: 'Oxidation' },
      { position: 2, label: 'Phospho' },
    ])
    expect(result).toEqual([
      { char: 'A' },
      { char: 'T', mod: 'Phospho' },
      { char: 'K' },
    ])
  })

  it('annotates multiple distinct positions independently', () => {
    const result = formatSequenceForDisplay('PEPTIDE', [
      { position: 1, label: 'Acetyl' },
      { position: 4, label: 'Oxidation' },
      { position: 7, label: 'Amidation' },
    ])
    expect(result).toEqual([
      { char: 'P', mod: 'Acetyl' },
      { char: 'E' },
      { char: 'P' },
      { char: 'T', mod: 'Oxidation' },
      { char: 'I' },
      { char: 'D' },
      { char: 'E', mod: 'Amidation' },
    ])
  })
})
