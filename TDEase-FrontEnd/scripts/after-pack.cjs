/**
 * electron-builder afterPack hook — stage the MSVC runtime DLLs beside the
 * packaged exe on Windows.
 *
 * WHY: the app's native modules (koffi, @node-rs/crc32, @mariozechner/clipboard)
 * are MSVC-built and import vcruntime140.dll / msvcp140.dll. On a clean Windows
 * machine without the VC++ redistributable, loading them fails with the
 * misleading "The specified module could not be found" — which takes the whole
 * main process down at import time (diagnosed on the release VM, 2026-11-04).
 * Shipping the DLLs beside the exe sidesteps the system dependency entirely;
 * DLL search order finds them first, and machines that already have the redist
 * simply keep using whatever loads first (same code, no conflict).
 *
 * The DLLs are taken from the BUILD machine's System32 (the release VM installs
 * the latest vc_redist before building — see docs/RELEASE-VM.md), so the
 * packaged copies are always a current, complete set.
 */
const path = require("node:path");
const fs = require("node:fs");

const MSVC_RUNTIME = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll"];

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const appOutDir = context.appOutDir;
  const system32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  let staged = 0;
  for (const name of MSVC_RUNTIME) {
    const source = path.join(system32, name);
    if (!fs.existsSync(source)) continue;
    fs.copyFileSync(source, path.join(appOutDir, name));
    staged += 1;
  }
  if (staged < 2) {
    // vcruntime140 + msvcp140 are the load-bearing pair; anything less means
    // the build host itself lacks the redist and the native modules would not
    // even load here. Fail the build rather than ship a broken installer.
    throw new Error(
      `afterPack: only ${staged} MSVC runtime DLLs found in ${system32} — install the latest vc_redist.x64 on the build machine before packaging`,
    );
  }
  console.log(`[afterPack] staged ${staged} MSVC runtime DLL(s) beside the exe`);
};
