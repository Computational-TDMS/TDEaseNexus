import { describe, expect, it, vi } from 'vitest'

import type { AuthInteraction } from '@earendil-works/pi-ai'

import {
  createProviderAuthService,
  OAUTH_PROVIDER_IDS,
  type ProviderAuthPush,
  type ProviderAuthRuntime,
} from './provider-auth'

/**
 * Fake runtime: login captures the interaction so a test drives the flow
 * exactly as pi's OAuth implementations do — notify(auth_url) then a secret
 * prompt, resolving the login when the prompt is answered.
 */
function fakeRuntime(overrides: Partial<ProviderAuthRuntime> = {}): ProviderAuthRuntime & {
  interactions: AuthInteraction[]
  resolveLogin: (credential?: unknown) => void
} {
  const interactions: AuthInteraction[] = []
  let settle: ((credential?: unknown) => void) | null = null
  return {
    interactions,
    resolveLogin: (credential) => { settle?.(credential) },
    login: (providerId, type, interaction) => new Promise((resolve, reject) => {
      interactions.push(interaction)
      // Mirror the real flow: an aborted interaction rejects the login —
      // including an ALREADY-aborted signal (cancel racing login start),
      // since abort events never fire retroactively.
      if (interaction.signal?.aborted) {
        reject(new Error('Login cancelled'))
        return
      }
      interaction.signal?.addEventListener('abort', () => reject(new Error('Login cancelled')), { once: true })
      settle = (credential) => resolve({ credential: credential ?? 'oauth-token', providerId, type })
    }),
    getProviderAuthStatus: (providerId) => ({ configured: true, source: 'oauth', label: `ChatGPT (${providerId})` }),
    getModels: (providerId) => [{ id: `${providerId}-model-a` }, { id: `${providerId}-model-b` }],
    ...overrides,
  }
}

function service(runtime: ProviderAuthRuntime) {
  const pushes: ProviderAuthPush[] = []
  const opened: string[] = []
  const instance = createProviderAuthService({
    authPath: '/tmp/auth.json',
    push: (payload) => pushes.push(payload),
    openExternal: (url) => opened.push(url),
    createRuntime: async () => runtime,
  })
  return { instance, pushes, opened }
}

describe('provider-auth service', () => {
  it('rejects providers without an OAuth flow mapping before touching a runtime', async () => {
    const runtime = fakeRuntime()
    const { instance } = service(runtime)

    const result = await instance.login('deepseek')

    expect(result.ok).toBe(false)
    expect(runtime.interactions).toHaveLength(0)
  })

  it('drives the flow: opens the auth URL, surfaces prompts, resolves with the answer', async () => {
    const runtime = fakeRuntime()
    const { instance, pushes, opened } = service(runtime)
    const login = instance.login('openai-codex-oauth')

    // The flow runs against pi's own provider id, not our catalog id.
    await vi.waitFor(() => expect(runtime.interactions).toHaveLength(1))
    const interaction = runtime.interactions[0]
    expect(OAUTH_PROVIDER_IDS['openai-codex-oauth']).toBe('openai-codex')

    void interaction.notify!({ type: 'auth_url', url: 'https://auth.example.com/consent' })
    expect(opened).toEqual(['https://auth.example.com/consent'])

    const promptPromise = interaction.prompt({ type: 'secret', message: 'Paste the code' })
    await vi.waitFor(() => expect(pushes.some((p) => p.kind === 'prompt')).toBe(true))
    const promptPush = pushes.find((candidate): candidate is Extract<ProviderAuthPush, { kind: 'prompt' }> => candidate.kind === 'prompt')
    instance.resolvePrompt(promptPush!.prompt.promptId, 'code-123')
    await expect(promptPromise).resolves.toBe('code-123')

    runtime.resolveLogin()
    await expect(login).resolves.toEqual({ ok: true })
    expect(pushes.at(-1)).toMatchObject({ kind: 'done', ok: true })
  })

  it('cancel aborts the flow and reports the failure', async () => {
    const runtime = fakeRuntime()
    const { instance, pushes } = service(runtime)
    const login = instance.login('anthropic')

    await vi.waitFor(() => expect(runtime.interactions).toHaveLength(1))
    // A hung prompt represents the flow waiting on the user. Real flows chain
    // the interaction's abort into each prompt's signal — mirror that here.
    // Handlers attach IMMEDIATELY: the cancel below rejects the prompt
    // synchronously, and an unhandled rejection window would fail the test.
    const promptAbort = new AbortController()
    runtime.interactions[0].signal?.addEventListener('abort', () => promptAbort.abort(), { once: true })
    const promptOutcome = runtime.interactions[0].prompt({ type: 'text', message: 'Waiting for input', signal: promptAbort.signal })
      .then(() => 'resolved', (error) => `rejected: ${error instanceof Error ? error.message : String(error)}`)
    instance.cancel()

    const result = await login
    expect(result.ok).toBe(false)
    await expect(promptOutcome).resolves.toContain('rejected')
    expect(pushes.at(-1)).toMatchObject({ kind: 'done', ok: false })
    // The slot is free again — a new login can start.
    const second = instance.login('anthropic')
    instance.cancel()
    expect((await second).ok).toBe(false)
  })

  it('reports per-provider status with the pi catalog models, keyed by our ids', async () => {
    const { instance } = service(fakeRuntime())

    const statuses = await instance.status()

    expect(statuses.map((entry) => entry.id)).toEqual(['openai-codex-oauth', 'anthropic'])
    const codex = statuses.find((entry) => entry.id === 'openai-codex-oauth')!
    expect(codex.configured).toBe(true)
    expect(codex.models).toContain('openai-codex-model-a')
  })
})
