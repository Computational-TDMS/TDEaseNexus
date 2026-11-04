import { describe, expect, it } from 'vitest'
import { isMassLedgerPayload, parseMassLedger } from './massLedger'

/**
 * The mass ledger read model over the kernel's resolve-shift result: the
 * envelope and the bare result parse identically, the ledger's terms come
 * from the best candidate's complete ProForma through the shared PRSM parser,
 * and the closure numbers stay the kernel's own (never re-derived).
 */
const RESULT = {
  sequence: 'MGNCGSNPKT',
  observedShift: 317.3952,
  shiftFrame: 'toppic',
  scans: ['8705'],
  ions: ['b', 'y'],
  candidates: [
    {
      combination: 'Myristoyl+Palmitoyl',
      components: ['Myristoyl', 'Palmitoyl'],
      combinationMass: 317.3951,
      massErrorDa: 0.0001,
      score: 0.82,
      proforma: '(MGN)[+210.1984]C[+238.2297]GSNPKT',
      numPlacements: 1,
    },
    {
      combination: 'Methyl',
      components: ['Methyl'],
      combinationMass: 14.0157,
      massErrorDa: 303.3795,
      score: 0.11,
    },
  ],
  enumeratedCombinations: 4,
  evaluatedCombinations: 4,
  maxCandidates: 5,
  notes: [],
}

describe('isMassLedgerPayload', () => {
  it('accepts the CLI envelope and the bare result', () => {
    expect(isMassLedgerPayload({ params: {}, result: RESULT })).toBe(true)
    expect(isMassLedgerPayload(RESULT)).toBe(true)
  })

  it('refuses anything without a sequence, a finite shift and candidates', () => {
    expect(isMassLedgerPayload(null)).toBe(false)
    expect(isMassLedgerPayload([RESULT])).toBe(false)
    expect(isMassLedgerPayload({ ...RESULT, observedShift: 'x' })).toBe(false)
    expect(isMassLedgerPayload({ sequence: 'PEP', observedShift: 1, candidates: [] })).toBe(false)
    expect(isMassLedgerPayload({ result: { sequence: '', observedShift: 1, candidates: [] } })).toBe(false)
  })
})

describe('parseMassLedger', () => {
  it('builds the ledger from the rank-1 candidate through the shared ProForma parser', () => {
    const model = parseMassLedger({ params: {}, result: RESULT })
    expect(model.sequence).toBe('MGNCGSNPKT')
    expect(model.observedShift).toBe(317.3952)
    expect(model.combination).toBe('Myristoyl+Palmitoyl')
    // Block term at the block's start site, single-residue tag on Cys-4 —
    // both extracted, sorted by site.
    expect(model.terms).toEqual([
      { name: null, site: 1, delta: 210.1984 },
      { name: null, site: 4, delta: 238.2297 },
    ])
    // The kernel's own sum and error — not re-derived.
    expect(model.modelShift).toBe(317.3951)
    expect(model.closureErrorDa).toBe(0.0001)
    expect(model.closureErrorPpm).toBeCloseTo((0.0001 / 317.3952) * 1e6, 9)
  })

  it('unwraps the bare result identically', () => {
    expect(parseMassLedger(RESULT).combination).toBe('Myristoyl+Palmitoyl')
  })

  it('keeps named N-terminal terms when the ProForma carries them', () => {
    const model = parseMassLedger({
      sequence: 'PEPTIDE',
      observedShift: 122.0118,
      candidates: [{
        combination: 'Acetyl+80',
        combinationMass: 122.0106,
        massErrorDa: -0.0012,
        score: 0.4,
        proforma: '[Acetyl]-PEP(T)[+80]IDE',
      }],
    })
    // The named N-term keeps its name; the block's mass-text name normalizes
    // to null (a number is not a chemistry name).
    expect(model.terms[0]).toMatchObject({ name: 'Acetyl', site: 1 })
    expect(model.terms[1]).toMatchObject({ name: null, delta: 80 })
    expect(model.modelShift).toBe(122.0106)
    expect(model.closureErrorDa).toBe(-0.0012)
  })

  it('falls back to a derived closure error when the kernel omits massErrorDa', () => {
    const model = parseMassLedger({
      sequence: 'PEPTIDE',
      observedShift: 100,
      candidates: [{ combination: 'X', combinationMass: 99.5, score: 0.1 }],
    })
    expect(model.freeMass).toBeNull()
    expect(model.modelShift).toBe(99.5)
    expect(model.closureErrorDa).toBeCloseTo(-0.5, 10)
    expect(model.terms).toEqual([])
  })

  it('refuses a result whose candidate list is empty', () => {
    // Detection itself rejects it; parse is the defense in depth.
    expect(() => parseMassLedger({ ...RESULT, candidates: [] })).toThrow(/payload/)
  })
})
