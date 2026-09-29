/**
 * sash — the pure core of the two-pane split sash (VS Code's Sash semantics,
 * reduced to one sized pane and one bound pair).
 *
 * Everything here is a pure function of numbers and enums: the SashState a
 * size sits in, the cursor that state names, the snap decision for a drag
 * step, the size a snap-out-of-collapse restores to, and the arrow-key map.
 * `ResizableSplit.vue` composes these with its own DOM/pointer machinery and
 * the global drag lock (which stays in the component — one implementation
 * today, so extracting it would be a hypothetical seam).
 *
 * This module is the test surface for those decisions: table-driven cases
 * here replace what would otherwise only be reachable through a mounted
 * component.
 */

export type SashOrientation = 'horizontal' | 'vertical'
export type SizedPane = 'first' | 'second'

export type SashState =
  /** Degenerate bounds — nothing can move. */
  | 'disabled'
  /** At the minimum: the sized pane can only grow. */
  | 'min'
  /** At the maximum: the sized pane can only shrink. */
  | 'max'
  /** Free to move either way. */
  | 'enabled'

/**
 * VS Code's SashState for a two-pane split: `min`/`max` mean the sized pane
 * sits at that bound and can only move the other way; `disabled` = degenerate
 * bounds. Comparisons round to whole px (sizes travel through styles).
 */
export function sashStateOf(size: number, min: number, max: number): SashState {
  if (min >= max) return 'disabled'
  if (Math.round(size) <= Math.round(min)) return 'min'
  if (Math.round(size) >= Math.round(max)) return 'max'
  return 'enabled'
}

/** The cursor for a resting sash: at a bound it names the only live direction
 *  ("e-resize" reads as "the sized pane can still grow rightward"). */
export function sashCursor(state: SashState, sizedPane: SizedPane, orientation: SashOrientation): string {
  const growsRightward = sizedPane === 'first'
  switch (state) {
    case 'disabled':
      return 'default'
    case 'min':
      return growCursor(growsRightward, orientation)
    case 'max':
      return shrinkCursor(growsRightward, orientation)
    case 'enabled':
      return orientation === 'horizontal' ? 'col-resize' : 'row-resize'
  }
}

/** The cursor while a drag is live. Dragging from a collapsed edge can only
 *  mean "open it back up", so it always shows the grow direction. */
export function sashDragCursor(
  state: SashState,
  sizedPane: SizedPane,
  orientation: SashOrientation,
  collapsed: boolean,
): string {
  if (collapsed) return growCursor(sizedPane === 'first', orientation)
  return sashCursor(state, sizedPane, orientation)
}

function growCursor(growsRightward: boolean, orientation: SashOrientation): string {
  if (orientation === 'horizontal') return growsRightward ? 'e-resize' : 'w-resize'
  return growsRightward ? 's-resize' : 'n-resize'
}

function shrinkCursor(growsRightward: boolean, orientation: SashOrientation): string {
  if (orientation === 'horizontal') return growsRightward ? 'w-resize' : 'e-resize'
  return growsRightward ? 'n-resize' : 's-resize'
}

// ── Snap (VS Code's rule): collapse past `min − min/2`, re-expand past min/2 ─

export const SNAP_FRACTION = 0.5
/** A tiny min still deserves a grabbable snap distance. */
export const SNAP_FLOOR_PX = 24

export function snapDistance(min: number): number {
  return Math.max(SNAP_FLOOR_PX, Math.round(min * SNAP_FRACTION))
}

export type SnapDecision = 'collapse' | 'expand' | null

/**
 * What one drag step means for a collapsible split. `dragStartSize` is the
 * size when the gesture began (the split's state at drag start decides which
 * direction of travel is meaningful); `next` is the candidate size.
 */
export function snapDecision(args: {
  collapsible: boolean
  dragStartSize: number
  collapsedSize: number
  next: number
  min: number
}): SnapDecision {
  if (!args.collapsible) return null
  const snap = snapDistance(args.min)
  const collapsedAtStart = Math.round(args.dragStartSize) <= Math.round(args.collapsedSize)
  if (!collapsedAtStart && args.next < args.min - snap) return 'collapse'
  if (collapsedAtStart && args.next > snap) return 'expand'
  return null
}

/**
 * The expanded size a snap-out-of-collapse (or Enter) restores to. The 200px
 * tail is the last resort for a split that has never been open (mounted
 * collapsed, no history) — never 0.
 */
export function expandTarget(lastExpandedSize: number, initialSize: number, min: number, max: number): number {
  const target = lastExpandedSize || initialSize || Math.max(min, 200)
  return Math.min(Math.max(target, min), max)
}

// ── Keyboard map ─────────────────────────────────────────────────────────────

export const ARROW_STEP = 16
export const SHIFT_STEP = 64

/** Arrow semantics follow the visual direction of the sized pane: for a
 *  trailing ('second') pane, dragging right shrinks it, so ArrowRight is the
 *  decreasing key — the inverse of the leading-pane case. */
export function sashKeys(orientation: SashOrientation, sizedPane: SizedPane): { decrease: string; increase: string } {
  const flip = sizedPane === 'second'
  if (orientation === 'horizontal') {
    return flip
      ? { decrease: 'ArrowRight', increase: 'ArrowLeft' }
      : { decrease: 'ArrowLeft', increase: 'ArrowRight' }
  }
  return flip
    ? { decrease: 'ArrowDown', increase: 'ArrowUp' }
    : { decrease: 'ArrowUp', increase: 'ArrowDown' }
}
