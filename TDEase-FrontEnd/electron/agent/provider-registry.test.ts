import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NodeProviderRegistry } from './provider-registry'

describe('NodeProviderRegistry.resolve baseUrl fallback', () => {
  let root: string
  let settingsPath: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tdease-provider-registry-'))
    settingsPath = path.join(root, 'settings.json')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('falls back to the catalog default baseUrl for a key-only config', () => {
    // The exact reported scenario: a key was entered, the Base URL field left
    // at its placeholder. zhipu-coding-cn is NOT in Pi's own catalog, so the
    // session bind registers it as a custom provider — an empty baseUrl is
    // rejected there ("baseUrl is required when defining custom models").
    writeFileSync(settingsPath, `${JSON.stringify({
      schemaVersion: 3,
      providers: { 'zhipu-coding-cn': { apiKey: 'sk-zhipu' } },
    }, null, 2)}\n`, 'utf8')

    const resolved = new NodeProviderRegistry(settingsPath).resolve({
      providerId: 'zhipu-coding-cn',
      modelId: 'glm-4.7',
    })

    expect(resolved.baseUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4')
    expect(resolved.api).toBe('openai-completions')
    expect(resolved.apiKey).toBe('sk-zhipu')
  })

  it('a user-set baseUrl override wins over the catalog default', () => {
    writeFileSync(settingsPath, `${JSON.stringify({
      schemaVersion: 3,
      providers: { 'zhipu-coding-cn': { apiKey: 'sk-zhipu', baseUrl: 'https://proxy.example.internal/v4' } },
    }, null, 2)}\n`, 'utf8')

    const resolved = new NodeProviderRegistry(settingsPath).resolve({
      providerId: 'zhipu-coding-cn',
      modelId: 'glm-4.7',
    })

    expect(resolved.baseUrl).toBe('https://proxy.example.internal/v4')
  })
})

describe('NodeProviderRegistry.persistModelMeta', () => {
  let root: string
  let settingsPath: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tdease-provider-registry-'))
    settingsPath = path.join(root, 'settings.json')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('freezes a digest under providers.<id>.models.<modelId>, merging per field and preserving everything else', async () => {
    writeFileSync(settingsPath, `${JSON.stringify({
      schemaVersion: 3,
      compaction: { keepRecentTokens: 200 },
      providers: {
        deepseek: {
          apiKey: 'sk-user',
          models: {
            sibling: { contextWindow: 64_000 },
            target: { reasoning: true },
          },
        },
      },
    }, null, 2)}\n`, 'utf8')
    const registry = new NodeProviderRegistry(settingsPath)

    await registry.persistModelMeta(
      { providerId: 'deepseek', modelId: 'target' },
      { contextWindow: 128_000, maxTokens: 8_192 },
    )

    const doc = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      schemaVersion: number
      compaction: unknown
      providers: { deepseek: { apiKey: string; models: Record<string, Record<string, unknown>> } }
    }
    // The write is a merge, never a rewrite: unrelated blocks survive.
    expect(doc.schemaVersion).toBe(3)
    expect(doc.compaction).toEqual({ keepRecentTokens: 200 })
    expect(doc.providers.deepseek.apiKey).toBe('sk-user')
    expect(doc.providers.deepseek.models.sibling).toEqual({ contextWindow: 64_000 })
    // Field-level merge: the digest lands next to the hand-set reasoning.
    expect(doc.providers.deepseek.models.target).toEqual({ reasoning: true, contextWindow: 128_000, maxTokens: 8_192 })

    // A second digest refreshes its own fields without clobbering the rest.
    await registry.persistModelMeta(
      { providerId: 'deepseek', modelId: 'target' },
      { contextWindow: 200_000 },
    )
    const again = JSON.parse(readFileSync(settingsPath, 'utf8')) as typeof doc
    expect(again.providers.deepseek.models.target).toEqual({ reasoning: true, contextWindow: 200_000, maxTokens: 8_192 })
  })

  it('is a silent no-op for a missing settings file or an unconfigured provider', async () => {
    // No settings file at all: persistence never invents one.
    const bare = new NodeProviderRegistry(settingsPath)
    await expect(bare.persistModelMeta({ providerId: 'deepseek', modelId: 'm' }, { contextWindow: 1 })).resolves.toBeUndefined()
    expect(existsSync(settingsPath)).toBe(false)

    writeFileSync(settingsPath, `${JSON.stringify({
      schemaVersion: 3,
      providers: { other: { apiKey: 'sk' } },
    })}\n`, 'utf8')
    await expect(bare.persistModelMeta({ providerId: 'deepseek', modelId: 'm' }, { contextWindow: 1 })).resolves.toBeUndefined()
    const doc = JSON.parse(readFileSync(settingsPath, 'utf8')) as { providers: Record<string, unknown> }
    expect(Object.keys(doc.providers)).toEqual(['other'])
  })
})

describe('NodeProviderRegistry built-in provider key fallback', () => {
  // builtin-provider-keys.ts captures process.env at module evaluation, so each
  // case re-imports the chain under vi.resetModules() with the env stubbed.
  let root: string
  let settingsPath: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tdease-provider-registry-'))
    settingsPath = path.join(root, 'settings.json')
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  async function loadRegistry(): Promise<typeof NodeProviderRegistry> {
    const module = await import('./provider-registry')
    return module.NodeProviderRegistry
  }

  it('resolves a provider with no settings entry from the baked-in key and catalog defaults', async () => {
    vi.stubEnv('TDEASE_BUILTIN_DEEPSEEK_API_KEY', 'sk-builtin')
    const Registry = await loadRegistry()
    const registry = new Registry(settingsPath)

    const resolved = registry.resolve({ providerId: 'deepseek', modelId: 'deepseek-v4-flash' })

    expect(resolved.apiKey).toBe('sk-builtin')
    expect(resolved.baseUrl).toBe('https://api.deepseek.com')
    expect(resolved.api).toBe('openai-completions')
    expect(registry.isConfigured({ providerId: 'deepseek', modelId: 'deepseek-v4-flash' })).toBe(true)
  })

  it('a user key in settings.json wins over the built-in key', async () => {
    vi.stubEnv('TDEASE_BUILTIN_DEEPSEEK_API_KEY', 'sk-builtin')
    writeFileSync(settingsPath, `${JSON.stringify({
      schemaVersion: 3,
      providers: { deepseek: { apiKey: 'sk-user' } },
    })}\n`, 'utf8')
    const Registry = await loadRegistry()
    const registry = new Registry(settingsPath)

    const resolved = registry.resolve({ providerId: 'deepseek', modelId: 'deepseek-v4-flash' })

    expect(resolved.apiKey).toBe('sk-user')
  })

  it('without a baked-in key a missing settings entry still throws', async () => {
    const Registry = await loadRegistry()
    const registry = new Registry(settingsPath)

    expect(() => registry.resolve({ providerId: 'deepseek', modelId: 'deepseek-v4-flash' })).toThrow('Provider not configured: deepseek')
    expect(registry.isConfigured({ providerId: 'deepseek', modelId: 'deepseek-v4-flash' })).toBe(false)
  })

  it('summarize reports a built-in-keyed provider as configured with no settings entry', async () => {
    vi.stubEnv('TDEASE_BUILTIN_DEEPSEEK_API_KEY', 'sk-builtin')
    const Registry = await loadRegistry()
    const registry = new Registry(settingsPath)

    const summaries = registry.summarize()

    expect(summaries).toEqual([
      { providerId: 'deepseek', displayName: 'deepseek', models: [], configured: true },
    ])
  })
})
