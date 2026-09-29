"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { reseedNodeCatalog, _internal } = require("./node_catalog_seed.cjs");

// The fake extractor plays the builder's contract: a `nodes/` tree inside the
// destination. `seedContent` maps package name -> file name -> text; the zip
// "bytes" only need to differ between seed versions for the fingerprint.
function makeEnv(shipped) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-node-seed-"));
  const env = {
    root,
    backendRoot: path.join(root, "backend"),
    toolsRoot: path.join(root, "backend", "nodes"),
    seedZip: path.join(root, "nodes.zip"),
    extractions: 0,
    extractCalls: [],
    logs: [],
    writeSeed(name, contents) {
      fs.writeFileSync(env.seedZip, `seed:${name}`);
      env.shipped = contents;
    },
    async extract(zipFile, destDir) {
      env.extractions += 1;
      env.extractCalls.push(destDir);
      const nodesRoot = path.join(destDir, "nodes");
      fs.mkdirSync(nodesRoot, { recursive: true });
      for (const [pkg, files] of Object.entries(env.shipped)) {
        fs.mkdirSync(path.join(nodesRoot, pkg), { recursive: true });
        for (const [file, text] of Object.entries(files)) {
          fs.writeFileSync(path.join(nodesRoot, pkg, file), text);
        }
      }
    },
    shipped: {},
    run(extra = {}) {
      return reseedNodeCatalog({
        seedZip: env.seedZip,
        backendRoot: env.backendRoot,
        toolsRoot: env.toolsRoot,
        extract: env.extract,
        log: (level, message, data) => env.logs.push({ level, message, data }),
        ...extra,
      });
    },
  };
  return env;
}

const toppicV1 = { "rules.smk": "toppic v1" };
const toppicV2 = { "rules.smk": "toppic v2" };

test("first seed installs the shipped set, writes the manifest, deletes the zip", async () => {
  const env = makeEnv();
  env.writeSeed("v1", { toppic: toppicV1, _template: { "README.md": "tpl" } });
  const expectedFingerprint = await _internal.sha256File(env.seedZip);

  const result = await env.run();

  assert.equal(result.action, "seeded");
  assert.deepEqual(result.packages, ["_template", "toppic"]);
  assert.equal(fs.readFileSync(path.join(env.toolsRoot, "toppic", "rules.smk"), "utf8"), "toppic v1");
  const manifest = JSON.parse(fs.readFileSync(path.join(env.toolsRoot, _internal.MANIFEST_NAME), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.fingerprint, expectedFingerprint);
  assert.deepEqual(manifest.packages, ["_template", "toppic"]);
  assert.ok(!fs.existsSync(env.seedZip), "zip removed after a verified seed");
});

test("matching fingerprint skips extraction and just discards the zip", async () => {
  const env = makeEnv();
  env.writeSeed("v1", { toppic: toppicV1 });
  await env.run();
  env.writeSeed("v1", { toppic: toppicV1 }); // same bytes, zip "returns" with the update
  assert.ok(fs.existsSync(env.seedZip));

  const result = await env.run();

  assert.equal(result.action, "unchanged");
  assert.equal(env.extractions, 1, "no second extraction");
  assert.ok(!fs.existsSync(env.seedZip));
});

test("changed fingerprint replaces seed-owned packages but never user-owned ones", async () => {
  const env = makeEnv();
  env.writeSeed("v1", { toppic: toppicV1, retired: { "a.txt": "old" } });
  await env.run();
  // A user-installed package (tdease.nodes.install) after the first seed.
  fs.mkdirSync(path.join(env.toolsRoot, "my-node"), { recursive: true });
  fs.writeFileSync(path.join(env.toolsRoot, "my-node", "rules.smk"), "user content");

  env.writeSeed("v2", { toppic: toppicV2, mynode2: { "b.txt": "new" } });
  const result = await env.run();

  assert.equal(result.action, "seeded");
  assert.equal(fs.readFileSync(path.join(env.toolsRoot, "toppic", "rules.smk"), "utf8"), "toppic v2");
  assert.equal(fs.readFileSync(path.join(env.toolsRoot, "my-node", "rules.smk"), "utf8"), "user content");
  assert.ok(fs.existsSync(path.join(env.toolsRoot, "mynode2", "b.txt")));
  assert.ok(!fs.existsSync(path.join(env.toolsRoot, "retired")), "shipped-but-retired package is removed");
});

test("a seed-owned name is refreshed even when the user recreated it manually", async () => {
  // Ownership is by NAME via the manifest (nodes.install refuses existing ids,
  // so a same-named dir is either an edited shipped package or an off-contract
  // manual copy) — the product doctrine is that shipped assets always update.
  const env = makeEnv();
  env.writeSeed("v1", { toppic: toppicV1 });
  await env.run();
  fs.rmSync(path.join(env.toolsRoot, "toppic"), { recursive: true, force: true });
  fs.mkdirSync(path.join(env.toolsRoot, "toppic"), { recursive: true });
  fs.writeFileSync(path.join(env.toolsRoot, "toppic", "rules.smk"), "user's own toppic");

  env.writeSeed("v2", { toppic: toppicV2 });
  const result = await env.run();

  assert.equal(result.action, "seeded");
  assert.equal(fs.readFileSync(path.join(env.toolsRoot, "toppic", "rules.smk"), "utf8"), "toppic v2");
});

test("matching fingerprint but a deleted shipped package reseeds it", async () => {
  const env = makeEnv();
  env.writeSeed("v1", { toppic: toppicV1, pride: { "p.txt": "pride" } });
  await env.run();
  env.writeSeed("v1", { toppic: toppicV1, pride: { "p.txt": "pride" } });
  fs.rmSync(path.join(env.toolsRoot, "pride"), { recursive: true, force: true });

  const result = await env.run();

  assert.equal(result.action, "seeded");
  assert.ok(fs.existsSync(path.join(env.toolsRoot, "pride", "p.txt")));
});

test("failed extraction keeps the zip and leaves the catalog untouched", async () => {
  const env = makeEnv();
  env.writeSeed("v1", { toppic: toppicV1 });
  await env.run();

  env.writeSeed("v2", { toppic: toppicV2 });
  const before = fs.readFileSync(path.join(env.toolsRoot, "toppic", "rules.smk"), "utf8");
  const result = await env.run({
    extract: async () => { throw new Error("tar exploded"); },
  });

  assert.equal(result.action, "failed");
  assert.equal(fs.readFileSync(path.join(env.toolsRoot, "toppic", "rules.smk"), "utf8"), before);
  assert.ok(fs.existsSync(env.seedZip), "zip kept for the next-launch retry");
  assert.ok(!fs.existsSync(path.join(env.backendRoot, ".nodes-seed-tmp")), "temp dir cleaned");
});

test("an extract missing a required entry aborts before touching the catalog", async () => {
  const env = makeEnv();
  env.writeSeed("v1", { toppic: toppicV1 });
  await env.run();

  env.writeSeed("v2", { pride: { "p.txt": "no toppic" } }); // toppic missing → broken seed
  const result = await env.run({ requiredEntries: [path.join("toppic", "rules.smk")] });

  assert.equal(result.action, "failed");
  assert.ok(fs.existsSync(path.join(env.toolsRoot, "toppic", "rules.smk")), "current catalog intact");
  assert.ok(!fs.existsSync(path.join(env.toolsRoot, "pride")), "broken seed not partially applied");
});
