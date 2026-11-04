/**
 * Provider model-list refresher — keeps the Settings UI's model list current
 * with what vendors actually serve, without touching the credential truth.
 *
 * Two live sources, one per-provider TTL cache, the static catalog as the
 * renderer's unconditional floor (the merge with static happens renderer-side,
 * where the static list lives):
 *
 *   1. Vendor discovery (authoritative) — `GET {baseUrl}/models` against the
 *      provider the user actually configured, with their own key, inside the
 *      main process (the key never crosses IPC; AGENT-CONTRACT.md §1). Only
 *      the two wire shapes vendors expose a model listing on are attempted:
 *      openai-completions (`{base}/models`, Bearer) and anthropic-messages
 *      (`{base}/v1/models`, x-api-key). Google/Mistral/OAuth and the local
 *      adapters have no comparable listing and are skipped.
 *   2. models.dev (fallback) — one community-maintained JSON catalog, mapped
 *      onto our provider ids. Covers providers the user has not configured a
 *      key for yet, and vendors without a listing endpoint.
 *
 * Architecture note: this is oh-my-pi's model-manager pattern (bundled static
 * → local cache → aggregator → vendor, later layers win, additive merge)
 * reduced to what this app's catalog layer needs — the Settings chips list.
 * It deliberately does NOT join the runtime: settings.json's `providers`
 * block stays the single truth a session binds against; a model being absent
 * from this list never blocks typing it (the same way it works today).
 *
 * The one exception is model METADATA (contextWindow/maxTokens/input/
 * reasoning/cost): `modelMeta()` serves the aggregator's per-model digest
 * from the warm cache to SessionHost's unknown-model register branch, which
 * freezes it into settings.json. The list stays advisory; the digest becomes
 * truth only through that explicit write.
 */

import { readFile } from 'node:fs/promises'

import type { AgentModelMetadata } from '../../src/contracts/agent-runtime'
import { PROVIDERS } from '../../src/services/catalog/provider-definitions'
import { writeTextAtomicQueued } from '../atomic-write'

// ── Public shape ─────────────────────────────────────────────────────────────

/** Which layer supplied `models` on this call. */
export type ProviderModelsSource = 'provider' | 'models-dev' | 'cache' | 'none'

export interface ProviderModelsResult {
  providerId: string
  /** Refreshed model ids in vendor order, deduped. Empty when nothing refreshed. */
  models: string[]
  source: ProviderModelsSource
  /** Epoch ms of the winning layer's fetch; null when source is 'none'. */
  updatedAt: number | null
  /** Last failed fetch message; null when every attempted layer succeeded (or none was attempted). */
  error: string | null
}

/** Minimal structural fetch — global fetch satisfies it; tests inject fakes. */
export interface FetchLike {
  (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
  }>
}

export interface ModelCatalogRefresher {
  refresh(providerId: string, options?: { force?: boolean }): Promise<ProviderModelsResult>
  /**
   * The aggregator's capability digest for one model, from the warm cache
   * only — the caller (SessionHost's register branch) must stay offline and
   * deterministic. Fresh or stale is served alike: a day-old contextWindow
   * beats the 128k guess. A missing or stale catalog triggers a background
   * refetch so the NEXT bind sees it; this call never waits on the network.
   * Returns null when the cache has nothing for the model.
   */
  modelMeta(providerId: string, modelId: string): Promise<AgentModelMetadata | null>
  /**
   * The Settings "Test connection" probe — one live GET against the
   * provider's own listing endpoint with its stored credential, mapped to a
   * typed verdict. Writes nothing: not the cache, not settings.json.
   */
  test(providerId: string): Promise<ProviderTestResult>
}

// ── Connection test (typed verdicts, PI-style two-stage semantics) ──────────

/**
 * Why a probe failed. The renderer localizes these; `detail` carries the raw
 * cause for the codes where the raw message IS the useful content (network,
 * server). Configuration problems (`no_key`, `no_config`, `unsupported`) are
 * decided before any wire traffic.
 */
export type ProviderTestCode =
  | 'no_key'
  | 'no_config'
  | 'unsupported'
  | 'unauthorized'
  | 'rate_limited'
  | 'not_found'
  | 'server'
  | 'timeout'
  | 'network'

export interface ProviderTestResult {
  ok: boolean
  code: ProviderTestCode | null
  latencyMs: number | null
  /** Parsed listing size on success; null when the body was not a listing. */
  modelCount: number | null
  detail: string | null
}

