/**
 * Reference data access (UniProt) as a Studio port — the typed contract
 * the registered `uniprot.get` command family calls through, with the
 * Node implementation living in `electron/agent/reference-command-port.ts`.
 * UniMod and ProFormA chemistry are reached directly through the `tdeasenexus-toolbox`
 * CLI in bash; this port deliberately owns no CLI adapter.
 *
 * Mirrors `spectra-command-port.ts`: an interface-only file in `src/`, the
 * concrete SQLite/HTTP store in Electron, and an optional field on
 * `CommandContext` so the same command definition works in both the main and
 * renderer compositions (a missing port makes the command `enabled:false`
 * rather than throwing at call time — the phantom-tool guard).
 */

// ── UniProt ────────────────────────────────────────────────────────────────

export type UniProtResource =
  | 'uniprotkb'
  | 'uniref'
  | 'uniparc'
  | 'proteomes'
  | 'taxonomy'
  /**
   * A high-level combination query, NOT a native UniProt field: seed accession
   * → UniProtKB seed → UniRef cluster mapping → cluster members → filters. The
   * result keeps clusterMembership and sequenceSimilarity distinct and never
   * claims orthology from a UniRef cluster alone.
   */
  | 'homology'

export type UniProtFormat =
  | 'json' | 'tsv' | 'fasta' | 'xml' | 'txt' | 'gff' | 'rdf' | 'normalized'

/**
 * Where a read may draw its answer from. The default is `local-first` with
 * `allowStaleOnFailure`: serve a cached entry if it is fresh enough, fall back
 * to the remote when it is not, and — if the remote is down — serve the stale
 * local copy rather than failing, because a slightly old protein record is
 * almost always more useful than none.
 */
export type SourcePolicy =
  | { mode: 'local-only' }
  | { mode: 'local-first'; maxAgeDays?: number; allowStaleOnFailure?: boolean }
  | { mode: 'remote-refresh'; allowStaleOnFailure?: boolean }
  | { mode: 'pinned'; snapshotDigest: string }

export interface UniProtGetInput {
  resource: UniProtResource
  id: string
  fields?: ReadonlyArray<string>
  format?: UniProtFormat
  sourcePolicy?: SourcePolicy
  /** Include local analyst/agent assertions and the merged effective view.
   *  Defaults to false so an authority lookup cannot leak prior analyses. */
  includeAssertions?: boolean
}

/**
 * A typed query expression for `uniprot.query`. The `all`/`any` forms build the
 * query without knowing UniProt's query syntax; `advancedQuery` is an escape
 * hatch that passes the official expression through verbatim, so a field UniProt
 * adds later is usable without a TDEase release.
 */
export interface UniProtQueryTerm {
  field: string
  eq?: string | number | boolean
  exists?: boolean
}

export interface UniProtQueryExpression {
  all?: ReadonlyArray<UniProtQueryTerm | UniProtQueryExpression>
  any?: ReadonlyArray<UniProtQueryTerm | UniProtQueryExpression>
}

export interface UniProtQueryInput {
  resource: UniProtResource
  query?: UniProtQueryExpression
  advancedQuery?: string
  fields?: ReadonlyArray<string>
  format?: UniProtFormat
  mode?: 'page' | 'stream'
  cursor?: string
  pageSize?: number
  /** Pass through UniProt's `includeIsoform` (UniProtKB search only): whether to
   *  include isoform sequences in the results. Defaults to the API default
   *  (false). */
  includeIsoform?: boolean
  sourcePolicy?: SourcePolicy
  // ── homology resource only ──
  /** The seed accession for a homology query. Required when resource="homology". */
  seed?: { accession: string }
  discovery?: {
    unirefLevels?: ReadonlyArray<100 | 90 | 50>
    reviewed?: 'prefer' | 'only'
    taxonomy?: { descendantsOf?: number }
    includeIsoforms?: boolean
  }
  validation?: {
    minIdentity?: number
    minQueryCoverage?: number
    minTargetCoverage?: number
  }
  limit?: number
}

/** A one-shot ID-mapping job: map `ids` from one database to another. */
export interface UniProtMapInput {
  from: string
  to: string
  ids: ReadonlyArray<string>
  /** How many result pages to walk before stopping; defaults to collecting all. */
  maxPages?: number
}

/**
 * BLAST of a short protein fragment against a UniProtKB database, through the
 * EBI Job Dispatcher (`ncbiblast`) — the official programmatic BLAST for UniProt
 * data. The alignment is the point: each HSP carries per-position query↔hit
 * coordinates, so a known modification site in the query can be mapped to a
 * position in a homologous protein (`querySite` → `hit_site`).
 */
