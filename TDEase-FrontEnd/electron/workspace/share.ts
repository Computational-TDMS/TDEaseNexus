// Host-side Web-sharing logic, extracted from main.ts (workstream 5).
//
// The host's only user-visible sharing surface: settings.json `sharing` holds
// the whole configuration (enable, loopback/LAN, port, tier, token, the ONE
// shared workspace). The ShareServer enforces it; this wiring only
// normalizes input, persists atomically and applies idempotently. Default is
// OFF + loopback, so nothing listens until the local user opts in.
//
// The ShareServer instance, the crash logger and the agent runtime are
// process state owned by main.ts, so they cross as an explicit `ShareWiring`
// object: main.ts builds it once and every IPC handler delegates with it.

import { readSettings } from "../runtime_config.cjs";
import { updateSettingsFile } from "../atomic-write";
import { ShareServer, type ShareConfig, type ShareInvite, type ShareMode, type ShareTier } from "../share-server";
import { readWorkspaceRegistry, workspacePath } from "./workspaceRegistry";

export const SHARE_TIERS: ReadonlyArray<ShareTier> = ["view", "continue", "control"];
export const SHARE_MODES: ReadonlyArray<ShareMode> = ["loopback", "lan"];

export interface ShareWiring {
  settingsFile: string
  registryFile: string
  crashLog: {
    info(event: string, details?: unknown): void
    warn(event: string, details?: unknown): void
    error(event: string, details?: unknown): void
  }
  getShareServer(): ShareServer | null
  setShareServer(server: ShareServer | null): void
  /** Host-side execution of a guest prompt — the ShareServer deps callback. */
  promptAgent(sessionId: string, message: string, guestName: string): Promise<{ ok: boolean; error?: string }>
}

export function normalizeShareInvite(value: unknown): ShareInvite | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const tier = SHARE_TIERS.includes(raw.tier as ShareTier) ? raw.tier as ShareTier : "view";
  const id = typeof raw.id === "string" ? raw.id : "";
  const name = typeof raw.name === "string" ? raw.name : "";
  const token = typeof raw.token === "string" ? raw.token : "";
  if (!id || !name || !token) return null;
  return {
    id,
    name,
    token,
    tier,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    ...(typeof raw.revokedAt === "string" ? { revokedAt: raw.revokedAt } : {}),
  };
}

export function normalizeShareConfig(value: unknown): ShareConfig {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const mode = SHARE_MODES.includes(raw.mode as ShareMode) ? raw.mode as ShareMode : "loopback";
  const portNumber = Number(raw.port);
  const invites = Array.isArray(raw.invites)
    ? raw.invites.map(normalizeShareInvite).filter((invite): invite is ShareInvite => invite !== null)
    : [];
  // Legacy migration (single shared token → one named invitation): the old
  // model's every-holder-is-one-crowd becomes an explicit "Link" guest, so an
  // upgrading host loses nothing and can revoke precisely what the old rotate
  // button used to nuke wholesale.
  if (invites.length === 0 && typeof raw.token === "string" && raw.token) {
    const legacyTier = SHARE_TIERS.includes(raw.tier as ShareTier) ? raw.tier as ShareTier : "view";
    invites.push({
      id: `legacy-${raw.token.slice(0, 6)}`,
      name: "Link",
      token: raw.token,
      tier: legacyTier,
      createdAt: new Date().toISOString(),
    });
  }
  return {
    enabled: raw.enabled === true,
    mode,
    port: Number.isInteger(portNumber) && portNumber >= 0 && portNumber <= 65535 ? portNumber : 0,
    invites,
    workspaceId: typeof raw.workspaceId === "string" ? raw.workspaceId : "",
  };
}

export async function resolveSharedWorkspaceRoot(wiring: ShareWiring, workspaceId: string): Promise<string> {
  if (!workspaceId) throw new Error("No workspace selected for sharing");
  const registry = await readWorkspaceRegistry(wiring.registryFile);
  const entry = registry.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
  if (!entry || typeof entry.local_path !== "string") {
    throw new Error(`Workspace is not registered: ${workspaceId}`);
  }
  return workspacePath(wiring.registryFile, entry.local_path);
}

export async function applyShareConfig(wiring: ShareWiring): Promise<void> {
  const config = normalizeShareConfig(readSettings(wiring.settingsFile)?.sharing);
  if (!config.enabled) {
    await wiring.getShareServer()?.stop();
    return;
  }
  // An enabled share whose workspace vanished from the registry stays DOWN —
  // fail closed with a log line instead of serving an empty root.
  try {
    await resolveSharedWorkspaceRoot(wiring, config.workspaceId);
  } catch (error) {
    wiring.crashLog.warn("share.start-workspace-unresolved", error);
    await wiring.getShareServer()?.stop();
    return;
  }
  const effective = config;
  let server = wiring.getShareServer();
  if (!server) {
    server = new ShareServer(effective, {
      resolveWorkspaceRoot: (workspaceId) => resolveSharedWorkspaceRoot(wiring, workspaceId),
      promptAgent: wiring.promptAgent,
      log: (level, message, details) => wiring.crashLog[level](`share.${message}`, details),
    });
    wiring.setShareServer(server);
  }
  await server.apply(effective).catch((error) => {
    wiring.crashLog.warn("share.apply-failed", error);
  });
}

export async function readShareInvites(wiring: ShareWiring): Promise<ShareInvite[]> {
  return [...normalizeShareConfig(readSettings(wiring.settingsFile)?.sharing).invites];
}

/** Serialized write of the invites array (create/revoke share this seam). */
export async function writeShareInvites(
  wiring: ShareWiring,
  transform: (invites: ShareInvite[]) => ShareInvite[],
): Promise<ShareInvite[]> {
  const current = normalizeShareConfig(readSettings(wiring.settingsFile)?.sharing);
  const nextInvites = transform([...current.invites]);
  const next: ShareConfig = { ...current, invites: nextInvites };
  const written = await updateSettingsFile(wiring.settingsFile, (doc) => ({ ...(doc ?? {}), sharing: next }));
  if (!written) throw new Error("settings.json could not be updated");
  await applyShareConfig(wiring);
  return nextInvites;
}
