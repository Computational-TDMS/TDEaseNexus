// build-main.mjs — bundle Electron main process TS → CJS via esbuild.
//
// Why: the Pi SDK (@earendil-works/pi-coding-agent) is ESM-only, but Electron
// main must be CJS (package.json "type":"module" forces .cjs). esbuild bundles
// our TS sources (electron/main.ts + electron/lib/**) into a single
// main.bundle.cjs; the SDK packages stay external so Electron resolves them
// from node_modules at runtime.
//
// Usage:
//   node electron/build-main.mjs         # one-shot build
//   node electron/build-main.mjs --watch # incremental rebuild for dev

import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { builtinModules } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const entry = path.join(__dirname, "main.ts");
const outdir = path.join(__dirname, "dist");
const outfile = path.join(outdir, "main.bundle.cjs");
const harnessEntry = path.join(__dirname, "agent-harness-cli.ts");
const harnessOutput = path.join(outdir, "agent-harness.cjs");
// The agent runtime's utilityProcess host — same bundle recipe as the harness
// (Pi SDK bundled, native modules external, import.meta patched post-build).
// main.ts forks this as electron/dist/agent-utility.cjs; see
// electron/agent/utility-host.ts.
const utilityHostEntry = path.join(__dirname, "agent", "utility-host.ts");
const utilityHostOutput = path.join(outdir, "agent-utility.cjs");
// The preload MUST land beside main.bundle.cjs, because that is where
// `createMainWindow()` looks for it: `path.join(__dirname, "preload.cjs")`,
// and __dirname for the bundle is electron/dist/.
//
// It was not built here, and Electron does not fail on a missing preload --
// it warns to the main process's stderr, which nothing was reading, and
// creates the window anyway. So `window.tdeaseDesktop` was undefined in every
// run, dev and packaged: no workspace filesystem, no workspace registry, no
// result cache, and no Pi runtime, which is to say no Agent turn could start
// at all. The renderer degraded quietly into its browser fallbacks instead of
// reporting that the desktop half of the application was missing.
//
// Caught by tests/desktop/boots-and-attaches.spec.ts on its first run.
const preloadSource = path.join(__dirname, "preload.cjs");
const preloadOutput = path.join(outdir, "preload.cjs");
// The splash window's minimal preload (see electron/splash-preload.cjs) —
// built with the same recipe and landed beside main.bundle.cjs, where
// createSplashWindow() looks for it via `path.join(__dirname, ...)`.
const splashPreloadSource = path.join(__dirname, "splash-preload.cjs");
const splashPreloadOutput = path.join(outdir, "splash-preload.cjs");
const NODE_BUILTINS = [...new Set([
  ...builtinModules,
  ...builtinModules.filter((module) => !module.startsWith("node:")).map((module) => `node:${module}`),
])];

// Packages that must remain external — Electron resolves them at runtime.
// - electron          : built-in to the Electron runtime.
// - chokidar / electron-updater : already optional dynamic require in main.
const EXTERNAL = [
  ...NODE_BUILTINS,
  "electron",
  "chokidar",
  "electron-updater",
  // `yauzl-promise` is CommonJS and reaches Node built-ins such as `tty`.
  // Keeping it external lets Node load it with its native CommonJS resolver
  // instead of emitting esbuild's unsupported dynamic-require shim in the
  // ESM Pi runtime.
  "yauzl-promise",
  // `node-pty` is a native module (build/Release/pty.node + conpty.dll) — it
  // can never be bundled; Electron must resolve it from node_modules at
  // runtime, and electron-builder unpacks it from asar (asarUnpack).
  "node-pty",
  // `koffi` (declarative FFI for the Windows job object) is likewise native:
  // prebuilt koffi.node in a platform optional dependency, loadable only
  // outside the asar archive.
  "koffi",
];

const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: [entry],
  bundle: true,
  outfile,
  format: "cjs",
  platform: "node",
  target: "node24",
  sourcemap: watch ? "inline" : false,
  sourcesContent: false,
  logLevel: "info",
  // Pi is ESM-only. It is intentionally bundled into this CJS artifact so
  // Electron never has to `require()` an ESM package and no second runtime
  // bundle can drift from main.
  external: EXTERNAL,
  // The Pi package's exports map exposes only . / ./rpc-entry / ./client —
  // its HTTP dispatcher is NOT importable as a subpath. The proxy wiring
  // must reach the SAME undici instance Pi's vendor calls fetch through
  // (a separate undici dependency would have its own global-dispatcher
  // registry and proxy nothing that matters), so the alias resolves our
  // import to Pi's bundled copy — esbuild dedupes by resolved path: one
  // module, one undici. If Pi ever moves the file, the build fails HERE
  // instead of the proxy silently not applying.
  alias: {
    "@tdease/pi-http-dispatcher": path.join(
      root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "http-dispatcher.js",
    ),
  },
  // `import.meta.url` for the CJS bundle is patched post-build by
  // `patchImportMetaShim` — see its comment for why esbuild's `inject` cannot
  // reach the Pi SDK's pre-compiled local `import_meta` variable.
  // main.cjs relies on __dirname for path resolution; esbuild preserves
  // __dirname in cjs format by default for the entry file.
};

const harnessOptions = {
  ...options,
  entryPoints: [harnessEntry],
  outfile: harnessOutput,
};