export interface ModelCatalogRefresherOptions {
  settingsPath: string
  cacheFile: string
  /**
   * safeStorage-backed key lookup (main decrypts credentials.json): used only
   * when settings.json carries no plaintext `apiKey` for the provider — the
   * plaintext value always wins, so pre-migration configs behave identically.
   */
  credentialLookup?: (providerId: string) => string | null
  fetchImpl?: FetchLike
  now?: () => number
  providerTtlMs?: number
  catalogTtlMs?: number
}

// ── Constants ────────────────────────────────────────────────────────────────

const MODELS_DEV_URL = 'https://models.dev/api.json'
const FETCH_TIMEOUT_MS = 10_000
/** The connection test answers a user staring at a button — tighter than discovery. */
const TEST_TIMEOUT_MS = 8_000
/** Vendor discovery goes stale fast (model launches), so a shorter TTL. */
const DEFAULT_PROVIDER_TTL_MS = 6 * 60 * 60 * 1000
/** The aggregator updates on community cadence; a day is plenty. */
const DEFAULT_CATALOG_TTL_MS = 24 * 60 * 60 * 1000

const CACHE_VERSION = 2

interface CacheEntry {
  models: string[]
  updatedAt: number
}

interface ModelsDevCacheEntry {
  updatedAt: number
  /** Our provider id → model ids extracted from the aggregator payload. */
  providers: Record<string, string[]>
  /** Our provider id → model id → capability digest. Absent in v1 caches. */
  meta?: Record<string, Record<string, AgentModelMetadata>>
}

interface CacheFile {
  version?: number
  providers?: Record<string, CacheEntry>
  modelsDev?: ModelsDevCacheEntry
}

/**
 * Our provider id → models.dev provider id. Best-effort by design: an id the
 * aggregator does not carry (or renames) simply yields no fallback list —
 * discovery and the static catalog remain the load-bearing layers. Verified
 * against the aggregator 2026-09-05 (the alibaba/moonshotai/minimax families,
 * deepseek, modelscope, kimi-for-coding); the international entries follow
 * its naming.
 */
const MODELS_DEV_IDS: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
  deepseek: 'deepseek',
  moonshot: 'moonshotai',
  'kimi-coding': 'kimi-for-coding',
  minimax: 'minimax',
  'minimax-token-plan': 'minimax-cn',
  dashscope: 'alibaba-cn',
  'dashscope-coding': 'alibaba-coding-plan-cn',
  modelscope: 'modelscope',
  zhipu: 'zai',
  'zhipu-coding': 'zai-coding-plan',
  'zhipu-coding-cn': 'zai-coding-plan',
  siliconflow: 'siliconflow',
  stepfun: 'stepfun',
  volcengine: 'volcengine',
  openrouter: 'openrouter',
  groq: 'groq',
  xai: 'xai',
  mistral: 'mistral',
  together: 'together',
  fireworks: 'fireworks-ai',
  perplexity: 'perplexity',
  opencode: 'opencode',
  'opencode-go': 'opencode-go',
}

// ── Parsing helpers ──────────────────────────────────────────────────────────

/**
 * settings.json providers block — only the fields this module reads. The same
 * tolerant slice NodeProviderRegistry takes: apiKey/baseUrl/api with their
 * snake_case aliases, everything else ignored.
 */
interface ProviderConfigSlice {
  api?: string
  baseUrl?: string
  base_url?: string
  apiKey?: string
  api_key?: string
}

function readProviderConfig(raw: unknown, providerId: string): ProviderConfigSlice {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const providers = (raw as { providers?: Record<string, unknown> }).providers
  const config = providers?.[providerId]
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  return config as ProviderConfigSlice
}

/**
 * Accept the shapes vendors actually return for a model listing: OpenAI's
 * `{data: [{id}]}`, Anthropic's `{data: [{id|display_name}]}`, and the bare
 * array some compatible endpoints answer with. Non-string entries that carry
 * no id are dropped, never fatal.
 */
function parseModelList(body: unknown): string[] {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : []
  const models: string[] = []
  for (const row of rows) {
    const id = typeof row === 'string'
      ? row
      : row && typeof row === 'object'
        ? (row as { id?: unknown; name?: unknown }).id ?? (row as { name?: unknown }).name
        : undefined
    if (typeof id === 'string' && id.trim()) models.push(id.trim())
  }
  return [...new Set(models)]
}

/**
 * Digest one aggregator model entry into the settings-schema metadata slice.
 * Field mapping verified against models.dev 2026-09-05: `reasoning` boolean,
 * `modalities.input` (["text","image",…]), `limit.context`/`limit.output` in
 * tokens, `cost` in USD per million tokens — the same unit Pi's bundled cards
 * carry. Only well-formed fields are kept; an entry carrying nothing usable
 * yields null (the register branch's conservative defaults then apply).
 */
