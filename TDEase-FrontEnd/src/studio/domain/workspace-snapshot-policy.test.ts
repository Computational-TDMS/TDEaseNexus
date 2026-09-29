import { describe, expect, it } from 'vitest'
import { isSubmissionPathIncluded, SUBMISSION_EXCLUDED_PATHS } from './workspace-snapshot-policy'

describe('submission snapshot policy', () => {
  it('matches the canonical FILE-LAYOUT exclusion contract', () => {
    expect(SUBMISSION_EXCLUDED_PATHS).toEqual([
      '.git/', '.venv/', '.tdease/events.jsonl', '.tdease/sessions/',
      'results/', 'views/assets/',
      'evidence/', 'analysis/', 'runs/*/analysis/', 'runs/*/evidence/',
      'node_modules/', '.snakemake/', '.tdease-runtime/',
    ])
    for (const path of [
      '.git/config', '.venv/pyvenv.cfg', '.tdease/events.jsonl',
      '.tdease/sessions/s1/events.jsonl', 'results/a.tsv',
      'views/assets/a.png', 'evidence/claim.json', 'node_modules/x/index.js',
      '.snakemake/metadata/x', '.tdease-runtime/state.json',
    ]) expect(isSubmissionPathIncluded(path), path).toBe(false)
  })

  it('excludes run analysis and evidence subtrees without hiding Run data', () => {
    for (const path of [
      'runs/r1/analysis/h4-ms1/observed.json',
      'runs/r1/analysis/h4-ms1/figure.svg',
      'runs/r1/evidence/2026-08-01-claim.json',
      'analysis/h4-ms1/observed.json',
      'analysis/unknown-peak/figure.svg',
    ]) expect(isSubmissionPathIncluded(path), path).toBe(false)
    for (const path of [
      'runs/r1/returned.mzML', 'runs/r1/returned.csv', 'runs/r1/sample.raw',
      'runs/r1/Snakefile', 'runs/r1/config.yaml',
    ]) expect(isSubmissionPathIncluded(path), path).toBe(true)
  })

  it('keeps Workspace identity, settings and permissions in the frozen tree', () => {
    for (const path of [
      '.tdease/workspace.json', '.tdease/settings.json', '.tdease/permissions.json',
      '.tdease/skills/workflow/SKILL.md', 'Snakefile', 'scripts/analysis.py',
    ]) expect(isSubmissionPathIncluded(path), path).toBe(true)
  })
})
