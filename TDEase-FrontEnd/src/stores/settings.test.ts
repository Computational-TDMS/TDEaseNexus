import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { DEFAULT_AGENT_TOOL_SETTINGS } from '@/contracts/agent-runtime'

vi.mock('@/services/catalog/providerCatalog', () => ({
  listProviders: () => [],
  listModels: () => [],
  DEFAULT_PROVIDER_ID: 'deepseek',
  DEFAULT_MODEL_ID: 'deepseek-v4-flash',
}))

vi.mock('@/services/backend/backend', () => ({ setTDEaseBaseUrl: vi.fn() }))

import { useSettingsStore } from './settings'
import { setTDEaseBaseUrl } from '@/services/backend/backend'
import { backendConnectionSupervisor } from '@/services/backend/backendConnection'

describe('settings Agent tool profile', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('uses the wide defaults and persists changes', async () => {
    const store = useSettingsStore()
    expect(store.agentTools).toEqual(DEFAULT_AGENT_TOOL_SETTINGS)
    // Defaults are intentionally wide — every capability on, so a tool the
    // prompt names is never a phantom. Narrowing is the mindset profile's job
    // (createAgentToolProfile), not the settings default. See DEFAULT_AGENT_TOOL_SETTINGS.
    expect(store.agentTools.mcp).toBe(true)
    expect(store.agentTools.shell).toBe(true)

    store.setAgentTool('mcp', false)
    await Promise.resolve()

    expect(JSON.parse(localStorage.getItem('tdease.settings') ?? '{}').agentTools.mcp).toBe(false)
  })

  it('normalizes older settings that have no Agent tool section', () => {
    localStorage.setItem('tdease.settings', JSON.stringify({ provider: 'anthropic' }))
    setActivePinia(createPinia())

    expect(useSettingsStore().agentTools).toEqual(DEFAULT_AGENT_TOOL_SETTINGS)
  })
})

describe('settings provider/model atomic selection', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('setModelFor writes the provider+model pair together', () => {
    const store = useSettingsStore()
    store.provider = 'deepseek'
    store.model = 'deepseek-chat'

    // Browsing another provider's model chip must switch BOTH sides — the
    // old write-the-model-only path produced `{deepseek, claude-*}` pairs
    // that bind into guaranteed API failures.
    store.setModelFor('anthropic', 'claude-sonnet-5')
    expect(store.provider).toBe('anthropic')
    expect(store.model).toBe('claude-sonnet-5')

    // Same-provider selection leaves the provider untouched.
    store.setModelFor('anthropic', 'claude-opus-5')
    expect(store.provider).toBe('anthropic')
    expect(store.model).toBe('claude-opus-5')
  })
})

describe('settings discovered-models persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  const entry = {
    providerId: 'zhipu-coding',
    models: ['glm-5.3', 'glm-5.3-flash'],
    source: 'models-dev',
    updatedAt: 1_700_000_000_000,
    error: null,
  }

  it('restores the discovery merge from localStorage so switchers survive a restart', () => {
    localStorage.setItem('tdease.discovered-models', JSON.stringify({ 'zhipu-coding': entry }))
    setActivePinia(createPinia())

    expect(useSettingsStore().availableModels('zhipu-coding')).toContain('glm-5.3-flash')
  })

  it('persists refresh results so the merge outlives the session', async () => {
    ;(globalThis as { tdeaseDesktop?: unknown }).tdeaseDesktop = {
      agentProviders: {
        readModels: vi.fn().mockResolvedValue({ ...entry, models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2'] }),
      },
    }
    try {
      const store = useSettingsStore()
      await store.refreshProviderModels('zhipu-coding')

      const persisted = JSON.parse(localStorage.getItem('tdease.discovered-models') ?? '{}') as {
        'zhipu-coding'?: { models: string[] }
      }
      expect(persisted['zhipu-coding']?.models).toContain('glm-5.3-flash')
      expect(store.availableModels('zhipu-coding')).toContain('glm-5.3-flash')
    } finally {
      delete (globalThis as { tdeaseDesktop?: unknown }).tdeaseDesktop
    }
  })

  it('ignores malformed persisted entries instead of poisoning the merge', () => {
    localStorage.setItem('tdease.discovered-models', JSON.stringify({ junk: { models: 'not-an-array' } }))
    setActivePinia(createPinia())

    expect(useSettingsStore().providerModelsRefresh('junk')).toBeUndefined()
  })
})

