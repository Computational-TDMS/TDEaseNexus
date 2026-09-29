/**
 * Atomic + serialized file writing for the main process.
 *
 * Two layers:
 *
 * 1. `atomicReplace` / `writeTextAtomicQueued` — the temp+rename discipline
 *    with the Windows retry loop. On POSIX `rename(temp, target)` atomically
 *    replaces the target; on Windows the rename fails with EPERM/EACCES when
 *    anything (an antivirus scan, a lingering reader handle, a parallel
 *    writer) holds the target open, so writers retry with a short backoff and
 *    one target's writes are serialized so they cannot race each other.
 *
 * 2. `updateSettingsFile` — the ONE read-modify-write seam for settings.json.
 *    The file has five producers across the app (provider credentials,
 *    MCP config, sharing config, and NodeProviderRegistry's frozen model
 *    digests); each used to read the whole document, mutate, and write it
 *    back unsynchronized, so two concurrent writers lost one side's update.
 *    Here the read, the caller's transform, and the atomic write all happen
 *    inside a per-path serialized chain — the whole read-modify-write is one
 *    queued unit, closing both the lost-update window and the retry gap in
 *    one place. Transforms see `null` for a missing/corrupt document and
 *    return `null` to abort without writing.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "EEXIST"]);
const RENAME_RETRIES = 20;
const RENAME_BACKOFF_MS = 25;
const queuedAtomicWrites = new Map<string, Promise<void>>();

export async function atomicReplace(temp: string, target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt += 1) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!code || !RENAME_RETRY_CODES.has(code)) throw error;
      // Transient Windows lock — back off and retry the rename.
      await new Promise((resolveTime) => setTimeout(resolveTime, RENAME_BACKOFF_MS * (attempt + 1)));
    }
  }
  // Never degrade an atomic API into an in-place copy. The caller keeps the
  // previous complete target and receives the final rename error.
  throw lastError;
}

/** Serialize replacement of one target so concurrent writers cannot race
 *  each other's Windows rename. Different files remain concurrent. */
export function writeTextAtomicQueued(target: string, content: string): Promise<void> {
  return writeBufferAtomicQueued(target, Buffer.from(content, "utf8"))
}

/** The bytes twin of writeTextAtomicQueued — binary artifacts (provisioned
 *  tools, blob content) share the same queue and retry discipline. */
export function writeBufferAtomicQueued(target: string, content: Buffer): Promise<void> {
  const previous = queuedAtomicWrites.get(target) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.tdease-${randomUUID()}.tmp`;
    try {
      await writeFile(temp, content);
      await atomicReplace(temp, target);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  });
  const tracked: Promise<void> = write.finally(() => {
    if (queuedAtomicWrites.get(target) === tracked) queuedAtomicWrites.delete(target);
  });
  queuedAtomicWrites.set(target, tracked);
  return tracked;
}

// ── settings.json: one serialized read-modify-write seam ─────────────────────

/**
 * Receives the parsed document (`null` when missing or corrupt — the caller
 * decides whether that means "start fresh" or "abort"), returns the next
 * document, or `null` to abort without writing.
 */
export type SettingsTransform = (doc: Record<string, unknown> | null) => Record<string, unknown> | null;

const settingsUpdates = new Map<string, Promise<boolean>>();

/** True when the update landed on disk; false when the transform aborted it. */
export function updateSettingsFile(settingsPath: string, transform: SettingsTransform): Promise<boolean> {
  const target = resolve(settingsPath);
  const previous = settingsUpdates.get(target) ?? Promise.resolve(false);
  const run = previous.catch(() => false).then(async () => {
    let doc: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>;
    } catch { /* missing or corrupt — the transform decides what that means */ }
    const next = transform(doc);
    if (!next || typeof next !== "object" || Array.isArray(next)) return false;
    const temp = `${target}.tdease-${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await atomicReplace(temp, target);
      return true;
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  });
  const tracked: Promise<boolean> = run.finally(() => {
    if (settingsUpdates.get(target) === tracked) settingsUpdates.delete(target);
  });
  settingsUpdates.set(target, tracked);
  return tracked;
}

/**
 * The `providers.<id>` merge behind `settings:write-agent-provider`. A normal
 * write shallow-merges per key. A fully-empty write is a credential CLEAR:
 * it deletes the block EXCEPT the `models` map — persistModelMeta's frozen
 * capability digests and any hand-edited thinkingLevelMap are truth about the
 * model, not about the credential, and must survive a key being cleared.
 * Returns null when nothing is worth keeping (drop the whole block).
 */
export function mergeProviderConfig(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> | null {
  const hasValue = ["apiKey", "baseUrl", "headers"].some((key) => incoming[key] !== undefined && incoming[key] !== "");
  if (hasValue) return { ...existing, ...incoming };
  const models = existing?.models;
  if (models && typeof models === "object" && !Array.isArray(models) && Object.keys(models).length > 0) {
    return { models };
  }
  return null;
}
