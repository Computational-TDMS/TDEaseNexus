import type { SpectrumPeak } from '@/composables/ms2-sequence'
import type { MsAlignSpectrum } from './msalign'

/**
 * mzML — pure-frontend streaming parser, the mzML sibling of `msalign.ts`.
 *
 * An mzML file is XML: one `<spectrum>` element per scan, each carrying its
 * metadata as `<cvParam>` accessions and its peaks as base64-encoded binary
 * arrays (32/64-bit floats, optionally zlib-compressed), plus a `<chromatogram>`
 * block whose TIC trace backs the overview track. Files run from tens of
 * megabytes to gigabytes, so nothing here materializes the whole document:
 *
 *   pass 1 (`parseMzmlIndex`) streams the source once, records each
 *          spectrum's byte offset + metadata and the TIC chromatogram's byte
 *          range, skipping the `<binary>` payloads — the index of a 1 GB file
 *          costs a scan, not a DOM.
 *   pass 2 (`decodeMzmlSpectrum`) slices out the one spectrum the user
 *          selected and decodes just its two arrays. Same for the TIC.
 *
 * The bytes come either from a Blob (Run files, tests) or from range reads
 * over IPC (`prepareRangeMzmlSource`) — the workspace path never holds a
 * multi-GB file whole in the renderer.
 *
 * MSnumpress-compressed arrays (MS:1002312/2313/2314 and the +zlib variants)
 * are detected and rejected with a typed message — there is no maintained JS
 * decoder for them, and honest refusal beats silent garbage. Uncompressed and
 * zlib files (the msconvert/OpenMS defaults) are fully supported.
 */

/** HUPO-PSI cvParam accessions this parser reads. Everything else is ignored. */
const ACCESSION = {
  msLevel: 'MS:1000511',
  scanStartTime: 'MS:1000016',
  selectedIonMz: 'MS:1000744',
  chargeState: 'MS:1000041',
  mzArray: 'MS:1000514',
  intensityArray: 'MS:1000515',
  timeArray: 'MS:1000756',
  ticChromatogram: 'MS:1000235',
  float32: 'MS:1000521',
  float64: 'MS:1000523',
  zlib: 'MS:1000574',
  numpressLinear: 'MS:1002312',
  numpressPic: 'MS:1002313',
  numpressSlof: 'MS:1002314',
  numpressLinearZlib: 'MS:1002746',
  numpressPicZlib: 'MS:1002747',
  numpressSlofZlib: 'MS:1002748',
} as const

const NUMPRESS_ACCESSIONS = new Set<string>([
  ACCESSION.numpressLinear, ACCESSION.numpressPic, ACCESSION.numpressSlof,
  ACCESSION.numpressLinearZlib, ACCESSION.numpressPicZlib, ACCESSION.numpressSlofZlib,
])

/** Short display names for the common dissociation methods. */
const ACTIVATION_NAMES: Record<string, string> = {
  'MS:1000044': 'CID',
  'MS:1002481': 'HCD',
  'MS:1000250': 'ETD',
  'MS:1000255': 'ECD',
}

/** mzML retention times are minutes (UO:0000031) unless stated in seconds. */
const UNIT_SECOND = 'UO:0000010'

/**
 * Index entry for one `<spectrum>` — an `MsAlignSpectrum` so existing
 * spectrum-list components can render it without knowing the format,
 * extended with the byte range the decode pass needs. `peaks` stays empty
 * until decoded.
 */
export interface MzmlSpectrum extends MsAlignSpectrum {
  /** Byte offset of the `<spectrum` tag within the source. */
  byteOffset: number
  /** `defaultArrayLength` — the peak count without decoding anything. */
  defaultArrayLength: number
}

/** The TIC chromatogram trace, for the overview track. */
export interface MzmlTic {
  rtMin: number[]
  intensity: number[]
}

export interface MzmlIndex {
  spectra: MzmlSpectrum[]
  tic: MzmlTic | null
}

/**
 * A random-access view over the bytes. Slicing returns the XML text of that
 * byte range; streaming feeds the index pass chunk by chunk.
 */
export interface MzmlSource {
  totalBytes: number
  slice: (start: number, end: number) => Promise<string>
  stream: () => ReadableStream<Uint8Array>
}

/** One-shot ReadableStream over an in-memory buffer. */
function oneShotStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

