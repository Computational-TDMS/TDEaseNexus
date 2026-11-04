import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'

/**
 * Provider OAuth login — the bridge between Pi's built-in OAuth flows
 * (callback server + PKCE + token refresh, keyed by pi's provider id) and the
 * desktop UI. The renderer drives everything through IPC: pushes carry the
 * flow's prompts and events (auth URL to open, device codes, progress), and
 * the renderer answers prompts with a one-shot resolve. Credentials persist
 * into the shared `authPath` (`<systemRoot>/agent/auth.json`) — the same file
 * every SessionHost's ModelRuntime reads, so a login here is a login for all
 * sessions without the secret ever reaching the renderer.
 *
 * Scope: the two flows Pi ships and maintains best — ChatGPT sign-in
 * (`openai-codex`) and the Anthropic account login. Adding a provider is one
 * map entry (plus UI whitelist if desired), not new architecture.
 */

/** Our catalog id → the pi provider id owning the OAuth flow and its models. */
export const OAUTH_PROVIDER_IDS: Readonly<Record<string, string>> = {
  'openai-codex-oauth': 'openai-codex',
  anthropic: 'anthropic',
}

/** Serializable view of one flow prompt, rendered by the settings UI. */
export type ProviderAuthPromptView = {
  promptId: string
} & AuthPrompt

/** Everything main pushes to the initiating renderer during a login. */
export type ProviderAuthPush =
  | { kind: 'notify'; event: AuthEvent }
  | { kind: 'prompt'; prompt: ProviderAuthPromptView }
  | { kind: 'done'; ok: boolean; error?: string }

export interface ProviderAuthStatus {
  id: string
  configured: boolean
  source?: string
  label?: string
  /** Model ids the pi catalog carries for this provider — merged into the picker. */
  models?: string[]
}

export interface ProviderAuthServiceOptions {
  /** Shared credential file — MUST match the SessionHost runtime's authPath. */
  authPath: string
  push: (payload: ProviderAuthPush) => void
  openExternal: (url: string) => void
  /** Runtime factory, injectable for tests. Defaults to the real ModelRuntime. */
  createRuntime?: (options: { authPath: string }) => Promise<ProviderAuthRuntime>
}

/** The slice of ModelRuntime the service consumes. */
export interface ProviderAuthRuntime {
  login(providerId: string, type: 'oauth', interaction: import('@earendil-works/pi-ai').AuthInteraction): Promise<unknown>
  getProviderAuthStatus(providerId: string): { configured: boolean; source?: string; label?: string }
  getModels(providerId: string): ReadonlyArray<{ id: string }>
}

export interface ProviderAuthService {
  login(catalogProviderId: string): Promise<{ ok: boolean; error?: string }>
  /** Abort the active login (renderer closed the dialog / pressed cancel). */
  cancel(): void
  /** Answer a pending flow prompt; unknown ids are ignored. */
  resolvePrompt(promptId: string, value: string): void
  status(): Promise<ProviderAuthStatus[]>
}

export function createProviderAuthService(options: ProviderAuthServiceOptions): ProviderAuthService {
  const { authPath, push, openExternal } = options
  const createRuntime = options.createRuntime ?? (async (runtimeOptions) => ModelRuntime.create(runtimeOptions))
  let active: {
    controller: AbortController
    pending: Map<string, (value: string) => void>
  } | null = null

  async function login(catalogProviderId: string): Promise<{ ok: boolean; error?: string }> {
    const piProviderId = OAUTH_PROVIDER_IDS[catalogProviderId]
    if (!piProviderId) return { ok: false, error: `No OAuth flow for provider: ${catalogProviderId}` }
    if (active) return { ok: false, error: 'A login is already in progress' }

    const controller = new AbortController()
    const pending = new Map<string, (value: string) => void>()
    active = { controller, pending }
    const interaction: import('@earendil-works/pi-ai').AuthInteraction = {
      signal: controller.signal,
      notify: (event) => {
        // The desktop equivalent of "the TUI printed a URL": open it for the
        // user AND mirror the event so the dialog can show instructions/codes.
        if (event.type === 'auth_url') openExternal(event.url)
        push({ kind: 'notify', event })
      },
      prompt: (prompt: AuthPrompt) => new Promise<string>((resolve, reject) => {
        const promptId = `p-${Date.now()}-${pending.size}`
        if (controller.signal.aborted) {
          reject(new Error('Login cancelled'))
          return
        }
        pending.set(promptId, (value) => {
          pending.delete(promptId)
          resolve(value)
        })
        // Per-prompt abort: the flow resolved this step out-of-band (e.g. the
        // callback server won the race against the manual-code prompt).
        prompt.signal?.addEventListener('abort', () => {
          pending.delete(promptId)
          reject(new Error('Prompt superseded'))
        }, { once: true })
        push({ kind: 'prompt', prompt: { promptId, ...prompt } })
      }),
    }

    const result: { ok: boolean; error?: string } = await (async () => {
      try {
        const runtime = await createRuntime({ authPath })
        await runtime.login(piProviderId, 'oauth', interaction)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })()
    active = null
    push({ kind: 'done', ...result })
    return result
  }

  function cancel(): void {
    active?.controller.abort()
  }

  function resolvePrompt(promptId: string, value: string): void {
    const resolve = active?.pending.get(promptId)
    if (resolve) resolve(value)
  }

  async function status(): Promise<ProviderAuthStatus[]> {
    try {
      const runtime = await createRuntime({ authPath })
      return Object.entries(OAUTH_PROVIDER_IDS).map(([id, piProviderId]) => {
        const status = runtime.getProviderAuthStatus(piProviderId)
        return {
          id,
          configured: status.configured,
          ...(status.source ? { source: status.source } : {}),
          ...(status.label ? { label: status.label } : {}),
          models: runtime.getModels(piProviderId).map((model) => model.id),
        }
      })
    } catch {
      return Object.keys(OAUTH_PROVIDER_IDS).map((id) => ({ id, configured: false }))
    }
  }

  return { login, cancel, resolvePrompt, status }
}
