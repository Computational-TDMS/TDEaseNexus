import { describe, expect, it, vi } from 'vitest'

/**
 * The file watcher translates raw chokidar event names into the `FileEvent`
 * union. Missing a case silently drops the event: the renderer never learns the
 * filesystem changed, so the file tree stops reflecting reality for that event
 * class. `unlinkDir` is the case this guards — dropping it meant a directory
 * deleted outside the app never disappeared from the tree.
 */
describe('mapNativeEvent', () => {
  it('is available as a named export', async () => {
    const mod = await import('./fileWatcher')
    expect(typeof mod.mapNativeEvent).toBe('function')
  })

  it('maps directory removal (unlinkDir) instead of dropping it', async () => {
    const { mapNativeEvent } = await import('./fileWatcher')
    expect(mapNativeEvent('unlinkDir')).toBe('unlinkDir')
  })

  it('still maps the file-level events it always has', async () => {
    const { mapNativeEvent } = await import('./fileWatcher')
    expect(mapNativeEvent('add')).toBe('add')
    expect(mapNativeEvent('change')).toBe('change')
    expect(mapNativeEvent('unlink')).toBe('unlink')
    expect(mapNativeEvent('addDir')).toBe('addDir')
  })
})

/**
 * A dropped event is one thing, but the event must also reach handlers once
 * mapped. The native watcher subscribes to chokidar's `'all'` stream; verify an
 * `unlinkDir` is forwarded as a `{ type: 'unlinkDir' }` FileEvent. Before the
 * fix this fired no handler at all, so a directory deleted outside the app
 * lived on in the tree forever.
 */
describe('createNativeWatcher forwards unlinkDir', () => {
  it('emits an unlinkDir FileEvent to handlers', async () => {
    // The preload exposes __tdease_fs_watch, which returns a chokidar-like
    // handle whose `.on('all', cb)` registers the filesystem-event callback.
    let emit!: (eventName: string, filePath: string) => void
    vi.stubGlobal('__tdease_fs_watch', (_root: string, _opts: unknown) => ({
      on: (_ev: string, cb: (eventName: string, filePath: string) => void) => {
        emit = cb
      },
      once: () => {},
      close: async () => {},
    }))
    const { createFileWatcher } = await import('./fileWatcher')
    const watcher = createFileWatcher('C:/ws')
    const seen: string[] = []
    watcher.on((e) => seen.push(e.type))
    await watcher.start()

    emit('unlinkDir', 'stale-dir')

    expect(seen).toContain('unlinkDir')
    await watcher.stop()
    vi.unstubAllGlobals()
  })
})
