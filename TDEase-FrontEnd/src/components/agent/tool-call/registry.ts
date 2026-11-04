/**
 * The tool-call renderer registry (ZCode's ToolCallBlocks/resolveRenderer
 * pattern, keyed by our tool-identity vocabulary).
 *
 * A row renderer is a Component that consumes `useToolCallRenderContext()`
 * and draws ONE tool call's expanded body. `resolveToolCallRenderer` maps a
 * tool name to its renderer; unknown tools fall through to the generic row.
 * Adding a rich per-tool surface (a diff view for `edit`, a live log pane
 * for `runs.tailLog`) is one component + one map entry — ToolGroupBlock and
 * the transcript never change.
 */
import type { Component } from 'vue'
import { bareToolName } from '@/utils/tool-identity'
import ToolCallRow from './ToolCallRow.vue'
import BashCallRow from './BashCallRow.vue'

/**
 * Entries whose expanded body deserves more than the generic row. Seeded
 * empty ON PURPOSE: a per-tool entry must be a real, better rendering —
 * never a cosmetic clone of the default with a different file name.
 */
const RENDERERS: Readonly<Record<string, Component>> = {
  // A mass-spec kernel call (tdeasenexus-toolbox) gets a typed result card;
  // every other shell call renders exactly the generic row.
  bash: BashCallRow,
}

/** Module-level animation LRU (ZCode's stream-animate rule): the row entry
 *  animation plays ONCE per group, not on every virtual-scroller remount or
 *  live→settled id swap. Keyed by the group's stable fold key; capped so a
 *  long session cannot grow it without bound. */
const ANIM_SEEN_LIMIT = 800
const animSeen = new Map<string, true>()

export function hasPlayedEntryAnimation(foldKey: string): boolean {
  return animSeen.has(foldKey)
}

export function markEntryAnimationPlayed(foldKey: string): void {
  if (animSeen.has(foldKey)) return
  if (animSeen.size >= ANIM_SEEN_LIMIT) {
    // Map preserves insertion order: drop the oldest recorded key.
    const oldest = animSeen.keys().next().value
    if (oldest !== undefined) animSeen.delete(oldest)
  }
  animSeen.set(foldKey, true)
}

export function resolveToolCallRenderer(toolName: string): Component {
  return RENDERERS[bareToolName(toolName)] ?? ToolCallRow
}
