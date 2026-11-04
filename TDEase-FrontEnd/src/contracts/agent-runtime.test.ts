import { describe, expect, it } from 'vitest'
import {
  AGENT_BUILTIN_TOOL_NAMES,
  assertBindSessionInput,
  assertPromptInput,
  assertResolveApprovalInput,
  DEFAULT_AGENT_TOOL_SETTINGS,
  type BindSessionInput,
  type PromptInput,
  type ResolveApprovalInput,
} from './agent-runtime'

/**
 * Locks the v2 IPC validators. These run in the Electron main process at the
 * IPC boundary; a malformed input from a compromised/hung Renderer must be
 * rejected before any Pi session is touched. The previous v1 surface carried
 * apiKey/systemPrompt/tools across IPC — v2 must refuse every one of those.
 */

function validBind(): BindSessionInput {
  return {
    workspaceId: 'ws_a',
    sessionId: 'session_1',
    mindset: 'analysis',
    authority: 'ask',
    model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
    thinkingLevel: 'medium',
    agentTools: { ...DEFAULT_AGENT_TOOL_SETTINGS },
  }
}

describe('assertBindSessionInput', () => {
  it('accepts the canonical minimal binding', () => {
    expect(() => assertBindSessionInput(validBind())).not.toThrow()
  })

  it('rejects an unknown mindset', () => {
    expect(() => assertBindSessionInput({ ...validBind(), mindset: 'supervisor' }))
      .toThrow('mindset must be analysis|workflow')
  })

  it('rejects an unknown authority', () => {
    expect(() => assertBindSessionInput({ ...validBind(), authority: 'elevated' }))
      .toThrow('authority must be ask|auto')
  })

  it('rejects an invalid thinking level', () => {
    expect(() => assertBindSessionInput({ ...validBind(), thinkingLevel: 'turbo' }))
      .toThrow('thinkingLevel is invalid')
  })

  it('rejects a model missing its ids', () => {
    expect(() => assertBindSessionInput({ ...validBind(), model: { providerId: 'deepseek' } as BindSessionInput['model'] }))
      .toThrow('model.modelId must be a non-empty string')
  })

  it('rejects an unknown agentTools setting key', () => {
    expect(() => assertBindSessionInput({
      ...validBind(),
      agentTools: { ...DEFAULT_AGENT_TOOL_SETTINGS, curl: true },
    })).toThrow('agentTools has unknown setting: curl')
  })

  it('rejects a non-boolean agentTools value', () => {
    expect(() => assertBindSessionInput({
      ...validBind(),
      agentTools: { ...DEFAULT_AGENT_TOOL_SETTINGS, shell: 'yes' },
    })).toThrow('agentTools.shell must be boolean')
  })

  it('rejects an internal delegation field (a renderer may never self-declare an inherited ceiling)', () => {
    expect(() => assertBindSessionInput({
      ...validBind(),
      delegation: {
        permissionCeiling: { 'shell.exec': 'allow' },
        approvalPresenterSessionId: 'parent_1',
      },
    })).toThrow('delegation is internal and never crosses IPC')
  })

  it('documents the complete builtin allowlist (mindset can only narrow it)', () => {
    expect([...AGENT_BUILTIN_TOOL_NAMES]).toEqual(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'])
  })
})

describe('assertPromptInput', () => {
  it('accepts a session id and a non-empty message', () => {
    const input: PromptInput = { sessionId: 'session_1', message: 'summarize @run:ubiquitin' }
    expect(() => assertPromptInput(input)).not.toThrow()
  })

  it('rejects an empty message (an empty turn must never start a provider request)', () => {
    expect(() => assertPromptInput({ sessionId: 'session_1', message: '   ' }))
      .toThrow('message must be a non-empty string')
  })
})

describe('assertResolveApprovalInput', () => {
  it('accepts allow and deny', () => {
    const allow: ResolveApprovalInput = { sessionId: 's', approvalId: 'a1', decision: 'allow' }
    const allowSession: ResolveApprovalInput = { sessionId: 's', approvalId: 'a1', decision: 'allow_session' }
    const deny: ResolveApprovalInput = { sessionId: 's', approvalId: 'a1', decision: 'deny' }
    expect(() => assertResolveApprovalInput(allow)).not.toThrow()
    expect(() => assertResolveApprovalInput(allowSession)).not.toThrow()
    expect(() => assertResolveApprovalInput(deny)).not.toThrow()
  })

  it('rejects any other decision vocabulary', () => {
    expect(() => assertResolveApprovalInput({ sessionId: 's', approvalId: 'a1', decision: 'ask' as 'allow' }))
      .toThrow('decision must be allow|allow_session|deny')
  })
})
