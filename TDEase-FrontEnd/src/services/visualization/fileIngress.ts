/**
 * fileIngress — (file document type dispatch), reduced
 * to what this slice actually ships: a viewer-routing decision plus the one
 * bit of parsing a Run/Workspace file needs before it can reach a viewer.
 *
 * Pure, framework-free logic so `FileDocument.vue` stays a thin wiring
 * component.
 */

import { csvParse, tsvParse } from 'd3'
import {
  stripLeadingPreamble,
} from './fileTypes'

// The path/extension/MIME helpers (`extensionOf`, `baseName`, `classifyFile`,
// `mediaMimeType`, `delimiterFor`, `formatByteSize`, the `FileRenderKind`
// type, and the extension sets) now live in `./fileTypes` -- a
// dependency-free module -- and are re-exported below so this module's
// existing importers keep working unchanged. Only `parseDelimited` needs
// `d3`, so this file is the one that pays that import cost.
export type { FileRenderKind } from './fileTypes'
export {
  TABLE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  IMAGE_MIME_TYPES,
  TEXT_EXTENSIONS,
  baseName,
  extensionOf,
  classifyFile,
  mediaMimeType,
  delimiterFor,
  formatByteSize,
  stripLeadingPreamble,
} from './fileTypes'

export interface DelimitedTable {
  columns: string[]
  rows: Record<string, string>[]
}

/** `d3-dsv` parses CSV/TSV text into `{columns, rows}`. A known TopPIC preamble is trimmed first so the real header is read, not the parameter block. */
export function parseDelimited(text: string, delimiter: ',' | '\t'): DelimitedTable {
  const source = stripLeadingPreamble(text, delimiter)
  const parsed = delimiter === '\t' ? tsvParse(source) : csvParse(source)
  return {
    columns: parsed.columns.slice(),
    rows: parsed.map((row) => ({ ...row }) as Record<string, string>),
  }
}
