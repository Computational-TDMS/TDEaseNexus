export interface FastaRecord {
  id: string
  description: string
  sequence: string
}

export interface FastaDocument {
  records: FastaRecord[]
  totalResidues: number
  invalidLineCount: number
}

/** Splits a FASTA header into its record id (first token) and description. */
export function splitFastaHeader(header: string): { id: string; description: string } {
  const separator = header.search(/\s/)
  return {
    id: separator === -1 ? header : header.slice(0, separator),
    description: separator === -1 ? '' : header.slice(separator).trim(),
  }
}

export function parseFasta(source: string): FastaDocument {
  const records: FastaRecord[] = []
  let current: FastaRecord | null = null
  let invalidLineCount = 0

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';')) continue
    if (line.startsWith('>')) {
      const { id, description } = splitFastaHeader(line.slice(1).trim())
      current = { id, description, sequence: '' }
      records.push(current)
      continue
    }
    if (!current) {
      invalidLineCount += 1
      continue
    }
    const sequence = line.replace(/\s+/g, '')
    if (!/^[A-Za-z*.-]+$/.test(sequence)) invalidLineCount += 1
    current.sequence += sequence
  }

  return {
    records,
    totalResidues: records.reduce((total, record) => total + record.sequence.length, 0),
    invalidLineCount,
  }
}

export function wrapSequence(sequence: string, width = 60): string {
  const lines: string[] = []
  for (let index = 0; index < sequence.length; index += width) lines.push(sequence.slice(index, index + width))
  return lines.join('\n')
}

export interface FastaNeedles {
  /** Lowercased query for id/description matching, whitespace preserved. */
  header: string
  /** Lowercased query with all whitespace removed, so a fragment pasted
   *  from a wrapped display still finds its sequence. */
  sequence: string
}

export interface FastaSearchEntry {
  header: string
  sequence: string
}

export interface TextSegment {
  text: string
  hit: boolean
}

export function fastaNeedles(query: string): FastaNeedles {
  return {
    header: query.trim().toLowerCase(),
    sequence: query.replace(/\s+/g, '').toLowerCase(),
  }
}

export function fastaSearchEntry(record: FastaRecord): FastaSearchEntry {
  return {
    header: `${record.id}\n${record.description}`.toLowerCase(),
    sequence: record.sequence.toLowerCase(),
  }
}

export function fastaEntryMatches(entry: FastaSearchEntry, needles: FastaNeedles): boolean {
  if (!needles.header) return true
  return entry.header.includes(needles.header)
    || (needles.sequence !== '' && entry.sequence.includes(needles.sequence))
}

/** Non-overlapping 1-based inclusive residue ranges where `needle` occurs
 *  (case-insensitive), capped at `maxRanges`. */
export function findResidueRanges(sequence: string, needle: string, maxRanges = 100): Array<[number, number]> {
  const probe = needle.trim().toLowerCase()
  if (!probe) return []
  const haystack = sequence.toLowerCase()
  const ranges: Array<[number, number]> = []
  let from = 0
  while (ranges.length < maxRanges) {
    const at = haystack.indexOf(probe, from)
    if (at === -1) break
    ranges.push([at + 1, at + probe.length])
    from = at + probe.length
  }
  return ranges
}

/** Splits text into plain/hit segments for case-insensitive highlighting. */
export function splitTextMatches(text: string, needle: string): TextSegment[] {
  const probe = needle.trim().toLowerCase()
  if (!probe) return [{ text, hit: false }]
  const segments: TextSegment[] = []
  const haystack = text.toLowerCase()
  let cursor = 0
  while (cursor < text.length) {
    const at = haystack.indexOf(probe, cursor)
    if (at === -1) {
      segments.push({ text: text.slice(cursor), hit: false })
      break
    }
    if (at > cursor) segments.push({ text: text.slice(cursor, at), hit: false })
    segments.push({ text: text.slice(at, at + probe.length), hit: true })
    cursor = at + probe.length
  }
  return segments
}

/** Wraps the sequence into fixed-width lines and marks hits per line, so the
 *  60-column layout (row r = residues r*width+1 .. (r+1)*width) survives
 *  highlighting and row positions stay readable. */
export function buildSequenceLines(sequence: string, ranges: Array<[number, number]>, width = 60): TextSegment[][] {
  const lines = wrapSequence(sequence, width).split('\n')
  const hit = new Uint8Array(sequence.length)
  for (const [start, end] of ranges) hit.fill(1, start - 1, end)
  const result: TextSegment[][] = []
  let offset = 0
  for (const line of lines) {
    const segments: TextSegment[] = []
    let cursor = 0
    while (cursor < line.length) {
      const flag = hit[offset + cursor]
      let end = cursor + 1
      while (end < line.length && hit[offset + end] === flag) end += 1
      segments.push({ text: line.slice(cursor, end), hit: flag === 1 })
      cursor = end
    }
    result.push(segments)
    offset += line.length
  }
  return result
}