function toModelMeta(entry: unknown): AgentModelMetadata | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const raw = entry as {
    reasoning?: unknown
    modalities?: { input?: unknown }
    limit?: { context?: unknown; output?: unknown }
    cost?: Record<string, unknown>
  }
  const positiveInt = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
  const nonNegative = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  const modalitiesInput = Array.isArray(raw.modalities?.input) ? (raw.modalities.input as unknown[]) : null
  const costInput = nonNegative(raw.cost?.input)
  const costOutput = nonNegative(raw.cost?.output)
  const meta: AgentModelMetadata = {
    ...(typeof raw.reasoning === 'boolean' ? { reasoning: raw.reasoning } : {}),
    ...(modalitiesInput ? { input: modalitiesInput.includes('image') ? ['text', 'image'] : ['text'] } : {}),
    ...(positiveInt(raw.limit?.context) !== undefined ? { contextWindow: positiveInt(raw.limit?.context) } : {}),
    ...(positiveInt(raw.limit?.output) !== undefined ? { maxTokens: positiveInt(raw.limit?.output) } : {}),
    ...(costInput !== undefined || costOutput !== undefined
      ? {
          cost: {
            input: costInput ?? 0,
            output: costOutput ?? 0,
            cacheRead: nonNegative(raw.cost?.cache_read) ?? 0,
            cacheWrite: nonNegative(raw.cost?.cache_write) ?? 0,
          },
        }
      : {}),
  }
  return Object.keys(meta).length > 0 ? meta : null
}

interface ModelsDevExtraction {
  providers: Record<string, string[]>
  meta: Record<string, Record<string, AgentModelMetadata>>
}

/**
 * Extract our per-provider model id lists + capability digests from the
 * aggregator payload — `{ "<models.dev id>": { models: { "<model id>": … } } }`.
 * Only ids in the mapping are extracted; anything else in the payload is
 * ignored.
 */
function parseModelsDev(body: unknown): ModelsDevExtraction {
  const extraction: ModelsDevExtraction = { providers: {}, meta: {} }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return extraction
  for (const [ourId, remoteId] of Object.entries(MODELS_DEV_IDS)) {
    const remote = (body as Record<string, unknown>)[remoteId]
    const models = remote && typeof remote === 'object' ? (remote as { models?: unknown }).models : undefined
    if (!models || typeof models !== 'object') continue
    const entries = models as Record<string, unknown>
    const ids = Object.keys(entries).filter((id) => id.trim())
    if (ids.length === 0) continue
    extraction.providers[ourId] = ids
    const metaById: Record<string, AgentModelMetadata> = {}
    for (const id of ids) {
      const meta = toModelMeta(entries[id])
      if (meta) metaById[id] = meta
    }
    if (Object.keys(metaById).length > 0) extraction.meta[ourId] = metaById
  }
  return extraction
}

// ── The refresher ────────────────────────────────────────────────────────────

