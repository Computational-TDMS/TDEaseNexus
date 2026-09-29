"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Resolve the project root from this module's location.
 * Unbundled: __dirname = electron/         → project root is parent.
 * Bundled:   __dirname = electron/dist/    → project root is grandparent.
 */
function projectRoot() {
  return path.basename(__dirname) === "dist"
    ? path.resolve(__dirname, "..", "..")
    : path.resolve(__dirname, "..");
}

/**
 * @param {{isDev?: boolean, resourcesPath?: string}} [options]
 */
function resolveComponents({ isDev, resourcesPath = process.resourcesPath } = {}) {
  const manifest = isDev
    ? path.resolve(projectRoot(), "config", "components.dev.json")
    : path.join(resourcesPath || "", "installation", "components.json");
  let value;
  try {
    value = JSON.parse(fs.readFileSync(manifest, "utf8"));
  } catch (cause) {
    throw new Error(`Component manifest is unreadable: ${manifest}: ${cause.message}`);
  }
  if (value?.schemaVersion !== 1) throw new Error("Component manifest schemaVersion must be 1");
  if (typeof value.backend?.root !== "string" || typeof value.backend?.command !== "string") {
    throw new Error("Component manifest backend entry is invalid");
  }
  if (typeof value.scientific?.root !== "string") {
    throw new Error("Component manifest scientific entry is invalid");
  }
  const base = path.dirname(manifest);
  return Object.freeze({
    manifest,
    backend: Object.freeze({
      root: path.resolve(base, value.backend.root),
      command: value.backend.command,
    }),
    scientific: Object.freeze({ root: path.resolve(base, value.scientific.root) }),
  });
}

module.exports = { resolveComponents };
