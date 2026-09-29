/**
 * Settings store — provider, model, credentials, backend configuration.
 *
 * Provider/model selection + backend mode persist to localStorage; credentials
 * do NOT. Credentials are written through the `agentProviders` IPC to
 * `<Client System>/settings.json` (`providers`), which is the single
 * truth Node's ProviderRegistry reads at bind time. This store only ever holds
 * a redacted `configured` flag in memory — the apiKey never lives in the
 * Renderer except transiently in the edit field, and never crosses back from
 * main. Model lists start from the static catalog; main's refresher
 * (`settings:read-provider-models`, vendor /models + models.dev, TTL-cached)
 * augments them additively — a refreshed list never removes or reorders the
 * curated entries, and never touches what a session binds against.
 */

import { defineStore } from 'pinia'
import { onScopeDispose, ref, watch } from 'vue'
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  listProviders,
  listModels,
  type CredentialInput,
  type ProviderInfo,
} from '@/services/catalog/providerCatalog'
import { setTDEaseBaseUrl } from '@/services/backend/backend'
import { desktopAgentProvidersBridge, desktopBackendBridge, type ProviderModelsResult, type ModelPricingBridge } from '@/services/desktop/desktopBridge'
import {
  backendConnectionSupervisor,
  type BackendConnectionPhase,
} from '@/services/backend/backendConnection'
import {
  DEFAULT_AGENT_TOOL_SETTINGS,
  normalizeAgentToolSettings,
  type AgentToolSettingKey,
  type AgentToolSettings,
} from '@/contracts/agent-runtime'

const STORAGE_KEY = 'tdease.settings'

/**
 * User-defined OpenAI-compatible providers live in settings.json under ids
 * with this prefix. The prefix IS the discriminator — everything else about a
 * custom provider (name, baseUrl, key, model list) is ordinary provider
 * config the runtime already resolves (NodeProviderRegistry accepts any
 * settings.json providers key).
 */
export const CUSTOM_PROVIDER_PREFIX = 'custom-'

export function isCustomProviderId(providerId: string): boolean {
  return providerId.startsWith(CUSTOM_PROVIDER_PREFIX)
}

/**
 * Font-scale bounds (Phase E). Exported so the Appearance settings panel and
 * the shortcut handler share the exact same range/step without re-declaring
 * them. The store clamps to these in `setFontScale`.
 */
export const FONT_SCALE_MIN = 0.85
export const FONT_SCALE_MAX = 1.4
export const FONT_SCALE_STEP = 0.05

/** Redacted provider summary read back from settings.json via IPC. */
interface AgentProviderSummary {
  configured: boolean
  /** Display name of user-defined providers ("custom-*"); catalog providers
   *  name themselves in the static catalog. */
  name?: string
  baseUrl?: string
  models?: string[]
  /**
   * Non-secret credential fingerprint (hash prefix of the stored apiKey).
   * Belongs in the turn binding key: a key swap changes nothing the binding
   * key used to watch, so the session stayed bound on the OLD credential
   * until a restart. Never the key itself — a hash prefix only.
   */
  credentialFingerprint?: string
}
interface AgentProviderConfig {
  providers: Record<string, AgentProviderSummary>
}

function loadStored(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

/** Read the redacted agent provider config from settings.json over IPC. */
function readAgentProviders(): Promise<AgentProviderConfig> {
  const bridge = desktopAgentProvidersBridge()
  // A partial bridge (test doubles, non-desktop hosts) must fail soft here:
  // a synchronous throw would escape the caller's `.catch` as an unhandled
  // rejection from the fire-and-forget boot call.
  if (!bridge || typeof bridge.read !== 'function') return Promise.resolve({ providers: {} })
  return bridge.read()
}

/** Atomically merge one provider's config into settings.json over IPC. */
function writeAgentProvider(providerId: string, config: Record<string, unknown>): Promise<{ ok: true; providerId: string; configured: boolean }> {
  const bridge = desktopAgentProvidersBridge()
  if (!bridge) throw new Error('Agent provider bridge is unavailable')
  return bridge.write(providerId, config)
}

/** Origin equality for "is the handshake serving the backend the form points at". */
function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin } catch { return false }
}

