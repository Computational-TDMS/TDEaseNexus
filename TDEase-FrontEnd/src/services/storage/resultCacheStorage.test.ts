import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { studioInfrastructure } from '../backend/studioInfrastructure'
import { desktopResultCache, localResultCacheStorage, workspaceResultCacheStorage } from './resultCacheStorage'

type FakeResultCacheBridge = {
  exists: ReturnType<typeof vi.fn>
  sha256: ReturnType<typeof vi.fn>
  readBytes: ReturnType<typeof vi.fn>
  writeBytesAtomic: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

type FakeWorkspaceBridge = {
  exists: ReturnType<typeof vi.fn>
  sha256: ReturnType<typeof vi.fn>
  readBytes: ReturnType<typeof vi.fn>
  writeBytesAtomic: ReturnType<typeof vi.fn>
  trash: ReturnType<typeof vi.fn>
}

function fakeResultCacheBridge(): FakeResultCacheBridge {
  return {
    exists: vi.fn(), sha256: vi.fn(), readBytes: vi.fn(), writeBytesAtomic: vi.fn(), remove: vi.fn(),
  }
}

function fakeWorkspaceBridge(): FakeWorkspaceBridge {
  return {
    exists: vi.fn(), sha256: vi.fn(), readBytes: vi.fn(), writeBytesAtomic: vi.fn(), trash: vi.fn(),
  }
}

function installDesktopBridge(overrides: Record<string, unknown>) {
  ;(globalThis as unknown as { tdeaseDesktop: unknown }).tdeaseDesktop = overrides
}

afterEach(() => {
  delete (globalThis as unknown as { tdeaseDesktop?: unknown }).tdeaseDesktop
})

describe('localResultCacheStorage', () => {
  it('digest resolves undefined for a path the bridge reports missing, without hashing it', async () => {
    const resultCache = fakeResultCacheBridge()
    resultCache.exists.mockResolvedValue(false)
    installDesktopBridge({ resultCache })

    await expect(localResultCacheStorage().digest('ws/run/result/deadbeef')).resolves.toBeUndefined()
    expect(resultCache.sha256).not.toHaveBeenCalled()
  })

  it('digest resolves the bridge hash when the path exists', async () => {
    const resultCache = fakeResultCacheBridge()
    resultCache.exists.mockResolvedValue(true)
    resultCache.sha256.mockResolvedValue('abc123')
    installDesktopBridge({ resultCache })

    await expect(localResultCacheStorage().digest('ws/run/result/abc123')).resolves.toBe('abc123')
    expect(resultCache.sha256).toHaveBeenCalledWith('ws/run/result/abc123')
  })

  it('read converts the bridge byte array into a Blob with the original bytes', async () => {
    const resultCache = fakeResultCacheBridge()
    resultCache.readBytes.mockResolvedValue(Array.from(new TextEncoder().encode('hello')))
    installDesktopBridge({ resultCache })

    const blob = await localResultCacheStorage().read('key')
    await expect(blob.text()).resolves.toBe('hello')
  })

  it('writeAtomic converts the Blob into a byte array and forwards it to the bridge', async () => {
    const resultCache = fakeResultCacheBridge()
    resultCache.writeBytesAtomic.mockResolvedValue(undefined)
    installDesktopBridge({ resultCache })

    await localResultCacheStorage().writeAtomic('key', new Blob(['payload']))

    expect(resultCache.writeBytesAtomic).toHaveBeenCalledWith('key', Array.from(new TextEncoder().encode('payload')))
  })

  it('remove delegates straight to the bridge (a hard delete, not trash)', async () => {
    const resultCache = fakeResultCacheBridge()
    installDesktopBridge({ resultCache })

    await localResultCacheStorage().remove('key')

    expect(resultCache.remove).toHaveBeenCalledWith('key')
  })

  it('rejects clearly when the desktop bridge is unavailable (e.g. running in a browser tab)', async () => {
    installDesktopBridge({})
    await expect(localResultCacheStorage().digest('key')).rejects.toThrow(/result-cache bridge is unavailable/)
  })
})

describe('workspaceResultCacheStorage', () => {
  it('refuses to build without a Workspace root', () => {
    expect(() => workspaceResultCacheStorage('')).toThrow(/Workspace root/)
  })

  it('digest resolves undefined for a missing Workspace path', async () => {
    const workspace = fakeWorkspaceBridge()
    workspace.exists.mockResolvedValue(false)
    installDesktopBridge({ workspace })

    await expect(workspaceResultCacheStorage('/root').digest('a/b.txt')).resolves.toBeUndefined()
    expect(workspace.exists).toHaveBeenCalledWith('/root', 'a/b.txt')
    expect(workspace.sha256).not.toHaveBeenCalled()
  })

  it('digest resolves the bridge hash scoped to the given root', async () => {
    const workspace = fakeWorkspaceBridge()
    workspace.exists.mockResolvedValue(true)
    workspace.sha256.mockResolvedValue('feed')
    installDesktopBridge({ workspace })

    await expect(workspaceResultCacheStorage('/root').digest('a/b.txt')).resolves.toBe('feed')
    expect(workspace.sha256).toHaveBeenCalledWith('/root', 'a/b.txt')
  })

  it('writeAtomic forwards the root, relative path, and byte content to the bridge', async () => {
    const workspace = fakeWorkspaceBridge()
    installDesktopBridge({ workspace })

    await workspaceResultCacheStorage('/root').writeAtomic('a/b.txt', new Blob(['content']))

    expect(workspace.writeBytesAtomic).toHaveBeenCalledWith(
      '/root', 'a/b.txt', Array.from(new TextEncoder().encode('content')),
    )
  })

  it('remove maps to workspace:trash, not a hard delete -- this is the user\'s own data', async () => {
    const workspace = fakeWorkspaceBridge()
    installDesktopBridge({ workspace })

    await workspaceResultCacheStorage('/root').remove('a/b.txt')

    expect(workspace.trash).toHaveBeenCalledWith('/root', 'a/b.txt')
  })
})

describe('desktopResultCache', () => {
  beforeEach(() => {
    installDesktopBridge({ resultCache: fakeResultCacheBridge(), workspace: fakeWorkspaceBridge() })
  })

  it('produces a usable ResultCache wired through studioInfrastructure', () => {
    // `desktopResultCache` resolves `studioInfrastructure()` internally; calling
    // it here first gets the identical memoized instance (same client, same
    // WeakMap entry -- see studioInfrastructure.test.ts's "reuses infrastructure
    // for the same client instance"), so spying on it observes the real call.
    const infrastructure = studioInfrastructure()
    const spy = vi.spyOn(infrastructure, 'resultCache')

    const cache = desktopResultCache('/root')

    expect(spy).toHaveBeenCalledTimes(1)
    expect(typeof cache.open).toBe('function')
    expect(typeof cache.availability).toBe('function')
    expect(typeof cache.materialize).toBe('function')
    expect(typeof cache.evict).toBe('function')
  })
})
