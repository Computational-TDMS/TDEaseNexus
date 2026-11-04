import { deflateSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  decodeMzmlSpectrum,
  mzmlPeakLoader,
  parseMzmlIndex,
  prepareMzmlSource,
  prepareRangeMzmlSource,
} from './mzml'
import { classifyFile } from './fileTypes'

function base64Of(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function floatBytes(values: number[], bits: 32 | 64): Uint8Array {
  const out = new Uint8Array(values.length * (bits / 8))
  const view = new DataView(out.buffer)
  values.forEach((value, i) => {
    if (bits === 64) view.setFloat64(i * 8, value, true)
    else view.setFloat32(i * 4, value, true)
  })
  return out
}

/**
 * A minimal but spec-shaped mzML: MS1 scan (64-bit, uncompressed) and MS2
 * scan (32-bit, zlib) with precursor + HCD activation metadata. Attributes
 * mzML writers actually emit (index, id, defaultArrayLength, unitAccession).
 */
function sampleMzml(): string {
  const ms1Mz = base64Of(floatBytes([100.1, 200.2, 300.3], 64))
  const ms1Int = base64Of(floatBytes([1e5, 2e5, 3e5], 64))
  const ms2Mz = base64Of(deflateSync(floatBytes([150.15, 250.25], 32)))
  const ms2Int = base64Of(deflateSync(floatBytes([900, 700], 32)))
  return `<?xml version="1.0"?>
<mzML xmlns="http://psi.hupo.org/ms/mzml">
 <run id="run1">
  <spectrumList count="2">
   <spectrum index="0" id="controllerType=0 controllerNumber=1 scan=1" defaultArrayLength="3">
    <cvParam accession="MS:1000511" name="ms level" value="1"/>
    <cvParam accession="MS:1000016" name="scan start time" value="0.5" unitAccession="UO:0000031"/>
    <binaryDataArrayList count="2">
     <binaryDataArray><cvParam accession="MS:1000523" name="64-bit float"/><cvParam accession="MS:1000514" name="m/z array"/><cvParam accession="MS:1000576" name="no compression"/><binary>${ms1Mz}</binary></binaryDataArray>
     <binaryDataArray><cvParam accession="MS:1000523" name="64-bit float"/><cvParam accession="MS:1000515" name="intensity array"/><cvParam accession="MS:1000576" name="no compression"/><binary>${ms1Int}</binary></binaryDataArray>
    </binaryDataArrayList>
   </spectrum>
   <spectrum index="1" id="controllerType=0 controllerNumber=1 scan=2" defaultArrayLength="2">
    <cvParam accession="MS:1000511" name="ms level" value="2"/>
    <cvParam accession="MS:1000016" name="scan start time" value="1.5" unitAccession="UO:0000031"/>
    <precursorList><precursor><activation><cvParam accession="MS:1002481" name="HCD"/></activation>
     <selectedIonList><selectedIon><cvParam accession="MS:1000744" name="selected ion m/z" value="502.85"/><cvParam accession="MS:1000041" name="charge state" value="2"/></selectedIon></selectedIonList>
    </precursor></precursorList>
    <binaryDataArrayList count="2">
     <binaryDataArray><cvParam accession="MS:1000521" name="32-bit float"/><cvParam accession="MS:1000514" name="m/z array"/><cvParam accession="MS:1000574" name="zlib compression"/><binary>${ms2Mz}</binary></binaryDataArray>
     <binaryDataArray><cvParam accession="MS:1000521" name="32-bit float"/><cvParam accession="MS:1000515" name="intensity array"/><cvParam accession="MS:1000574" name="zlib compression"/><binary>${ms2Int}</binary></binaryDataArray>
    </binaryDataArrayList>
   </spectrum>
  </spectrumList>
 </run>
</mzML>
`
}

async function indexOver(text: string, gzip = false) {
  const bytes = new TextEncoder().encode(text)
  const blob = new Blob([gzip ? gzipSync(bytes) : bytes])
  const source = await prepareMzmlSource(blob, gzip)
  return { source, index: await parseMzmlIndex(source) }
}

describe('mzml', () => {
  it('classifies .mzML and .mzML.gz as the mzml kind', () => {
    expect(classifyFile('raw/sample.mzML')).toBe('mzml')
    expect(classifyFile('raw/sample.mzml.gz')).toBe('mzml')
    expect(classifyFile('raw/sample.raw')).toBe('binary')
  })

  it('indexes metadata without decoding payloads (plain and gzipped)', async () => {
    for (const gzip of [false, true]) {
      const { index } = await indexOver(sampleMzml(), gzip)
      const spectra = index.spectra
      expect(spectra).toHaveLength(2)

      const [ms1, ms2] = spectra
      expect(ms1.spectrumId).toBe(1)
      expect(ms1.scan).toBe(1)
      expect(ms1.metadata.LEVEL).toBe('1')
      expect(ms1.metadata.RT).toBe('0.50')
      expect(ms1.metadata.PEAKS_COUNT).toBe('3')
      expect(ms1.peaks).toEqual([])

      expect(ms2.scan).toBe(2)
      expect(ms2.metadata.LEVEL).toBe('2')
      expect(ms2.activation).toBe('HCD')
      expect(ms2.precursorMz).toBeCloseTo(502.85, 2)
      expect(ms2.precursorCharge).toBe(2)
    }
  })

  it('decodes a selected spectrum on demand: 64-bit plain and 32-bit zlib', async () => {
    const { source, index } = await indexOver(sampleMzml())
    const spectra = index.spectra
    const loader = mzmlPeakLoader(source, spectra)

    const ms1 = await loader(spectra[0])
    expect(ms1.map(p => p.mz)).toEqual([100.1, 200.2, 300.3])
    expect(ms1.map(p => p.intensity)).toEqual([1e5, 2e5, 3e5])

    const ms2 = await decodeMzmlSpectrum(source, spectra[1], source.totalBytes)
    expect(ms2).toHaveLength(2)
    expect(ms2[0].mz).toBeCloseTo(150.15, 4)
    expect(ms2[1].intensity).toBeCloseTo(700, 1)
  })

  it('parses the embedded TIC chromatogram when present', async () => {
    const times = base64Of(floatBytes([0.5, 1.5], 64))
    const tic = base64Of(floatBytes([7e5, 9e5], 64))
    const text = `<?xml version="1.0"?><mzML><run>
<chromatogram id="TIC" index="0" defaultArrayLength="2">
<cvParam accession="MS:1000235" name="total ion current chromatogram"/>
<binaryDataArrayList count="2">
<binaryDataArray><cvParam accession="MS:1000523" name="64-bit float"/><cvParam accession="MS:1000756" name="time array" unitAccession="UO:0000031"/><cvParam accession="MS:1000576" name="no compression"/><binary>${times}</binary></binaryDataArray>
<binaryDataArray><cvParam accession="MS:1000523" name="64-bit float"/><cvParam accession="MS:1000515" name="intensity array"/><cvParam accession="MS:1000576" name="no compression"/><binary>${tic}</binary></binaryDataArray>
</binaryDataArrayList></chromatogram></run></mzML>`
    const { index } = await indexOver(text)
    expect(index.spectra).toEqual([])
    expect(index.tic).toEqual({ rtMin: [0.5, 1.5], intensity: [7e5, 9e5] })
  })

  it('returns null TIC when the file has no chromatogram', async () => {
    const { index } = await indexOver('<?xml version="1.0"?><mzML><run/></mzML>')
    expect(index.tic).toBeNull()
  })

  it('indexes and decodes through byte-range reads without a whole-file Blob', async () => {
    const bytes = new TextEncoder().encode(sampleMzml())
    const source = prepareRangeMzmlSource(bytes.byteLength, (start, end) =>
      Promise.resolve(bytes.subarray(start, end)))
    const index = await parseMzmlIndex(source)
    expect(index.spectra).toHaveLength(2)
    const loader = mzmlPeakLoader(source, index.spectra)
    const ms1 = await loader(index.spectra[0])
    expect(ms1.map(p => p.mz)).toEqual([100.1, 200.2, 300.3])
  })

  it('keeps byte offsets aligned through multi-byte UTF-8 metadata', async () => {
    // Free-text metadata (sample names, userParams) may carry multi-byte
    // UTF-8 anywhere in the document. Offsets counted in characters would
    // slice every following spectrum short by the byte difference — cutting
    // the tail of its base64 — while byte-accounted offsets stay aligned.
    const text = sampleMzml()
      .replace('<run id="run1">', '<run id="run1"><userParam name="样品名" value="小鼠肝脏QC"/>')
      .replace(
        '<cvParam accession="MS:1000511" name="ms level" value="1"/>',
        '<cvParam accession="MS:1000511" name="ms level" value="1"/><userParam name="批注" value="第二批次"/>',
      )
    const bytes = new TextEncoder().encode(text)
    expect(bytes.byteLength).toBeGreaterThan(text.length) // the precondition: non-ASCII is present
    const source = prepareRangeMzmlSource(bytes.byteLength, (start, end) =>
      Promise.resolve(bytes.subarray(start, end)))
    const index = await parseMzmlIndex(source)
    expect(index.spectra).toHaveLength(2)
    const loader = mzmlPeakLoader(source, index.spectra)
    // spectrum 1's slice ends at spectrum 2's byteOffset — misalignment lands
    // exactly here, truncating spectrum 1's intensity array.
    const ms1 = await loader(index.spectra[0])
    expect(ms1.map(p => p.mz)).toEqual([100.1, 200.2, 300.3])
    expect(ms1.map(p => p.intensity)).toEqual([1e5, 2e5, 3e5])
    const ms2 = await decodeMzmlSpectrum(source, index.spectra[1], source.totalBytes)
    expect(ms2[0].mz).toBeCloseTo(150.15, 4)
    expect(ms2[1].intensity).toBeCloseTo(700, 1)
  })

  it('refuses MS-Numpress arrays with a typed message instead of decoding garbage', async () => {
    const numpressMz = base64Of(new Uint8Array([1, 2, 3]))
    const xml = `<?xml version="1.0"?><mzML><run><spectrumList count="1">
<spectrum index="0" id="scan=1" defaultArrayLength="1">
 <binaryDataArrayList count="1"><binaryDataArray>
  <cvParam accession="MS:1000523" name="64-bit float"/><cvParam accession="MS:1000514" name="m/z array"/>
  <cvParam accession="MS:1002312" name="MS-Numpress linear prediction"/><binary>${numpressMz}</binary>
 </binaryDataArray></binaryDataArrayList></spectrum></spectrumList></run></mzML>`
    const { source, index } = await indexOver(xml)
    await expect(decodeMzmlSpectrum(source, index.spectra[0])).rejects.toThrow(/NUMPRESS/)
  })
})
