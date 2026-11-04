import { describe, expect, it } from 'vitest'
import {
  buildSequenceLines,
  fastaEntryMatches,
  fastaNeedles,
  fastaSearchEntry,
  findResidueRanges,
  parseFasta,
  splitTextMatches,
  wrapSequence,
} from './fasta'

describe('FASTA parsing', () => {
  it('parses records, descriptions, multiline sequences and comments', () => {
    const parsed = parseFasta('; generated\n>sp|P1|H4 Histone H4\nMGRGK\nGGKG\n>ref2\nACD-*\n')
    expect(parsed.records).toEqual([
      { id: 'sp|P1|H4', description: 'Histone H4', sequence: 'MGRGKGGKG' },
      { id: 'ref2', description: '', sequence: 'ACD-*' },
    ])
    expect(parsed.totalResidues).toBe(14)
    expect(parsed.invalidLineCount).toBe(0)
  })

  it('wraps sequences at a stable residue width', () => {
    expect(wrapSequence('ABCDEFGHIJ', 4)).toBe('ABCD\nEFGH\nIJ')
  })
})

describe('FASTA search', () => {
  it('keeps header whitespace for descriptions but strips it for sequences', () => {
    const needles = fastaNeedles(' Histone H4 ')
    expect(needles.header).toBe('histone h4')
    expect(needles.sequence).toBe('histoneh4')
    expect(fastaNeedles('  ').header).toBe('')
  })

  it('matches an entry by id, description or sequence', () => {
    const entry = fastaSearchEntry({ id: 'sp|P62805|H4_HUMAN', description: 'Histone H4', sequence: 'MGRGKGGK' })
    expect(fastaEntryMatches(entry, fastaNeedles('H4_HUMAN'))).toBe(true)
    expect(fastaEntryMatches(entry, fastaNeedles('histone'))).toBe(true)
    expect(fastaEntryMatches(entry, fastaNeedles('ggk'))).toBe(true)
    expect(fastaEntryMatches(entry, fastaNeedles('tubulin'))).toBe(false)
    expect(fastaEntryMatches(entry, fastaNeedles(''))).toBe(true)
  })

  it('reports non-overlapping 1-based inclusive residue ranges, capped', () => {
    expect(findResidueRanges('MGRGKGGKGGK', 'GGK')).toEqual([[6, 8], [9, 11]])
    expect(findResidueRanges('mgrgkggk', 'GGK')).toEqual([[6, 8]])
    expect(findResidueRanges('AAAAAA', 'AA', 2)).toEqual([[1, 2], [3, 4]])
    expect(findResidueRanges('MGRGK', '')).toEqual([])
  })

  it('splits text into hit/plain segments', () => {
    expect(splitTextMatches('Histone H4', 'h4')).toEqual([
      { text: 'Histone ', hit: false },
      { text: 'H4', hit: true },
    ])
    expect(splitTextMatches('Histone H4', '')).toEqual([{ text: 'Histone H4', hit: false }])
  })

  it('marks hits across wrapped lines without shifting the column layout', () => {
    const sequence = 'A'.repeat(58) + 'GGK' + 'A'.repeat(58)
    const lines = buildSequenceLines(sequence, findResidueRanges(sequence, 'ggk'), 60)
    expect(lines).toHaveLength(2)
    expect(lines[0].map((segment) => segment.text)).toEqual(['A'.repeat(58), 'GG'])
    expect(lines[0].map((segment) => segment.hit)).toEqual([false, true])
    expect(lines[1].map((segment) => segment.text)).toEqual(['K', 'A'.repeat(58)])
    expect(lines[1].map((segment) => segment.hit)).toEqual([true, false])
    expect(lines.flat().map((segment) => segment.text).join('')).toBe(sequence)
  })
})