export const useSettingsStore = defineStore('settings', () => {
  const stored = loadStored()

  // Internal-test default: DeepSeek + v4-flash. The shipped settings.seed.json
  // pre-fills the DeepSeek key, so this pair makes a fresh install usable
  // out of the box. Users who pick another provider persist their choice and
  // are unaffected.
  const provider = ref<string>((stored.provider as string) || DEFAULT_PROVIDER_ID)
  const model = ref<string>((stored.model as string) || DEFAULT_MODEL_ID)
  const backendMode = ref<'disabled' | 'local' | 'remote'>(
    stored.backendMode === 'disabled' || stored.backendMode === 'remote' ? stored.backendMode : 'local',
  )
  const backendUrl = ref<string>(typeof stored.backendUrl === 'string' ? stored.backendUrl : '')
  // The remote backend's bearer token, as typed in the form. Deliberately NOT
  // persisted here: the durable copy lives in the main-process settings block
  // (written through `backend:configure`), and boot re-hydrates the live value
  // from the `backend:connection` handshake — the same channel the embedded
  // mode has always used to hand the renderer its session token.
  const backendAccessToken = ref<string>('')
  // Display-only mirror of "the persisted connection carries a token" so the
  // password field can say "saved — leave empty to keep it".
  const backendTokenConfigured = ref<boolean>(false)
  const backendConnected = ref(false)
  const backendConnecting = ref(false)
  const backendError = ref<string | null>(null)
  const backendState = ref<BackendConnectionPhase>(backendMode.value === 'disabled' ? 'disabled' : 'offline')
  const agentTools = ref<AgentToolSettings>(normalizeAgentToolSettings(stored.agentTools))
  /**
   * Programmatic tool calling (tdease.ptc.exec): on by default, opt-out via
   * the settings switch — distinct from orchestration (subagent
   * organization). When off, the command is never advertised and the prompt
   * carries no PTC guidance; the binding only turns it on for new sessions.
   */
  const ptcEnabled = ref<boolean>(stored.ptcEnabled !== false)
  /**
   * User-driven font zoom (Phase E of the palot inspector migration). Applied
   * to <html> as `--font-scale`, which every type token multiplies by in
   * unified-design-tokens.css — the single choke point. Range 0.85–1.4 in
   * 0.05 steps; Ctrl+= / Ctrl+- / Ctrl+0 (AppShell) drive it, and the
   * Appearance settings panel exposes a stepper.
   */
  const storedFontScale = typeof stored.fontScale === 'number'
    && Number.isFinite(stored.fontScale)
    && stored.fontScale >= FONT_SCALE_MIN
    && stored.fontScale <= FONT_SCALE_MAX
      ? stored.fontScale : 1
  const fontScale = ref<number>(storedFontScale)
  /**
   * The Agent permission mode (`ask` | `auto`) — PERSISTENCE ONLY. The
   * runtime truth lives on the agent store (`stores/agent.ts` turn
   * preferences). These refs are PRIVATE persistence slots: the only writer
   * is `writeTurnPrefs` (the persistence sink useAgentTurn registers), the
   * only reader is `readTurnPrefs` (the boot hydration source). Not exported,
   * so a second writer cannot even typecheck.
   *
   * Default `auto`. v1 payloads (anything written before 2026-09-08) defaulted
   * to `ask`, so their stored `ask` says nothing about intent — the version
   * marker is what distinguishes "the old default" from a deliberate choice,
   * and only a v2 `ask` is honoured verbatim.
   */
  const TURN_PREFS_VERSION = 2
  const storedTurnPrefsVersion = typeof stored.turnPrefsVersion === 'number' ? stored.turnPrefsVersion : 1
  const permissionMode = ref<'ask' | 'auto'>(
    stored.permissionMode === 'ask' && storedTurnPrefsVersion >= TURN_PREFS_VERSION ? 'ask' : 'auto',
  )
  /**
   * The Agent reasoning effort — persistence-only companion of
   * `permissionMode` above. Validated against the canonical ThinkingLevel
   * union so a stale/seeded value outside the set falls back to `medium`.
   */
  const VALID_THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
  const thinkingLevel = ref<string>(
    VALID_THINKING_LEVELS.includes(stored.thinkingLevel as typeof VALID_THINKING_LEVELS[number])
      ? (stored.thinkingLevel as string)
      : 'medium',
  )

  /**
   * The persistence seam for the agent store's turn preferences. Boot reads
   * through `readTurnPrefs`; the agent store's persistence watcher writes
   * through `writeTurnPrefs`. Keeping the refs unexported makes this the
   * only writer the type system allows.
   */
  function readTurnPrefs(): { permissionMode: 'ask' | 'auto'; thinkingLevel: string } {
    return { permissionMode: permissionMode.value, thinkingLevel: thinkingLevel.value }
  }
  function writeTurnPrefs(prefs: { permissionMode: 'ask' | 'auto'; thinkingLevel: string }): void {
    permissionMode.value = prefs.permissionMode
    thinkingLevel.value = prefs.thinkingLevel
  }
  /** Redacted provider summaries from settings.json; refreshed on read/write. */
  const agentProviderConfig = ref<Record<string, AgentProviderSummary>>({})
  /** providerId → modelId → declared price (USD/1M tokens), read back from
   *  settings.json. Only models the user actually priced appear. */
  const providerPricing = ref<Record<string, Record<string, ModelPricingBridge>>>({})
  const DISCOVERED_MODELS_KEY = 'tdease.discovered-models'
  /**
   * Live model lists per provider, fetched by main (discovery + aggregator).
   * Persisted to localStorage: the discovery merge is what every model
   * switcher reads on top of the static catalog, and discovery only runs
   * on demand — without persistence a restart blanked every dropdown back
   * to the curated floor until somebody happened to reopen the provider
   * detail page.
   */
  const refreshedProviderModels = ref<Record<string, ProviderModelsResult>>(readDiscoveredModels())

  // ── Discovery persistence (advisory data, tolerant shape) ────────────────────

  function readDiscoveredModels(): Record<string, ProviderModelsResult> {
    try {
      const raw = localStorage.getItem(DISCOVERED_MODELS_KEY)
      if (!raw) return {}
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const restored: Record<string, ProviderModelsResult> = {}
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue
        const v = value as Record<string, unknown>
        if (typeof v.providerId !== 'string' || v.providerId !== id) continue
        if (!Array.isArray(v.models) || !v.models.every((m) => typeof m === 'string')) continue
        if (v.source !== 'provider' && v.source !== 'models-dev' && v.source !== 'cache' && v.source !== 'none') continue
        if (typeof v.updatedAt !== 'number' || (v.error !== null && typeof v.error !== 'string')) continue
        restored[id] = {
          providerId: v.providerId,
          models: v.models as string[],
          source: v.source,
          updatedAt: v.updatedAt,
          error: v.error,
        }
      }
      return restored
    } catch {
      return {}
    }
  }

  function persistDiscoveredModels(): void {
    try {
      localStorage.setItem(DISCOVERED_MODELS_KEY, JSON.stringify(refreshedProviderModels.value))
    } catch { /* advisory data — a dead localStorage costs nothing */ }
  }

  // ── Derived ──────────────────────────────────────────────────────────────────
  /** Custom providers as synthetic catalog entries, so every picker that reads
   *  availableProviders() sees them next to the curated 38 with zero
   *  per-surface wiring. */
  function customProviderInfos(): ProviderInfo[] {
    return Object.entries(agentProviderConfig.value)
      .filter(([id]) => isCustomProviderId(id))
      .map(([id, summary]) => ({
        id,
        displayName: summary.name || id,
        authType: 'api-key' as const,
        defaultBaseUrl: summary.baseUrl ?? '',
        defaultApi: 'openai-completions',
        models: summary.models ?? [],
      }))
  }

  /** All available providers: static catalog first, then user-defined. */
  function availableProviders(): ProviderInfo[] {
    return [...listProviders(), ...customProviderInfos()]
  }

  /**
   * Models for a provider: the curated static list first, then frozen model
   * ids from settings.json (the only list a custom endpoint has until
   * discovery runs), then anything the live refresh discovered, in vendor
   * order. Additive merge — earlier sources are stable, later ones only add.
   */
  function availableModels(providerId: string = provider.value): string[] {
    const merged = [...listModels(providerId)]
    const summary = agentProviderConfig.value[providerId]
    if (summary?.models?.length) {
      for (const modelId of summary.models) {
        if (!merged.includes(modelId)) merged.push(modelId)
      }
    }
    const refreshed = refreshedProviderModels.value[providerId]
    if (refreshed?.models.length) {
      for (const modelId of refreshed.models) {
        if (!merged.includes(modelId)) merged.push(modelId)
      }
    }
    return merged
  }

  /** The raw refresh result for a provider (source/updatedAt/error for the UI). */
  function providerModelsRefresh(providerId: string): ProviderModelsResult | undefined {
    return refreshedProviderModels.value[providerId]
  }

  /** Ask main to refresh one provider's live model list (no-op in browser dev). */
  async function refreshProviderModels(providerId: string, options: { force?: boolean } = {}): Promise<void> {
    const bridge = desktopAgentProvidersBridge()
    if (!bridge?.readModels) return
    const result = await bridge.readModels(providerId, options).catch(() => null)
    if (result) {
      refreshedProviderModels.value[providerId] = result
      persistDiscoveredModels()
    }
  }

  /**
   * Feed OAuth status models (the pi catalog's ids for a logged-in provider)
   * into the same additive merge the live refresh uses — the picker learns
   * the exact model ids the runtime can actually resolve.
   */
  function noteOAuthModels(providerId: string, models: string[]) {
    if (models.length === 0) return
    refreshedProviderModels.value[providerId] = {
      providerId,
      models,
      source: 'provider',
      updatedAt: Date.now(),
      error: null,
    }
    persistDiscoveredModels()
  }

  /**
   * Redacted credential view for the currently selected provider. The apiKey is
   * never returned by main; this carries only `configured`, `baseUrl`, `models`
   * so the settings UI can show state without holding the secret.
   */
  function currentCredential(): CredentialInput | null {
    const summary = agentProviderConfig.value[provider.value]
    if (!summary) return null
    const cred: CredentialInput = {}
    if (summary.baseUrl) cred.baseUrl = summary.baseUrl
    return Object.keys(cred).length ? cred : null
  }

  /**
   * Whether a provider is usable right now — THE single configured rule every
   * surface (model picker, settings provider list, credential warning) reads.
   * OAuth-backed providers authenticate through the shared auth.json
   * (provider-auth.ts login), which the redacted summary cannot see, and
   * no-auth providers need nothing — both always pass; api-key providers
   * (catalog and custom alike) need the `configured` flag from settings.json.
   */
  function isProviderConfigured(providerId: string): boolean {
    const p = availableProviders().find(ap => ap.id === providerId)
    if (!p) return false
    if (p.authType !== 'api-key') return true
    return agentProviderConfig.value[providerId]?.configured === true
  }

  /** Whether the current provider has a usable credential in settings.json. */
  function hasProviderCredential(): boolean {
    return isProviderConfigured(provider.value)
  }

  /** Refresh the redacted provider summaries from settings.json. */
  async function refreshAgentProviders(): Promise<void> {
    const config = await readAgentProviders().catch(() => ({ providers: {} }))
    agentProviderConfig.value = config.providers
  }

  function providerSummary(providerId: string): AgentProviderSummary | undefined {
    return agentProviderConfig.value[providerId]
  }

  void refreshAgentProviders()
  // Keep the discovery merge warm for the ACTIVE provider: every model
  // switcher reads availableModels(), but only the provider-detail page used
  // to trigger discovery — a dropdown showed the curated floor until that
  // page happened to be opened. Kick once at boot and follow switches; main
  // TTL-caches the listing, so an already-warm provider costs zero network.
  void refreshProviderModels(provider.value)
  watch(provider, (id) => { void refreshProviderModels(id) })

  // ── Persistence ─────────────────────────────────────────────────────────────

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      provider: provider.value,
      model: model.value,
      backendMode: backendMode.value,
      backendUrl: backendUrl.value,
      agentTools: agentTools.value,
      ptcEnabled: ptcEnabled.value,
      fontScale: fontScale.value,
      permissionMode: permissionMode.value,
      thinkingLevel: thinkingLevel.value,
      turnPrefsVersion: TURN_PREFS_VERSION,
    }))
  }

  watch([provider, model, backendMode, backendUrl, agentTools, ptcEnabled, fontScale, permissionMode, thinkingLevel], persist, { deep: true })

  /**
   * Write the current `fontScale` to <html> as `--font-scale`. Mirrors the
   * density application in uiLayout.ts (`document.documentElement.dataset.*`):
   * one CSS variable on the root element, consumed by every type token in
   * unified-design-tokens.css. Called on hydrate and on every setFontScale.
   */
  function applyFontScale() {
    if (typeof document === 'undefined') return
    document.documentElement.style.setProperty('--font-scale', String(fontScale.value))
  }
  // Apply on store creation so the persisted value takes effect at boot.
  applyFontScale()
  watch(fontScale, applyFontScale)

  // ── Actions ──────────────────────────────────────────────────────────────────

  function setProvider(id: string) {
    provider.value = id
    // Auto-select first model for the new provider, preferring the merged
    // (static + discovered) list so a fresh vendor model is selectable.
    const models = availableModels(id)
    if (models.length > 0 && !models.includes(model.value)) {
      model.value = models[0]
    }
  }

  function setModel(id: string) {
    model.value = id
  }

  /**
   * THE atomic selection entry: a model only exists under its provider, so
   * the pair must be written together. The Settings document browses providers
   * in a local master list without switching the active one — writing the
   * model alone there produced `{active provider, browsed provider's model}`
   * pairs that bind into guaranteed API failures. Every model-picking surface
   * goes through this; the separate setters remain only for surfaces that
   * already operate on the active provider.
   */
  function setModelFor(providerId: string, modelId: string) {
    if (provider.value !== providerId) {
      provider.value = providerId
    }
    model.value = modelId
  }

  /**
   * Persist credentials for a provider to settings.json (NOT localStorage). The
   * apiKey transits to main once and is never read back; `refreshAgentProviders`
   * updates the redacted `configured` flag the UI shows.
   */
  async function setCredentials(providerId: string, cred: CredentialInput) {
    // Drop undefined fields so the merge does not stamp `undefined` over a real
    // value in settings.json; only present fields are written.
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(cred)) {
      if (value !== undefined) patch[key] = value
    }
    await writeAgentProvider(providerId, patch)
    await refreshAgentProviders()
  }

  /** Delete stored credentials for a provider (writes an empty config). */
  async function clearCredentials(providerId: string) {
    await writeAgentProvider(providerId, {})
    await refreshAgentProviders()
  }

  // ── Custom providers ─────────────────────────────────────────────────────────

  function slugify(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    // A CJK-only display name slugs to nothing; the id still needs a stable tail.
    return slug || 'endpoint'
  }

  /**
   * Create a user-defined OpenAI-compatible endpoint and return its id. The
   * id is derived from the display name and collision-resolved against both
   * the catalog and settings.json — renaming later never renames the id, so
   * sessions stay bound across a cosmetic edit.
   */
  async function createCustomProvider(input: { name: string; baseUrl: string; apiKey?: string }): Promise<string> {
    const name = input.name.trim()
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
    if (!name) throw new Error('Provider name is required')
    if (!baseUrl) throw new Error('Base URL is required')
    const base = CUSTOM_PROVIDER_PREFIX + slugify(name)
    const taken = new Set([...listProviders().map((p) => p.id), ...Object.keys(agentProviderConfig.value)])
    let id = base
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`
    await writeAgentProvider(id, {
      name,
      api: 'openai-completions',
      baseUrl,
      ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
    })
    await refreshAgentProviders()
    return id
  }

  /** Cosmetic/config edit of a custom provider. Only present fields are
   *  written — an omitted apiKey never clears the stored one. */
  async function updateCustomProvider(providerId: string, patch: { name?: string; baseUrl?: string; apiKey?: string }) {
    const clean: Record<string, unknown> = {}
    if (patch.name?.trim()) clean.name = patch.name.trim()
    if (patch.baseUrl?.trim()) clean.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '')
    if (patch.apiKey?.trim()) clean.apiKey = patch.apiKey.trim()
    if (Object.keys(clean).length === 0) return
    await writeAgentProvider(providerId, clean)
    await refreshAgentProviders()
  }

  /**
   * Remove a custom provider outright. `clearCredentials` is NOT this: its
   * merge semantics deliberately spare frozen model digests, which would leave
   * a ghost entry. Falls back to the default pair when the removed provider
   * was the active one — a dangling active id binds into guaranteed failures.
   */
  async function removeCustomProvider(providerId: string) {
    const bridge = desktopAgentProvidersBridge()
    if (!bridge?.remove) throw new Error('Agent provider bridge is unavailable')
    await bridge.remove(providerId)
    await refreshAgentProviders()
    if (provider.value === providerId) {
      provider.value = DEFAULT_PROVIDER_ID
      model.value = DEFAULT_MODEL_ID
    }
  }

  /** Register a hand-typed model id under a provider (custom endpoints without
   *  a /models listing). Main merges sibling-safely — frozen metas survive. */
  async function addProviderModel(providerId: string, modelId: string) {
    const bridge = desktopAgentProvidersBridge()
    if (!bridge?.addModel) throw new Error('Agent provider bridge is unavailable')
    await bridge.addModel(providerId, modelId)
    await refreshAgentProviders()
  }

  // ── Per-model pricing (custom endpoints) ────────────────────────────────────
  // Declared prices are infrastructure config, not secrets: they cross IPC in
  // plain form and are cached here so the pricing editor prefills on revisit.

  async function refreshProviderPricing(providerId: string) {
    const bridge = desktopAgentProvidersBridge()
    if (!bridge?.readPricing) return
    try {
      const { pricing } = await bridge.readPricing(providerId)
      providerPricing.value = { ...providerPricing.value, [providerId]: pricing }
    } catch { /* a failed read degrades to "unpriced" — never blocks the page */ }
  }

  function providerModelPricing(providerId: string): Record<string, ModelPricingBridge> {
    return providerPricing.value[providerId] ?? {}
  }

  async function setProviderModelPricing(providerId: string, modelId: string, cost: ModelPricingBridge | null) {
    const bridge = desktopAgentProvidersBridge()
    if (!bridge?.setPricing) throw new Error('Agent provider bridge is unavailable')
    await bridge.setPricing(providerId, modelId, cost)
    await refreshProviderPricing(providerId)
  }

  function setAgentTool(key: AgentToolSettingKey, enabled: boolean) {
    agentTools.value = Object.freeze({ ...agentTools.value, [key]: enabled })
  }

  function resetAgentTools() {
    agentTools.value = DEFAULT_AGENT_TOOL_SETTINGS
  }

  /**
   * Set the font scale, clamped to [0.85, 1.4]. `applyFontScale` + the
   * `watch(fontScale)` propagate it to <html> immediately. Values outside the
   * range are clamped, never rejected — the caller (shortcut key, stepper) does
   * not need to know the bounds.
   */
  function setFontScale(value: number) {
    if (!Number.isFinite(value)) return
    const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value))
    // Round to the nearest step so 0.85 + 0.05 + 0.05 lands on 0.95, not 0.9499.
    fontScale.value = Math.round(clamped / FONT_SCALE_STEP) * FONT_SCALE_STEP
  }

  /** Step the font scale by ±1 step (Ctrl+= / Ctrl+-). */
  function stepFontScale(delta: number) {
    setFontScale(fontScale.value + delta * FONT_SCALE_STEP)
  }

  /** Reset the font scale to 1 (Ctrl+0). */
  function resetFontScale() {
    fontScale.value = 1
  }

  /**
   * Connect to the Backend. `awaitFirstProbe: false` (the boot path) resolves
   * and installs the base URL — the client swap mount must observe — and
   * starts the supervisor without waiting for the first probe roundtrip to
   * answer; the supervisor's phase subscription then drives the shell's
   * connecting/degraded UI. The default (`true`, every interactive caller)
   * awaits the first probe and surfaces its failure as `backendError`.
   *
   * `persist: false` (the boot path) never writes the connection choice
   * through to the main-process settings block — boot must honor what is
   * already persisted, not overwrite a preconfigured deployment.
   */
  async function connectBackend(options: { awaitFirstProbe?: boolean; persist?: boolean } = {}) {
    const awaitFirstProbe = options.awaitFirstProbe !== false
    const persistChoice = options.persist !== false
    if (backendConnecting.value) return
    backendConnected.value = false
    backendError.value = null
    if (backendMode.value === 'disabled') {
      if (persistChoice) {
        // Keep the launch-time wiring in step with the UI choice: a session
        // that had switched to remote must not boot external forever just
        // because the user later turned the service off.
        await desktopBackendBridge()?.configure({ mode: 'local' }).catch(() => undefined)
      }
      backendConnectionSupervisor.disable()
      return
    }
    backendConnecting.value = true
    try {
      const desktop = desktopBackendBridge()
      let connection: { baseUrl: string; accessToken: string | null } | null
      if (backendMode.value === 'remote') {
        const formBase = backendUrl.value.trim().replace(/\/+$/, '')
        if (!/^https?:\/\/.+/i.test(formBase)) throw new Error('Backend address is required (http://…)')
        const typedToken = backendAccessToken.value.trim()
        if (persistChoice) {
          // An empty form token means "keep the persisted one" — never wipe a
          // credential the form simply did not echo back.
          await desktop?.configure?.({ mode: 'remote', baseUrl: formBase, ...(typedToken ? { accessToken: typedToken } : {}) })
        }
        // After configure (and on any boot that started external) the
        // handshake serves the authoritative remote connection, token
        // included. The form values remain the fallback for the one state the
        // handshake cannot answer: remote chosen in the UI while this process
        // still serves an embedded backend.
        connection = { baseUrl: formBase, accessToken: typedToken || null }
        try {
          const served = await desktop?.connection()
          if (served?.baseUrl && sameOrigin(served.baseUrl, formBase)) connection = served
        } catch { /* not ready yet — the supervisor probes and retries anyway */ }
        backendUrl.value = connection.baseUrl
        backendTokenConfigured.value = connection.accessToken !== null
      } else {
        if (persistChoice) await desktop?.configure?.({ mode: 'local' }).catch(() => undefined)
        connection = await desktop?.connection() ?? null
        // backendTokenConfigured stays REMOTE-scoped: the embedded mode's
        // minted launch token is not a saved credential the remote form
        // should claim.
      }
      if (!connection?.baseUrl) throw new Error('Backend address is required')
      const baseUrl = connection.baseUrl.replace(/\/$/, '')
      setTDEaseBaseUrl(baseUrl, connection.accessToken ?? null)
      const settled = backendConnectionSupervisor.connect(baseUrl, connection.accessToken ?? null)
      if (!awaitFirstProbe) {
        // Boot path: never let an unobserved first probe become an unhandled
        // rejection — phase/errors arrive through the subscription below.
        void settled.catch(() => {})
        return
      }
      const snapshot = await settled
      if (snapshot.phase !== 'online') throw new Error(snapshot.error ?? `Backend is ${snapshot.phase}`)
    } catch (error) {
      backendError.value = error instanceof Error ? error.message : String(error)
    } finally {
      backendConnecting.value = false
    }
  }

  // Switching modes resets the remote-token hint to neutral: whether the
  // PERSISTED REMOTE block carries a token is only knowable from the remote
  // handshake itself (embedded minted tokens are not that), so the password
  // field must not inherit a stale "Saved" from whatever the previous mode
  // last connected with. The boot remote path re-establishes the real state
  // through its handshake right after.
  watch(backendMode, () => { backendTokenConfigured.value = false })

  const stopConnectionProjection = backendConnectionSupervisor.subscribe((snapshot) => {    backendState.value = snapshot.phase
    backendConnected.value = snapshot.phase === 'online' || snapshot.phase === 'degraded'
    if (snapshot.error) backendError.value = snapshot.error
    else if (snapshot.phase === 'online') backendError.value = null
  })
  onScopeDispose(stopConnectionProjection)

  return {
    provider,
    model,
    availableProviders,
    availableModels,
    currentCredential,
    hasProviderCredential,
    isProviderConfigured,
    setProvider,
    setModel,
    setModelFor,
    setCredentials,
    clearCredentials,
    createCustomProvider,
    updateCustomProvider,
    removeCustomProvider,
    addProviderModel,
    refreshProviderPricing,
    providerModelPricing,
    setProviderModelPricing,
    agentTools,
    setAgentTool,
    resetAgentTools,
    ptcEnabled,
    fontScale,
    setFontScale,
    stepFontScale,
    resetFontScale,
    backendMode,
    backendUrl,
    backendAccessToken,
    backendTokenConfigured,
    backendConnected,
    backendConnecting,
    backendError,
    readTurnPrefs,
    writeTurnPrefs,
    backendState,
    connectBackend,
    refreshAgentProviders,
    providerSummary,
    refreshedProviderModels,
    providerModelsRefresh,
    refreshProviderModels,
    noteOAuthModels,
  }
})
