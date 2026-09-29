"use strict";

/**
 * Node-catalog seed with refresh-on-update contract.
 *
 * The installer ships the compute-node catalog as ONE zip
 * (`resources/backend/nodes.zip`, laid out `nodes/<package>/…`). The catalog
 * itself lives in the WRITABLE data root, so the question every update boot
 * must answer is: which directories there are ours to replace? The answer is
 * a manifest — `<toolsRoot>/.seed-manifest.json` records the zip fingerprint
 * (SHA-256) and the exact top-level names the last seed installed. On boot:
 *
 *   - fingerprint matches AND every recorded package still present → nothing
 *     to do; the zip is deleted (it already did its job this install).
 *   - otherwise the zip is extracted to a temp dir beside the catalog and
 *     each shipped entry REPLACES its seed-owned twin (a directory the
 *     previous manifest does not own — a user-installed or user-renamed
 *     package — is never touched, mirroring tdease.nodes.install's refusal
 *     rule); entries the previous seed owned but the new zip no longer ships
 *     are removed, so the catalog always equals shipped-set + user-set.
 *
 * A crash mid-reseed is retried idempotently on the next boot: the zip is
 * only deleted after the manifest is written, and the temp dir is wiped
 * before every attempt. Run snapshots are digest-addressed under
 * `nodes/.snapshots` and are never part of the manifest, so a reseed cannot
 * change the bytes an already-bound definition executes.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const MANIFEST_NAME = ".seed-manifest.json";
const TEMP_DIR_NAME = ".nodes-seed-tmp";

/** Streamed SHA-256 of a file — the seed is ~230 MB, read in chunks. */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function readManifest(toolsRoot) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(toolsRoot, MANIFEST_NAME), "utf8"));
    if (value?.schemaVersion === 1 && typeof value.fingerprint === "string" && Array.isArray(value.packages)) {
      return value;
    }
  } catch { /* absent or corrupt manifest: fall through to a full reseed */ }
  return null;
}

function writeManifest(toolsRoot, fingerprint, packages) {
  const payload = `${JSON.stringify({ schemaVersion: 1, fingerprint, packages }, null, 2)}\n`;
  fs.writeFileSync(path.join(toolsRoot, MANIFEST_NAME), payload, "utf8");
}

/** Default extractor: Windows bsdtar reads zip archives (`nodes/` prefix out). */
function defaultExtract(zipFile, destDir) {
  const tarPath = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  const extractor = fs.existsSync(tarPath) ? tarPath : "tar.exe";
  return new Promise((resolve, reject) => {
    execFile(extractor, ["-xf", zipFile, "-C", destDir], { windowsHide: true, timeout: 300_000 }, (error) => {
      if (error) reject(error); else resolve();
    });
  });
}

/**
 * @param {Object} options
 * @param {string} options.seedZip - Shipped `nodes.zip` path.
 * @param {string} options.backendRoot - Writable backend root (temp dir lives beside the catalog, same volume).
 * @param {string} options.toolsRoot - Catalog directory (`<backendRoot>/nodes`).
 * @param {string[]} [options.requiredEntries] - Entries the extraction must contain or the catalog is left untouched.
 * @param {(zipFile: string, destDir: string) => Promise<void>} [options.extract]
 * @param {() => void} [options.onBeforeExtract] - Invoked right before the (slow) extraction starts.
 * @param {(level: "info"|"warn", message: string, data?: unknown) => void} [options.log]
 * @returns {Promise<{action: "missing"|"unchanged"|"seeded"|"failed", packages?: string[], error?: unknown}>}
 */
async function reseedNodeCatalog({
  seedZip,
  backendRoot,
  toolsRoot,
  requiredEntries = [],
  extract = defaultExtract,
  onBeforeExtract = () => {},
  log = () => {},
} = {}) {
  if (!fs.existsSync(seedZip)) return { action: "missing" };

  const fingerprint = await sha256File(seedZip);
  const manifest = readManifest(toolsRoot);
  const previouslyOwned = new Set(manifest?.packages ?? []);
  if (manifest && manifest.fingerprint === fingerprint) {
    const missing = (manifest.packages ?? []).filter((name) => !fs.existsSync(path.join(toolsRoot, name)));
    if (missing.length === 0) {
      fs.rmSync(seedZip, { force: true });
      return { action: "unchanged", packages: manifest.packages };
    }
    log("info", "nodes.seed-package-deleted", { missing });
  }

  const tempDir = path.join(backendRoot, TEMP_DIR_NAME);
  try {
    fs.mkdirSync(toolsRoot, { recursive: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });
    onBeforeExtract();
    await extract(seedZip, tempDir);
    const extractedRoot = path.join(tempDir, "nodes");
    if (!fs.existsSync(extractedRoot)) throw new Error("seed archive does not contain a nodes/ root");
    for (const entry of requiredEntries) {
      if (!fs.existsSync(path.join(extractedRoot, entry))) {
        throw new Error(`seed extraction did not produce the shipped packages (missing ${entry})`);
      }
    }

    const shipped = fs.readdirSync(extractedRoot).sort();
    for (const name of shipped) {
      const target = path.join(toolsRoot, name);
      if (fs.existsSync(target) && !previouslyOwned.has(name)) {
        // Not ours: a user-installed package (tdease.nodes.install) or one the
        // user renamed — the catalog's ownership rule keeps it untouched.
        log("warn", "nodes.seed-skip-user-owned", { name });
        continue;
      }
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(path.join(extractedRoot, name), target);
    }
    // Shipped previously, gone now: keep the catalog exactly shipped-set + user-set.
    for (const name of previouslyOwned) {
      if (!shipped.includes(name)) {
        fs.rmSync(path.join(toolsRoot, name), { recursive: true, force: true });
        log("info", "nodes.seed-removed-retired", { name });
      }
    }

    writeManifest(toolsRoot, fingerprint, shipped);
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(seedZip, { force: true });
    return { action: "seeded", packages: shipped };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    // The zip is kept so the next launch retries; the manifest still names the
    // packages the CURRENT catalog got from the last successful seed.
    log("warn", "nodes.seed-reseed-failed", error);
    return { action: "failed", error };
  }
}

module.exports = { reseedNodeCatalog, _internal: { MANIFEST_NAME, readManifest, sha256File } };