export async function prepareMzmlSource(blob: Blob, gzip: boolean): Promise<MzmlSource> {
  if (gzip) {
    // Inflate streams straight off the blob — the compressed bytes are never
    // duplicated into a second full-size buffer on top of the inflated
    // result, which halves the peak footprint of the gz path.
    const compressed = typeof blob.stream === 'function'
      ? blob.stream()
      : oneShotStream(new Uint8Array(await blob.arrayBuffer()))
    const inflated = await new Response(
      compressed.pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer()
    blob = new Blob([inflated])
  }
  if (typeof blob.stream === 'function') {
    const streamable = blob
    return {
      totalBytes: streamable.size,
      slice: (start, end) => streamable.slice(start, end).text(),
      stream: () => streamable.stream() as unknown as ReadableStream<Uint8Array>,
    }
  }
  // Fallback for environments whose Blob cannot stream (e.g. jsdom): load the
  // bytes once and slice from memory. Same results, only the large-file
  // memory profile differs.
  const whole = new Uint8Array(await blob.arrayBuffer())
  const decoder = new TextDecoder()
  return {
    totalBytes: whole.byteLength,
    slice: async (start, end) => decoder.decode(whole.subarray(start, end)),
    stream: () => oneShotStream(whole),
  }
}

const RANGE_CHUNK_BYTES = 4 * 1024 * 1024

/**
 * Build a source from byte-range reads (the workspace IPC path). The stream
 * pulls fixed-size chunks sequentially, so indexing a huge file costs one
 * chunk of memory at a time.
 */
export function prepareRangeMzmlSource(
  totalBytes: number,
  read: (start: number, end: number) => Promise<Uint8Array | null>,
): MzmlSource {
  const decoder = new TextDecoder()
  return {
    totalBytes,
    slice: async (start, end) => {
      const bytes = await read(start, end)
      if (!bytes) throw new Error('MZML_RANGE_READ_UNAVAILABLE: the workspace adapter cannot range-read this file')
      return decoder.decode(bytes)
    },
    stream: () => {
      let position = 0
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (position >= totalBytes) {
            controller.close()
            return
          }
          const end = Math.min(position + RANGE_CHUNK_BYTES, totalBytes)
          const bytes = await read(position, end)
          if (!bytes) {
            controller.error(new Error('MZML_RANGE_READ_UNAVAILABLE: the workspace adapter cannot range-read this file'))
            return
          }
          position += bytes.byteLength
          controller.enqueue(bytes)
          if (bytes.byteLength === 0 || position >= totalBytes) controller.close()
        },
      })
    },
  }
}

/** Pull one attribute out of a raw tag string. */
function attrOf(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag)
  return match ? match[1] : undefined
}

/**
 * Feed every complete tag to `onTag` with its UTF-8 byte offset in the
 * stream.
 *
 * Offsets must be BYTES — pass 2 slices by byte (`Blob.slice`, range reads),
 * not by char. Tags and inter-tag payloads are ASCII (base64, nativeIDs,
 * cvParam values), where the two coincide, but free-text metadata (sample
 * names, userParams) may carry multi-byte UTF-8 anywhere in the document, so
 * every segment that flows past is measured with `utf8ByteLength` — the
 * fast path skips the encoder for pure-ASCII segments. Chunks are decoded
 * with a streaming TextDecoder (`ignoreBOM`) so UTF-8 sequences split across
 * chunks survive and a BOM, if present, stays counted in the offsets; a
 * partial tag at the buffer end is carried into the next chunk.
 */
const utf8Encoder = new TextEncoder()

/** Byte length of a string; the ASCII fast path avoids the encode copy. */
function utf8ByteLength(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) return utf8Encoder.encode(text).length
  }
  return text.length
}

async function scanTags(
  stream: ReadableStream<Uint8Array>,
  onTag: (tag: string, offset: number) => void,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  let buffer = ''
  let consumed = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const lt = buffer.indexOf('<')
        if (lt < 0) {
          consumed += utf8ByteLength(buffer)
          buffer = ''
          break
        }
        if (lt > 0) {
          consumed += utf8ByteLength(buffer.slice(0, lt))
          buffer = buffer.slice(lt)
        }
        const gt = buffer.indexOf('>')
        if (gt < 0) break // partial tag — wait for the next chunk
        const tag = buffer.slice(0, gt + 1)
        buffer = buffer.slice(gt + 1)
        const tagBytes = utf8ByteLength(tag)
        onTag(tag, consumed)
        consumed += tagBytes
      }
    }
    buffer += decoder.decode()
    // A trailing tag without '>' is malformed; nothing to recover from it.
  } finally {
    reader.releaseLock()
  }
}

/** Element name of a raw tag — `spectrum` for `<spectrum …>` / `</spectrum>`. */
function tagName(tag: string): string {
  const match = /^<\/?([A-Za-z0-9_.:-]+)/.exec(tag)
  return match ? match[1] : ''
}

