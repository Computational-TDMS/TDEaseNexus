import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createModelCatalogRefresher,
  type FetchLike,
  type ProviderModelsResult,
} from './model-catalog-refresher'

/**
 * Fake fetch routed by URL substring. A route returning `{ status }` simulates
 * a failed response; anything else is a 200 JSON body. Every call is recorded
 * with the headers main actually sent — the assertion target for the
 * "user's key never leaves main but IS used against the vendor" contract.
 */
function makeFetch(routes: Record<string, (url: string, headers: Record<string, string>) => unknown>): {
  fetchImpl: FetchLike
  calls: Array<{ url: string; headers: Record<string, string> }>
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = init?.headers ?? {}
    calls.push({ url, headers })
    for (const [fragment, route] of Object.entries(routes)) {
      if (!url.includes(fragment)) continue
      const body = route(url, headers)
      if (body && typeof body === 'object' && 'status' in (body as Record<string, unknown>)) {
        return { ok: false, status: (body as { status: number }).status, json: async () => ({}) }
      }
      return { ok: true, status: 200, json: async () => body }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return { fetchImpl, calls }
}

describe('model-catalog-refresher', () => {
  let root: string
  let settingsPath: string
  let cacheFile: string
  let clock: number

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tdease-model-catalog-'))
    settingsPath = path.join(root, 'settings.json')
    cacheFile = path.join(root, 'models-cache.json')
    clock = 1_000_000_000_000
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeSettings(providers: Record<string, unknown>): void {
    writeFileSync(settingsPath, `${JSON.stringify({ schemaVersion: 3, providers }, null, 2)}\n`, 'utf8')
  }

  function refresher(fetchImpl: FetchLike) {
    return createModelCatalogRefresher({
      settingsPath,
      cacheFile,
      fetchImpl,
      now: () => clock,
    })
  }

  it('serves vendor discovery with the user key, from main, and caches it', async () => {
    writeSettings({ deepseek: { api: 'openai-completions', apiKey: 'sk-user' } })
    const { fetchImpl, calls } = makeFetch({
      'api.deepseek.com/models': (_url, headers) => {
        expect(headers.authorization).toBe('Bearer sk-user')
        return { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-new' }, { id: 'deepseek-chat' }] }
      },
    })

    const result: ProviderModelsResult = await refresher(fetchImpl).refresh('deepseek')

    expect(result).toMatchObject({ providerId: 'deepseek', source: 'provider', error: null })
    // Vendor order, deduped.
    expect(result.models).toEqual(['deepseek-chat', 'deepseek-new'])
    expect(result.updatedAt).toBe(clock)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.deepseek.com/models')

    const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as {
      providers: Record<string, { models: string[]; updatedAt: number }>
    }
    expect(cached.providers.deepseek).toEqual({ models: ['deepseek-chat', 'deepseek-new'], updatedAt: clock })
  })

  it('short-circuits a fresh cache with zero network and refetches on force', async () => {
    writeSettings({ deepseek: { apiKey: 'sk-user' } })
    let calls = 0
    const { fetchImpl } = makeFetch({
      'api.deepseek.com/models': () => {
        calls += 1
        return { data: [{ id: `deepseek-v${calls}` }] }
      },
    })
    const store = refresher(fetchImpl)

    const first = await store.refresh('deepseek')
    expect(first.source).toBe('provider')
    expect(calls).toBe(1)

    // Inside the TTL: served from cache, no wire.
    const second = await store.refresh('deepseek')
    expect(calls).toBe(1)
    expect(second).toEqual(first)

    // Force bypasses the TTL and refreshes the cache.
    const forced = await store.refresh('deepseek', { force: true })
    expect(calls).toBe(2)
    expect(forced.models).toEqual(['deepseek-v2'])
  })

  it('falls back to models.dev for an unconfigured provider with a mapping', async () => {
    writeSettings({})
    const { fetchImpl, calls } = makeFetch({
      'models.dev/api.json': () => ({
        deepseek: { models: { 'deepseek-v4': {}, 'deepseek-reasoner': {} } },
        openai: { models: { 'gpt-5': {} } },
      }),
    })

    const result = await refresher(fetchImpl).refresh('deepseek')

    expect(result).toMatchObject({ providerId: 'deepseek', source: 'models-dev' })
    expect(result.models).toEqual(['deepseek-v4', 'deepseek-reasoner'])
    // No discovery attempt for a keyless provider — the aggregator only.
    expect(calls.map((call) => call.url)).toEqual(['https://models.dev/api.json'])
  })

  it('reports none when a provider has no key and no aggregator mapping', async () => {
    writeSettings({})
    const { fetchImpl, calls } = makeFetch({
      'models.dev/api.json': () => ({}),
    })

    const result = await refresher(fetchImpl).refresh('agnes')

    expect(result).toEqual({ providerId: 'agnes', models: [], source: 'none', updatedAt: null, error: null })
    expect(calls).toHaveLength(1)
  })

  it('discovers anthropic-shape and keyless providers with the right auth shape', async () => {
    writeSettings({
      anthropic: { api: 'anthropic-messages', apiKey: 'sk-ant' },
      ollama: {},
    })
    const { fetchImpl, calls } = makeFetch({
      'api.anthropic.com/v1/models': (_url, headers) => {
        expect(headers['x-api-key']).toBe('sk-ant')
        expect(headers['anthropic-version']).toBe('2023-06-01')
        return { data: [{ id: 'claude-sonnet-5' }, { display_name: 'Claude Opus 5', id: 'claude-opus-5' }] }
      },
      'localhost:11434/v1/models': (_url, headers) => {
        expect(headers.authorization).toBeUndefined()
        return [{ id: 'llama4' }]
      },
    })
    const store = refresher(fetchImpl)

    const anthropic = await store.refresh('anthropic')
    expect(anthropic.models).toEqual(['claude-sonnet-5', 'claude-opus-5'])
    expect(anthropic.source).toBe('provider')

    const ollama = await store.refresh('ollama')
    expect(ollama.models).toEqual(['llama4'])
    expect(ollama.source).toBe('provider')
    expect(calls).toHaveLength(2)
  })

  it('degrades to the stale cache when every live source fails', async () => {
    writeSettings({ deepseek: { apiKey: 'sk-user' } })
    const failing = makeFetch({
      'api.deepseek.com': () => ({ status: 401 }),
      'models.dev/api.json': () => ({ status: 503 }),
    })
    const working = makeFetch({
      'api.deepseek.com/models': () => ({ data: [{ id: 'deepseek-chat' }] }),
    })
    const store = refresher(working.fetchImpl)
    const fresh = await store.refresh('deepseek')
    expect(fresh.source).toBe('provider')

    clock += 7 * 60 * 60 * 1000
    const degraded = await refresher(failing.fetchImpl).refresh('deepseek')
    expect(degraded.source).toBe('cache')
    expect(degraded.models).toEqual(['deepseek-chat'])
    expect(degraded.updatedAt).toBe(fresh.updatedAt)
    expect(degraded.error).toBe('HTTP 401')
  })

  it('tolerates a corrupt cache file and refreshes through it', async () => {
    writeSettings({ deepseek: { apiKey: 'sk-user' } })
    writeFileSync(cacheFile, '{not json', 'utf8')
    const { fetchImpl } = makeFetch({
      'api.deepseek.com/models': () => ({ data: [{ id: 'deepseek-chat' }] }),
    })

    const result = await refresher(fetchImpl).refresh('deepseek')

    expect(result.source).toBe('provider')
    expect(existsSync(cacheFile)).toBe(true)
  })

  // ── modelMeta: the register branch's offline digest lookup ──────────────────

  it('digests aggregator entries into capability metadata and serves modelMeta from the warm cache', async () => {
    writeSettings({})
    const { fetchImpl, calls } = makeFetch({
      'models.dev/api.json': () => ({
        deepseek: {
          models: {
            'deepseek-v4': {
              reasoning: true,
              modalities: { input: ['text', 'image'], output: ['text'] },
              limit: { context: 163840, output: 8192 },
              cost: { input: 0.27, output: 1.1, cache_read: 0.07, cache_write: 0.27 },
            },
            // An entry with nothing digestible: listed, but no metadata claim.
            'deepseek-blank': {},
          },
        },
      }),
    })
    const store = refresher(fetchImpl)
    await store.refresh('deepseek')
    const callsAfterRefresh = calls.length

    await expect(store.modelMeta('deepseek', 'deepseek-v4')).resolves.toEqual({
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 163840,
      maxTokens: 8192,
      cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
    })
    await expect(store.modelMeta('deepseek', 'deepseek-blank')).resolves.toBeNull()
    await expect(store.modelMeta('deepseek', 'deepseek-unknown')).resolves.toBeNull()
    // A fresh cache makes the lookup free — zero network on the bind path.
    expect(calls.length).toBe(callsAfterRefresh)
  })

  it('serves a stale digest immediately and background-warms the catalog for the next lookup', async () => {
    writeSettings({})
    let contextWindow = 100_000
    const { fetchImpl, calls } = makeFetch({
      'models.dev/api.json': () => ({
        deepseek: { models: { 'deepseek-v4': { limit: { context: contextWindow } } } },
      }),
    })
    const store = refresher(fetchImpl)
    await store.refresh('deepseek')
    await expect(store.modelMeta('deepseek', 'deepseek-v4')).resolves.toEqual({ contextWindow: 100_000 })

    // A day later the catalog entry is stale: the old digest still serves
    // (offline, immediate), the refetch runs in the background, and the
    // refreshed digest is what the NEXT lookup sees.
    clock += 25 * 60 * 60 * 1000
    contextWindow = 200_000
    await expect(store.modelMeta('deepseek', 'deepseek-v4')).resolves.toEqual({ contextWindow: 100_000 })
    await vi.waitFor(() => {
      expect(calls.filter((call) => call.url.includes('models.dev'))).toHaveLength(2)
    })
    await expect(store.modelMeta('deepseek', 'deepseek-v4')).resolves.toEqual({ contextWindow: 200_000 })
  })

  it('treats a version-1 cache as stale: null digest now, background warm for the next lookup', async () => {
    writeSettings({})
    writeFileSync(cacheFile, `${JSON.stringify({
      version: 1,
      modelsDev: { updatedAt: clock, providers: { deepseek: ['deepseek-v4'] } },
    })}\n`, 'utf8')
    const { fetchImpl, calls } = makeFetch({})

    await expect(refresher(fetchImpl).modelMeta('deepseek', 'deepseek-v4')).resolves.toBeNull()
    // A v1 entry predates the metadata digest, so freshness is version-gated:
    // the lookup misses but fires the background warm (here it fails on the
    // empty route — tolerance, not success, is what this asserts).
    await vi.waitFor(() => {
      expect(calls.map((call) => call.url)).toEqual(['https://models.dev/api.json'])
    })
  })

  // ── test(): the Settings connection probe — typed verdicts, zero writes ────

  it('probes the stored endpoint with the stored key and writes nothing', async () => {
    writeSettings({ 'custom-x': { api: 'openai-completions', apiKey: 'sk-x', baseUrl: 'https://relay.example/v1' } })
    const { fetchImpl, calls } = makeFetch({
      'relay.example/v1/models': (_url, headers) => {
        expect(headers.authorization).toBe('Bearer sk-x')
        return { data: [{ id: 'relay-a' }, { id: 'relay-b' }] }
      },
    })

    const verdict = await refresher(fetchImpl).test('custom-x')

    expect(verdict).toMatchObject({ ok: true, code: null, modelCount: 2, detail: null })
    expect(verdict.latencyMs).toBeTypeOf('number')
    expect(calls.map((call) => call.url)).toEqual(['https://relay.example/v1/models'])
    // A test is a probe: neither the models cache nor settings.json is touched.
    expect(existsSync(cacheFile)).toBe(false)
  })

  it('maps every failure to its typed code', async () => {
    writeSettings({
      'custom-401': { apiKey: 'k', baseUrl: 'https://a401.example/v1' },
      'custom-429': { apiKey: 'k', baseUrl: 'https://a429.example/v1' },
      'custom-404': { apiKey: 'k', baseUrl: 'https://a404.example/v1' },
      'custom-500': { apiKey: 'k', baseUrl: 'https://a500.example/v1' },
    })
    const store = refresher(makeFetch({
      'a401.example': () => ({ status: 401 }),
      'a429.example': () => ({ status: 429 }),
      'a404.example': () => ({ status: 404 }),
      'a500.example': () => ({ status: 500 }),
    }).fetchImpl)

    await expect(store.test('custom-401')).resolves.toMatchObject({ ok: false, code: 'unauthorized', detail: 'HTTP 401' })
    await expect(store.test('custom-429')).resolves.toMatchObject({ ok: false, code: 'rate_limited' })
    await expect(store.test('custom-404')).resolves.toMatchObject({ ok: false, code: 'not_found' })
    await expect(store.test('custom-500')).resolves.toMatchObject({ ok: false, code: 'server' })
  })

  it('distinguishes timeout from network without wire traffic for config faults', async () => {
    writeSettings({
      deepseek: {}, // catalog default base URL, but no key yet
      'custom-bare': { apiKey: 'k' }, // no base URL anywhere
      'custom-weird': { apiKey: 'k', baseUrl: 'https://w.example/v1', api: 'google-generative-ai' },
    })
    const aborting: FetchLike = async () => {
      const error = new Error('The operation was aborted due to timeout')
      error.name = 'TimeoutError'
      throw error
    }
    const refusing: FetchLike = async () => {
      throw new TypeError('fetch failed')
    }
    const silent = makeFetch({})

    // Config faults are decided before any wire traffic — the probe fetch is
    // never constructed for them.
    await expect(refresher(silent.fetchImpl).test('deepseek')).resolves.toMatchObject({ ok: false, code: 'no_key' })
    await expect(refresher(silent.fetchImpl).test('custom-bare')).resolves.toMatchObject({ ok: false, code: 'no_config' })
    await expect(refresher(silent.fetchImpl).test('custom-weird')).resolves.toMatchObject({ ok: false, code: 'unsupported' })
    // OAuth providers are account-based; the probe does not apply.
    await expect(refresher(silent.fetchImpl).test('openai-codex-oauth')).resolves.toMatchObject({ ok: false, code: 'unsupported' })
    expect(silent.calls).toHaveLength(0)

    // Wire faults: an abort names the timeout, a thrown fetch names the network.
    writeSettings({ deepseek: { apiKey: 'sk-user' } })
    await expect(refresher(aborting).test('deepseek')).resolves.toMatchObject({ ok: false, code: 'timeout' })
    await expect(refresher(refusing).test('deepseek')).resolves.toMatchObject({ ok: false, code: 'network', detail: 'fetch failed' })
  })
})
