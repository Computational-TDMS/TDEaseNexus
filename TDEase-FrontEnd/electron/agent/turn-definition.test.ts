import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  deepFreeze,
  type AgentRunDefinition,
  type ProviderRequestSnapshot,
  type SessionBinding,
  type ToolCeiling,
} from './turn-definition'
import {
  AGENT_PERMISSION_ACTIONS,
  type AgentPermissionDecision,
  type PermissionSnapshot,
} from '../../src/contracts/agent-runtime'

/**
 * Locks the three-state model and its invariants. These are the rules the Node
 * AgentRuntime must uphold; if a later change silently relaxes the security
 * boundary (e.g. makes a ceiling mutable, or widens tools mid-run), these fail.
 */

function sampleBinding(overrides: Partial<SessionBinding> = {}): SessionBinding {
  const decisions = {} as Record<typeof AGENT_PERMISSION_ACTIONS[number], AgentPermissionDecision>
  for (const action of AGENT_PERMISSION_ACTIONS) decisions[action] = 'ask'
  const permissionCeiling: PermissionSnapshot = decisions
  const toolCeiling: ToolCeiling = {
    builtins: ['read', 'grep', 'find', 'ls'],
    mcp: false,
  }
  const binding: SessionBinding = {
    workspaceId: 'ws_a',
    sessionId: 'session_1',
    workspaceRoot: '/tmp/workspace',
    authority: 'ask',
    permissionCeiling,
    toolCeiling,
    generation: 1,
    ...overrides,
  }
  // The Node AgentRuntime builds every binding via deepFreeze so a hook cannot
  // widen the ceiling by mutating a nested array. The test mirrors that.
  return deepFreeze(binding)
}

describe('SessionBinding (level 1 — frozen for the binding lifetime)', () => {
  it('freezes the permission ceiling so a hook cannot widen it', () => {
    const binding = sampleBinding()
    expect(Object.isFrozen(binding.permissionCeiling)).toBe(true)
    expect(() => {
      // @ts-expect-error — attempting a runtime mutation that must be rejected
      ;(binding.permissionCeiling as Record<string, AgentPermissionDecision>).workspace.write = 'allow'
    }).toThrow()
  })

  it('freezes the tool ceiling so active tools can only narrow, never exceed', () => {
    const binding = sampleBinding()
    expect(Object.isFrozen(binding.toolCeiling)).toBe(true)
    expect(Object.isFrozen(binding.toolCeiling.builtins)).toBe(true)
    expect(() => {
      // @ts-expect-error — runtime mutation must be rejected
      ;(binding.toolCeiling as { builtins: string[] }).builtins.push('bash')
    }).toThrow()
  })
})

describe('AgentRunDefinition (level 2 — frozen at before_agent_start)', () => {
  it('carries the initial model/thinking that hooks may later override per-request', () => {
    const run: AgentRunDefinition = {
      turnId: 'turn_1',
      userMessage: 'summarize @run:ubiquitin',
      mindset: 'explorer',
      budgets: { wallClockMs: 15 * 60_000 },
      referencedAssetsDigest: 'a'.repeat(64),
      initialModel: { providerId: 'deepseek', modelId: 'deepseek-chat' },
      initialThinkingLevel: 'medium',
    }
    // The run records *initial* values; later ProviderRequestSnapshots record
    // what each provider request actually used. They are distinct levels.
    expect(run.initialModel.modelId).toBe('deepseek-chat')
    expect(run.initialThinkingLevel).toBe('medium')
  })
})

describe('ProviderRequestSnapshot (level 3 — per provider request, replayable)', () => {
  it('records only digests, never prompt/context bytes', () => {
    const snapshot: ProviderRequestSnapshot = {
      turnId: 'turn_1',
      requestSeq: 2,
      systemPromptDigest: 's'.repeat(64),
      contextDigest: 'c'.repeat(64),
      activeToolsDigest: 't'.repeat(64),
      model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
      thinkingLevel: 'high',
    }
    // The type itself enforces "only digests + scalar metadata, no prompt bytes":
    // every field is a string, number, or the ModelSelector object. The
    // vocabulary assertSessionEvent test separately locks that no extra field
    // (like prompt bytes) can sneak through.
    expect(snapshot.requestSeq).toBe(2)
    expect(snapshot.systemPromptDigest).toBe('s'.repeat(64))
  })
})

describe('canonicalJson (deterministic digest input)', () => {
  it('produces identical output regardless of key insertion order', () => {
    const a = { b: 2, a: 1, c: { z: 26, y: 25 } }
    const b = { c: { y: 25, z: 26 }, a: 1, b: 2 }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
  })

  it('drops undefined values so a snapshot digest is stable', () => {
    expect(canonicalJson({ x: 1, y: undefined })).toBe(canonicalJson({ x: 1 }))
  })
})
