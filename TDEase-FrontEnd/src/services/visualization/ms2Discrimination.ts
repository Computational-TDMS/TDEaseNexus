/**
 * ms2Discrimination — read model for chart-forge's candidate-discrimination
 * payload (`<stem>.data.json`, `meta.tool: chart-forge`), so the Workbench
 * renders it natively instead of the embedded HTML copy.
 *
 * The payload carries one MS2 scan's peaks and, per candidate proteoform
 * model, the isotope-envelope-matched fragments. What DISCRIMINATES the
 * models is derived here from those facts alone: an ion (type, number,
 * charge) matched under exactly one model. The optional sibling
 * `<stem>_compare.json` (the kernel's `fragment-compare` output) adds each
 * model's theoretical m/z for ions it predicted but did not observe — the
 * "not observed" ghosts. Without it the viewer simply draws no ghosts.
 */

export interface DiscriminationPeak { mz: number; i: number }
export interface DiscriminationMatch {
  ion: string
  n: number
  q: number
  cleav: number
  mz: number
  ppm: number
  i: number
}
export interface DiscriminationCandidate {
  id: string
  label: string
  color?: string
  coverage: number
  counts: Record<string, number>
  matches: DiscriminationMatch[]
  mods: Array<{ pos: number; tag: string; nTerm?: boolean }>
}
export interface DiscriminationGhost { candidateId: string; ion: string; n: number; q: number; mz: number }
export interface DiscriminationModel {
  title: string
  source?: string
  thresholds?: string
  scan: string
  activation?: string
  precursorCharge?: number
  tolerancePpm?: number
  sequence: string
  peaks: DiscriminationPeak[]
  candidates: DiscriminationCandidate[]
  /** Ions matched under exactly one model, keyed `ion:n:q`. */
  discriminating: Map<string, string>
  ghosts: DiscriminationGhost[]
}

export const ionKey = (ion: string, n: number, q: number): string => `${ion}:${n}:${q}`

/** True when a parsed JSON value is a candidate-discrimination payload. */
export function isDiscriminationPayload(value: unknown): boolean {
  const data = (value as { data?: Record<string, unknown> } | null)?.data
  return Boolean(data
    && Array.isArray(data.peaks)
    && Array.isArray(data.candidates)
    && typeof data.sequence === 'string'
    && data.candidates.length >= 1)
}

// ── Decoders ─────────────────────────────────────────────────────────────────
//
// Same rule as studioBackendGateway: no defaults, no invented fields. A record
// missing a required field is skipped, not patched with a plausible zero —
// producer-side drift must surface as a missing row, not a wrong one.

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function decodePeak(value: unknown): DiscriminationPeak | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const mz = asNumber(record.mz)
  const i = asNumber(record.i)
  return mz !== undefined && i !== undefined ? { mz, i } : null
}

function decodeMatch(value: unknown): DiscriminationMatch | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const ion = asString(record.ion)
  const n = asNumber(record.n)
  const q = asNumber(record.q)
  const cleav = asNumber(record.cleav)
  const mz = asNumber(record.mz)
  const ppm = asNumber(record.ppm)
  const i = asNumber(record.i)
  return ion !== undefined && n !== undefined && q !== undefined && cleav !== undefined
    && mz !== undefined && ppm !== undefined && i !== undefined
    ? { ion, n, q, cleav, mz, ppm, i }
    : null
}

function decodeMod(value: unknown): DiscriminationCandidate['mods'][number] | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const pos = asNumber(record.pos)
  const tag = asString(record.tag)
  if (pos === undefined || tag === undefined) return null
  return { pos, tag, nTerm: record.nTerm === true ? true : undefined }
}

function decodeCounts(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object') return {}
  const counts: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const n = asNumber(entry)
    if (n !== undefined) counts[key] = n
  }
  return counts
}

function decodeCandidate(value: unknown): DiscriminationCandidate | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = asString(record.id)
  const coverage = asNumber(record.coverage)
  if (id === undefined || coverage === undefined) return null
  return {
    id,
    label: asString(record.label) ?? id,
    color: asString(record.color),
    coverage,
    counts: decodeCounts(record.counts),
    matches: Array.isArray(record.matches)
      ? record.matches.map(decodeMatch).filter((m): m is DiscriminationMatch => m !== null)
      : [],
    mods: Array.isArray(record.mods)
      ? record.mods.map(decodeMod).filter((m): m is DiscriminationCandidate['mods'][number] => m !== null)
      : [],
  }
}

