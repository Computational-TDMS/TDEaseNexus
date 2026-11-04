/**
 * variantAlignment — the model behind the FileDocument "Variants" render
 * target for TopPIC prsm/proteoform TSVs.
 *
 * Division of truth: the TSV owns identification facts (accession, span,
 * proteoform masses, E-value); the run's FASTA owns the full-length
 * sequences — the TSV's embedded `Database protein sequence` column only
 * covers the identified First–Last span, not the whole protein. The
 * alignment itself is display-layer computation (Needleman–Wunsch against
 * the longest identified sequence, linear gap); the Rust kernel remains the
 * analysis truth and nothing here feeds back into evidence.
 */

import type { FastaDocument, FastaRecord } from '@/services/fasta'
import { splitFastaHeader } from '@/services/fasta'

// ── TSV identification facts ───────────────────────────────────────────────

export interface ProteinFacts {
  accession: string
  description: string
  firstResidue: number | null
  lastResidue: number | null
  /** Distinct observed proteoform masses, ascending. */
  proteoformMasses: number[]
  /** Aggregated prsm/proteoform rows for this accession. */
  matchCount: number
  bestEValue: number | null
  maxIntensity: number | null
  /** The TSV's `Database protein sequence` cell — the identified span only. */
  spanSequence: string
}

/**
 * Aggregates prsm-level or proteoform-level rows into per-protein facts.
 * Both layouts share the `Protein accession` column; everything else
 * degrades to `null` when a column is absent.
 */
export function aggregateProteinFacts(
  table: { columns: readonly string[]; rows: ReadonlyArray<Record<string, string>> },
): Map<string, ProteinFacts> {
  const facts = new Map<string, ProteinFacts>()
  const number = (row: Record<string, string>, column: string): number | null => {
    const raw = row[column]?.trim()
    if (!raw) return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }

  for (const row of table.rows) {
    const accession = row['Protein accession']?.trim()
    if (!accession) continue
    let entry = facts.get(accession)
    if (!entry) {
      entry = {
        accession,
        description: row['Protein description']?.trim() ?? '',
        firstResidue: null,
        lastResidue: null,
        proteoformMasses: [],
        matchCount: 0,
        bestEValue: null,
        maxIntensity: null,
        spanSequence: '',
      }
      facts.set(accession, entry)
    }
    entry.matchCount += 1
    if (!entry.description) entry.description = row['Protein description']?.trim() ?? ''

    const first = number(row, 'First residue')
    const last = number(row, 'Last residue')
    if (entry.firstResidue === null || (first !== null && first < entry.firstResidue)) entry.firstResidue = first
    if (entry.lastResidue === null || (last !== null && last > entry.lastResidue)) entry.lastResidue = last

    const mass = number(row, 'Proteoform mass')
    if (mass !== null && !entry.proteoformMasses.includes(mass)) entry.proteoformMasses.push(mass)

    const eValue = number(row, 'E-value')
    if (eValue !== null && (entry.bestEValue === null || eValue < entry.bestEValue)) entry.bestEValue = eValue

    const intensity = number(row, 'Feature intensity')
    if (intensity !== null && (entry.maxIntensity === null || intensity > entry.maxIntensity)) entry.maxIntensity = intensity

    const span = row['Database protein sequence']?.replace(/\s+/g, '') ?? ''
    if (span.length > entry.spanSequence.length) entry.spanSequence = span
  }

  for (const entry of facts.values()) entry.proteoformMasses.sort((a, b) => a - b)
  return facts
}

/** Lowercase lookup keys for an accession: the full id plus its pipe tokens. */
export function accessionKeys(raw: string): string[] {
  const value = raw.trim().toLowerCase()
  if (!value) return []
  const keys = new Set<string>([value])
  const parts = value.split('|')
  for (let index = 1; index < parts.length; index++) {
    const part = parts[index]!.trim()
    if (part) keys.add(part)
  }
  return [...keys]
}

