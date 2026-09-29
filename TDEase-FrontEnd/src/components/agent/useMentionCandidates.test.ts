import { describe, expect, it } from 'vitest'
import type { MentionCandidate } from './useMentionCandidates'
import { extractRunNames, pickWorkspaceFiles, rankCandidates, scoreCandidate } from './useMentionCandidates'

function cand(kind: MentionCandidate['kind'], refId: string, label: string, detail = ''): MentionCandidate {
  return { token: { kind, refId }, label, detail, kind }
}

const ALL: MentionCandidate[] = [
  cand('run', 'run-1', 'TopPIC run'),
  cand('file', 'views/report.md', 'report.md', 'views/report.md'),
  cand('skill', 'workspace:qc', 'workspace:qc', 'QC validation skill'),
]

describe('scoreCandidate', () => {
  it('returns 0 for an empty query (everything matches)', () => {
    expect(scoreCandidate('', 'anything')).toBe(0)
  })

  it('returns null when the query is not a subsequence', () => {
    expect(scoreCandidate('xyz', 'abc')).toBeNull()
  })

  it('scores a subsequence match', () => {
    expect(scoreCandidate('tp', 'TopPIC')).not.toBeNull()
  })

  it('rewards consecutive characters with a higher score', () => {
    expect(scoreCandidate('top', 'TopPIC')).toBeGreaterThan(scoreCandidate('tp', 'TopPIC')!)
  })
})

describe('rankCandidates', () => {
  it('returns all candidates for an empty query', () => {
    expect(rankCandidates(ALL, '').map((c) => c.token.refId)).toEqual(['run-1', 'views/report.md', 'workspace:qc'])
  })

  it('filters to one kind via a kind: prefix', () => {
    const out = rankCandidates(ALL, 'run:')
    expect(out.every((c) => c.kind === 'run')).toBe(true)
    expect(out.map((c) => c.token.refId)).toContain('run-1')
  })

  it('constrains the picker as soon as a kind is typed, before the colon', () => {
    expect(rankCandidates(ALL, 'run').map((c) => c.kind)).toEqual(['run'])
  })

  it('matches by label, detail, or refId', () => {
    // 'report' appears only in detail/refId of the file candidate
    const out = rankCandidates(ALL, 'report')
    expect(out.map((c) => c.token.refId)).toEqual(['views/report.md'])
  })

  it('matches skill by its scope:name refId or bare name', () => {
    expect(rankCandidates(ALL, 'qc').map((c) => c.token.refId)).toContain('workspace:qc')
  })

  it('returns nothing for a query matching no candidate', () => {
    expect(rankCandidates(ALL, 'zzzzz')).toEqual([])
  })
})

describe('pickWorkspaceFiles', () => {
  it('keeps every user file across the workspace, not just runs/', () => {
    const all = [
      'runs/run-1/proteoform.tsv',
      'runs/run-1/results/out.tsv',
      'config/settings.json',
      'README.md',
      '.tdease/sessions/abc/snap.json',
      'src/main.ts',
    ]
    expect(pickWorkspaceFiles(all)).toEqual([
      'runs/run-1/proteoform.tsv',
      'runs/run-1/results/out.tsv',
      'config/settings.json',
      'README.md',
      'src/main.ts',
    ])
  })

  it('keeps deep nested files verbatim, input order preserved', () => {
    const all = [
      'runs/run-1/results/rev-2/proteoform.tsv',
      'runs/run-1/log.txt',
      'data/raw/sample.mzml',
      'notes.md',
    ]
    expect(pickWorkspaceFiles(all)).toEqual([
      'runs/run-1/results/rev-2/proteoform.tsv',
      'runs/run-1/log.txt',
      'data/raw/sample.mzml',
      'notes.md',
    ])
  })

  it('drops directory markers and internal dot-dirs, keeps everything else', () => {
    const all = [
      'other/prerun.tsv',
      'runs/x.tsv',
      '.git/objects/ab/cdef',
      '.tdease/snap.json',
      'src/',
    ]
    expect(pickWorkspaceFiles(all)).toEqual([
      'other/prerun.tsv',
      'runs/x.tsv',
    ])
  })
})

describe('extractRunNames', () => {
  it('pulls the run id (segment after runs/) from nested paths', () => {
    expect(extractRunNames([
      'runs/run-1/proteoform.tsv',
      'runs/run-1/results/out.tsv',
      'runs/run-2/log.txt',
    ])).toEqual(['run-1', 'run-2'])
  })

  it('de-duplicates and sorts', () => {
    expect(extractRunNames([
      'runs/beta/x',
      'runs/alpha/y',
      'runs/beta/z',
    ])).toEqual(['alpha', 'beta'])
  })

  it('ignores paths outside runs/', () => {
    expect(extractRunNames(['config/a', 'other/prerun.tsv'])).toEqual([])
  })
})