export interface UniProtBlastInput {
  /** The query fragment sequence (the modification-carrying region). */
  sequence: string
  /** Target UniProt database. Default `uniprotkb_swissprot`. */
  database?: string
  /** BLAST program. Default `blastp`. */
  program?: string
  /** Scoring matrix. Default `BLOSUM62`. */
  matrix?: string
  /** E-value threshold (expect). Default `1e-4`. */
  threshold?: number
  /** NCBI taxonomy ids restricting the search (included). */
  taxids?: ReadonlyArray<string>
  /** Optional 1-based position of the modification site within `sequence`.
   *  When given, each returned alignment carries the mapped subject position. */
  querySite?: number
  /** Cap the returned hits. Default 25. */
  limit?: number
}

/** One high-scoring pair: a local alignment between query and hit. */
export interface UniProtBlastAlignment {
  queryFrom: number
  queryTo: number
  hitFrom: number
  hitTo: number
  /** Percent identity over the aligned region. */
  identity: number
  /** Percent positives (identity + conservative substitution). */
  positive: number
  gaps: number
  score: number
  bitScore: number
  evalue: number
  /** Aligned query sequence (may contain `-` gaps). */
  querySeq: string
  /** Alignment midline (match/mismatch symbols). */
  midline: string
  /** Aligned subject sequence (may contain `-` gaps). */
  hitSeq: string
  /** 1-based subject position mapped from `querySite`, when provided. */
  hitSite?: number | null
}

/** One BLAST hit: a UniProt entry with its alignments. */
export interface UniProtBlastHit {
  accession: string
  entryId: string
  description: string
  organism: string
  length: number
  alignments: ReadonlyArray<UniProtBlastAlignment>
}

/** How the read resolved — so a caller can tell a cache hit from a live fetch. */
export interface ReferenceResolution {
  localHit: boolean
  remoteQueried: boolean
  /** For set queries: whether the cached result set is complete or partial. */
  completeness?: 'complete' | 'partial' | 'unknown'
  snapshotDigest?: string
  release?: string
  freshness?: 'fresh' | 'stale' | 'unknown'
}

/** The unified result shape returned by the reference port. */
export interface ReferenceResult {
  source: ReferenceSourceProvenance
  resolution?: ReferenceResolution
  [key: string]: unknown
}

export interface ReferenceSourceProvenance {
  database?: string
  digest?: string
  version?: string
  release?: string
  retrievedAt?: string
}

export interface ReferenceCommandPort {
  uniprotGet(input: UniProtGetInput, signal?: AbortSignal): Promise<ReferenceResult>
  uniprotQuery(input: UniProtQueryInput, signal?: AbortSignal): Promise<ReferenceResult>
  uniprotMap(input: UniProtMapInput, signal?: AbortSignal): Promise<ReferenceResult>
  /** BLAST a protein fragment against UniProtKB (EBI Job Dispatcher ncbiblast). */
  uniprotBlast(input: UniProtBlastInput, signal?: AbortSignal): Promise<ReferenceResult>
  /** Record a local note about a reference entry. */
  note(input: UniProtNoteInput): Promise<ReferenceResult>
  /** Revise a note: update fields, append/replace evidence, comment, or retract. */
  revise(input: UniProtReviseInput): Promise<ReferenceResult>
}

/**
 * A local note/annotation about a reference entry. It overlays the authority
 * record on read — it NEVER overwrites it — so a scientist's evolving knowledge
 * (a hypothesis, a correction, a confirmation) travels with the entry without
 * corrupting provenance. Notes are revised over time, not re-created: use
 * `uniprot.revise` to add evidence, sharpen a value, or retract.
 */
export interface UniProtNoteInput {
  resource: UniProtResource
  id: string
  subject: string
  predicate: string
  value: string
  verdict: 'confirmed' | 'rejected' | 'supplemented'
  evidenceRefs?: ReadonlyArray<string>
  basedOnSnapshot?: string
  notedBy?: string
  comment?: string
}

/** Revise an existing note. Only the fields you set change; retract via `retracted: true`. */
export interface UniProtReviseInput {
  noteId: string
  value?: string
  verdict?: 'confirmed' | 'rejected' | 'supplemented'
  evidenceRefs?: ReadonlyArray<string>
  /** Default true: append to existing evidence. false replaces it. */
  appendEvidence?: boolean
  comment?: string
  retracted?: boolean
}

// Module-augment CommandContext so the port and its context field travel as
// one capability: a composition that supplies the port gets the field typed,
// one that does not keeps the commands disabled.
declare module '../commands/registry' {
  interface CommandContext {
    references?: ReferenceCommandPort
  }
}
