import { describe, expect, it } from 'vitest'
import { asRelativePath, asRunId, asWorkspaceId } from '../domain/identity'
import { defaultDocumentSubview } from './document-projection'

describe('document projection', () => {
  it('assigns stable defaults by document kind', () => {
    expect(defaultDocumentSubview({ kind: 'run', runId: asRunId('run-1') })).toBe('overview')
    expect(defaultDocumentSubview({ kind: 'file', workspaceId: asWorkspaceId('ws'), path: asRelativePath('Snakefile') })).toBe('editor')
  })
})
