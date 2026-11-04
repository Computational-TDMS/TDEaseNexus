/**
 * fileParseCore — the pure parsing jobs for large file documents
 * (delimited tables, TopFD `.msalign` spectra), factored out of the
 * components so they can run inside a Web Worker (see `fileParse.worker.ts`)
 * without any DOM or Vue dependency.
 *
 * `parseDelimitedTable` mirrors `fileIngress.parseDelimited` — including the
 * TopPIC preamble strip — but skips that function's per-row `{...row}` spread:
 * d3-dsv builds each row object from exactly the header columns, so the copy
 * duplicated every row for nothing. Rows are handed to consumers as the
 * parser produced them.
 */

import { csvParse, tsvParse } from 'd3'
import { stripLeadingPreamble } from '@/services/visualization/fileTypes'
import type { DelimitedTable } from '@/services/visualization/fileIngress'
import { parseMsAlign } from '@/services/visualization/msalign'
import type { MsAlignSpectrum } from '@/services/visualization/msalign'

export interface FileParseRequest {
  kind: 'delimited' | 'msalign'
  /** Required for `delimited`. */
  delimiter?: ',' | '\t'
  /** The text to parse — or pass `buffer` instead to decode off-thread. */
  text?: string
  buffer?: ArrayBuffer
}

export type FileParseResult =
  | { table: DelimitedTable; spectra: null }
  | { table: null; spectra: MsAlignSpectrum[] }

/** d3-dsv CSV/TSV parse into `{columns, rows}` with a TopPIC preamble strip. */
export function parseDelimitedTable(text: string, delimiter: ',' | '\t'): DelimitedTable {
  const source = stripLeadingPreamble(text, delimiter)
  const parsed = delimiter === '\t' ? tsvParse(source) : csvParse(source)
  const columns = parsed.columns.slice()
  // d3-dsv stamps its result array with a `columns` own property; drop it so
  // `rows` is a plain array (the row objects themselves carry nothing extra).
  delete (parsed as unknown as { columns?: string[] }).columns
  return { columns, rows: parsed as unknown as Record<string, string>[] }
}

/**
 * Run one parse job. `buffer` is decoded here (worker thread or fallback),
 * so the main thread never pays the text-decode cost for a large file.
 */
export function runParseRequest(request: FileParseRequest): FileParseResult {
  const text = request.text ?? (request.buffer ? new TextDecoder().decode(request.buffer) : '')
  if (request.kind === 'msalign') {
    return { table: null, spectra: parseMsAlign(text) }
  }
  const delimiter = request.delimiter ?? ','
  return { table: parseDelimitedTable(text, delimiter), spectra: null }
}