/** Extract the scan number from a nativeID (`controller…scan=5` or a bare number). */
function scanFromId(id: string): number | undefined {
  const explicit = /scan=(\d+)/i.exec(id)
  if (explicit) return Number(explicit[1])
  if (/^\d+$/.test(id)) return Number(id)
  return undefined
}

/**
 * Pass 1 — build the spectrum index and locate the TIC chromatogram. Streams
 * the whole source once and keeps only scalar metadata; the `<binary>`
 * payloads flow past untouched.
 */
export async function parseMzmlIndex(source: MzmlSource): Promise<MzmlIndex> {
  const spectra: MzmlSpectrum[] = []
  interface Draft {
    offset: number
    id: string
    indexAttr: number | null
    defaultArrayLength: number
    msLevel?: number
    rtMin?: number
    precursorMz?: number
    precursorCharge?: number
    activation?: string
    inActivation: boolean
  }
  let draft: Draft | null = null
  let chromatogramOffset: number | null = null
  let chromatogramEnd: number | null = null

  await scanTags(source.stream(), (tag, offset) => {
    const name = tagName(tag)
    if (name === 'spectrum' && !tag.startsWith('</')) {
      draft = {
        offset,
        id: attrOf(tag, 'id') ?? '',
        indexAttr: Number(attrOf(tag, 'index')),
        defaultArrayLength: Number(attrOf(tag, 'defaultArrayLength')) || 0,
        inActivation: false,
      }
      return
    }
    if (name === 'chromatogram' && !tag.startsWith('</')) {
      chromatogramOffset = offset
      return
    }
    if (name === 'chromatogram' && tag.startsWith('</')) {
      chromatogramEnd = offset + tag.length
      return
    }
    if (!draft) return
    if (name === 'activation') {
      draft.inActivation = !tag.startsWith('</')
      return
    }
    if (name === 'cvParam' && !tag.startsWith('</')) {
      const accession = attrOf(tag, 'accession')
      if (!accession) return
      const value = attrOf(tag, 'value')
      if (accession === ACCESSION.msLevel && value !== undefined) {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) draft.msLevel = parsed
      } else if (accession === ACCESSION.scanStartTime && value !== undefined) {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) {
          draft.rtMin = attrOf(tag, 'unitAccession') === UNIT_SECOND ? parsed / 60 : parsed
        }
      } else if (accession === ACCESSION.selectedIonMz && value !== undefined) {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) draft.precursorMz = parsed
      } else if (accession === ACCESSION.chargeState && value !== undefined) {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) draft.precursorCharge = parsed
      } else if (draft.inActivation && ACTIVATION_NAMES[accession]) {
        draft.activation = ACTIVATION_NAMES[accession]
      }
      return
    }
    if (name === 'spectrum' && tag.startsWith('</')) {
      const d = draft
      draft = null
      // Reuse the viewer's metadata bag (LEVEL/RT/PEAKS_COUNT) so list-style
      // components need no mzML-specific branches.
      const metadata: Record<string, string> = {}
      if (d.msLevel !== undefined) metadata.LEVEL = String(d.msLevel)
      if (d.rtMin !== undefined) metadata.RT = d.rtMin.toFixed(2)
      if (d.defaultArrayLength > 0) metadata.PEAKS_COUNT = String(d.defaultArrayLength)
      spectra.push({
        // mzML's `index` attribute is 0-based; viewers key selections by a
        // 1-based id like TopFD's SPECTRUM_ID.
        spectrumId: d.indexAttr !== null ? d.indexAttr + 1 : spectra.length + 1,
        scan: scanFromId(d.id),
        activation: d.activation,
        precursorMz: d.precursorMz,
        precursorCharge: d.precursorCharge,
        peaks: [],
        metadata,
        byteOffset: d.offset,
        defaultArrayLength: d.defaultArrayLength,
      })
    }
  })

  const tic = chromatogramOffset !== null && chromatogramEnd !== null
    ? await decodeTicChromatogram(source, chromatogramOffset, chromatogramEnd)
    : null
  return { spectra, tic }
}

