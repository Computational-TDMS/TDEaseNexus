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
    && (data.candidates as unknown[]).length >= 1)
}

export function parseDiscrimination(value: unknown, compare?: unknown): DiscriminationModel {
  if (!isDiscriminationPayload(value)) throw new Error('Not a candidate-discrimination payload')
  const root = value as { data: Record<string, any>; meta?: Record<string, any> }
  const data = root.data
  const candidates: DiscriminationCandidate[] = (data.candidates as any[]).map((c) => ({
    id: String(c.id),
    label: String(c.label ?? c.id),
    color: typeof c.color === 'string' ? c.color : undefined,
    coverage: Number(c.coverage) || 0,
    counts: c.counts && typeof c.counts === 'object' ? c.counts : {},
    matches: Array.isArray(c.matches) ? c.matches.map((m: any) => ({
      ion: String(m.ion), n: Number(m.n), q: Number(m.q), cleav: Number(m.cleav),
      mz: Number(m.mz), ppm: Number(m.ppm), i: Number(m.i),
    })) : [],
    mods: Array.isArray(c.mods) ? c.mods.map((m: any) => ({ pos: Number(m.pos), tag: String(m.tag), nTerm: Boolean(m.nTerm) })) : [],
  }))

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
  const ghosts: DiscriminationGhost[] = []
  const comparison = (compare as any)?.comparisons?.[0]?.result
  if (comparison && Array.isArray(comparison.candidates)) {
    for (const cand of comparison.candidates as any[]) {
      for (const f of (cand.fragmentStatuses ?? []) as any[]) {
        const key = ionKey(String(f.ion), Number(f.number), Number(f.charge))
        const owner = discriminating.get(key)
        if (!owner || owner === cand.candidateId || f.state === 'matched') continue
        const mz = Number(f.theoreticalApexMz ?? f.theoreticalMz)
        if (Number.isFinite(mz)) ghosts.push({ candidateId: String(cand.candidateId), ion: String(f.ion), n: Number(f.number), q: Number(f.charge), mz })
      }
    }
  }

  return {
    title: String(root.meta?.title ?? `MS2 scan ${data.scan}`),
    source: root.meta?.source,
    thresholds: root.meta?.thresholds,
    scan: String(data.scan ?? ''),
    activation: data.activation,
    precursorCharge: typeof data.precursorCharge === 'number' ? data.precursorCharge : undefined,
    tolerancePpm: typeof data.tol === 'number' ? data.tol : undefined,
    sequence: data.sequence,
    peaks: (data.peaks as any[]).map((p) => ({ mz: Number(p.mz), i: Number(p.i) })).filter((p) => Number.isFinite(p.mz)),
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
