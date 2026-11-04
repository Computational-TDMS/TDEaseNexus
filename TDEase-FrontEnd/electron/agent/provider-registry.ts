/**
 * Node-side ProviderRegistry: reads the provider catalog + credentials from
 * `<Client System>/settings.json` (`providers`). No build-baked credential
 * exists: users configure their own provider keys in Settings.
 *
 * This is the one place the apiKey ever lives in memory. The Renderer never
 * sees it: `summarize()` returns only `configured: boolean`, and `resolve()`
 * hands the secret straight to the Pi provider adapter inside Node. Keeping
 * that boundary in this one file is what lets us audit "no secret crosses IPC"
 * by grepping a single module (AGENT-CONTRACT.md §1).
 *
 * The file is small and rarely written, so each call re-reads it. That trades a
 * tiny bit of IO for never serving a stale credential after the user edits
 * settings — a stale apiKey would surface as a confusing 401 mid-turn, and the
 * settings file is read at most a few times per prompt.
 *
 * Defensive parsing throughout: a corrupt or partial settings.json must degrade
 * to "no providers" (`summarize()` → []) rather than throw at startup. Only
 * `resolve()` throws, because a request for a specific unconfigured provider is
 * a real error the caller must surface (it cannot silently fall back).
 */

import { readFileSync } from 'node:fs'

import type {
  AgentModelMetadata,
  ModelSelector,
} from '../../src/contracts/agent-runtime'
import { PROVIDERS } from '../../src/services/catalog/provider-definitions'
import { updateSettingsFile } from '../atomic-write'

import type { ProviderRegistry, ProviderSummary, ResolvedProvider } from './contracts'

// ── settings.json v3 shape (only the fields this module reads) ───────────────
//
// Mirroring only the slice we consume keeps us resilient to the schema growing
// new top-level keys. The full schema lives in the plan; this is the contract
// this module actually depends on.
interface SettingsFile {
  schemaVersion?: number
  providers?: Record<string, ProviderConfig>
}

interface ProviderConfig {
  name?: string
  api?: string
  baseUrl?: string
  base_url?: string
  apiKey?: string
  api_key?: string
  headers?: Record<string, string>
  models?: Record<string, AgentModelMetadata>
}

/** Sentinel returned when the file is missing/corrupt — treated as "no agent config". */
const EMPTY_SETTINGS: SettingsFile = {}

/**
 * Credential seam for safeStorage-backed keys: the agent runtime lives in a
 * utilityProcess where Electron's safeStorage is unreachable, so main decrypts
 * credentials.json and hands the plaintext keys in via this sync lookup. A
 * config carrying a legacy plaintext `apiKey` (pre-migration install, or an OS
 * without key storage) still wins — the encrypted store only ever ADDS a way
 * to find a key, never shadows an explicit settings value. Optional so every
 * non-Electron caller (tests, tooling) keeps today's behavior.
 */
export type CredentialKeyLookup = (providerId: string) => string | null

export class NodeProviderRegistry implements ProviderRegistry {
  constructor(
    private readonly settingsPath: string,
    private readonly credentialKey?: CredentialKeyLookup,
  ) {}

  /**
   * Resolve a concrete provider+model for one model call. Throws if the
   * provider is not configured at all — a missing provider is a config error
   * the caller must surface, not silently fall back from.
   *
   * `api` defaults to 'openai-completions' because that is the only adapter
   * Pi ships today; an absent field should not break a config that omitted it
   * explicitly relying on the default. `baseUrl` falls back to the static
   * catalog's default the same way: the Settings UI shows it as a placeholder,
   * so a key-only config must resolve to the vendor's real endpoint — an
   * empty baseUrl reaches Pi's provider registration and is rejected there
   * ("baseUrl is required when defining custom models") for every provider
   * Pi does not natively catalog.
   */
  resolve(selector: ModelSelector): ResolvedProvider {
    const config = this.readConfig().providers?.[selector.providerId]
    if (!config) {
      throw new Error(`Provider not configured: ${selector.providerId}`)
    }
    const modelMeta = config?.models?.[selector.modelId]
    const catalogBaseUrl = PROVIDERS.find((candidate) => candidate.id === selector.providerId)?.defaultBaseUrl
    return {
      providerId: selector.providerId,
      modelId: selector.modelId,
      api: config?.api ?? 'openai-completions',
      baseUrl: config?.baseUrl ?? config?.base_url ?? catalogBaseUrl ?? '',
      // `apiKey` is intentionally `undefined`-on-absent, not empty-string, so a
      // downstream `if (provider.apiKey)` check works without a length probe.
      apiKey: config?.apiKey || config?.api_key || this.credentialKey?.(selector.providerId) || undefined,
      headers: config?.headers,
      modelMeta,
    }
  }

