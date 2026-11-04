"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createCrashLogger, formatReason, sanitize } = require("./crash_logger.cjs");

test("writes timestamped crash records synchronously", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-crash-log-"));
  const filePath = path.join(root, "logs", "electron-main.log");
  const logger = createCrashLogger(filePath);

  logger.error("main.uncaught-exception", new Error("boom"));

  const content = fs.readFileSync(filePath, "utf8");
  assert.match(content, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(content, /ERROR main\.uncaught-exception/);
  assert.match(content, /Error: boom/);
});

test("rotates bounded crash logs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-crash-rotate-"));
  const filePath = path.join(root, "electron-main.log");
  fs.writeFileSync(filePath, "x".repeat(64));
  const logger = createCrashLogger(filePath, { maxBytes: 32, backups: 2 });

  logger.warn("renderer.gone", "crashed");

  assert.equal(fs.readFileSync(`${filePath}.1`, "utf8"), "x".repeat(64));
  assert.match(fs.readFileSync(filePath, "utf8"), /WARN renderer\.gone crashed/);
});

test("formats non-Error reasons and redacts credentials", () => {
  assert.equal(formatReason({ code: "BAD" }), '{"code":"BAD"}');
  assert.equal(sanitize("Authorization: Bearer token-value"), "Authorization: Bearer [REDACTED]");
  assert.equal(sanitize("api_key=private-value"), "api_key=[REDACTED]");
});
