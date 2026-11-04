import { describe, expect, it } from 'vitest'
import {
  parseDelimitedTable,
  runParseRequest,
} from '@/services/documents/fileParseCore'
import { parseFile } from '@/services/documents/fileParseClient'

describe('fileParseCore', () => {
  describe('parseDelimitedTable', () => {
    it('parses CSV text into columns and rows', () => {
      const result = parseDelimitedTable('a,b\n1,2\n3,4\n', ',')
      expect(result.columns).toEqual(['a', 'b'])
      expect(result.rows).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }])
    })

    it('parses TSV text', () => {
      const result = parseDelimitedTable('a\tb\n1\t2\n', '\t')
      expect(result.columns).toEqual(['a', 'b'])
      expect(result.rows).toEqual([{ a: '1', b: '2' }])
    })

    it('rows carry exactly the header fields — no parser residue to strip', () => {
      const result = parseDelimitedTable('x,y\n1,2\n', ',')
      expect(Object.keys(result.rows[0]!)).toEqual(['x', 'y'])
    })

    it('strips a known TopPIC preamble before the header', () => {
      const text = [
        '********************** Parameters **********************',
        'Protein database file:\t\treinhardtii_histones.fasta',
        '',
        'Data file name\tPrsm ID\tSpectrum ID\tProtein accession',
        'sample.msalign\t0\t1177\ttr|Q39576|Q39576_CHLRE',
      ].join('\n')
      const result = parseDelimitedTable(text, '\t')
      expect(result.columns).toEqual(['Data file name', 'Prsm ID', 'Spectrum ID', 'Protein accession'])
      expect(result.rows).toEqual([
        {
          'Data file name': 'sample.msalign',
          'Prsm ID': '0',
          'Spectrum ID': '1177',
          'Protein accession': 'tr|Q39576|Q39576_CHLRE',
        },
      ])
    })
  })

  describe('runParseRequest', () => {
    it('parses delimited text', () => {
      const { table, spectra } = runParseRequest({ kind: 'delimited', delimiter: ',', text: 'a,b\n1,2\n' })
      expect(table!.rows).toHaveLength(1)
      expect(spectra).toBeNull()
    })

    it('decodes an ArrayBuffer so the main thread never pays the decode', () => {
      const buffer = new TextEncoder().encode('a\tb\n1\t2\n').buffer as ArrayBuffer
      const { table } = runParseRequest({ kind: 'delimited', delimiter: '\t', buffer })
      expect(table!.rows).toEqual([{ a: '1', b: '2' }])
    })

    it('parses msalign block text into spectra', () => {
      const text = 'BEGIN IONS\nSPECTRUM_ID=1\nSCANS=100\nLEVEL=2\n100.1 10.0 2\nEND IONS'
      const { table, spectra } = runParseRequest({ kind: 'msalign', text })
      expect(table).toBeNull()
      expect(spectra).toHaveLength(1)
      expect(spectra![0]).toMatchObject({ spectrumId: 1, scan: 100 })
      expect(spectra![0].peaks).toEqual([{ index: 0, mz: 100.1, intensity: 10, charge: 2, isDeconvoluted: true }])
    })
  })
})

describe('fileParseClient', () => {
  // jsdom has no Worker: parseFile must degrade to the same pure parse,
  // synchronously resolved — the graceful-fallback contract.
  it('falls back to the local pure parse when no Worker exists', async () => {
    const result = await parseFile({ kind: 'delimited', delimiter: ',', text: 'a,b\n1,2\n' })
    expect(result.table!.rows).toEqual([{ a: '1', b: '2' }])
  })

  it('resolves msalign requests through the same path', async () => {
    const result = await parseFile({ kind: 'msalign', text: 'BEGIN IONS\nSPECTRUM_ID=7\n1 1\nEND IONS' })
    expect(result.spectra![0]!.spectrumId).toBe(7)
  })
})