export function createModelCatalogRefresher(options: ModelCatalogRefresherOptions): ModelCatalogRefresher {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined)
  const now = options.now ?? Date.now
  const providerTtlMs = options.providerTtlMs ?? DEFAULT_PROVIDER_TTL_MS
  const catalogTtlMs = options.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS
  const inflight = new Map<string, Promise<ProviderModelsResult>>()
  let catalogInflight: Promise<ModelsDevExtraction> | null = null

  async function readCache(): Promise<CacheFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(options.cacheFile, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return parsed as CacheFile
    } catch {
      return {}
    }
  }

  /**
   * Freshness gate for the aggregator entry: in-TTL AND the file carries the
   * current cache shape — a v1 entry (predates the metadata digest) counts as
   * stale, so upgraders warm to v2 immediately instead of serving no model
   * metadata for up to a day.
   */
  function catalogFresh(cache: CacheFile, tick: number): boolean {
    return cache.version === CACHE_VERSION
      && Boolean(cache.modelsDev && tick - cache.modelsDev.updatedAt < catalogTtlMs)
  }

  /** Atomic write — the shared temp+rename discipline with the Windows retry. */
  async function writeCache(cache: CacheFile): Promise<void> {
    const payload = `${JSON.stringify({ ...cache, version: CACHE_VERSION }, null, 2)}\n`
    try {
      await writeTextAtomicQueued(options.cacheFile, payload)
    } catch { /* a dead cache must never break a refresh that already succeeded */ }
  }

  async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
    if (!fetchImpl) throw new Error('no fetch implementation')
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }

  /**
   * Vendor discovery. Resolves null when this provider has no listing to
   * ask for (unknown shape, OAuth, no key) — a skip, not a failure.
   */
  async function fetchProviderModels(providerId: string): Promise<string[] | null> {
    const def = PROVIDERS.find((candidate) => candidate.id === providerId)
    if (def?.authType === 'oauth') return null
    const config = readProviderConfig(await readSettings(), providerId)
    const api = config.api ?? def?.defaultApi ?? 'openai-completions'
    const baseUrl = (config.baseUrl ?? config.base_url ?? def?.defaultBaseUrl ?? '').replace(/\/+$/, '')
    if (!baseUrl) return null
    const apiKey = config.apiKey ?? config.api_key ?? options.credentialLookup?.(providerId) ?? undefined
    if (!apiKey && def?.authType !== 'none') return null

    if (api === 'openai-completions') {
      return parseModelList(await fetchJson(`${baseUrl}/models`, apiKey ? { authorization: `Bearer ${apiKey}` } : {}))
    }
    if (api === 'anthropic-messages') {
      return parseModelList(await fetchJson(`${baseUrl}/v1/models`, {
        'x-api-key': apiKey ?? '',
        'anthropic-version': '2023-06-01',
      }))
    }
    return null
  }

  async function readSettings(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(options.settingsPath, 'utf8'))
    } catch {
      return {}
    }
  }

  /** The aggregator fetch, one payload for every provider, coalesced in flight. */
  function fetchCatalog(): Promise<ModelsDevExtraction> {
    catalogInflight ??= fetchJson(MODELS_DEV_URL, { accept: 'application/json' })
      .then(parseModelsDev)
      .finally(() => { catalogInflight = null })
    return catalogInflight
  }

  /** Background refetch of a stale/absent aggregator entry, for the next lookup. */
  async function warmCatalog(): Promise<void> {
    try {
      const tick = now()
      const before = await readCache()
      if (catalogFresh(before, tick)) return
      const extracted = await fetchCatalog()
      // Re-read at write time so a provider entry refreshed while we were
      // fetching survives (advisory cache; best-effort merge, never fatal).
      const latest = await readCache()
      await writeCache({
        providers: latest.providers ?? before.providers ?? {},
        modelsDev: { updatedAt: tick, providers: extracted.providers, meta: extracted.meta },
      })
    } catch { /* a failed warm leaves the previous cache in charge */ }
  }

  /** The register branch's offline digest lookup — see ModelCatalogRefresher. */
  async function lookupModelMeta(providerId: string, modelId: string): Promise<AgentModelMetadata | null> {
    const cache = await readCache()
    if (!catalogFresh(cache, now())) void warmCatalog()
    return cache.modelsDev?.meta?.[providerId]?.[modelId] ?? null
  }

  async function refreshOne(providerId: string, force?: boolean): Promise<ProviderModelsResult> {
    const cache = await readCache()
    const tick = now()
    const providers = cache.providers ?? {}
    let dirty = false

    // Layer 1 — vendor discovery. A fresh cache entry short-circuits the wire;
    // `force` re-fetches regardless and degrades to the cache on failure.
    const cached = providers[providerId]
    const cachedFresh = Boolean(cached && tick - cached.updatedAt < providerTtlMs)
    let discoveryError: string | null = null
    let answered = false
    let freshModels: string[] | null = null
    if (force || !cachedFresh) {
      try {
        const models = await fetchProviderModels(providerId)
        if (models) {
          freshModels = models
          providers[providerId] = { models, updatedAt: tick }
          dirty = true
          answered = models.length > 0
        }
      } catch (error) {
        discoveryError = error instanceof Error ? error.message : String(error)
      }
    }

    // Layer 2 — models.dev, whenever discovery has nothing fresh (no answer
    // and no fresh cache — the fast path must cost zero network). The
    // aggregator payload is one fetch for every provider, so it is cached and
    // coalesced independently of the per-provider entry above.
    let catalogEntry = catalogFresh(cache, tick) ? cache.modelsDev : undefined
    let catalogError: string | null = null
    if (!catalogEntry && !answered && !cachedFresh) {
      try {
        const extracted = await fetchCatalog()
        catalogEntry = { updatedAt: tick, providers: extracted.providers, meta: extracted.meta }
        cache.modelsDev = catalogEntry
        dirty = true
      } catch (error) {
        catalogError = error instanceof Error ? error.message : String(error)
      }
    }
    if (dirty) {
      // Re-read at write time: a warmCatalog or sibling-provider refresh that
      // landed while we were on the wire must not be reverted by our older
      // snapshot (advisory cache; best-effort merge, never fatal).
      const latest = await readCache()
      await writeCache({
        providers: { ...latest.providers, ...providers },
        modelsDev: catalogEntry ?? latest.modelsDev ?? cache.modelsDev,
      })
    }

    // Winner, in priority order; whatever survives lands in the UI additively
    // on top of the static catalog (merged renderer-side).
    if (freshModels !== null) {
      return { providerId, models: freshModels, source: 'provider', updatedAt: tick, error: null }
    }
    if (cachedFresh && cached.models.length > 0) {
      return { providerId, models: cached.models, source: 'provider', updatedAt: cached.updatedAt, error: null }
    }
    if (catalogEntry?.providers?.[providerId]?.length) {
      return {
        providerId,
        models: catalogEntry.providers[providerId],
        source: 'models-dev',
        updatedAt: catalogEntry.updatedAt,
        error: discoveryError,
      }
    }
    if (cached?.models.length) {
      return { providerId, models: cached.models, source: 'cache', updatedAt: cached.updatedAt, error: discoveryError }
    }
    const staleCatalog = cache.modelsDev?.providers?.[providerId]
    if (staleCatalog?.length) {
      return {
        providerId,
        models: staleCatalog,
        source: 'cache',
        updatedAt: cache.modelsDev?.updatedAt ?? null,
        error: discoveryError ?? catalogError,
      }
    }
    return { providerId, models: [], source: 'none', updatedAt: null, error: discoveryError ?? catalogError }
  }

  /**
   * The explicit connection test. Stage 1 is configuration (no wire traffic):
   * a provider needing a key without one, or no base URL to probe at all,
   * fails with its own code. Stage 2 is one live GET against the listing
   * endpoint the same way discovery asks — the user's stored credential, the
   * provider's stored base URL — with every failure mapped to a typed code.
   * Unlike `refresh` it never falls back to models.dev (that would test the
   * aggregator, not the user's endpoint) and never writes the cache.
   */
  async function testProvider(providerId: string): Promise<ProviderTestResult> {
    const untested = (code: ProviderTestCode, detail: string | null = null): ProviderTestResult =>
      ({ ok: false, code, latencyMs: null, modelCount: null, detail })
    const def = PROVIDERS.find((candidate) => candidate.id === providerId)
    if (def?.authType === 'oauth') return untested('unsupported')
    const config = readProviderConfig(await readSettings(), providerId)
    const api = config.api ?? def?.defaultApi ?? 'openai-completions'
    const baseUrl = (config.baseUrl ?? config.base_url ?? def?.defaultBaseUrl ?? '').replace(/\/+$/, '')
    const apiKey = config.apiKey ?? config.api_key ?? options.credentialLookup?.(providerId) ?? undefined
    if (!baseUrl) return untested('no_config')
    if (!apiKey && def?.authType !== 'none') return untested('no_key')
    if (api !== 'openai-completions' && api !== 'anthropic-messages') return untested('unsupported')

    const url = api === 'anthropic-messages' ? `${baseUrl}/v1/models` : `${baseUrl}/models`
    const headers: Record<string, string> = api === 'anthropic-messages'
      ? { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' }
      : apiKey ? { authorization: `Bearer ${apiKey}` } : {}
    const started = now()
    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await fetchImpl!(url, { headers, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') return untested('timeout')
      return untested('network', error instanceof Error ? error.message : String(error))
    }
    const latencyMs = now() - started
    if (response.ok) {
      let modelCount: number | null = null
      try {
        modelCount = parseModelList(await response.json()).length
      } catch { /* a 200 with a non-JSON body still proves the endpoint answers */ }
      return { ok: true, code: null, latencyMs, modelCount, detail: null }
    }
    const code: ProviderTestCode = response.status === 401 || response.status === 403
      ? 'unauthorized'
      : response.status === 429
        ? 'rate_limited'
        : response.status === 404
          ? 'not_found'
          : 'server'
    return { ok: false, code, latencyMs, modelCount: null, detail: `HTTP ${response.status}` }
  }

  return {
    refresh(providerId, options) {
      const key = `${providerId}:${options?.force === true}`
      const pending = inflight.get(key)
      if (pending) return pending
      const running = refreshOne(providerId, options?.force === true).finally(() => { inflight.delete(key) })
      inflight.set(key, running)
      return running
    },
    modelMeta: lookupModelMeta,
    test: testProvider,
  }
}
