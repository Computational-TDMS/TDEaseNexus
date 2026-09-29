import type { TDEaseDesktop } from '@/services/desktop/desktopBridge'

export interface WorkspaceRegistryEntry {
  workspace_id: string
  name: string
  local_path: string
  last_opened_at: string
}

/**
 * The short label shown for a Workspace in selection lists, rail buttons and
 * titles. Prefers the registry `name`; falls back to the basename of
 * `local_path` when the name is empty OR is itself an absolute path.
 *
 * The absolute-path guard is a defensive backstop: a previous `setWorkspace`
 * bug wrote the full path as both `workspace_id` and `name`, and those stale
 * entries still sit in users' registries. The on-disk identity is the source
 * of truth going forward, but the display layer should never show a full path
 * regardless of how a bad name got in.
 */
export function workspaceDisplayName(entry: Pick<WorkspaceRegistryEntry, 'name' | 'local_path'>): string {
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (name && !isAbsolutePath(name)) return name
  const base = entry.local_path.split(/[\\/]/).filter(Boolean).pop()
  return base || entry.local_path || 'workspace'
}

export interface WorkspaceRegistry {
  schema_version: 1
  workspaces: WorkspaceRegistryEntry[]
}

interface WorkspaceRegistryBridge {
  list(): Promise<WorkspaceRegistry>
  upsert(entry: Pick<WorkspaceRegistryEntry, 'workspace_id' | 'name' | 'local_path'>): Promise<WorkspaceRegistry>
  remove(workspaceId: string): Promise<WorkspaceRegistry>
}

/** localStorage key used as fallback when the Electron bridge is absent. */
const LS_KEY = 'tdease.workspace.registry'

function bridge(): WorkspaceRegistryBridge | undefined {
  return (globalThis as { tdeaseDesktop?: TDEaseDesktop }).tdeaseDesktop?.workspaceRegistry
}

function hasBridge(): boolean {
  return !!bridge()
}

// ── localStorage fallback (used in browser dev mode) ──

function lsRead(): WorkspaceRegistry {
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed?.schema_version === 1 && Array.isArray(parsed.workspaces)) return parsed
    }
  } catch { /* ignore */ }
  return { schema_version: 1, workspaces: [] }
}

function lsWrite(reg: WorkspaceRegistry) {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(reg))
  } catch { /* ignore */ }
}

// ── Public API ──

export async function listOpenedWorkspaces(): Promise<WorkspaceRegistryEntry[]> {
  if (hasBridge()) return (await bridge()!.list()).workspaces
  return lsRead().workspaces
}

export async function rememberWorkspace(entry: {
  workspaceId: string
  name: string
  localPath: string
}): Promise<void> {
  if (hasBridge()) {
    if (!isAbsolutePath(entry.localPath)) return
    await bridge()!.upsert({
      workspace_id: entry.workspaceId,
      name: entry.name,
      local_path: entry.localPath,
    })
    return
  }
  // Browser fallback — accept relative paths (e.g. "demo").
  const reg = lsRead()
  reg.workspaces = reg.workspaces.filter((w) => w.workspace_id !== entry.workspaceId)
  reg.workspaces.push({
    workspace_id: entry.workspaceId,
    name: entry.name || entry.localPath.split(/[\\/]/).filter(Boolean).pop() || entry.workspaceId,
    local_path: entry.localPath,
    last_opened_at: new Date().toISOString(),
  })
  reg.workspaces.sort((a, b) => b.last_opened_at.localeCompare(a.last_opened_at))
  lsWrite(reg)
}

export async function forgetWorkspace(workspaceId: string): Promise<void> {
  if (hasBridge()) {
    await bridge()!.remove(workspaceId)
    return
  }
  const reg = lsRead()
  reg.workspaces = reg.workspaces.filter((w) => w.workspace_id !== workspaceId)
  lsWrite(reg)
}

function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')
}
