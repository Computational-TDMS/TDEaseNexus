import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { EXECUTION_MODES, runStatusForEvent, type RunStatus } from './run'

/**
 * Parity guard for the shared lifecycle declaration.
 *
 * `tdease-backend/src/contracts/run_lifecycle.json` is the ONE declaration the
 * Backend's projector loads. The Client cannot import it (a repository-path
 * import across repositories is forbidden by
 * design/THREE-REPOSITORY-ARCHITECTURE.md), so `domain/run.ts` mirrors the
 * vocabulary by hand and this test reads the JSON and fails on drift. Without
 * it, a new lifecycle event would update the Backend and leave the Client's
 * live projection silently stale — the exact defect class a second
 * hand-maintained state machine invites.
 */
const declaration = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../../tdease-backend/src/contracts/run_lifecycle.json'),
    'utf8',
  ),
) as {
  statuses: Record<string, string>
  terminal_events: string[]
  execution_modes: string[]
}

describe('run lifecycle parity with the shared declaration', () => {
  it('maps every declared event to the declared status and nothing else', () => {
    for (const [eventType, status] of Object.entries(declaration.statuses)) {
      expect(runStatusForEvent(eventType), eventType).toBe(status)
    }
    expect(runStatusForEvent('run.submitted')).toBeNull()
    expect(runStatusForEvent('task.started')).toBeNull()
  })

  it('declares the same execution modes', () => {
    expect([...EXECUTION_MODES].sort()).toEqual([...declaration.execution_modes].sort())
  })

  it('treats every declared terminal event as a settled status', () => {
    const terminal = new Set<RunStatus>(['SUCCEEDED', 'FAILED', 'CANCELLED'])
    for (const eventType of declaration.terminal_events) {
      const status = runStatusForEvent(eventType)
      expect(status && terminal.has(status), eventType).toBe(true)
    }
  })
})
