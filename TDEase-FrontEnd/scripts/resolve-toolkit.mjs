/**
 * Single source of truth for locating the TDEase AI capability toolkit
 * (the bundled `rust/` mass-spec kernel + `system/` skills/prompts/reference
 * assets), which lives in the root `tdease-ai-capability` submodule.
 *
 * The development location is the root `tdease-ai-capability/` submodule.
 *
 * Every consumer that needs the rust workspace or the system assets root must
 * route through this module so there is one place to change if the toolkit
 * moves.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(frontendRoot, '..')

/**
 * Resolve the toolkit root directory.
 * @param {object} [options]
 * @param {object} [options.env] - Process env (defaults to `process.env`).
 * @returns {string} Absolute path to the toolkit root.
 */
export function resolveToolkitRoot() {
  return path.join(repoRoot, 'tdease-ai-capability')
}

/**
 * Resolve the `rust/` workspace directory inside the toolkit.
 * @returns {string}
 */
export function resolveRustRoot() {
  return path.join(resolveToolkitRoot(), 'rust')
}

/**
 * Resolve the read-only `system/` assets directory inside the toolkit.
 * @returns {string}
 */
export function resolveSystemAssetsRoot() {
  return path.join(resolveToolkitRoot(), 'system')
}
