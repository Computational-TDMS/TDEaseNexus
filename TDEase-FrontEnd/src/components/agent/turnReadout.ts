/**
 * turnReadout — the provide/inject contract between AgentPage and the
 * AgentSettingsTab drawer.
 *
 * `useAgentTurn` owns the live turn state (context-window size, tokens used,
 * the bound model's image capability), but that state lives in a composable
 * instance, not a store. The settings drawer needs to read it without
 * AgentPage threading individual props through the tab registry (which takes
 * no props). So AgentPage provides this read-only projection, and the drawer
 * injects it.
 *
 * The values are the SAME refs the Composer used to bind directly — moved, not
 * duplicated. `null`-able so a tab rendered outside the provide scope (tests)
 * falls back gracefully instead of throwing.
 */
import type { InjectionKey, Ref } from 'vue'
import type { ComputedRef } from 'vue'

export interface AgentTurnReadout {
  /**
   * Tokens the active session's conversation occupies right now — the LIVE
   * value Node pushed over the `context:changed` side channel (Pi's
   * `getContextUsage()`). `null` = unknown: post-compaction until the next
   * response, or a session that was never bound (bind happens on the first
   * send). Forwarded, not re-derived — one source.
   */
  readonly contextTokensUsed: ComputedRef<number | null>
  /**
   * Cache hit rate of the last valid request (read/(read+write+uncached)), or
   * `null` when unknown. Companion to `contextTokensUsed` from the same push.
   */
  readonly contextCacheHitRate: ComputedRef<number | null>
  /**
   * The bound model's context-window size, or `undefined` until a model is
   * bound — consumers show an unknown total rather than a fabricated one.
   */
  readonly contextWindow: ComputedRef<number | undefined>
  /** The bound model declares image input. */
  readonly modelSupportsImages: Ref<boolean>
}

export const AGENT_TURN_READOUT: InjectionKey<AgentTurnReadout> = Symbol('agent-turn-readout')

/**
 * Token counts in the readout's compact voice: `152k`, `980`. Shared by the
 * Composer's context gauge and the transcript's compaction divider so the two
 * never disagree about what "k" means.
 */
export function formatTokensK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}