/** `Protein database file:` line from a TopPIC output preamble, if present. */
export function extractDatabaseFileName(rawTsv: string): string | null {
  const match = /^Protein database file:\s*(\S+)\s*$/m.exec(rawTsv)
  return match ? match[1]! : null
}

// ── display-only monoisotopic mass ─────────────────────────────────────────

const RESIDUE_MONOISOTOPIC_MASS: Record<string, number> = {
  A: 71.037113805, R: 156.101111050, N: 114.042927470, D: 115.026943065,
  C: 103.009184505, E: 129.042593135, Q: 128.058577540, G: 57.021463735,
  H: 137.058911875, I: 113.084064015, L: 113.084064015, K: 128.094963050,
  M: 131.040484645, F: 147.068413945, P: 97.052763875, S: 87.032028435,
  T: 101.047678505, W: 186.079312980, Y: 163.063328575, V: 99.068413915,
}
const WATER_MONOISOTOPIC_MASS = 18.0105646863

/**
 * Unmodified monoisotopic mass of a protein sequence (residue sum + H₂O).
 * `null` for empty sequences and any ambiguous residue — the viewer makes no
 * mass claim it cannot stand behind.
 */
export function theoreticalMass(sequence: string): number | null {
  if (!sequence) return null
  let total = WATER_MONOISOTOPIC_MASS
  for (const ch of sequence) {
    const residue = RESIDUE_MONOISOTOPIC_MASS[ch.toUpperCase()]
    if (residue === undefined) return null
    total += residue
  }
  return total
}

// ── Needleman–Wunsch against a reference (linear gap) ──────────────────────

const MATCH_SCORE = 1
const MISMATCH_SCORE = -1
const GAP_SCORE = -2
/** Upper bound on one pairwise DP (reference × query cells). */
const MAX_ALIGN_CELLS = 25_000_000

const TRACE_DIAG = 0
const TRACE_UP = 1
const TRACE_LEFT = 2

function alignPair(reference: string, query: string): { referenceAligned: string; queryAligned: string } {
  const n = reference.length
  const m = query.length
  const width = m + 1
  const directions = new Uint8Array((n + 1) * width)
  let previous = new Int32Array(width)
  let current = new Int32Array(width)
  for (let j = 0; j <= m; j++) {
    previous[j] = j * GAP_SCORE
    if (j > 0) directions[j] = TRACE_LEFT
  }

  for (let i = 1; i <= n; i++) {
    current[0] = i * GAP_SCORE
    directions[i * width] = TRACE_UP
    const referenceCh = reference.charCodeAt(i - 1)
    for (let j = 1; j <= m; j++) {
      const diagonal = previous[j - 1]! + (referenceCh === query.charCodeAt(j - 1) ? MATCH_SCORE : MISMATCH_SCORE)
      const up = previous[j]! + GAP_SCORE
      const left = current[j - 1]! + GAP_SCORE
      let direction = TRACE_DIAG
      let best = diagonal
      if (up > best) {
        best = up
        direction = TRACE_UP
      }
      if (left > best) {
        best = left
        direction = TRACE_LEFT
      }
      current[j] = best
      directions[i * width + j] = direction
    }
    const swap = previous
    previous = current
    current = swap
  }

  const referenceChars: string[] = []
  const queryChars: string[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const direction = i > 0 && j > 0 ? directions[i * width + j]! : (i > 0 ? TRACE_UP : TRACE_LEFT)
    if (direction === TRACE_DIAG) {
      referenceChars.push(reference[i - 1]!)
      queryChars.push(query[j - 1]!)
      i -= 1
      j -= 1
    } else if (direction === TRACE_UP) {
      referenceChars.push(reference[i - 1]!)
      queryChars.push('-')
      i -= 1
    } else {
      referenceChars.push('-')
      queryChars.push(query[j - 1]!)
      j -= 1
    }
  }
  return {
    referenceAligned: referenceChars.reverse().join(''),
    queryAligned: queryChars.reverse().join(''),
  }
}

// ── model assembly ─────────────────────────────────────────────────────────

