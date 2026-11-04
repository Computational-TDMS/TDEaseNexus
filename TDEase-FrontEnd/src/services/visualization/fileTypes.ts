/**
 * fileTypes — dependency-free path/extension/MIME helpers shared across the
 * Workspace UI.
 *
 * Split out of `fileIngress.ts` so callers that only need extension/MIME
 * logic (Vue components, tree renderers, viewSpec parsing) don't pull in
 * `d3` (imported by `fileIngress.ts` for `csvParse`/`tsvParse`). This module
 * has zero imports — safe to use from anywhere.
 *
 * `fileIngress.ts` re-exports everything here, so its existing importers
 * keep working unchanged.
 */

/**
 * `table` and `media` route through `ViewerSurface` (
 * `AgGridTable` / `MediaViewer` rows). `text` is the plain read-only
 * view this task asks for. `binary` is the honest "cannot preview" card —
 * an unknown or binary file never
 * renders its raw bytes. `msalign` is the TopFD deconvoluted-spectra text
 * format (`BEGIN IONS`/`END IONS` blocks): parseable, but not a flat table —
 * it routes to the dedicated spectrum-list viewer instead of AgGrid.
 */
export type FileRenderKind = 'table' | 'media' | 'text' | 'binary' | 'msalign' | 'mzml'

export const TABLE_EXTENSIONS = new Set([
  'csv', 'tsv',
  // TopFD feature tables (`*_ms1.feature` / `*_ms2.feature`): tab-separated,
  // one row per feature/MS2 scan, with a header line. d3 parses them like any
  // other TSV; the Feature Map target reuses the same parsed rows.
  'feature',
])

/**
 * TopFD deconvoluted-spectra files. Block text, not a table — handled by the
 * msalign viewer path rather than AgGrid.
 */
export const MSALIGN_EXTENSIONS = new Set(['msalign'])

/**
 * mzML — PSI-MO standard XML, optionally gzipped. Parsed client-side by the
 * streaming parser in `visualization/mzml.ts` and browsed through the same
 * spectrum-list viewer as msalign. Matched on the basename (not the
 * extension) because `.mzML.gz` must not fall through to the `gz` extension.
 */
export function isMzmlPath(path: string): boolean {
  return /\.mzml(\.gz)?$/i.test(baseName(path))
}

export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'])

/** Self-contained interactive documents (Plotly figures, small reports) rendered
 * by the MediaViewer as a sandboxed iframe. */
export const HTML_EXTENSIONS = new Set(['html', 'htm'])

export const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

// Source and config text a scientist opens directly from a Run's file list:
// the Snakefile, scripts it calls out to, and structured config/log output.
// CodeMirror is a later slice; this is the plain
// read-only view this task asks for instead.
export const TEXT_EXTENSIONS = new Set([
  'py', 'r', 'sh', 'smk', 'yaml', 'yml', 'toml', 'json',
  'md', 'txt', 'log', 'ini', 'cfg', 'cwl', 'fasta', 'fa', 'faa', 'fna', 'fas',
])

/** Last path segment (basename). A trailing/whole-string path with no `/` yields itself. */
export function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

/** Lower-cased extension, without the dot. An extensionless name (`Snakefile`) yields itself. */
export function extensionOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return name.toLowerCase()
  return name.slice(dot + 1).toLowerCase()
}

/** Renders bytes never being dumped: the only ways in are `table`, `media`, `msalign`, `mzml`, or a `<pre>` of decoded text. */
export function classifyFile(path: string): FileRenderKind {
  const ext = extensionOf(path)
  if (isMzmlPath(path)) return 'mzml'
  if (TABLE_EXTENSIONS.has(ext)) return 'table'
  if (IMAGE_EXTENSIONS.has(ext) || HTML_EXTENSIONS.has(ext)) return 'media'
  if (MSALIGN_EXTENSIONS.has(ext)) return 'msalign'
  if (TEXT_EXTENSIONS.has(ext) || baseName(path).toLowerCase() === 'snakefile') return 'text'
  return 'binary'
}

/** MIME type for the `media` viewer's `viewSpec.media.type` (falls back to a generic binary type). */
export function mediaMimeType(path: string): string {
  const ext = extensionOf(path)
  if (HTML_EXTENSIONS.has(ext)) return 'text/html'
  return IMAGE_MIME_TYPES[ext] ?? 'application/octet-stream'
}

export function delimiterFor(path: string): ',' | '\t' {
  // `.tsv` and TopFD `.feature` are both tab-separated; everything else routed
  // to the table viewer (`.csv`) is comma-separated.
  const ext = extensionOf(path)
  return ext === 'tsv' || ext === 'feature' ? '\t' : ','
}

/** `1.2 MB`-style formatting for the Run Document's Files/Artifacts listing. */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`
}

/**
 * Column names whose presence identifies the real header of a TopPIC table.
 * TopPIC writes a `* Parameters *` preamble (plus a summary block) above the
 * tab-separated header in `*_ms2_toppic_prsm.tsv` / `*_toppic_proteoform.tsv`,
 * so a parser that treats the first line as the header swallows a preamble
 * line and shifts every column. Names have drifted across TopPIC versions, so
 * identification is any-of, not exact.
 */
export const TOPPIC_SIGNATURE_COLUMNS = new Set([
  'Prsm ID', 'PrSM ID',
  'Spectrum ID',
  'Protein accession',
  'Proteoform', 'Proteoform ID',
])

/**
 * If the text's first non-blank line is a TopPIC preamble (`*` / `#!`), scan
 * forward for the first delimiter-separated line containing a signature column
 * and return the text from that line onward. Otherwise return the text
 * unchanged, so ordinary CSV/TSV (whose first line IS the header) and other
 * tools' output parse exactly as before.
 *
 * Pure string logic, no parsing — both delimited parsers (`fileIngress`'s d3
 * path and viewer ingress share this single source of
 * truth for preamble handling instead of duplicating the detection.
 */
export function stripLeadingPreamble(text: string, delimiter: ',' | '\t'): string {
  const lines = text.split(/\r?\n/)
  let firstNonBlank = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed) {
      firstNonBlank = trimmed
      break
    }
  }
  if (!firstNonBlank || (!firstNonBlank.startsWith('*') && !firstNonBlank.startsWith('#!'))) {
    return text
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('*') || trimmed.startsWith('#!')) continue
    if (!line.includes(delimiter)) continue
    const cells = line.split(delimiter).map((cell) => cell.trim())
    if (cells.some((cell) => TOPPIC_SIGNATURE_COLUMNS.has(cell))) {
      return lines.slice(i).join('\n')
    }
  }
  // No signature header found — preserve original behavior rather than guessing.
  return text
}
