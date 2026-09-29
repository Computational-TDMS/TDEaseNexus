import { describe, expect, it } from 'vitest'
import { stripLeadingPreamble } from './fileTypes'

describe('stripLeadingPreamble', () => {
  it('returns the text unchanged when the first line is already a header', () => {
    const text = 'a\tb\n1\t2\n'
    expect(stripLeadingPreamble(text, '\t')).toBe(text)
  })

  it('returns ordinary CSV text unchanged (comma, first line is header)', () => {
    const text = 'a,b\n1,2\n'
    expect(stripLeadingPreamble(text, ',')).toBe(text)
  })

  it('returns text unchanged when the first line is a non-comment data row', () => {
    const text = 'no delimiter here\nPrsm ID\t1\n'
    expect(stripLeadingPreamble(text, '\t')).toBe(text)
  })

  it('skips a TopPIC `* Parameters *` block up to the real header', () => {
    const text = [
      '********************** Parameters **********************',
      'Protein database file:\t\treinhardtii_histones.fasta',
      '********************** Parameters **********************',
      '',
      'Number of identified PrSMs: 1',
      '',
      'Data file name\tPrsm ID\tSpectrum ID',
      'sample.msalign\t0\t1177',
    ].join('\n')
    const stripped = stripLeadingPreamble(text, '\t')
    expect(stripped.split(/\r?\n/)[0]).toBe('Data file name\tPrsm ID\tSpectrum ID')
  })

  it('leaves the text unchanged when a preamble has no signature header', () => {
    // Starts with `*` (looks like a preamble) but never names a TopPIC column —
    // do not guess, preserve the original so a wrong parser change can't help.
    const text = '*** some other tool ***\nx\ty\n1\t2\n'
    expect(stripLeadingPreamble(text, '\t')).toBe(text)
  })
})