export type AlignedRowState = 'reference' | 'aligned' | 'span-only'

export interface AlignedVariantRow {
  accession: string
  description: string
  /** Aligned sequence with '-' gaps; spans the model's columns. */
  alignedSequence: string
  identified: boolean
  theoreticalMass: number | null
  facts: ProteinFacts | null
  state: AlignedRowState
}

export interface VariantAlignmentModel {
  referenceAccession: string
  columnCount: number
  consensus: string
  /** Per-column fraction of non-gap residues matching the consensus (0..1). */
  conservation: number[]
  rows: AlignedVariantRow[]
  /** Un-identified rows pulled in by the family filter. */
  familyCount: number
  fastaRecordCount: number
  /** Rows exceeding the DP cell budget — named, never silently dropped. */
  skipped: Array<{ accession: string; length: number }>
}

export interface BuildVariantAlignmentInput {
  fasta: FastaDocument
  facts: ReadonlyMap<string, ProteinFacts>
  /** Include un-identified FASTA records whose header contains this (case-insensitive). */
  filter?: string
}

interface Entry {
  accession: string
  description: string
  record: FastaRecord | null
  facts: ProteinFacts | null
  identified: boolean
}

export function buildVariantAlignment(input: BuildVariantAlignmentInput): VariantAlignmentModel {
  const { fasta, facts } = input
  const filterText = input.filter?.trim().toLowerCase() ?? ''

  const byKey = new Map<string, FastaRecord>()
  for (const record of fasta.records) {
    for (const key of accessionKeys(record.id)) {
      if (!byKey.has(key)) byKey.set(key, record)
    }
  }

  const entries: Entry[] = []
  const usedRecords = new Set<FastaRecord>()
  for (const entry of facts.values()) {
    let record: FastaRecord | null = null
    for (const key of accessionKeys(entry.accession)) {
      const hit = byKey.get(key)
      if (hit) {
        record = hit
        break
      }
    }
    if (record) usedRecords.add(record)
    entries.push({
      accession: entry.accession,
      description: record?.description || entry.description,
      record,
      facts: entry,
      identified: true,
    })
  }

  let familyCount = 0
  if (filterText) {
    for (const record of fasta.records) {
      if (usedRecords.has(record)) continue
      const header = `${record.id} ${record.description}`.toLowerCase()
      if (!header.includes(filterText)) continue
      usedRecords.add(record)
      familyCount += 1
      entries.push({ accession: record.id, description: record.description, record, facts: null, identified: false })
    }
  }

  const fastaRecordCount = fasta.records.length
  if (entries.length === 0) {
    return { referenceAccession: '', columnCount: 0, consensus: '', conservation: [], rows: [], familyCount, fastaRecordCount, skipped: [] }
  }

  const sequenceOf = (entry: Entry): string => entry.record?.sequence ?? entry.facts?.spanSequence ?? ''
  // The reference anchors on identified sequences; family rows only take it
  // when the table identified nothing with a usable sequence.
  let referenceEntry = entries.find((entry) => entry.identified && sequenceOf(entry).length > 0) ?? entries[0]!
  for (const entry of entries) {
    if (entry.identified !== referenceEntry.identified) continue
    if (sequenceOf(entry).length > sequenceOf(referenceEntry).length) referenceEntry = entry
  }

  const referenceSequence = sequenceOf(referenceEntry)
  const skipped: VariantAlignmentModel['skipped'] = []
  const rows: AlignedVariantRow[] = []
  const pairs: Array<{ entry: Entry; pair: { referenceAligned: string; queryAligned: string } }> = []
  for (const entry of entries) {
    if (entry === referenceEntry) continue
    const sequence = sequenceOf(entry)
    if (sequence.length * Math.max(referenceSequence.length, 1) > MAX_ALIGN_CELLS) {
      skipped.push({ accession: entry.accession, length: sequence.length })
      continue
    }
    pairs.push({ entry, pair: alignPair(referenceSequence, sequence) })
  }

  const merged = mergeReferenceAlignment(referenceSequence, pairs.map(({ pair }) => pair))
  rows.push(toRow(referenceEntry, merged.referenceRow, referenceEntry.record ? 'reference' : 'span-only'))
  pairs.forEach(({ entry }, index) => {
    rows.push(toRow(entry, merged.queryRows[index]!, entry.record ? 'aligned' : 'span-only'))
  })

  const { consensus, conservation } = buildConsensus([merged.referenceRow, ...merged.queryRows])
  return {
    referenceAccession: referenceEntry.accession,
    columnCount: merged.columnCount,
    consensus,
    conservation,
    rows,
    familyCount,
    fastaRecordCount,
    skipped,
  }
}

