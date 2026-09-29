import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createJobRegistry } from './job-registry'
import type { PermissionGateway } from './contracts'
import type { JobStatus } from '../../src/studio/commands/registry'

function makeRegistry() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'tdease-job-'))
  const permission = {
    decide: () => 'allow',
    resolveWorkspacePath: (relative: string) => join(workspaceRoot, relative),
    assertCommandCwd: (cwd?: string) => cwd ?? workspaceRoot,
    assertShellCommand: () => undefined,
  } as PermissionGateway
  return {
    workspaceRoot,
    registry: createJobRegistry({
      workspaceRoot,
      parentSessionId: 'parent_test',
      resolveEnv: () => process.env,
      permission,
    }),
  }
}

async function waitForSettled(
  registry: ReturnType<typeof createJobRegistry>,
  jobId: string,
  timeoutMs = 5000,
): Promise<JobStatus> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await registry.status(jobId)
    if (status.state !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms`)
}

/** A sleep command the registry's default shell accepts. Both platforms run
 *  Git Bash now (jobs execute the agent's bash-language commands), so plain
 *  `sleep` works everywhere — the old Windows `ping` hack was cmd-only. */
function platformSleep(seconds: number): string {
  return `sleep ${seconds}`
}

describe('JobRegistry', () => {
  it('start returns a jobId immediately and settles succeeded on exit 0', async () => {
    const { registry } = makeRegistry()
    const { jobId } = await registry.start({ command: 'echo hello' })
    expect(jobId).toMatch(/^job_/)
    const settled = await waitForSettled(registry, jobId)
    expect(settled.state).toBe('succeeded')
    expect(settled.exitCode).toBe(0)
  })

  it('settles failed on a non-zero exit code', async () => {
    const { registry } = makeRegistry()
    const { jobId } = await registry.start({ command: 'exit 1' })
    const settled = await waitForSettled(registry, jobId)
    expect(settled.state).toBe('failed')
    expect(settled.exitCode).toBe(1)
    expect(settled.error?.code).toBe('JOB_NONZERO_EXIT')
  })

  it('drainSettled returns each settled job exactly once', async () => {
    const { registry } = makeRegistry()
    const { jobId } = await registry.start({ command: 'echo once' })
    await waitForSettled(registry, jobId)
    const first = registry.drainSettled()
    expect(first).toHaveLength(1)
    expect(first[0].jobId).toBe(jobId)
    // Second drain is empty — the job was marked notified.
    expect(registry.drainSettled()).toHaveLength(0)
  })

  it('list reflects a running job and cancel settles it as cancelled', async () => {
    const { registry } = makeRegistry()
    expect(registry.list()).toHaveLength(0)
    const { jobId } = await registry.start({ command: platformSleep(30), timeoutS: 30 })
    expect(registry.list().some((j) => j.jobId === jobId && j.state === 'running')).toBe(true)
    await registry.cancel(jobId)
    const settled = await registry.status(jobId)
    expect(settled.state).toBe('cancelled')
  })

  it('wait blocks until the job settles and reports the terminal status', async () => {
    const { registry } = makeRegistry()
    const { jobId } = await registry.start({ command: 'echo waited' })
    const settled = await registry.wait({ jobIds: [jobId] })
    expect(settled).toHaveLength(1)
    expect(settled[0].jobId).toBe(jobId)
    expect(settled[0].state).toBe('succeeded')
  })

  it('wait on an already-settled job returns immediately, and drainSettled stays silent after wait', async () => {
    const { registry } = makeRegistry()
    const { jobId } = await registry.start({ command: 'echo done' })
    await waitForSettled(registry, jobId)
    // Consumed the settlement — the wait marked it notified, so the context
    // hook must not re-announce what the model just read.
    const [settled] = await registry.wait({ jobIds: [jobId] })
    expect(settled.state).toBe('succeeded')
    expect(registry.drainSettled()).toHaveLength(0)
  })

  it('concurrent waiters on the same job all resolve when it settles', async () => {
    const { registry } = makeRegistry()
    const { jobId } = await registry.start({ command: platformSleep(1), timeoutS: 30 })
    const first = registry.wait({ jobIds: [jobId] })
    const second = registry.wait({ jobIds: [jobId] })
    const [a, b] = await Promise.all([first, second])
    expect(a[0].state).toBe('succeeded')
    expect(b[0].state).toBe('succeeded')
  })

  it('the unscoped wait collects every session job, first-completion returns early for scoped waits', async () => {
    const { registry } = makeRegistry()
    const fast = await registry.start({ command: 'echo fast' })
    const slow = await registry.start({ command: platformSleep(3), timeoutS: 30 })
    // Scoped first-completion: returns as soon as the fast job settles.
    const first = await registry.wait({ jobIds: [fast.jobId, slow.jobId] })
    expect(first.map((j) => j.jobId)).toEqual([fast.jobId, slow.jobId])
    expect(first.find((j) => j.jobId === fast.jobId)?.state).toBe('succeeded')
    // Unscoped: waits for ALL — including the still-running slow job.
    const everything = await registry.wait({})
    expect(everything.length).toBeGreaterThanOrEqual(2)
    expect(everything.every((j) => j.state !== 'running')).toBe(true)
  })

  it('wait returns the terminal status WITH its output, and drainSettled stays silent', async () => {
    const { registry } = makeRegistry()
    const { jobId } = await registry.start({ command: 'echo wait-output-probe' })
    const [settled] = await registry.wait({ jobIds: [jobId] })
    // The wait response carries the bounded output tail — the model never
    // needs a follow-up peek for what it already waited on (2026-09-05
    // review: wait used to return state-only while marking notified, so the
    // output reached nobody).
    expect(settled.state).toBe('succeeded')
    expect(settled.stdoutTail).toContain('wait-output-probe')
    expect(registry.drainSettled()).toHaveLength(0)
  })

  it('wait returns at once when the signal was already cancelled at entry', async () => {
    const { registry } = makeRegistry()
    const { jobId } = await registry.start({ command: platformSleep(20), timeoutS: 20 })
    const controller = new AbortController()
    controller.abort()
    const startedAt = Date.now()
    const statuses = await registry.wait({ jobIds: [jobId] }, controller.signal)
    // Returned immediately with the running snapshot — a stop that raced the
    // permission check must not park the tool call for the job's duration.
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(statuses[0].state).toBe('running')
    await registry.cancel(jobId)
  })

  it('peek shows live output while the job is still running', async () => {
    const { registry } = makeRegistry()
    const { jobId } = await registry.start({ command: 'echo live-tail-probe && sleep 5', timeoutS: 30 })
    try {
      // The stdout data event must land in the record's live tail — not only
      // at settle (2026-09-05 review: peek read a record that stayed empty
      // until exit).
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const peeked = await registry.peek(jobId)
      expect(peeked.state).toBe('running')
      expect(peeked.stdoutTail).toContain('live-tail-probe')
    } finally {
      await registry.cancel(jobId)
    }
  })

  // The scenario needs a real 4s job plus a second full wait — ~4.1s bare,
  // which sits too close to vitest's 5s default under suite load (this was
  // the recurring one-flake full-run failure), so the budget is explicit.
  it('an aborted wait does not hold a waiter on the record', { timeout: 15_000 }, async () => {
    const { registry } = makeRegistry()
    const { jobId } = await registry.start({ command: platformSleep(4), timeoutS: 30 })
    const controller = new AbortController()
    const aborted = registry.wait({ jobIds: [jobId] }, controller.signal)
    setTimeout(() => controller.abort(), 200)
    const statuses = await aborted
    expect(statuses[0].jobId).toBe(jobId)
    // After the abort the record is still running and NOT notified — a later
    // drain/wait can still observe its real settlement.
    expect(registry.drainSettled()).toHaveLength(0)
    await registry.wait({ jobIds: [jobId] })
    expect(registry.status(jobId)).resolves.toBeDefined()
  })

  it('cancelAll sweeps every running job and settles them cancelled', async () => {
    const { registry } = makeRegistry()
    const a = await registry.start({ command: platformSleep(30), timeoutS: 30 })
    const b = await registry.start({ command: 'echo quick' })
    await waitForSettled(registry, b.jobId)
    registry.cancelAll()
    const [sweptA, sweptB] = await Promise.all([
      registry.status(a.jobId),
      registry.status(b.jobId),
    ])
    expect(sweptA.state).toBe('cancelled')
    expect(sweptB.state).toBe('succeeded')
    // Idempotent: a second sweep is a no-op.
    expect(() => registry.cancelAll()).not.toThrow()
  })
})