const utilityHostOptions = {
  ...options,
  entryPoints: [utilityHostEntry],
  outfile: utilityHostOutput,
};

// The preload runs in a sandboxed renderer, not in Node: `electron` is the only
// module it may require, and esbuild is used rather than a file copy so a
// stray future `require("node:fs")` fails the build instead of failing silently
// at window-create time.
/** @type {esbuild.BuildOptions} */
const preloadOptions = {
  entryPoints: [preloadSource],
  bundle: true,
  outfile: preloadOutput,
  format: "cjs",
  platform: "browser",
  target: "chrome138",
  sourcemap: watch ? "inline" : false,
  sourcesContent: false,
  logLevel: "info",
  external: ["electron"],
};

const splashPreloadOptions = {
  ...preloadOptions,
  entryPoints: [splashPreloadSource],
  outfile: splashPreloadOutput,
};

async function main() {
  if (!fs.existsSync(entry)) {
    console.error(`[build-main] entry not found: ${entry}`);
    console.error(`[build-main] expected electron/main.ts (created during Pi kernel migration)`);
    process.exit(1);
  }
  fs.mkdirSync(outdir, { recursive: true });
  if (!fs.existsSync(preloadSource)) {
    throw new Error(`[build-main] preload not found: ${preloadSource}`);
  }

  if (watch) {
    const contexts = await Promise.all(
      [options, harnessOptions, utilityHostOptions, preloadOptions, splashPreloadOptions].map((opts) => esbuild.context(opts)),
    );
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("[build-main] watching for changes...");
  } else {
    await Promise.all([
      esbuild.build(options),
      esbuild.build(harnessOptions),
      esbuild.build(utilityHostOptions),
      esbuild.build(preloadOptions),
      esbuild.build(splashPreloadOptions),
    ]);
    patchImportMetaShim(outfile);
    patchImportMetaShim(harnessOutput);
    patchImportMetaShim(utilityHostOutput);
    for (const out of [outfile, harnessOutput, utilityHostOutput, preloadOutput, splashPreloadOutput]) {
      console.log(
        `[build-main] ${path.relative(root, out)} — built (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`,
      );
    }
  }
}

/**
 * Patch the Pi SDK's pre-compiled `import.meta.url` capture in the CJS bundle.
 *
 * The SDK's dist/config.js was itself bundled with an older esbuild that emits
 * `var import_meta = {};` and then reads `import_meta.url` at MODULE LOAD time
 * (fileURLToPath(import_meta.url) → __dirname for self-update config). Our
 * esbuild `inject` shim only rewrites `import.meta.url` references in OUR
 * sources; it cannot reach inside the SDK's already-minified local variable,
 * so the load-time `fileURLToPath(undefined)` crashes Electron before app code
 * runs. There is exactly one such occurrence (verified), from config.js.
 *
 * Replacing the empty object with a real `pathToFileURL(__filename).href`
 * (available in CJS) makes import_meta.url spec-equivalent, and the SDK's
 * fileURLToPath/__dirname/isBunBinary reads all resolve correctly. Idempotent:
 * if the pattern is already patched (or absent), this is a no-op.
 */
function patchImportMetaShim(bundlePath) {
  const before = fs.readFileSync(bundlePath, "utf8");
  // Matches every pre-compiled `import.meta` capture the SDK emits, in BOTH
  // shapes esbuild has been observed to emit across bundler versions and
  // module-graph layouts:
  //   1. a standalone declaration — `var import_meta2 = {};`
  //   2. an assignment inside a hoisted comma declaration list —
  //      `var a = 1, import_meta = {};` → the `import_meta = {};` fragment.
  // Each is a module-load-time hazard: the SDK reads `.url` from it
  // (fileURLToPath(import_meta.url), createRequire(import_meta.url)) and esbuild
  // leaves the object empty under cjs format, so `.url` is undefined and the
  // load crashes Electron before app code runs. Shape (2) is why this patch
  // once silently missed: the 2026-09-05 lazy-agent-runtime rework reordered
  // the graph, esbuild switched to the comma-list form, the `var `-anchored
  // regex matched nothing, and the first agent IPC died at runtime with
  // ERR_INVALID_ARG_TYPE from fileURLToPath(undefined).
  const pattern = /(var\s+)?(import_meta\d*)\s*=\s*\{\}(;?)/g;
  const replacement =
    "$1$2 = { url: require('url').pathToFileURL(__filename).href }$3";
  const after = before.replace(pattern, replacement);
  const count = (before.match(pattern) || []).length;
  if (count === 0) {
    // Verify the absence is real and not a THIRD shape the pattern no longer
    // knows: any surviving empty `import_meta*` capture after this pass is a
    // guaranteed runtime crash, so fail the build loudly instead of shipping
    // it silently (the exact failure mode this function existed to prevent).
    const survivors = after.match(/import_meta\d*\s*=\s*\{\}/g);
    if (survivors) {
      console.error(
        `[build-main] import.meta patch found ${survivors.length} UNPATCHED capture(s) in an unrecognized shape — update the pattern (electron/build-main.mjs patchImportMetaShim).`,
      );
      process.exit(1);
    }
    return;
  }
  fs.writeFileSync(bundlePath, after, "utf8");
  console.log(
    `[build-main] patched ${count} Pi SDK import.meta.url capture(s) in main bundle`,
  );
}

main().catch((err) => {
  console.error("[build-main] failed:", err);
  process.exit(1);
});