/**
 * Merges pairwise alignments-against-the-reference into one column space.
 * The reference's own residues define the backbone columns; query-only
 * insertions (gaps inside a pair's reference string) become shared insertion
 * slots keyed by how many reference residues precede them, so every row —
 * the reference included — spans exactly the same columns.
 */
function mergeReferenceAlignment(
  reference: string,
  pairs: Array<{ referenceAligned: string; queryAligned: string }>,
): { columnCount: number; referenceRow: string; queryRows: string[] } {
  const slotWidths = new Map<number, number>()
  const perPair = pairs.map((pair) => {
    const residues: string[] = []
    const runs = new Map<number, string[]>()
    let beforeCount = 0
    let openKey = -1
    let openList: string[] = []
    for (let index = 0; index < pair.referenceAligned.length; index++) {
      const referenceCh = pair.referenceAligned[index]!
      const queryCh = pair.queryAligned[index]!
      if (referenceCh === '-') {
        if (openKey !== beforeCount) {
          openKey = beforeCount
          openList = []
          runs.set(openKey, openList)
        }
        openList.push(queryCh)
      } else {
        residues.push(queryCh)
        beforeCount += 1
        openKey = -1
      }
    }
    for (const [key, list] of runs) slotWidths.set(key, Math.max(slotWidths.get(key) ?? 0, list.length))
    return { residues, runs }
  })

  const slotKeys = [...slotWidths.keys()].sort((a, b) => a - b)
  const buildRow = (residues: string[], runs: Map<number, string[]>): string => {
    let out = ''
    let index = 0
    for (const key of slotKeys) {
      while (index < key && index < residues.length) out += residues[index++]!
      const list = runs.get(key) ?? []
      out += list.join('') + '-'.repeat((slotWidths.get(key) ?? 0) - list.length)
    }
    while (index < residues.length) out += residues[index++]!
    return out
  }

  let columnCount = reference.length
  for (const width of slotWidths.values()) columnCount += width
  return {
    columnCount,
    referenceRow: buildRow([...reference], new Map()),
    queryRows: perPair.map(({ residues, runs }) => buildRow(residues, runs)),
  }
}

function toRow(entry: Entry, aligned: string, state: AlignedRowState): AlignedVariantRow {
  const sequence = entry.record?.sequence ?? entry.facts?.spanSequence ?? ''
  return {
    accession: entry.accession,
    description: entry.description,
    alignedSequence: aligned,
    identified: entry.identified,
    theoreticalMass: theoreticalMass(sequence),
    facts: entry.facts,
    state,
  }
}

function buildConsensus(sequences: string[]): { consensus: string; conservation: number[] } {
  if (sequences.length === 0) return { consensus: '', conservation: [] }
  const columnCount = sequences[0]!.length
  const consensusChars: string[] = []
  const conservation: number[] = []
  for (let column = 0; column < columnCount; column++) {
    const counts = new Map<string, number>()
    let total = 0
    for (const sequence of sequences) {
      const ch = sequence[column]!
      if (ch === '-') continue
      counts.set(ch, (counts.get(ch) ?? 0) + 1)
      total += 1
    }
    if (total === 0) {
      consensusChars.push('-')
      conservation.push(0)
      continue
    }
    let best: string | null = null
    let bestCount = 0
    for (const [ch, count] of counts) {
      if (count > bestCount || (count === bestCount && best !== null && ch < best)) {
        best = ch
        bestCount = count
      }
    }
    consensusChars.push(best!)
    conservation.push(bestCount / total)
  }
  return { consensus: consensusChars.join(''), conservation }
}

