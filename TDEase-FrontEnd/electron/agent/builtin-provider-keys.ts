/**
 * Built-in provider credentials for packaged builds.
 *
 * A packaged build must work out of the box: when the user has no key of their
 * own in settings.json, the app falls back to the credential baked in at build
 * time. The secret lives ONLY in the main-process bundle — build-main.mjs
 * inlines the `process.env.TDEASE_*` member expressions below via esbuild
 * `define`, so it never reaches the renderer nor crosses IPC, and an ordinary
 * build (env var unset) inlines the empty string, i.e. no built-in key.
 *
 * The lookup must stay a literal `process.env.X` member expression: esbuild
 * cannot inline a dynamic `process.env[name]` read, and a dynamic read would
 * silently resolve to nothing in the packaged app.
 */

const BUILTIN_PROVIDER_KEYS: Readonly<Record<string, string | undefined>> = {
  deepseek: process.env.TDEASE_BUILTIN_DEEPSEEK_API_KEY,
}

/** The baked-in key for a provider, or undefined when the build carries none. */
export function builtinApiKeyFor(providerId: string): string | undefined {
  const key = BUILTIN_PROVIDER_KEYS[providerId]
  return typeof key === 'string' && key.trim() ? key.trim() : undefined
}

/** Provider ids this build carries a built-in key for. */
export function builtinProviderIds(): string[] {
  return Object.keys(BUILTIN_PROVIDER_KEYS).filter((id) => builtinApiKeyFor(id) !== undefined)
}
