// Bidirectional translator between TDEase tool names and provider tool names.
//
// TDEase canonical tool names are dotted (`tdease.runs.listFiles`,
// `tdease.workflow.dryRun`), but LLM providers forbid dots in tool/function
// names (OpenAI/Anthropic only accept `[A-Za-z0-9_-]`). This protocol
// translates between the two sides:
//
//   toProvider          canonical -> provider-safe (dots -> underscores)
//   toCanonical         name in provider events -> canonical (reverse lookup)
//   rewriteForProvider  rewrite canonical references in prompts/descriptions to provider names
//
// Only the registered set of canonical names is translated. Built-ins
// (read/grep/find/ls/bash/edit/write/mcp) contain no dots to begin with, so
// they are neither registered through this protocol nor rewritten; unregistered
// names are returned as-is, to avoid mangling dots in ordinary English text.

export interface ToolNameProtocol {
  /** canonical dotted name -> provider-safe name (dots replaced with underscores). */
  toProvider(canonical: string): string
  /** name from provider events -> canonical dotted name (lookup; unregistered names returned as-is). */
  toCanonical(providerName: string): string
  /** Rewrite every registered canonical reference in text to its provider name. */
  rewriteForProvider(text: string): string
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function createToolNameProtocol(canonicalNames: ReadonlyArray<string>): ToolNameProtocol {
  const toProviderMap = new Map<string, string>()
  const toCanonicalMap = new Map<string, string>()

  for (const canonical of canonicalNames) {
    // Skip empty strings and dot-free names (built-ins, or already
    // provider-safe) — the fallbacks on both sides (?? name) return them as-is.
    if (!canonical || !canonical.includes('.')) continue

    const providerName = canonical.replace(/\./g, '_')

    // Collision guard: two distinct canonical names must not encode to the
    // same provider name (otherwise reverse lookup silently drops one side,
    // and audit/UI only ever sees one of them). This is a single-source-of-
    // truth hard rule — silent overwrite is more dangerous than throwing.
    const prior = toCanonicalMap.get(providerName)
    if (prior !== undefined && prior !== canonical) {
      throw new Error(
        `Tool name protocol collision: "${canonical}" and "${prior}" both encode to "${providerName}".`,
      )
    }

    toProviderMap.set(canonical, providerName)
    toCanonicalMap.set(providerName, canonical)
  }

  // One global regex, sorted longest-first so short prefixes cannot shadow
  // longer names sharing the prefix. \b keeps dotted names whole.
  const dottedNames = [...toProviderMap.keys()].sort((a, b) => b.length - a.length)
  const rewriteRe = dottedNames.length
    ? new RegExp(`\\b(?:${dottedNames.map(escapeRegex).join('|')})\\b`, 'g')
    : null

  return {
    toProvider(canonical: string) {
      return toProviderMap.get(canonical) ?? canonical
    },
    toCanonical(providerName: string) {
      return toCanonicalMap.get(providerName) ?? providerName
    },
    rewriteForProvider(text: string) {
      if (!rewriteRe || !text) return text
      return text.replace(rewriteRe, (match) => toProviderMap.get(match) ?? match)
    },
  }
}
