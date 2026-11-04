/**
 * OS-backed provider credential storage (Electron `safeStorage` — DPAPI on
 * Windows), persisted as `credentials.json` beside settings.json:
 *
 *   { "schemaVersion": 1, "providers": { "<providerId>": "<safeStorage base64>" } }
 *
 * Same data root as settings.json → the blob inherits the existing
 * install/uninstall lifecycle (drive-root fallback included) with zero new
 * path policy. The blob is bound to the Windows user, so a copied file is
 * useless off-machine; the protection class rises from "any reader of
 * settings.json" to "same-user processes only" (THREE-REPOSITORY-ARCHITECTURE
 * §6). Recorded tradeoff: safeStorage is OS-keyed, not user-secret-keyed —
 * any process running as the same user can decrypt. That is the
 * OS-credential-storage bar; a stronger vault is out of scope.
 *
 * Fail-closed by contract: when safeStorage is unavailable, writes and deletes
 * REFUSE (callers surface the error) and reads answer "not configured". There
 * is no plaintext write-back path anywhere in this module — a key that cannot
 * be stored encrypted is never persisted, and settings.json is scrubbed only
 * AFTER the encrypted blob is durably written.
 *
 * Every call requires app.whenReady() (safeStorage's precondition); callers
 * are post-ready by construction (IPC handlers, lazy resolve) and
 * `isAvailable()` asserts it. Outside Electron (unit tests, node-only
 * tooling) the module degrades to unavailable — fail-closed, exactly like a
 * pre-ready call.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { app, safeStorage } from "electron";

import { updateSettingsFile } from "./atomic-write";

const CREDENTIALS_SCHEMA_VERSION = 1;

export interface CredentialStore {
  /** True only when the app is ready AND safeStorage can encrypt. */
  isAvailable(): boolean;
  /**
   * Encrypt `plainKey` into credentials.json, then scrub the plaintext out of
   * settings.json (`apiKey`/`api_key` removed, `apiKeyStored: true` marker).
   * Refuses (throws) when safeStorage is unavailable — settings.json is not
   * touched in that case.
   */
  storeProviderKey(providerId: string, plainKey: string): Promise<void>;
  /** Remove one provider's blob. Refuses (throws) when unavailable. */
  deleteProviderKey(providerId: string): Promise<void>;
  /**
   * Decrypt one provider's key, or null when unconfigured/unavailable —
   * never a plaintext fallback. Synchronous on purpose: safeStorage's
   * decryptString is sync, the store file is tiny, and resolve()'s contract
   * is sync (provider-registry reads settings.json the same way).
   */
  getProviderKey(providerId: string): string | null;
  /** sha256[:8] of the stored key — the redacted summary contract. */
  fingerprint(providerId: string): string | null;
  /**
   * One pass over settings.json: every provider still carrying a legacy
   * plaintext `apiKey`/`api_key` (pre-upgrade install, the packaged seed) is
   * moved into the store — encrypted blob first, then the settings block
   * scrubbed to the marker. Refuses the whole pass when unavailable:
   * plaintext stays where it is (status quo) and the next launch retries.
   */
  migrateLegacyProviderKeys(): Promise<void>;
}

/** The providers slice of credentials.json — the only fields this module reads. */
interface CredentialsFile {
  schemaVersion?: number;
  providers?: Record<string, unknown>;
}

