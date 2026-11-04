import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The only electron bindings credential-store touches: safeStorage and app
// readiness, both mocked here (encrypt = a tagged buffer, decrypt = the
// inverse; a non-tagged buffer refuses — same failure shape as DPAPI handing
// back garbage off-machine). The real electron package never loads, so this
// suite stays inside the no-electron-runtime bar vitest.config.ts sets for
// electron/*.test.ts.
const electronMocks = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn((): boolean => true),
    encryptString: vi.fn((plain: string) => Buffer.from(`enc:${plain}`, 'utf8')),
    decryptString: vi.fn((buffer: Buffer) => {
      const text = buffer.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('not a safeStorage buffer')
      return text.slice(4)
    }),
  },
  app: { isReady: vi.fn((): boolean => true) },
}))

vi.mock('electron', () => ({ safeStorage: electronMocks.safeStorage, app: electronMocks.app }))

import { createCredentialStore } from './credential-store'

function legacySettings(apiKey: string): string {
  return `${JSON.stringify({
    schemaVersion: 3,
    providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey } },
  }, null, 2)}\n`
}

describe('credential-store', () => {
  let root: string
  let settingsPath: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tdease-credential-store-'))
    settingsPath = path.join(root, 'settings.json')
    electronMocks.safeStorage.isEncryptionAvailable.mockReturnValue(true)
    electronMocks.app.isReady.mockReturnValue(true)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('roundtrips a key: encrypted blob on disk, settings.json scrubbed to the marker', async () => {
    writeFileSync(settingsPath, legacySettings('sk-user-key'), 'utf8')
    const store = createCredentialStore(settingsPath)

    await store.storeProviderKey('deepseek', 'sk-user-key')

    const credentialsPath = path.join(root, 'credentials.json')
    expect(existsSync(credentialsPath)).toBe(true)
    const raw = readFileSync(credentialsPath, 'utf8')
    expect(raw).not.toContain('sk-user-key')
    const stored = JSON.parse(raw) as { schemaVersion: number; providers: Record<string, string> }
    expect(stored.schemaVersion).toBe(1)
    expect(typeof stored.providers.deepseek).toBe('string')

    expect(store.getProviderKey('deepseek')).toBe('sk-user-key')

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      providers: { deepseek: Record<string, unknown> }
    }
    expect(settings.providers.deepseek.apiKey).toBeUndefined()
    expect(settings.providers.deepseek.api_key).toBeUndefined()
    expect(settings.providers.deepseek.apiKeyStored).toBe(true)
    expect(settings.providers.deepseek.baseUrl).toBe('https://api.deepseek.com/v1')
  })

  it('isAvailable=false refuses the write, reads not-configured — never a plaintext fallback', async () => {
    writeFileSync(settingsPath, legacySettings('sk-user-key'), 'utf8')
    electronMocks.safeStorage.isEncryptionAvailable.mockReturnValue(false)
    const store = createCredentialStore(settingsPath)

    await expect(store.storeProviderKey('deepseek', 'sk-user-key')).rejects.toThrow(/unavailable/)
    expect(existsSync(path.join(root, 'credentials.json'))).toBe(false)
    // Refusing is the fail-closed posture: the plaintext settings.json already
    // had stays exactly as it was (the module never rewrites it either way).
    expect((JSON.parse(readFileSync(settingsPath, 'utf8')) as { providers: { deepseek: { apiKey: string } } }).providers.deepseek.apiKey).toBe('sk-user-key')
    expect(store.getProviderKey('deepseek')).toBeNull()
    await expect(store.deleteProviderKey('deepseek')).rejects.toThrow(/unavailable/)
  })

  it('refuses everything before app.whenReady()', async () => {
    electronMocks.app.isReady.mockReturnValue(false)
    const store = createCredentialStore(settingsPath)

    await expect(store.storeProviderKey('deepseek', 'sk-user-key')).rejects.toThrow(/unavailable/)
    expect(store.getProviderKey('deepseek')).toBeNull()
    expect(existsSync(path.join(root, 'credentials.json'))).toBe(false)
  })

  it('fingerprint is the stable sha256[:8] of the stored key, null when unconfigured', async () => {
    const store = createCredentialStore(settingsPath)
    expect(store.fingerprint('deepseek')).toBeNull()

    await store.storeProviderKey('deepseek', 'sk-user-key')
    const expected = createHash('sha256').update('sk-user-key').digest('hex').slice(0, 8)
    expect(store.fingerprint('deepseek')).toBe(expected)
    expect(store.fingerprint('deepseek')).toBe(expected)
  })

  it('migration moves legacy plaintext out of settings.json (marker stays, key encrypted)', async () => {
    writeFileSync(settingsPath, legacySettings('sk-legacy'), 'utf8')
    const store = createCredentialStore(settingsPath)

    await store.migrateLegacyProviderKeys()

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      providers: { deepseek: Record<string, unknown> }
    }
    expect(settings.providers.deepseek.apiKey).toBeUndefined()
    expect(settings.providers.deepseek.api_key).toBeUndefined()
    expect(settings.providers.deepseek.apiKeyStored).toBe(true)
    expect(store.getProviderKey('deepseek')).toBe('sk-legacy')
  })

  it('migration with safeStorage down refuses (caller logs) and leaves settings.json untouched', async () => {
    writeFileSync(settingsPath, legacySettings('sk-legacy'), 'utf8')
    electronMocks.safeStorage.isEncryptionAvailable.mockReturnValue(false)
    const store = createCredentialStore(settingsPath)

    await expect(store.migrateLegacyProviderKeys()).rejects.toThrow(/unavailable/)

    expect((JSON.parse(readFileSync(settingsPath, 'utf8')) as { providers: { deepseek: { apiKey: string } } }).providers.deepseek.apiKey).toBe('sk-legacy')
    expect(existsSync(path.join(root, 'credentials.json'))).toBe(false)
  })

  it('fingerprint survives the plaintext→store migration unchanged (computed on the DECRYPTED key)', async () => {
    // What main's read handler showed pre-migration: sha256[:8] of the
    // plaintext apiKey in settings.json. After migrateLegacyProviderKeys the
    // fingerprint comes from the decrypted blob — it must be the same value,
    // or every existing turn binding would re-bind on upgrade.
    writeFileSync(settingsPath, legacySettings('sk-fp-stable'), 'utf8')
    const preMigration = createHash('sha256').update('sk-fp-stable').digest('hex').slice(0, 8)
    const store = createCredentialStore(settingsPath)

    await store.migrateLegacyProviderKeys()

    expect(store.fingerprint('deepseek')).toBe(preMigration)
    // And settings.json no longer carries the plaintext the hash was taken from.
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('sk-fp-stable')
  })

  it('deleteProviderKey removes the blob; reads answer not-configured afterwards', async () => {
    writeFileSync(settingsPath, legacySettings('sk-user-key'), 'utf8')
    const store = createCredentialStore(settingsPath)

    await store.storeProviderKey('deepseek', 'sk-user-key')
    await store.deleteProviderKey('deepseek')

    expect(store.getProviderKey('deepseek')).toBeNull()
  })

  it('storing never invents a settings.json; scrub of a missing file is a no-op', async () => {
    const store = createCredentialStore(settingsPath)

    await store.storeProviderKey('deepseek', 'sk-user-key')

    expect(existsSync(settingsPath)).toBe(false)
    expect(store.getProviderKey('deepseek')).toBe('sk-user-key')
  })

  it('a corrupt or undecryptable store reads as not-configured, never throws', () => {
    writeFileSync(path.join(root, 'credentials.json'), '{not json', 'utf8')
    const store = createCredentialStore(settingsPath)
    expect(store.getProviderKey('deepseek')).toBeNull()

    // A blob another Windows user encrypted comes back as garbage → same verdict.
    writeFileSync(path.join(root, 'credentials.json'), `${JSON.stringify({
      schemaVersion: 1,
      providers: { deepseek: Buffer.from('garbage', 'utf8').toString('base64') },
    })}\n`, 'utf8')
    expect(store.getProviderKey('deepseek')).toBeNull()
  })
})
