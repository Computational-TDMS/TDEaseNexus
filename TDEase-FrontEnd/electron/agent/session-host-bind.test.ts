import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionHost } from './session-host'

/**
 * Pins the provider-bind endpoint contract: a settings.json baseUrl override
 * must win over Pi's native model catalog. Pi bakes vendor endpoints into its
 * native models (deepseek -> api.deepseek.com), so a catalog hit alone must
 * NOT skip re-registration when the resolved provider endpoint differs —
 * otherwise the user's endpoint (or a test double) is silently ignored and
 * their key is sent to the vendor (observed live: 401 from the real API with
 * a key meant for a local mock).
 *
 * The pi module is mocked at the boundary: ModelRuntime records
 * registerProvider calls; the session machinery (loader/manager/
 * createAgentSession) is stubbed to inert.
 */

const nativeModel = {
  id: 'deepseek-v4-flash',
  name: 'deepseek-v4-flash',
  baseUrl: 'https://api.deepseek.com',
  api: 'openai-completions',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
}

// vitest hoists vi.mock above the module body; the state the mocked
// factory closes over must exist before the mocked module is imported.
const state = vi.hoisted(() => ({
  registered: [] as Array<{ id: string; config: { baseUrl?: string; models: Array<{ baseUrl?: string }> } }>,
  runtimeModel: undefined as { baseUrl: string } | undefined,
  continueRecentThrows: false as boolean,
}))

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: {
    create: async () => mockRuntime,
  },
  DefaultResourceLoader: class {
    async reload() {}
  },
  SessionManager: {
    create: () => ({}),
    continueRecent: () => {
      if (state.continueRecentThrows) throw new Error('corrupt transcript tail')
      return {}
    },
  },
  SettingsManager: {
    inMemory: () => ({}),
  },
  createAgentSession: async () => ({
    session: { subscribe: () => () => {} },
  }),
}))

const mockRuntime = {
  setRuntimeApiKey: async () => undefined,
  getModel: (_providerId: string, _modelId: string) => state.runtimeModel,
  registerProvider: (id: string, config: { baseUrl?: string; models: Array<{ baseUrl?: string }> }) => {
    state.registered.push({ id, config })
    state.runtimeModel = { baseUrl: config.models[0]?.baseUrl ?? config.baseUrl ?? '' }
  },
}

function makeHost(options: {
  providerBaseUrl: string
  modelSessionDir?: string
  hasTranscript?: boolean
}) {
  return new SessionHost({
    binding: {
      workspaceId: 'workspace',
      sessionId: 'session',
      workspaceRoot: '/tmp/workspace',
      authority: 'ask',
      permissionCeiling: {} as never,
      toolCeiling: { builtins: [], mcp: false },
      generation: 1,
    },
    model: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
    thinkingLevel: 'off',
    agentDir: '/tmp/agent',
    providers: {
      resolve: () => ({
        providerId: 'deepseek',
        modelId: 'deepseek-v4-flash',
        api: 'openai-completions',
        baseUrl: options.providerBaseUrl,
        apiKey: 'test-key',
        headers: undefined,
        modelMeta: undefined,
      }),
    } as never,
    store: {
      ensureSessionDirs: () => undefined,
      hasTranscript: () => options.hasTranscript ?? false,
      modelSessionDir: () => options.modelSessionDir ?? '/tmp/sessions',
    } as never,
    prompt: { resolveReferences: async () => [], assembleForRun: async () => ({ systemPrompt: '', digest: '', fragments: [] }), snapshotProviderRequest: vi.fn() } as never,
    approvals: { request: vi.fn(), resolve: vi.fn(), cancelSession: vi.fn() } as never,
    events: { observe: () => [], transientDelta: () => null, reset: vi.fn(), finish: () => ({ events: [], usage: { input_tokens: 0, output_tokens: 0 }, suspended_ms: 0 }) } as never,
    observers: { startUsage: () => 'h', finishUsage: vi.fn(), errorUsage: vi.fn(), auditTool: vi.fn() } as never,
    sink: { textDelta: vi.fn(), thinkingDelta: vi.fn(), approvalRequested: vi.fn(), eventCommitted: vi.fn(), turnTerminal: vi.fn() } as never,
    tools: [],
    activeToolNames: [],
    toolNames: { rewriteForProvider: (v: string) => v, toCanonical: (v: string) => v, toProvider: (v: string) => v } as never,
    actionForTool: () => undefined,
    ambient: {
      drainSettledJobs: () => [],
      drainSettledSubagents: () => [],
      hasActiveSubagents: () => false,
      readWorkspaceBytes: async () => new Uint8Array(),
      emitContextUsage: () => undefined,
    },
    costGuard: undefined,
  } as never)
}

afterEach(() => {
  state.runtimeModel = undefined
  state.registered.length = 0
  state.runtimeModel = undefined
  state.continueRecentThrows = false
})

describe('SessionHost provider bind endpoint contract', () => {
  it('re-registers the provider when the native catalog endpoint differs from settings', async () => {
    state.runtimeModel = { ...nativeModel }
    const host = makeHost({ providerBaseUrl: 'http://127.0.0.1:9100/v1' })
    const bound = await host.initialize()
    expect(state.registered).toHaveLength(1)
    expect(state.registered[0].id).toBe('deepseek')
    expect(state.registered[0].config.baseUrl).toBe('http://127.0.0.1:9100/v1')
    expect(state.registered[0].config.models[0]?.baseUrl).toBe('http://127.0.0.1:9100/v1')
    expect(bound.ok).toBe(true)
  })

  it('does not re-register when the native catalog endpoint already matches', async () => {
    state.runtimeModel = { ...nativeModel, baseUrl: 'https://api.deepseek.com' }
    const host = makeHost({ providerBaseUrl: 'https://api.deepseek.com' })
    const bound = await host.initialize()
    expect(state.registered).toHaveLength(0)
    expect(bound.ok).toBe(true)
  })

  it('registers a custom provider when the catalog has no such model at all', async () => {
    state.runtimeModel = undefined
    const host = makeHost({ providerBaseUrl: 'http://127.0.0.1:9100/v1' })
    const bound = await host.initialize()
    expect(state.registered).toHaveLength(1)
    expect(state.registered[0].config.baseUrl).toBe('http://127.0.0.1:9100/v1')
    expect(bound.ok).toBe(true)
  })
})

describe('SessionHost resume quarantine (corrupt transcript)', () => {
  it('quarantines the unreadable transcript dir aside and still binds fresh', async () => {
    state.runtimeModel = { ...nativeModel, baseUrl: 'https://api.deepseek.com' }
    state.continueRecentThrows = true
    const tmp = await mkdtemp(join(tmpdir(), 'tdease-quarantine-'))
    try {
      const dir = join(tmp, 'model-session')
      mkdirSync(dir)
      await writeFile(join(dir, 'transcript.jsonl'), '{"torn')
      const host = makeHost({
        providerBaseUrl: 'https://api.deepseek.com',
        modelSessionDir: dir,
        hasTranscript: true,
      })
      const bound = await host.initialize()
      expect(bound.ok).toBe(true)
      expect(bound.resumed).toBe(false)
      expect(bound.resumeError).toContain('corrupt transcript tail')
      // The torn original survived, renamed aside; the live dir is fresh.
      const entries = readdirSync(tmp)
      const quarantined = entries.find((name) => name.startsWith('model-session.corrupt-'))
      expect(quarantined).toBeDefined()
      expect(readFileSync(join(tmp, quarantined!, 'transcript.jsonl'), 'utf8')).toBe('{"torn')
      expect(readdirSync(dir)).toEqual([])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
