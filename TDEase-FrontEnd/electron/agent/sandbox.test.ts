import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { bwrapPrefix, planBashSandbox, seatbeltProfile, selectSandboxBackend } from './sandbox'

// The generators resolve inputs through the host path module, so the expected
// strings are built with the same resolution — the tests assert STRUCTURE
// (what is allowed, what is read-only, binding order), not platform literals.
const WORKSPACE = path.resolve('/Users/tdease/workspace')
const TEMP = tmpdir()

describe('sandbox profile generation', () => {
  it('seatbelt allows everything except writes outside the workspace and temp', () => {
    const lines = seatbeltProfile({ workspaceRoot: WORKSPACE }).split('\n')
    expect(lines[0]).toBe('(version 1)')
    expect(lines).toContain('(allow default)')
    expect(lines).toContain('(deny file-write*)')
    expect(lines).toContain(`(allow file-write* (subpath "${WORKSPACE}") (subpath "${TEMP}"))`)
  })

  it('bwrap re-binds the root read-only, then re-opens workspace and temp writable', () => {
    const prefix = bwrapPrefix({ workspaceRoot: WORKSPACE })
    expect(prefix[0]).toBe('bwrap')
    const roIndex = prefix.indexOf('--ro-bind')
    expect(roIndex).toBeGreaterThan(-1)
    // The writable binds must come AFTER the ro-bind: later binds override.
    // Workspace and temp appear twice each (src + dst); the first occurrence
    // is the writable source pair.
    const workspaceIndex = prefix.indexOf(WORKSPACE)
    const tempIndex = prefix.indexOf(TEMP)
    expect(workspaceIndex).toBeGreaterThan(roIndex)
    expect(tempIndex).toBeGreaterThan(roIndex)
    expect(prefix[prefix.length - 1]).toBe('--')
  })
})

describe('backend selection honesty', () => {
  it('windows selects no backend and plans no sandbox', () => {
    // On a platform without a usable sandbox primitive the answer must be
    // "none" — never a wrapper that pretends. planBashSandbox returning
    // undefined is the caller's signal to spawn exactly as before.
    if (process.platform !== 'win32') return
    expect(selectSandboxBackend('win32')).toBe('none')
    expect(planBashSandbox({ workspaceRoot: 'C:\\ws' })).toBeUndefined()
  })

  it('unsupported platforms fall back to none even when asked directly', () => {
    expect(selectSandboxBackend('freebsd')).toBe('none')
    expect(selectSandboxBackend('openbsd')).toBe('none')
  })
})
