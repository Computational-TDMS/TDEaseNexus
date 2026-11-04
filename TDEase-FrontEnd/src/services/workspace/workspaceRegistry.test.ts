import { describe, expect, it } from 'vitest'
import { workspaceDisplayName } from './workspaceRegistry'

/**
 * The display helper exists because a previous `setWorkspace` bug wrote the
 * full path as both `workspace_id` and `name`, and those stale entries still
 * sit in users' registries. The selection UI must never show a full path
 * regardless of how a bad name got in — these cases pin that contract.
 */
describe('workspaceDisplayName', () => {
  it('returns the registry name when it is a plain label', () => {
    expect(workspaceDisplayName({ name: 'My Study', local_path: 'C:/studies/x' })).toBe('My Study')
  })

  it('falls back to the basename when the name is an absolute path (the stale-entry case)', () => {
    expect(
      workspaceDisplayName({
        name: 'C:\\Users\\ray\\Desktop\\TDEase-nexus\\data\\workspace',
        local_path: 'C:\\Users\\ray\\Desktop\\TDEase-nexus\\data\\workspace',
      }),
    ).toBe('workspace')
  })

  it('falls back to the basename when the name is empty', () => {
    expect(workspaceDisplayName({ name: '', local_path: 'C:/studies/demo' })).toBe('demo')
    expect(workspaceDisplayName({ name: '   ', local_path: 'C:/studies/demo' })).toBe('demo')
  })

  it('handles POSIX-style absolute paths in the name', () => {
    expect(
      workspaceDisplayName({ name: '/home/ray/studies/alpha', local_path: '/home/ray/studies/alpha' }),
    ).toBe('alpha')
  })

  it('returns "workspace" when both name and path are empty', () => {
    expect(workspaceDisplayName({ name: '', local_path: '' })).toBe('workspace')
  })
})