export function createCredentialStore(settingsPath: string): CredentialStore {
  const settingsFile = resolve(settingsPath);
  const credentialsFile = join(dirname(settingsFile), "credentials.json");

  function isAvailable(): boolean {
    try {
      // Electron's own predicate is isEncryptionAvailable(); our interface
      // shortens it and additionally asserts app readiness (safeStorage's
      // precondition — the docs' `app.whenReady()` bar).
      return app.isReady() && safeStorage.isEncryptionAvailable();
    } catch {
      // Outside Electron the imports bind to nothing — degrade to
      // unavailable, which is this module's fail-closed posture.
      return false;
    }
  }

  function requireAvailable(): void {
    if (!isAvailable()) {
      throw new Error("credential store unavailable: safeStorage needs app.whenReady() and OS key storage");
    }
  }

  function readProviderKey(providerId: string): string | null {
    if (!isAvailable()) return null;
    let doc: CredentialsFile | null = null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(credentialsFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed as CredentialsFile;
    } catch {
      return null; // missing or corrupt store file: "not configured"
    }
    const blob = doc?.providers?.[providerId];
    if (typeof blob !== "string" || !blob) return null;
    try {
      return safeStorage.decryptString(Buffer.from(blob, "base64"));
    } catch {
      // Undecryptable (different OS user, corrupt blob): not configured.
      return null;
    }
  }

  /** One serialized read-modify-write of credentials.json (null blob = delete). */
  function writeProviderBlob(providerId: string, blob: string | null): Promise<boolean> {
    return updateSettingsFile(credentialsFile, (doc) => {
      const providers = { ...((doc?.providers ?? {}) as Record<string, string>) };
      if (blob === null) {
        if (!(providerId in providers)) return null; // absent: no write
        delete providers[providerId];
      } else {
        if (providers[providerId] === blob) return null; // unchanged: no write
        providers[providerId] = blob;
      }
      return { schemaVersion: doc?.schemaVersion ?? CREDENTIALS_SCHEMA_VERSION, providers };
    });
  }

  /**
   * settings.json scrub: drop both plaintext spellings, leave the
   * `apiKeyStored` marker. Never invents a settings file; a no-op (no write)
   * when the file is missing or the block is already clean.
   */
  function scrubSettingsBlock(providerId: string): Promise<boolean> {
    return updateSettingsFile(settingsFile, (doc) => {
      if (!doc) return null;
      const providers = { ...((doc.providers ?? {}) as Record<string, Record<string, unknown>>) };
      const config = providers[providerId];
      if (!config) return null;
      if (config.apiKey === undefined && config.api_key === undefined && config.apiKeyStored === true) return null;
      const next = { ...config };
      delete next.apiKey;
      delete next.api_key;
      next.apiKeyStored = true;
      providers[providerId] = next;
      return { ...doc, providers };
    });
  }

  async function storeProviderKey(providerId: string, plainKey: string): Promise<void> {
    if (typeof plainKey !== "string" || !plainKey) throw new Error("cannot store an empty provider key");
    requireAvailable();
    const blob = safeStorage.encryptString(plainKey).toString("base64");
    // Order is load-bearing: the encrypted blob lands FIRST. A failure after
    // it leaves a re-storable credential; a failure before it leaves the
    // status quo. The plaintext scrub happens only once the blob is durable —
    // that ordering is what makes "no plaintext write-back" true.
    await writeProviderBlob(providerId, blob);
    await scrubSettingsBlock(providerId);
  }

  async function migrateLegacyProviderKeys(): Promise<void> {
    let settings: { providers?: unknown } | null = null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as { providers?: unknown };
    } catch {
      return; // no settings file — nothing to migrate
    }
    const providers = settings?.providers;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) return;
    for (const [providerId, raw] of Object.entries(providers)) {
      const config = raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as { apiKey?: unknown; api_key?: unknown })
        : null;
      const plain = typeof config?.apiKey === "string" && config.apiKey ? config.apiKey
        : typeof config?.api_key === "string" && config.api_key ? config.api_key
        : null;
      if (!plain) continue;
      // Refuse (keep the status quo) rather than half-migrate when the OS
      // store is not there; the next post-ready launch retries.
      requireAvailable();
      await storeProviderKey(providerId, plain);
    }
  }

  return {
    isAvailable,
    storeProviderKey,
    async deleteProviderKey(providerId: string): Promise<void> {
      requireAvailable();
      await writeProviderBlob(providerId, null);
    },
    getProviderKey: readProviderKey,
    fingerprint(providerId: string): string | null {
      const key = readProviderKey(providerId);
      return key ? createHash("sha256").update(key).digest("hex").slice(0, 8) : null;
    },
    migrateLegacyProviderKeys,
  };
}
