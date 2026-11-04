// Workspace registry persistence + the containment gatekeeper, extracted
// from main.ts.
//
// The registry file path and the Backend connection are process state owned by
// main.ts (`runtimePaths`, `backendConnectionInfo()`), so every function takes
// them explicitly: `registryFile` as a plain parameter, the connection as a
// `getConnection` thunk evaluated at the exact point the inline code used to
// call `backendConnectionInfo()`. main.ts binds thin forwarders so its ~20
// call sites read exactly as before.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { containedPath } from "../path_containment.cjs";
import { atomicReplace } from "../atomic-write";

/** One local Workspaces registry entry. The file on disk is external data —
 *  field accesses still guard at runtime; this interface states the shape
 *  this process itself writes. */
export interface WorkspaceRegistryEntry {
  workspace_id: string
  name?: string
  local_path: string
  backend_root_id?: string
  last_opened_at?: string
}
export type WorkspaceRegistryFile = { schema_version: 1; workspaces: WorkspaceRegistryEntry[] };

/** The slice of the Backend connection the root-approval calls need. */
export interface BackendConnectionRef {
  baseUrl: string
  accessToken: string | null
}

export async function readWorkspaceRegistry(registryFile: string): Promise<WorkspaceRegistryFile> {
  try {
    const value = JSON.parse(await fsp.readFile(registryFile, "utf8")) as WorkspaceRegistryFile;
    return value?.schema_version === 1 && Array.isArray(value.workspaces)
      ? value
      : { schema_version: 1, workspaces: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { schema_version: 1, workspaces: [] };
    throw error;
  }
}

export async function writeWorkspaceRegistry(registryFile: string, value: WorkspaceRegistryFile) {
  await fsp.mkdir(path.dirname(registryFile), { recursive: true });
  const temp = `${registryFile}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await atomicReplace(temp, registryFile);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
}

// ── Backend Workspace-root approval ────────────────────────────────────
//
// An absolute path crosses the protocol only at attach time. Backend persists a
// per-principal grant and returns an opaque root_id; Run commits use that id plus
// a relative Run path. Removing a Workspace revokes the same grant.
export async function approveWorkspaceRootWithBackend(
  getConnection: () => BackendConnectionRef,
  absolutePath: string,
): Promise<{ root_id: string; path: string }> {
  const { baseUrl, accessToken } = getConnection();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/workspace-roots`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ path: absolutePath }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Backend at ${baseUrl} is unavailable while approving the Workspace root (${reason}). Start or repair the development Backend, then retry.`, { cause });
  }
  if (!response.ok) {
    // Surface the Backend's own envelope rather than inventing a message: it
    // already carries the code and the remedy the user needs.
    let detail = `HTTP ${response.status}`;
    try {
      type BackendErrorEnvelope = { code?: string; message?: string; remedy?: string };
      const body = await response.json() as { error?: BackendErrorEnvelope; detail?: { error?: BackendErrorEnvelope } } | null;
      const error = body?.error ?? body?.detail?.error;
      if (error?.message) detail = `${error.code}: ${error.message}${error.remedy ? ` — ${error.remedy}` : ""}`;
    } catch { /* keep the status-only detail */ }
    throw new Error(`Backend refused the Workspace root ${absolutePath} (${detail})`);
  }
  return response.json() as Promise<{ root_id: string; path: string }>;
}

export async function revokeWorkspaceRootWithBackend(
  getConnection: () => BackendConnectionRef,
  rootId: string,
): Promise<void> {
  let connection;
  try { connection = getConnection(); } catch { return; }
  let response: Response;
  try {
    response = await fetch(`${connection.baseUrl}/api/workspace-roots/${encodeURIComponent(rootId)}`, {
      method: "DELETE",
      headers: connection.accessToken ? { Authorization: `Bearer ${connection.accessToken}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Backend at ${connection.baseUrl} is unavailable while revoking the Workspace root (${reason})`, { cause });
  }
  if (!response.ok && response.status !== 404) {
    throw new Error(`Backend refused to revoke Workspace root ${rootId} (HTTP ${response.status})`);
  }
}

// Absolute-path variant of the gatekeeper for the few IPC that take a raw
// absolute path instead of (root, relative): the path must sit inside SOME
// registered Workspace root (the root itself counts). Same fail-closed
// registry read as `workspacePath` below.
export function registeredWorkspacePath(registryFile: string, absPath: string): string {
  if (!path.isAbsolute(absPath)) throw new Error("path must be absolute");
  const resolved = path.resolve(absPath);
  let workspaces: unknown[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFile, "utf8")) as { workspaces?: unknown[] } | null;
    if (Array.isArray(parsed?.workspaces)) workspaces = parsed.workspaces;
  } catch {
    // Unreadable registry ⇒ nothing registered ⇒ membership fails closed.
  }
  const contained = workspaces.some((entry) => {
    const localPath = (entry as WorkspaceRegistryEntry | undefined)?.local_path;
    if (typeof localPath !== "string") return false;
    const root = path.resolve(localPath);
    return resolved === root || resolved.startsWith(root + path.sep);
  });
  if (!contained) throw new Error("path is outside every registered workspace");
  return resolved;
}

// The gatekeeper for every `workspace:*` IPC: the root must be absolute AND a
// registered Workspace (canonical-path membership in the registry file), and
// the relative part must stay contained. Checked ONLY against the local
// registry — never the Backend. Read synchronously on purpose: every handler
// below resolves through here before touching the filesystem.
export function workspacePath(registryFile: string, root: string, relative = "."): string {
  if (!path.isAbsolute(root)) throw new Error("workspace root must be absolute");
  const resolvedRoot = path.resolve(root);
  let workspaces: unknown[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFile, "utf8")) as { workspaces?: unknown[] } | null;
    if (Array.isArray(parsed?.workspaces)) workspaces = parsed.workspaces;
  } catch {
    // An unreadable registry means nothing is registered; the membership
    // check below fails closed on the empty list.
  }
  const registered = workspaces.some((entry) => {
    const localPath = (entry as WorkspaceRegistryEntry | undefined)?.local_path;
    return typeof localPath === "string" && path.resolve(localPath) === resolvedRoot;
  });
  if (!registered) throw new Error("workspace root is not registered");
  return containedPath(resolvedRoot, relative, "workspace path traversal denied");
}
