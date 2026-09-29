/**
 * Selection types — unified scope model.
 *
 * FRONTEND-ZERO: single SelectionContext replaces scattered logRunId.
 * Components MUST read/write the selection store — never decide "what's selected" locally.
 */

/** Global selection context — exactly one active at any time. */
export interface SelectionContext {
  workspaceId: string            // always present (session-bound)
  runId?: string                 // current Run focus
  filePath?: string              // workspace-relative path
}

/** Main area tab — driven by projection rules (§3.2). */
export type MainTab = 'editor' | 'dag' | 'results' | 'log' | 'overview'

/** Projection rule: what tab to show for a given selection state. */
export function resolveMainTab(ctx: SelectionContext): MainTab {
  if (ctx.filePath) {
    const fp = ctx.filePath.toLowerCase()
    if (fp.endsWith('.smk') || fp.endsWith('.snakefile') || fp === 'snakefile') return 'dag'
    return 'editor'
  }
  if (ctx.runId) return 'dag'
  return 'overview'
}