describe('custom providers', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  /** Stateful bridge double over the agentProviders IPC: write/remove mutate
   *  the map `read` serves, like the real settings.json would. */
  function bridgeWithExisting(providers: Record<string, unknown> = {}) {
    const store: Record<string, unknown> = { ...providers }
    ;(globalThis as { tdeaseDesktop?: unknown }).tdeaseDesktop = {
      agentProviders: {
        read: vi.fn().mockImplementation(async () => ({ providers: store })),
        write: vi.fn().mockImplementation(async (id: string, config: Record<string, unknown>) => {
          store[id] = { ...(store[id] as object ?? {}), ...config }
          return { ok: true as const, providerId: id, configured: true }
        }),
        remove: vi.fn().mockImplementation(async (id: string) => {
          delete store[id]
          return { ok: true as const, providerId: id }
        }),
        addModel: vi.fn().mockResolvedValue({ ok: true as const, providerId: 'x', modelId: 'm' }),
      },
    }
    return { store }
  }

  it('creates with a collision-resolved id and surfaces in the catalog view', async () => {
    bridgeWithExisting({ 'custom-relay': { configured: true, name: 'Old Relay', baseUrl: 'https://old/v1', models: ['legacy-model'] } })
    const store = useSettingsStore()
    await store.refreshAgentProviders()

    const id = await store.createCustomProvider({ name: 'Relay', baseUrl: 'https://api.relay.com/v1/' })
    expect(id).toBe('custom-relay-2')

    const view = store.availableProviders()
    expect(view.map((p) => p.id)).toContain('custom-relay-2')
    // Pre-existing custom entry shows its settings.json name and frozen models.
    const existing = view.find((p) => p.id === 'custom-relay')
    expect(existing?.displayName).toBe('Old Relay')
    expect(store.availableModels('custom-relay')).toContain('legacy-model')
  })

  it('drops empty fields from an update so a cosmetic rename never clears the key', async () => {
    const { store } = bridgeWithExisting()
    const settings = useSettingsStore()

    await settings.updateCustomProvider('custom-a', { name: '  Renamed  ', apiKey: '   ' })
    expect(store['custom-a']).toMatchObject({ name: 'Renamed' })
    expect(store['custom-a']).not.toHaveProperty('apiKey')
  })

  it('removing the active custom provider falls back to the default pair', async () => {
    bridgeWithExisting({ 'custom-relay': { configured: true, name: 'Relay' } })
    const store = useSettingsStore()
    await store.refreshAgentProviders()
    store.setModelFor('custom-relay', 'some-model')
    expect(store.provider).toBe('custom-relay')

    await store.removeCustomProvider('custom-relay')
    expect(store.provider).toBe('deepseek')
    expect(store.availableProviders().map((p) => p.id)).not.toContain('custom-relay')
  })
})

describe('remote backend connection', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.mocked(setTDEaseBaseUrl).mockClear()
  })
  afterEach(() => {
    // The supervisor is module-global; stop its probe timers before the next
    // test reuses the process.
    backendConnectionSupervisor.disable()
    delete (globalThis as { tdeaseDesktop?: unknown }).tdeaseDesktop
  })

  /** Stateful backend-bridge double: `configure` persists the settings block,
   *  `connection` serves it (remote) or an embedded-style one (local mode). */
  function backendBridge(state: { mode: 'local' | 'remote'; baseUrl: string | null; accessToken: string | null }) {
    const configure = vi.fn().mockImplementation(async (input: { mode: string; baseUrl?: string; accessToken?: string }) => {
      if (input.mode === 'remote') {
        state.mode = 'remote'
        state.baseUrl = (input.baseUrl ?? '').trim().replace(/\/+$/, '')
        state.accessToken = typeof input.accessToken === 'string' && input.accessToken.trim()
          ? input.accessToken.trim()
          : input.accessToken === undefined ? state.accessToken : null
      } else {
        state.mode = 'local'; state.baseUrl = null; state.accessToken = null
      }
      return { mode: state.mode, baseUrl: state.baseUrl, accessTokenConfigured: state.accessToken !== null }
    })
    const connection = vi.fn().mockImplementation(async () => state.mode === 'remote' && state.baseUrl
      ? { baseUrl: state.baseUrl, accessToken: state.accessToken }
      : { baseUrl: 'http://127.0.0.1:51016', accessToken: 'embedded-token' })
    ;(globalThis as { tdeaseDesktop?: unknown }).tdeaseDesktop = { backend: { configure, connection } }
    return { configure, connection }
  }

  function remoteStore(url = 'https://backend.example') {
    const store = useSettingsStore()
    store.backendMode = 'remote'
    store.backendUrl = url
    return store
  }

  it('persists the typed token through configure and installs it on the client', async () => {
    const { configure } = backendBridge({ mode: 'local', baseUrl: null, accessToken: null })
    const store = remoteStore('https://backend.example/')
    store.backendAccessToken = 'sekret'

    await store.connectBackend({ awaitFirstProbe: false })

    // Trailing slash normalization happens before the write-through.
    expect(configure).toHaveBeenCalledWith({ mode: 'remote', baseUrl: 'https://backend.example', accessToken: 'sekret' })
    expect(setTDEaseBaseUrl).toHaveBeenCalledWith('https://backend.example', 'sekret')
    expect(store.backendTokenConfigured).toBe(true)
  })

  it('treats an empty form token as keep-the-persisted-one, never a wipe', async () => {
    backendBridge({ mode: 'remote', baseUrl: 'https://backend.example', accessToken: 'kept-token' })
    const store = remoteStore()
    store.backendAccessToken = ''

    await store.connectBackend({ awaitFirstProbe: false })

    expect(store.backendTokenConfigured).toBe(true)
    // The handshake re-hydrates the persisted token the form never echoed.
    expect(setTDEaseBaseUrl).toHaveBeenCalledWith('https://backend.example', 'kept-token')
  })

  it('boot (persist:false) never rewrites the persisted block but still serves its token', async () => {
    const { configure } = backendBridge({ mode: 'remote', baseUrl: 'https://backend.example', accessToken: 'boot-token' })
    const store = remoteStore()

    await store.connectBackend({ awaitFirstProbe: false, persist: false })

    expect(configure).not.toHaveBeenCalled()
    expect(setTDEaseBaseUrl).toHaveBeenCalledWith('https://backend.example', 'boot-token')
  })
})
