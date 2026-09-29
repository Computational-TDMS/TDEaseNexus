/**
 * massLedger — read model for the kernel's `resolve-shift` result JSON, so the
 * Workbench renders the shift's mass accounting natively (the trailer's "mass
 * ledger" surface) instead of raw stdout.
 *
 * The payload is the CLI envelope `{ params, result }` or the bare
 * `GraphSearchResult`: `sequence`, `observedShift`, `candidates[]` with
 * `combinationMass`, `freeMass`, `massErrorDa`, `score` and the complete
 * candidate `proforma` (RUST-MS-CONTRACT.md). The ledger answers one question
 * — WHICH chemistry closes the observed shift, and how exactly — so the model
 * is built from the BEST (rank-1) candidate only: per-term deltas parsed from
 * its complete ProForma (the same parser the PRSM viewers use), the kernel's
 * own sum (`combinationMass + freeMass`) as the model shift, and its
 * `massErrorDa` as the closure error. Numbers are never re-derived here: the
 * kernel's accounting is the truth this surface presents.
 */

import { parseProteoformAnnotation } from '@/utils/proforma'

export interface MassLedgerTerm {
  /** Named modification, or null for a bare mass shift. */
  name: string | null
  /** 1-based residue position, or null when the parser carries none. */
  site: number | null
  /** Delta mass in Da. */
  delta: number
}

export interface MassLedgerModel {
  sequence: string
  observedShift: number
  /** The best candidate's library combination label. */
  combination: string
  /** The best candidate's complete ProForma, when the frame provided one. */
  proforma: string | null
  score: number
  /** Per-term accounting parsed from the complete ProForma. */
  terms: MassLedgerTerm[]
  /** The candidate's unassigned residual mass, when it carries one. */
  freeMass: number | null
  /** The kernel's own sum: combinationMass + freeMass. */
  modelShift: number
  /** The kernel's massErrorDa: model shift − observed shift. */
  closureErrorDa: number
  /** Closure error in ppm against the observed shift (null at 0 shift). */
  closureErrorPpm: number | null
}

/** True when a parsed JSON value is a resolve-shift result (envelope or bare). */
export function isMassLedgerPayload(value: unknown): boolean {
  const result = unwrapResult(value)
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false
  const record = result as Record<string, unknown>
  return typeof record.sequence === 'string' && record.sequence.trim() !== ''
    && Number.isFinite(record.observedShift)
    && Array.isArray(record.candidates) && record.candidates.length > 0
}

/** Single-residue mass tag the PRSM parser's block grammar does not carry
 *  (`C[+238.2297]`) — the common shape in the kernel's complete ProForma. */
const SINGLE_RESIDUE_MASS_RE = /([A-Z])\[([+-]?\d+(?:\.\d+)?)\]/g
/** A block term's `name` is the mass text itself (`+210.1984`) — not a name. */
const BARE_MASS_NAME_RE = /^[+-]?\d/

function unwrapResult(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = (value as Record<string, unknown>).result
  return result && typeof result === 'object' && !Array.isArray(result) ? result : value
}

function finite(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function parseMassLedger(payload: unknown): MassLedgerModel {
  if (!isMassLedgerPayload(payload)) throw new Error('Not a resolve-shift result payload')
  const result = unwrapResult(payload) as Record<string, unknown>
  const best = Array.isArray(result.candidates)
    ? (result.candidates as unknown[])[0] as Record<string, unknown> | undefined
    : undefined
  if (!best || typeof best !== 'object') throw new Error('Resolve-shift result has no candidates')

  const observedShift = Number(result.observedShift)
  const combinationMass = finite(best.combinationMass) ?? 0
  const freeMass = finite(best.freeMass) ?? null
  const closureErrorDa = finite(best.massErrorDa)
    ?? (combinationMass + (freeMass ?? 0) - observedShift)

  const proforma = typeof best.proforma === 'string' && best.proforma.trim() ? best.proforma : null
  // Terms come from the complete ProForma: the shared PRSM parser carries the
  // N-term and block grammar; a supplementary pass picks up the single-residue
  // mass tags it does not. Site coordinates come from the parser's delivered
  // sequence — residues before the tag, skipping annotation characters.
  const terms: MassLedgerTerm[] = []
  if (proforma) {
    const parsed = parseProteoformAnnotation(proforma)
    for (const mod of parsed.modifications) {
      if (!Number.isFinite(mod.massShift)) continue
      terms.push({
        name: mod.name && !BARE_MASS_NAME_RE.test(mod.name) ? mod.name : null,
        site: Number.isFinite(mod.position) ? mod.position : null,
        delta: mod.massShift,
      })
    }
    if (parsed.sequence) {
      for (const match of proforma.matchAll(SINGLE_RESIDUE_MASS_RE)) {
        const residuesBefore = proforma.slice(0, match.index ?? 0).replace(/[^A-Z]/g, '').length
        terms.push({ name: null, site: residuesBefore + 1, delta: Number(match[2]) })
      }
    }
  }
  terms.sort((a, b) => (a.site ?? Infinity) - (b.site ?? Infinity))

  const modelShift = combinationMass + (freeMass ?? 0)
  return {
    sequence: String(result.sequence),
    observedShift,
    combination: typeof best.combination === 'string' ? best.combination : '',
    proforma,
    score: finite(best.score) ?? 0,
    terms,
    freeMass,
    modelShift,
    closureErrorDa,
    closureErrorPpm: observedShift !== 0 ? (closureErrorDa / observedShift) * 1e6 : null,
  }
}
