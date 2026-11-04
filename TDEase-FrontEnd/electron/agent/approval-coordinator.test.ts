/**
 * ApprovalCoordinator — pins that the tool's `args` flow through `onPending`
 * to the Renderer. Historically `_args` was dropped "by design" on the false
 * premise that the Renderer already had them; it does not (the approval event
 * is an independent stream from tool.requested, with no shared correlation the
 * Renderer keeps). The approval modal needs the args to show what shell
 * command is actually about to run, so they MUST travel the whole chain.
 */
import { describe, expect, it, vi } from 'vitest'
import { NodeApprovalCoordinator } from './approval-coordinator'

describe('NodeApprovalCoordinator request → onPending', () => {
  it('forwards the tool args to onPending so the approval UI can show them', async () => {
    const onPending = vi.fn()
    const coordinator = new NodeApprovalCoordinator(onPending)

    const args = { command: 'rm -rf node_modules', cwd: '/repo' }
    const promise = coordinator.request('session-1', 'shell.exec', 'bash requested shell.exec', args)

    expect(onPending).toHaveBeenCalledTimes(1)
    const info = onPending.mock.calls[0][0]
    expect(info.approvalId).toBeTruthy()
    expect(info.sessionId).toBe('session-1')
    expect(info.action).toBe('shell.exec')
    expect(info.args).toEqual(args) // the regression: args used to be dropped here

    // Resolve so the promise does not leak.
    coordinator.resolve(info.approvalId, 'allow')
    await expect(promise).resolves.toBe('allow')
  })

  it('still works when no args are supplied (optional field)', async () => {
    const onPending = vi.fn()
    const coordinator = new NodeApprovalCoordinator(onPending)

    const promise = coordinator.request('session-1', 'shell.exec', 'basis')
    const info = onPending.mock.calls[0][0]
    expect(info.args).toBeUndefined()

    coordinator.resolve(info.approvalId, 'deny')
    await expect(promise).resolves.toBe('deny')
  })
})

describe('NodeApprovalCoordinator allow_always (whitelist deepening)', () => {
  const ARGS = { command: 'git status -sb' }

  async function settleAlways(onWhitelistRule?: Parameters<typeof NodeApprovalCoordinator>[1]) {
    const coordinator = new NodeApprovalCoordinator(undefined, onWhitelistRule)
    const promise = coordinator.request('session-1', 'shell.exec', 'basis', ARGS)
    const info = { approvalId: '' }
    // Recover the approvalId from the pending map via a second request is
    // ugly; instead resolve through the coordinator the same way the IPC
    // handler does — the id arrives via onPending, so use the hook.
    return { coordinator, promise, info }
  }

  it('resolves allow_always, records the session overlay rule and fires the host callback', async () => {
    const onPending = vi.fn()
    const onWhitelistRule = vi.fn()
    const coordinator = new NodeApprovalCoordinator(onPending, onWhitelistRule)

    const promise = coordinator.request('session-1', 'shell.exec', 'basis', ARGS)
    const { approvalId } = onPending.mock.calls[0][0]
    coordinator.resolve(approvalId, 'allow_always')

    await expect(promise).resolves.toBe('allow_always')
    // The overlay covers this session immediately: a two-token prefix rule.
    const rules = coordinator.sessionRulesFor('session-1')
    expect(rules).toHaveLength(1)
    expect(rules[0].match).toEqual({ command: '^git status\\b' })
    expect(rules[0].priority).toBe(-1)
    // The host got the same rule plus a human-readable scope.
    expect(onWhitelistRule).toHaveBeenCalledTimes(1)
    const payload = onWhitelistRule.mock.calls[0][0]
    expect(payload.sessionId).toBe('session-1')
    expect(payload.rule).toEqual(rules[0])
    expect(payload.scope).toBe('git status …')
    // Another session sees nothing of it.
    expect(coordinator.sessionRulesFor('session-2')).toEqual([])
  })

  it('an undecorable call settles allow_always without overlay or callback', async () => {
    const onPending = vi.fn()
    const onWhitelistRule = vi.fn()
    const coordinator = new NodeApprovalCoordinator(onPending, onWhitelistRule)

    const promise = coordinator.request('session-1', 'run.trash', 'basis', { runId: 'r1' })
    coordinator.resolve(onPending.mock.calls[0][0].approvalId, 'allow_always')

    await expect(promise).resolves.toBe('allow_always')
    expect(coordinator.sessionRulesFor('session-1')).toEqual([])
    expect(onWhitelistRule).not.toHaveBeenCalled()
  })

  it('a rejected persist callback never breaks the resolution', async () => {
    const onPending = vi.fn()
    const onWhitelistRule = vi.fn(() => Promise.reject(new Error('disk full')))
    const coordinator = new NodeApprovalCoordinator(onPending, onWhitelistRule)

    const promise = coordinator.request('session-1', 'shell.exec', 'basis', ARGS)
    coordinator.resolve(onPending.mock.calls[0][0].approvalId, 'allow_always')

    await expect(promise).resolves.toBe('allow_always')
    expect(coordinator.sessionRulesFor('session-1')).toHaveLength(1)
  })

  it('cancelSession clears the overlay with the session', async () => {
    const onPending = vi.fn()
    const coordinator = new NodeApprovalCoordinator(onPending)

    const promise = coordinator.request('session-1', 'shell.exec', 'basis', ARGS)
    coordinator.resolve(onPending.mock.calls[0][0].approvalId, 'allow_always')
    expect(coordinator.sessionRulesFor('session-1')).toHaveLength(1)

    coordinator.cancelSession('session-1')
    expect(coordinator.sessionRulesFor('session-1')).toEqual([])
    await expect(promise).resolves.toBe('allow_always')
  })
})
