import { describe, expect, it, vi } from 'vitest'

import { PROMPT_ASSETS, type PromptAssetReader } from '../../src/agent/prompt'
import type { AgentPermissionDecision, PermissionSnapshot } from '../../src/contracts/agent-runtime'
import type { RunInfo } from '../../src/services/backend/client-contracts'
import type { RunResultEntry } from '../../src/services/backend/backend'
import type { AgentRunDefinition, SessionBinding, ToolCeiling } from './turn-definition'

import { NodePromptPipeline, formatRunReference } from './prompt-pipeline'

/**
 * `formatRunReference` is the pure logic point that turns a Backend Run
 * projection + its Published Results into the markdown body the @run resolver
 * freezes into the per-turn snapshot. It is the only non-trivial step in the
 * @run data path — status() and listResults() are thin HTTP, and the resolver
 * plumbing is the same as @file. So this is the one place worth a unit
 * test: it pins what the model actually reads for an @run mention.
 */

function baseRun(overrides: Partial<RunInfo> = {}): RunInfo {
  return {
    run_id: 'r1',
    name: 'TopPIC run',
    workspace_id: 'ws',
    workspace_run_path: null,
    current_revision: null,
    status: 'SUCCEEDED',
    cores: 8,
    pid: null,
    exit_code: null,
    error: null,
    rerun_mode: 'resume',
    labels: {},
    result_file_count: 0,
    created_at: '2026-07-01T00:00:00Z',
    started_at: null,
    finished_at: null,
    event_seq_last: 0,
    idempotent: false,
    ...overrides,
  }
}

function result(overrides: Partial<RunResultEntry> = {}): RunResultEntry {
  return {
    result_id: 'res1',
    name: 'proteoform',
    kind: 'table',
    dimensions: {},
    output: 'toppic_proteoform.tsv',
    status: 'ready',
    digest: 'abc',
    size: 12700,
    ref: { workspace_id: 'ws', run_id: 'r1', result_id: 'res1', digest: 'abc' },
    ...overrides,
  }
}

describe('formatRunReference', () => {
  it('renders only compact Run metadata', () => {
    const body = formatRunReference(
      baseRun({
        name: 'chlamy-h4',
        status: 'SUCCEEDED',
        cores: 8,
        result_file_count: 2,
        current_revision: 'rev-00000024',
        labels: { organism: 'chlamy' },
      }),
      [
        result({ name: 'proteoform', kind: 'table', output: 'toppic_proteoform.tsv', size: 12700 }),
        result({ result_id: 'res2', name: 'mzML centroided', kind: 'spectrum', output: 'centroided.mzML', size: 150_000_000 }),
      ],
    )
    // ## Run header carries the name.
    expect(body).toContain('## Run chlamy-h4')
    // Core identity fields.
    expect(body).toContain('- status: SUCCEEDED')
    expect(body).toContain('- cores: 8')
    expect(body).toContain('results: 2 files')
    expect(body).toContain('- revision: rev-00000024')
    expect(body).not.toContain('organism=chlamy')
    // No error line when there is none.
    expect(body).not.toMatch(/^- error:/m)
    expect(body).not.toContain('## Published Results')
    expect(body).not.toContain('toppic_proteoform.tsv')
    expect(body).not.toContain('README.md')
  })

  it('renders a failed Run with an error line and no Published Results section', () => {
    const body = formatRunReference(
      baseRun({ name: 'bad-run', status: 'FAILED', error: 'snakemake exit 1', result_file_count: 0 }),
      [],
    )
    expect(body).toContain('## Run bad-run')
    expect(body).toContain('- status: FAILED')
    expect(body).toContain('- error: snakemake exit 1')
    // No results to list → the section is omitted entirely.
    expect(body).not.toContain('## Published Results')
  })

  it('omits the Published Results section when the Run succeeded but has none', () => {
    const body = formatRunReference(
      baseRun({ name: 'empty-run', status: 'SUCCEEDED', result_file_count: 0 }),
      [],
    )
    expect(body).toContain('## Run empty-run')
    expect(body).not.toContain('## Published Results')
  })
})