function base64ToBytes(text: string): Uint8Array {
  const bin = atob(text.replace(/\s+/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const buffer = await new Response(
    oneShotStream(bytes).pipeThrough(new DecompressionStream('deflate')),
  ).arrayBuffer()
  return new Uint8Array(buffer)
}

function toFloats(bytes: Uint8Array, bits: 32 | 64): Float64Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const step = bits / 8
  const out = new Float64Array(Math.floor(bytes.byteLength / step))
  for (let i = 0; i < out.length; i++) {
    out[i] = bits === 64 ? view.getFloat64(i * step, true) : view.getFloat32(i * step, true)
  }
  return out
}

interface DecodedArrays {
  mz?: Float64Array
  intensity?: Float64Array
  time?: Float64Array
  timeUnitSeconds?: boolean
}

/**
 * Decode the `<binaryDataArrayList>` of one XML block (a `<spectrum>` or
 * `<chromatogram>`). Each `<binaryDataArray>` names its role (m/z /
 * intensity / time) and its encoding (precision, compression) via cvParams.
 */
async function decodeArraysFromBlock(block: string): Promise<DecodedArrays> {
  const out: DecodedArrays = {}
  for (const rawChunk of block.split('<binaryDataArray').slice(1)) {
    const chunk = rawChunk.slice(0, rawChunk.indexOf('</binaryDataArray>') + 1)
    const accessions = new Set<string>()
    for (const match of chunk.matchAll(/accession\s*=\s*"([^"]+)"/g)) accessions.add(match[1])
    const binary = /<binary[^>]*>([^<]*)<\/binary>/.exec(chunk)?.[1] ?? ''
    const trimmed = binary.replace(/\s+/g, '')
    if (!trimmed) continue
    if ([...accessions].some(a => NUMPRESS_ACCESSIONS.has(a))) {
      throw new Error(
        'MZML_NUMPRESS_UNSUPPORTED: this block uses MS-Numpress compression, which has no supported decoder here. '
        + 'Re-convert the file without numpress (msconvert: --no-numpress / OpenMS: omit numpress flags).',
      )
    }
    const isMz = accessions.has(ACCESSION.mzArray)
    const isIntensity = accessions.has(ACCESSION.intensityArray)
    const isTime = accessions.has(ACCESSION.timeArray)
    if (!isMz && !isIntensity && !isTime) continue
    let bytes = base64ToBytes(trimmed)
    if (accessions.has(ACCESSION.zlib)) bytes = await inflate(bytes)
    const floats = toFloats(bytes, accessions.has(ACCESSION.float64) ? 64 : 32)
    if (isMz) out.mz = floats
    else if (isTime) {
      out.time = floats
      out.timeUnitSeconds = /accession\s*=\s*"MS:1000756"[^>]*unitAccession\s*=\s*"UO:0000010"/.test(chunk)
    } else out.intensity = floats
  }
  return out
}

/**
 * Pass 2 — decode one spectrum's peak arrays from its byte range. `end` is
 * the next spectrum's offset (or the end of file); callers get it from the
 * sorted index, keeping this function free of index bookkeeping.
 */
export async function decodeMzmlSpectrum(
  source: MzmlSource,
  spectrum: MzmlSpectrum,
  end?: number,
): Promise<SpectrumPeak[]> {
  const xml = await source.slice(spectrum.byteOffset, end ?? source.totalBytes)
  const terminator = xml.indexOf('</spectrum>')
  const body = terminator < 0 ? xml : xml.slice(0, terminator)
  const { mz, intensity } = await decodeArraysFromBlock(body)
  if (!mz || !intensity) {
    throw new Error('MZML_SPECTRUM_DECODE_FAILED: the spectrum block carries no decodable m/z + intensity array pair')
  }
  const count = Math.min(mz.length, intensity.length)
  const peaks: SpectrumPeak[] = new Array(count)
  for (let i = 0; i < count; i++) {
    peaks[i] = { index: i, mz: mz[i], intensity: intensity[i] }
  }
  return peaks
}

/** Decode the embedded TIC chromatogram from its byte range. */
async function decodeTicChromatogram(
  source: MzmlSource,
  start: number,
  end: number,
): Promise<MzmlTic | null> {
  const xml = await source.slice(start, end)
  if (!/accession\s*=\s*"MS:1000235"/.test(xml)) return null
  const { time, intensity, timeUnitSeconds } = await decodeArraysFromBlock(xml)
  if (!time || !intensity) return null
  const count = Math.min(time.length, intensity.length)
  const rtMin: number[] = new Array(count)
  const values: number[] = new Array(count)
  for (let i = 0; i < count; i++) {
    rtMin[i] = timeUnitSeconds ? time[i] / 60 : time[i]
    values[i] = intensity[i]
  }
  return { rtMin, intensity: values }
}

/**
 * The peak loader the document viewer consumes: binds the source and the
 * sorted index so a selection decodes exactly one spectrum's byte range.
 */
export function mzmlPeakLoader(
  source: MzmlSource,
  spectra: readonly MzmlSpectrum[],
): (spectrum: MsAlignSpectrum) => Promise<SpectrumPeak[]> {
  return async (spectrum) => {
    const position = spectra.findIndex(entry => entry.spectrumId === spectrum.spectrumId)
    if (position < 0) throw new Error('MZML_SPECTRUM_NOT_INDEXED: no byte range is known for this spectrum')
    return decodeMzmlSpectrum(source, spectra[position], spectra[position + 1]?.byteOffset)
  }
}
