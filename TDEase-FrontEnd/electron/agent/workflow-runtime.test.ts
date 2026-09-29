import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  SubagentCommandPort,
  SubagentResult,
  SubagentSpawnInput,
  SubagentStatus,
} from '../../src/studio/commands/registry'
import { createWorkflowJournal } from './workflow-journal'
import { createOrchestrateRegistry, runWorkflow } from './workflow-runtime'

/** A minimal subagent port that resolves each spawn with a deterministic §6
 *  envelope derived from the task text — no LLM, no async settle, but it
 *  exercises the real spawn→wait contract the runtime depends on. */
function mockSubagents(resolveWith: (task: string, role: string) => SubagentResult): {
  port: SubagentCommandPort
  spawnCount: () => number
  spawnedTasks: () => string[]
} {
  const spawned: Array<{ id: string; task: string; role: string }> = []
  let counter = 0
  const port: SubagentCommandPort = {
    async spawn(input: SubagentSpawnInput) {
      const id = `sub_${counter++}`
      spawned.push({ id, task: input.task, role: input.role })
      return { subagentId: id }
    },
    async wait({ subagentIds }) {
      return subagentIds.map((id) => {
        const record = spawned.find((s) => s.id === id)!
        const status: SubagentStatus = {
          subagentId: id,
          role: record.role,
          state: 'returned',
          createdAt: 0,
          elapsedS: 0,
          result: resolveWith(record.task, record.role),
        }
        return status
      })
    },
    // The runtime never calls these; stub them so the port is structurally complete.
    async status() { throw new Error('unused in orchestration runtime test') },
    async cancel() { return { ok: true as const } },
    async followup() { throw new Error('unused') },
    async spawnGroup() { throw new Error('unused') },
    async peek() { throw new Error('unused') },
    async listAgents() { return [] },
    list() { return [] },
    subscribe() { return () => { /* noop */ } },
  }
  return { port, spawnCount: () => spawned.length, spawnedTasks: () => spawned.map((s) => s.task) }
}

function envelope(task: string): SubagentResult {
  return {
    subagentId: 'mock',
    role: 'generic',
    findings: [task],
    evidenceLinks: [],
    confidence: 'high',
    openQuestions: [],
  }
}

describe('workflow-runtime', () => {
  it('runs a linear script: agent() routes to spawn+wait and returns the §6 result', async () => {
    const { port, spawnCount } = mockSubagents((task) => envelope(task))
    const journal = createWorkflowJournal({ runId: 'r1' })
    const { result } = await runWorkflow(
      { script: "const a = await agent('do A'); return a" },
      { subagents: port, journal, cwd: '/ws' },
    )
    expect(spawnCount()).toBe(1)
    expect((result as SubagentResult).findings).toEqual(['do A'])
    expect(journal.size).toBe(1)
  })

  it('parallel() fans out N thunks concurrently and preserves input order', async () => {
    const { port, spawnCount, spawnedTasks } = mockSubagents((task) => envelope(task))
    const journal = createWorkflowJournal({ runId: 'r1' })
    const { result } = await runWorkflow(
      { script: "return await parallel([() => agent('p1'), () => agent('p2'), () => agent('p3')])" },
      { subagents: port, journal, cwd: '/ws' },
    )
    expect(spawnCount()).toBe(3)
    expect(spawnedTasks().sort()).toEqual(['p1', 'p2', 'p3'])
    expect((result as SubagentResult[]).map((r) => r.findings[0])).toEqual(['p1', 'p2', 'p3'])
    expect(journal.size).toBe(3)
  })

  it('resume replays the unchanged prefix from the journal and re-runs only the changed tail', async () => {
    // This is the core value prop of the whole feature: editing one prompt in a
    // multi-agent script re-pays for only that one call, not the whole fleet.
    const dir = mkdtempSync(join(tmpdir(), 'wf-resume-'))
    try {
      const persistPath = join(dir, 'workflows', 'r1.json')

      // First run: two sequential agent() calls, both fresh.
      const first = mockSubagents((task) => envelope(task))
      const j1 = createWorkflowJournal({ runId: 'r1', persistPath })
      await runWorkflow(
        { script: "const a = await agent('task A'); const b = await agent('task B'); return [a, b]" },
        { subagents: first.port, journal: j1, cwd: '/ws' },
      )
      expect(first.spawnCount()).toBe(2)

      // Resume with the SECOND prompt edited. The first call must hit the
      // journal cache (no spawn); only the edited second call re-spawns.
      const resumed = mockSubagents((task) => envelope(task))
      const j2 = createWorkflowJournal({ runId: 'r1', persistPath, resume: true })
      const { result } = await runWorkflow(
        { script: "const a = await agent('task A'); const b = await agent('task B edited'); return [a, b]", resumeFromRunId: 'r1' },
        { subagents: resumed.port, journal: j2, cwd: '/ws' },
      )
      expect(resumed.spawnCount()).toBe(1)
      expect(resumed.spawnedTasks()).toEqual(['task B edited'])
      // The replayed first result is the cached envelope from the first run.
      const pair = result as SubagentResult[]
      expect(pair[0].findings).toEqual(['task A'])
      expect(pair[1].findings).toEqual(['task B edited'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The user-stop contract: a turn parked in orchestrate.wait must settle the
  // moment the tool call's abort signal fires — and cancelAll() must stop the
  // background run's own controller (no further agent() spawns).
  it('wait rejects at once on the abort signal and cancelAll fires the run controller', async () => {
    let release!: () => void
    const parked = new Promise<void>((resolve) => { release = resolve })
    const port: SubagentCommandPort = {
      ...mockSubagents((task) => envelope(task)).port,
      // The child never settles on its own — only the abort path can end this.
      async wait() { await parked; throw new Error('unreachable') },
    }
    const registry = createOrchestrateRegistry({ subagents: port, parentSessionId: 'p1' })
    const { runId } = await registry.run({ script: "await agent('never returns')" })
    const controller = new AbortController()

    const waiting = registry.wait(runId, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow('orchestration wait aborted')

    // cancelAll fires the run's controller; the parked agent() wait inside the
    // script observes the run signal and the workflow settles as failed.
    registry.cancelAll()
    release()
    await vi.waitFor(() => expect(registry.status(runId).state).toBe('failed'))
  })
})