describe('NodePromptPipeline — @file mention resolution', () => {
  function makePipeline(workspaceReadText: (path: string) => Promise<string>) {
    const systemAssets: PromptAssetReader = { readText: async () => '' }
    return new NodePromptPipeline({
      systemAssets,
      workspaceRoot: '/tmp/workspace',
      workspaceReadText,
      systemReadText: async () => '',
    })
  }

  it('an image mention is recorded as binary and never read as text', async () => {
    const readText = vi.fn(async () => {
      throw new Error('images must not ride the text path')
    })
    const refs = await makePipeline(readText).resolveReferences('see @file:plots/census.png')
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ kind: 'file', refId: 'plots/census.png', found: true })
    expect(refs[0].body).toContain('binary image')
    expect(readText).not.toHaveBeenCalled()
  })

  it('a text file mention is still read as text', async () => {
    const readText = vi.fn(async () => 'hello')
    const refs = await makePipeline(readText).resolveReferences('see @file:notes.txt')
    expect(refs).toHaveLength(1)
    expect(refs[0].found).toBe(true)
    expect(readText).toHaveBeenCalledWith('notes.txt')
  })
})

describe('NodePromptPipeline — subagent system-prompt override', () => {
  const ASSET_TEXTS: Record<string, string> = {
    [PROMPT_ASSETS.baseRole]: 'BASE ROLE',
    [PROMPT_ASSETS.toolPolicy]: 'TOOL POLICY',
    [PROMPT_ASSETS.bashPolicy]: 'BASH POLICY',
    [PROMPT_ASSETS.wikiPolicy]: 'WIKI POLICY',
    [PROMPT_ASSETS.nativeToolchain]: 'NATIVE TOOLCHAIN',
    [PROMPT_ASSETS.scientificHonesty]: 'SCIENTIFIC HONESTY',
    [PROMPT_ASSETS.terminology]: 'TERMINOLOGY',
    [PROMPT_ASSETS.analysisLayout]: 'ANALYSIS LAYOUT',
    [PROMPT_ASSETS.delegationPolicy]: 'DELEGATION POLICY',
    [PROMPT_ASSETS.analysisMode]: 'ANALYSIS MODE',
    [PROMPT_ASSETS.workflowMode]: 'WORKFLOW MODE',
    [PROMPT_ASSETS.safetyPolicy]: 'SAFETY POLICY',
  }

  function sampleBinding(overrides: Partial<SessionBinding> = {}): SessionBinding {
    const decisions = {} as Record<string, AgentPermissionDecision>
    for (const action of ['read', 'write', 'bash'] as const) decisions[action] = 'ask'
    const permissionCeiling = decisions as PermissionSnapshot
    const toolCeiling: ToolCeiling = { builtins: ['read', 'grep'], mcp: false }
    return {
      workspaceId: 'ws_a',
      sessionId: 'session_1',
      workspaceRoot: '/tmp/workspace',
      authority: 'auto',
      permissionCeiling,
      toolCeiling,
      generation: 1,
      ...overrides,
    }
  }

  function runDefinition(): AgentRunDefinition {
    return {
      turnId: 't1',
      userMessage: 'do the task',
      mindset: 'workflow',
      budgets: { wallClockMs: 60_000 },
      referencedAssetsDigest: 'digest',
      initialModel: { providerId: 'test', modelId: 'test-model' },
      initialThinkingLevel: 'medium',
    }
  }

  function makePipeline() {
    const systemAssets: PromptAssetReader = {
      readText: async (path: string) => ASSET_TEXTS[path] ?? '',
    }
    const pipeline = new NodePromptPipeline({
      systemAssets,
      workspaceRoot: '/tmp/workspace',
      workspaceReadText: async () => '',
      systemReadText: async () => '',
    })
    return pipeline
  }

  it('threads binding.systemPromptOverride into the assembled system prompt', async () => {
    const pipeline = makePipeline()

    const without = await pipeline.assembleForRun(sampleBinding(), runDefinition(), [])
    expect(without.systemPrompt).not.toContain('ROLE BRIEFING')

    const withRole = await pipeline.assembleForRun(
      sampleBinding({ systemPromptOverride: '# Base\n\nROLE BRIEFING' }),
      runDefinition(),
      [],
    )
    // The role briefing lands in the frozen system prompt of the child session.
    expect(withRole.systemPrompt).toContain('ROLE BRIEFING')
    // It comes after the common safety policy, not before it.
    expect(withRole.systemPrompt.indexOf('SAFETY POLICY')).toBeLessThan(withRole.systemPrompt.indexOf('ROLE BRIEFING'))
  })
})
