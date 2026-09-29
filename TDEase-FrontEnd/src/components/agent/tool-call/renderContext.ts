/**
 * ToolCallRenderContext — the one channel through which a tool group hands
 * its rows their state and callbacks (ZCode's renderContext pattern).
 *
 * Per-kind row components nest (a diff view inside a bash row, a run card
 * inside a job row), so constructor props would drill through every layer.
 * `ToolCallRenderer` provides this context once per row; every consumer
 * downstream sees the same settled facts, and no join data (run ids, parent
 * messages) can leak in by accident: if a renderer needs more, the context
 * interface grows here, explicitly.
 */
import { inject, type InjectionKey } from 'vue'
import type { ToolCall } from '@/stores/chat-types'

export interface ToolCallRenderContext {
  /** The call this row renders, enriched with the un-truncated `full` summary
   *  the owning group extracted from the args. */
  readonly tool: ToolCall & { full?: string }
  /** Single-tool group: the summary row already shows the identity, so the
   *  body row drops its own icon/phrase/glyph echo. */
  readonly isSingle: boolean
}

export const TOOL_CALL_CONTEXT_KEY: InjectionKey<ToolCallRenderContext> = Symbol('tool-call-render-context')

export function useToolCallRenderContext(): ToolCallRenderContext {
  return inject(TOOL_CALL_CONTEXT_KEY) as ToolCallRenderContext
}
