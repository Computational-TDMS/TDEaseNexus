/**
 * useWorkspaceOpener — single source of truth for opening / switching a
 * workspace.
 *
 * It used to also prime a Canvas `views` store (which started a second file
 * watcher) and a `selection` store on every open. Nothing read either one once
 * the Canvas surface came out, so both are gone.
 *
 * Flow:
 *   pickAndOpen()  → Electron folder dialog (or demo fallback in browser)
 *   openPath(p)    → setWorkspace + loadFileTree
 *   switchTo(entry)→ openPath(entry.local_path, { id, name }) for a remembered
 *                    workspace — passing the registry's stable `workspace_id`
 *                    so reopening a folder reuses its id instead of minting a
 *                    new one (which the registry would then dedupe away,
 *                    losing the history entry).
 */

import { useWorkspaceStore } from '@/stores/workspace'

export function useWorkspaceOpener() {
  const workspaceStore = useWorkspaceStore()

  /**
   * Bind `path` as the active Workspace.
   *
   * `opts.id` is forwarded to `setWorkspace` so callers that already hold a
   * stable identity (the registry entry on a reopen, a test) reuse it rather
   * than letting `setWorkspace` mint a fresh `ws_<hex>`. Omit it for a genuine
   * first open of an unknown folder.
   */
  async function openPath(path: string, opts: { id?: string; name?: string } = {}) {
    const name = (opts.name ?? path.split(/[\\/]/).pop()) || 'workspace'
    await workspaceStore.setWorkspace(path, { id: opts.id, name })
    await workspaceStore.loadFileTree()
  }

  /**
   * Show the native folder picker; resolves to the chosen path or null.
   * Returns `null` in three cases: no native picker (browser dev), user
   * cancelled, or the bridge threw. The caller distinguishes the first from
   * the latter two via `pickerAvailable`.
   */
  async function pickDirectory(): Promise<{ path: string | null; pickerAvailable: boolean }> {
    const bridge = window.__tdease_fs
    if (!bridge || typeof bridge.pickDirectory !== 'function') {
      // Browser / no preload — there is genuinely no picker.
      return { path: null, pickerAvailable: false }
    }
    try {
      const picked = await bridge.pickDirectory()
      // Elect.dialog returns '' when the user cancels; treat empty as null.
      return { path: picked || null, pickerAvailable: true }
    } catch {
      // Bridge is present but failed — do NOT silently fall back to demo.
      return { path: null, pickerAvailable: true }
    }
  }

  /**
   * Open the folder dialog and switch to the picked workspace.
   *
   * Browser dev mode (no Electron preload) has no native picker — to keep the
   * UI usable we fall back to a seed workspace (`fallbackPath`, default
   * 'demo'). In Electron the picker IS available, so a null result means the
   * user cancelled (or the bridge failed): we do NOT silently open the demo
   * in that case — return false and let the caller decide.
   *
   * Returns true if a workspace is now open (picked, OR fallback in browser
   * mode), false when the picker was available but produced nothing.
   */
  async function pickAndOpen(fallbackPath: string | null = 'demo'): Promise<boolean> {
    const { path: picked, pickerAvailable } = await pickDirectory()
    if (picked) {
      await openPath(picked)
      return true
    }
    if (!pickerAvailable && fallbackPath !== null) {
      await openPath(fallbackPath)
      return true
    }
    return false
  }

  return { openPath, pickDirectory, pickAndOpen }
}
