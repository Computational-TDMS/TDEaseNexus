"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createSystemAssetCatalog } = require("./system_asset_catalog.cjs");

test("reads only component-manifest product assets", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-system-assets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const productRoot = path.join(root, "product");
  const writableRoot = path.join(root, "writable");
  fs.mkdirSync(path.join(productRoot, "skills", "current"), { recursive: true });
  fs.mkdirSync(path.join(writableRoot, "skills", "stale"), { recursive: true });
  fs.writeFileSync(path.join(productRoot, "skills", "current", "SKILL.md"), "current");
  fs.writeFileSync(path.join(writableRoot, "skills", "stale", "SKILL.md"), "stale");

  const catalog = createSystemAssetCatalog({ productRoot });
  assert.deepEqual(await catalog.listFiles("skills"), ["current/SKILL.md"]);
  assert.equal(await catalog.readText("skills/current/SKILL.md"), "current");
  await assert.rejects(catalog.readText("skills/stale/SKILL.md"), /Unknown System asset/);
});