// ── display helpers for the viewer ─────────────────────────────────────────

export type AlignmentSegmentType = 'match' | 'mismatch' | 'gap'
export interface AlignmentSegment { text: string; type: AlignmentSegmentType }

/** Run-length-compressed display segments for columns `[start, end)` — identity needs no span. */
export function alignmentSegments(sequence: string, consensus: string, start: number, end: number): AlignmentSegment[] {
  const segments: AlignmentSegment[] = []
  for (let index = start; index < end; index++) {
    const ch = sequence[index] ?? '-'
    const type: AlignmentSegmentType = ch === '-' ? 'gap' : ch === consensus[index] ? 'match' : 'mismatch'
    const last = segments[segments.length - 1]
    if (last && last.type === type) last.text += ch
    else segments.push({ text: ch, type })
  }
  return segments
}

// ── chunked FASTA scan (workspace files beyond whole-read size) ────────────

export type ByteRangeReader = (start: number, end: number) => Promise<Uint8Array | null>

/**
 * Streams a FASTA through byte-range reads and retains only the records whose
 * header id matches `wanted` (lowercase keys from `accessionKeys`); `null`
 * retains everything. Mirrors `parseFasta` semantics — same record shape, same
 * invalid-line counting — so the two ingestion paths are interchangeable.
 */
export async function scanFastaRecords(
  read: ByteRangeReader,
  size: number,
  options: { wanted?: ReadonlySet<string>; chunkBytes?: number } = {},
): Promise<FastaDocument> {
  const wanted = options.wanted ?? null
  const chunkBytes = options.chunkBytes ?? 4 * 1024 * 1024
  const decoder = new TextDecoder('utf-8')
  const records: FastaRecord[] = []
  const index = new Map<string, FastaRecord>()
  let invalidLineCount = 0
  let current: FastaRecord | null = null
  let carry = ''

  const processLine = (rawLine: string): void => {
    const line = rawLine.trim()
    if (!line || line.startsWith(';')) return
    if (line.startsWith('>')) {
      const { id, description } = splitFastaHeader(line.slice(1).trim())
      const retain = wanted === null || accessionKeys(id).some((key) => wanted.has(key))
      if (retain) {
        current = { id, description, sequence: '' }
        records.push(current)
        for (const key of accessionKeys(id)) if (!index.has(key)) index.set(key, current)
      } else {
        // Discard sequence lines silently — they belong to a known record.
        current = { id: '', description: '', sequence: '' }
      }
      return
    }
    if (!current) {
      invalidLineCount += 1
      return
    }
    const sequence = line.replace(/\s+/g, '')
    if (!/^[A-Za-z*.-]+$/.test(sequence)) invalidLineCount += 1
    current.sequence += sequence
  }

  for (let start = 0; start < size; start += chunkBytes) {
    const bytes = await read(start, Math.min(start + chunkBytes, size))
    if (!bytes) throw new Error('FASTA_RANGE_READ_UNAVAILABLE')
    const text = carry + decoder.decode(bytes, { stream: true })
    const lines = text.split(/\r?\n/)
    carry = lines.pop() ?? ''
    for (const line of lines) processLine(line)
  }
  const tail = decoder.decode()
  for (const line of (carry + tail).split(/\r?\n/)) processLine(line)

  return {
    records,
    totalResidues: records.reduce((total, record) => total + record.sequence.length, 0),
    invalidLineCount,
  }
}

/** Lowercase FASTA lookup keys for every `Protein accession` in a facts map. */
export function wantedFastaKeys(facts: ReadonlyMap<string, ProteinFacts>): Set<string> {
  const wanted = new Set<string>()
  for (const entry of facts.values()) {
    for (const key of accessionKeys(entry.accession)) wanted.add(key)
  }
  return wanted
}