  /**
   * One summary per configured provider. Never includes the apiKey — only the
   * boolean `configured` (non-empty key present). Used to populate the Renderer's
   * provider picker without leaking secrets across IPC.
   */
  summarize(): ReadonlyArray<ProviderSummary> {
    const providers = this.readConfig().providers
    const summaries: ProviderSummary[] = []
    if (providers) {
      for (const [providerId, config] of Object.entries(providers)) {
        summaries.push({
          providerId,
          // No "display name" field exists in the v3 schema today; the providerId
          // is the stable identity the user configured, so it doubles as the label.
          // When a nicer name is added, read it here.
          displayName: config.name || providerId,
          models: config.models ? Object.keys(config.models) : [],
          configured: Boolean(config.apiKey || config.api_key || this.credentialKey?.(providerId)),
        })
      }
    }
    return summaries
  }

  /** True when the selected provider has a non-empty apiKey. */
  isConfigured(selector: ModelSelector): boolean {
    const config = this.readConfig().providers?.[selector.providerId]
    return Boolean(config && (config.apiKey || config.api_key || this.credentialKey?.(selector.providerId)))
  }

  /**
   * Freeze one model's discovered capability digest into settings.json
   * (`providers.<id>.models.<modelId>`), where it becomes the highest-priority
   * input of the capability seam. Per-model field-level merge: a hand-edited
   * field (e.g. a thinkingLevelMap settings can carry but discovery cannot)
   * survives; sibling models are untouched. Never throws and never invents a
   * settings file — persistence is an optimization, the caller already runs
   * on the digest. Routes through updateSettingsFile: the read-modify-write
   * is serialized with every other settings producer and the rename carries
   * the Windows retry.
   */
  async persistModelMeta(selector: ModelSelector, meta: AgentModelMetadata): Promise<void> {
    try {
      await updateSettingsFile(this.settingsPath, (doc) => {
        if (!doc) return null // never invent a settings file
        const providers = doc.providers as Record<string, ProviderConfig> | undefined
        const config = providers?.[selector.providerId]
        if (!config) return null
        const models = {
          ...(config.models ?? {}),
          [selector.modelId]: { ...(config.models?.[selector.modelId] ?? {}), ...meta },
        }
        return { ...doc, providers: { ...providers, [selector.providerId]: { ...config, models } } }
      })
    } catch {
      // A failed freeze costs a re-resolve on the next bind, nothing more.
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Read + parse settings.json. Any error (missing file, bad JSON, wrong shape)
   * degrades to the empty sentinel: a half-written or absent settings file is a
   * runtime condition the caller treats as "no providers configured", not a
   * crash. Only `resolve()` later turns "not configured" into a thrown error
   * with the offending providerId.
   *
   * Synchronous on purpose: resolve/summarize/isConfigured are sync in the
   * contract, and the settings file is tiny and local, so `readFileSync` is the
   * cheapest correct bridge. The old IPC path paid the same disk cost.
   */
  private readConfig(): SettingsFile {
    let text: string
    try {
      text = readFileSync(this.settingsPath, 'utf8')
    } catch {
      return EMPTY_SETTINGS
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return EMPTY_SETTINGS
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_SETTINGS
    const doc = parsed as SettingsFile
    // Tolerate a missing or different schemaVersion by returning the provider
    // block when present; settings schema growth must not disable credentials. No guard
    // is applied here so a settings file that bumps schemaVersion but keeps the
    // provider block does not hard-fail — a future tightening would be deliberate.
    return doc
  }
}