/** A ghost is a `fragmentStatuses` entry of a model that did NOT observe a
 *  discriminating ion but predicted where it would be. */
function decodeGhosts(
  compare: unknown,
  discriminating: Map<string, string>,
): DiscriminationGhost[] {
  const root = compare as { comparisons?: unknown[] } | null | undefined
  const result = (root?.comparisons?.[0] as { result?: unknown } | undefined)?.result
  if (result === null || typeof result !== 'object') return []
  const candidates = (result as Record<string, unknown>).candidates
  if (!Array.isArray(candidates)) return []
  const ghosts: DiscriminationGhost[] = []
  for (const candValue of candidates) {
    if (candValue === null || typeof candValue !== 'object') continue
    const cand = candValue as Record<string, unknown>
    const candidateId = asString(cand.candidateId)
    if (candidateId === undefined || !Array.isArray(cand.fragmentStatuses)) continue
    for (const statusValue of cand.fragmentStatuses) {
      if (statusValue === null || typeof statusValue !== 'object') continue
      const status = statusValue as Record<string, unknown>
      const ion = asString(status.ion)
      const n = asNumber(status.number)
      const q = asNumber(status.charge)
      if (ion === undefined || n === undefined || q === undefined) continue
      const key = ionKey(ion, n, q)
      const owner = discriminating.get(key)
      if (!owner || owner === candidateId || status.state === 'matched') continue
      const mz = asNumber(status.theoreticalApexMz) ?? asNumber(status.theoreticalMz)
      if (mz !== undefined) ghosts.push({ candidateId, ion, n, q, mz })
    }
  }
  return ghosts
}

export function parseDiscrimination(value: unknown, compare?: unknown): DiscriminationModel {
  if (!isDiscriminationPayload(value)) throw new Error('Not a candidate-discrimination payload')
  const root = value as { data: Record<string, unknown>; meta?: Record<string, unknown> }
  const data = root.data
  const candidates = (data.candidates as unknown[])
    .map(decodeCandidate)
    .filter((c): c is DiscriminationCandidate => c !== null)

  const matchedBy = new Map<string, Set<string>>()
  for (const c of candidates) {
    for (const m of c.matches) {
      const key = ionKey(m.ion, m.n, m.q)
      if (!matchedBy.has(key)) matchedBy.set(key, new Set())
      matchedBy.get(key)!.add(c.id)
    }
  }
  const discriminating = new Map<string, string>()
  if (candidates.length > 1) {
    for (const [key, ids] of matchedBy) if (ids.size === 1) discriminating.set(key, [...ids][0]!)
  }

  // Ghosts: for each discriminating ion, every OTHER model's predicted m/z
  // (from fragment-compare), when that model did not observe it.
  const ghosts = decodeGhosts(compare, discriminating)

  const scan = asString(data.scan) ?? ''
  const peaks = (Array.isArray(data.peaks) ? data.peaks : [])
    .map(decodePeak)
    .filter((p): p is DiscriminationPeak => p !== null)

  return {
    title: asString(root.meta?.title) ?? `MS2 scan ${scan}`,
    source: asString(root.meta?.source),
    thresholds: asString(root.meta?.thresholds),
    scan,
    activation: asString(data.activation),
    precursorCharge: asNumber(data.precursorCharge),
    tolerancePpm: asNumber(data.tol),
    sequence: asString(data.sequence) ?? '',
    peaks,
    candidates,
    discriminating,
    ghosts,
  }
}

/** Sibling `fragment-compare` output path for a `<stem>.data.json`. */
export function compareSiblingPath(path: string): string | null {
  return /\.data\.json$/i.test(path) ? path.replace(/\.data\.json$/i, '_compare.json') : null
}

/** Parse an ion label like `b2`, `y12`, `b2+1` → key parts. */
export function parseIonLabel(label: string): { ion: string; n: number; q?: number } | null {
  const match = /^([a-z])(\d+)(?:\+(\d+))?$/i.exec(label.trim())
  if (!match) return null
  return { ion: match[1]!.toLowerCase(), n: Number(match[2]), q: match[3] ? Number(match[3]) : undefined }
}

/** Residue span (1-based, inclusive) a fragment covers. */
export function ionResidues(ion: string, n: number, length: number): [number, number] {
  return ion === 'y' || ion === 'z' || ion === 'x' ? [length - n + 1, length] : [1, n]
}
