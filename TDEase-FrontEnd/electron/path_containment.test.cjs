"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { containedPath } = require("./path_containment.cjs");

test("contains existing and not-yet-created paths under the approved root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-contained-"));
  fs.mkdirSync(path.join(root, "runs"));
  assert.equal(containedPath(root, "runs/new/output.csv", "denied"), path.join(root, "runs", "new", "output.csv"));
  assert.throws(() => containedPath(root, "../outside.txt", "denied"), /denied/);
});

test("rejects a path crossing a symlink or Windows junction", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-junction-"));
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  const link = path.join(root, "escape");
  try {
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlink/junction unavailable: ${error.message}`);
    return;
  }
  assert.throws(() => containedPath(root, "escape/secret.txt", "denied"), /denied/);
  assert.throws(() => containedPath(root, "escape/new.txt", "denied"), /denied/);
});
