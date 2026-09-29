import { describe, expect, it } from 'vitest'
import { resolveMsalignSource } from './artifactSource'

describe('resolveMsalignSource', () => {
  it('prefers explicit artifact ids when present', () => {
    expect(
      resolveMsalignSource({
        'MS2 Artifact ID': 'artifact-ms2-001',
        'Data file name': 'D:/TDEase/runs/run-1/sample_ms2.msalign',
      })
    ).toEqual({
      artifactId: 'artifact-ms2-001',
      filePath: 'D:/TDEase/runs/run-1/sample_ms2.msalign',
    })
  })

  it('falls back to run-owned msalign file paths for historical rows', () => {
    expect(
      resolveMsalignSource({
        'Data file name': 'D:/TDEase/projects/workspaces/test_workspace/runs/run-1/5_ms2.msalign',
      })
    ).toEqual({
      artifactId: '__by_path__',
      filePath: 'D:/TDEase/projects/workspaces/test_workspace/runs/run-1/5_ms2.msalign',
    })
  })

  it('returns null when neither artifact id nor msalign path exists', () => {
    expect(resolveMsalignSource({ 'Spectrum ID': '26' })).toBeNull()
  })
})
