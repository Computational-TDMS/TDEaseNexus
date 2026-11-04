import { describe, expect, it } from 'vitest'
import {
  classifyFile,
  delimiterFor,
  extensionOf,
  formatByteSize,
  mediaMimeType,
  parseDelimited,
} from './fileIngress'

describe('fileIngress', () => {
  describe('extensionOf', () => {
    it('lower-cases a normal extension', () => {
      expect(extensionOf('results/sample/Proteoforms.TSV')).toBe('tsv')
    })

    it('returns the whole lower-cased name for an extensionless file', () => {
      expect(extensionOf('runs/run-1/Snakefile')).toBe('snakefile')
    })

    it('treats a leading dot (dotfile) as having no extension', () => {
      expect(extensionOf('.gitignore')).toBe('.gitignore')
    })
  })

  describe('classifyFile', () => {
    it('routes csv and tsv to the table viewer', () => {
      expect(classifyFile('a.csv')).toBe('table')
      expect(classifyFile('a.tsv')).toBe('table')
    })

    it('routes TopFD .feature tables to the table viewer (tab-separated)', () => {
      expect(classifyFile('runs/run-1/sample_ms1.feature')).toBe('table')
      expect(classifyFile('runs/run-1/sample_ms2.feature')).toBe('table')
    })

    it('routes TopFD .msalign deconvoluted spectra to the msalign viewer', () => {
      expect(classifyFile('runs/run-1/sample_ms1.msalign')).toBe('msalign')
      expect(classifyFile('runs/run-1/sample_ms2.msalign')).toBe('msalign')
    })

    it('routes common image extensions to the media viewer', () => {
      for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp']) {
        expect(classifyFile(`a.${ext}`)).toBe('media')
      }
    })

    it('routes source and config extensions, and a bare Snakefile, to the plain text view', () => {
      for (const ext of ['py', 'r', 'sh', 'smk', 'yaml', 'yml', 'toml', 'json', 'md', 'txt', 'log', 'ini', 'cfg']) {
        expect(classifyFile(`a.${ext}`)).toBe('text')
      }
      for (const ext of ['fasta', 'fa', 'faa', 'fna', 'fas']) expect(classifyFile(`reference.${ext}`)).toBe('text')
      expect(classifyFile('runs/run-1/Snakefile')).toBe('text')
    })

    it('classifies anything else as binary, never guessing a parser', () => {
      expect(classifyFile('spectra/scan.raw')).toBe('binary')
      expect(classifyFile('spectra/scan.mzML')).toBe('mzml')
      expect(classifyFile('table.parquet')).toBe('binary')
    })
  })

  describe('mediaMimeType', () => {
    it('maps known image extensions to a MIME type', () => {
      expect(mediaMimeType('plot.png')).toBe('image/png')
      expect(mediaMimeType('plot.jpg')).toBe('image/jpeg')
    })

    it('falls back to a generic binary type for anything unmapped', () => {
      expect(mediaMimeType('scan.raw')).toBe('application/octet-stream')
    })
  })

  describe('delimiterFor', () => {
    it('picks tab for .tsv and TopFD .feature, comma otherwise', () => {
      expect(delimiterFor('a.tsv')).toBe('\t')
      expect(delimiterFor('a.csv')).toBe(',')
      expect(delimiterFor('runs/run-1/sample_ms1.feature')).toBe('\t')
    })
  })

  describe('parseDelimited', () => {
    it('parses CSV text into columns and rows', () => {
      const result = parseDelimited('a,b\n1,2\n3,4\n', ',')
      expect(result.columns).toEqual(['a', 'b'])
      expect(result.rows).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }])
    })

    it('parses TSV text into columns and rows', () => {
      const result = parseDelimited('a\tb\n1\t2\n', '\t')
      expect(result.columns).toEqual(['a', 'b'])
      expect(result.rows).toEqual([{ a: '1', b: '2' }])
    })

    it('skips a TopPIC parameter preamble and reads the real header', () => {
      // A faithful slice of *_ms2_toppic_prsm_single.tsv: a `* Parameters *`
      // block, a summary block, then the tab-separated header + data rows.
      const text = [
        '********************** Parameters **********************',
        'Protein database file:\t\treinhardtii_histones.fasta',
        'Spectrum-level cutoff value:\t\t0.01',
        '********************** Parameters **********************',
        '',
        'Number of identified PrSMs: 1',
        '',
        'Data file name\tPrsm ID\tSpectrum ID\tProtein accession',
        'sample.msalign\t0\t1177\ttr|Q39576|Q39576_CHLRE',
        'sample.msalign\t1\t1225\ttr|Q39576|Q39576_CHLRE',
      ].join('\n')
      const result = parseDelimited(text, '\t')
      expect(result.columns).toEqual(['Data file name', 'Prsm ID', 'Spectrum ID', 'Protein accession'])
      expect(result.rows).toHaveLength(2)
      expect(result.rows[0]).toEqual({
        'Data file name': 'sample.msalign',
        'Prsm ID': '0',
        'Spectrum ID': '1177',
        'Protein accession': 'tr|Q39576|Q39576_CHLRE',
      })
    })
  })

  describe('formatByteSize', () => {
    it('formats bytes, kilobytes, megabytes and gigabytes', () => {
      expect(formatByteSize(500)).toBe('500 B')
      expect(formatByteSize(2048)).toBe('2.0 KB')
      expect(formatByteSize(5 * 1024 * 1024)).toBe('5.0 MB')
      expect(formatByteSize(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB')
    })

    it('is honest about invalid input rather than printing NaN', () => {
      expect(formatByteSize(Number.NaN)).toBe('—')
      expect(formatByteSize(-1)).toBe('—')
    })
  })
})
