/**
 * Node-side System asset surface.
 *
 * The renderer read System templates/skills/wiki through `tdeaseDesktop.system`
 * IPC handlers, which in main.ts delegated to `createSystemAssetCatalog(...)`
 * (`electron/system_asset_catalog.cjs`). That catalog is constructed in main.ts
 * from the product root (read-only app assets) and writable root (user
 * overrides) and resolves collisions between them. This module does not rebuild
 * it — main.ts constructs the catalog and injects it here, so the composition
 * root stays the one place that decides where System assets live.
 *
 * The catalog's methods are all async (the .cjs uses `fs/promises` and
 * `realpathSync`), so this adapter keeps them async too. `resolvePath` is kept
 * even though only skill-directory resolution uses it, because the agent
 * runtime's skill runner needs the absolute path to spawn `uv` against a
 * skill's `scripts/` directory.
 */

export interface NodeSystemAssets {
  readText(relative: string): Promise<string>
  listFiles(relative: string): Promise<ReadonlyArray<string>>
  /**
   * Absolute filesystem path for one System asset. Used by the skill runner to
   * resolve a skill's `scripts/` directory before spawning the bundled `uv`.
   * Throws if the asset is absent or is a product/user collision.
   */
  resolvePath(relative: string): Promise<string>
}

/**
 * The injected catalog shape. Mirrors what `createSystemAssetCatalog` returns
 * in `electron/system_asset_catalog.cjs`: every method is async, every path is
 * contained inside the product or writable root, and a product/user collision
 * is an error rather than a silent preference.
 */
export interface SystemAssetCatalog {
  readText(relative: string): Promise<string>
  listFiles(relative: string): Promise<ReadonlyArray<string>>
  resolvePath(relative: string): Promise<string>
}

export function createNodeSystemAssets(catalog: SystemAssetCatalog): NodeSystemAssets {
  // Pure passthrough. The catalog already enforces containment + collision
  // rules; wrapping it in a second layer of checks here would duplicate the
  // `containedPath` calls in system_asset_catalog.cjs and give a false sense
  // of independent verification. The seam exists so the agent runtime talks to
  // a typed TS interface, not a .cjs require, and so a future swap of the
  // catalog (e.g. an in-memory test fixture) needs no caller change.
  return {
    readText: (relative) => catalog.readText(relative),
    listFiles: (relative) => catalog.listFiles(relative),
    resolvePath: (relative) => catalog.resolvePath(relative),
  }
}
