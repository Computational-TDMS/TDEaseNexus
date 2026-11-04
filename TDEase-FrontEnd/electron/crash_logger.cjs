"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_BACKUPS = 2;
const MAX_VALUE_LENGTH = 16 * 1024;

function formatReason(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sanitize(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, MAX_VALUE_LENGTH);
}

function rotate(filePath, maxBytes, backups) {
  let size = 0;
  try { size = fs.statSync(filePath).size; } catch { return; }
  if (size < maxBytes) return;

  for (let index = backups; index >= 1; index -= 1) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
    const target = `${filePath}.${index}`;
    try { fs.rmSync(target, { force: true }); } catch { /* best effort */ }
    try { fs.renameSync(source, target); } catch { /* best effort */ }
  }
}

function createCrashLogger(filePath, { maxBytes = DEFAULT_MAX_BYTES, backups = DEFAULT_BACKUPS } = {}) {
  if (!filePath) throw new Error("crash log filePath is required");

  function write(level, event, details) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      rotate(filePath, maxBytes, backups);
      const suffix = details === undefined ? "" : ` ${sanitize(formatReason(details))}`;
      fs.appendFileSync(
        filePath,
        `${new Date().toISOString()} ${String(level).toUpperCase()} ${sanitize(event)}${suffix}\n`,
        "utf8",
      );
    } catch {
      // Crash reporting must never become another crash source.
    }
  }

  return {
    filePath,
    info: (event, details) => write("info", event, details),
    warn: (event, details) => write("warn", event, details),
    error: (event, details) => write("error", event, details),
  };
}

module.exports = {
  createCrashLogger,
  formatReason,
  sanitize,
};
