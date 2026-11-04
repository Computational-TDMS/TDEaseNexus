/**
 * Tab drag state for the editor tab strips.
 *
 * `DataTransfer.getData` is unreadable during `dragover` (the spec only
 * exposes types there), so the payload rides this module-level singleton —
 * set at `dragstart`, read at `dragover`/`drop`, cleared at `dragend`.
 * One drag can only start from one tab; the singleton is written before any
 * dragover can fire, so no async hazard exists.
 */

export interface TabDragPayload {
  tabId: string
  fromGroupId: string
}

let drag: TabDragPayload | null = null

export function setTabDrag(payload: TabDragPayload): void {
  drag = payload
}

export function currentTabDrag(): TabDragPayload | null {
  return drag
}

export function clearTabDrag(): void {
  drag = null
}

/** The dataTransfer type marking a TDEase tab drag (informational). */
export const TAB_DRAG_TYPE = 'application/x-tdease-tab'

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

/**
 * Modifier semantics for a tab drop, read off the DROP event (the user may
 * have pressed them after the last dragover). Ctrl (Alt on mac) copies the
 * tab into the target group without removing it from its source; Alt
 * (Shift on mac) collapses the whole gesture into a merge. VS Code's
 `isToggleSplitOperation` / copy mapping.
 */
export function isCopyDrop(event: DragEvent): boolean {
  return IS_MAC ? event.altKey : event.ctrlKey
}

export function isMergeDrop(event: DragEvent): boolean {
  return IS_MAC ? event.shiftKey : event.altKey
}

// ── Drop-target partition (VS Code's editorDropTarget) ──────────────────────
// The INVERSE of a naive thirds grid: the inner 80% of a group's body is one
// big MERGE target; only the outer 10% ring offers a split, and the direction
// comes from the preferred-axis thirds (Ctrl+\ splits side-by-side, so
// horizontal thirds lead). Zones are measured on the region BELOW the tab
// strip — the caller passes that region's rect, not the whole group.

export type TabDropZone = 'left' | 'right' | 'up' | 'down' | 'center'

export const DROP_EDGE = 0.1

export function dropZoneOf(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): TabDropZone {
  if (rect.width <= 0 || rect.height <= 0) return 'center'
  const x = clientX - rect.left
  const y = clientY - rect.top
  const edgeX = rect.width * DROP_EDGE
  const edgeY = rect.height * DROP_EDGE
  // Inside the ring → merge. Outside it → the preferred-axis thirds decide.
  if (x > edgeX && x < rect.width - edgeX && y > edgeY && y < rect.height - edgeY) return 'center'
  const third = rect.width / 3
  if (x < third) return 'left'
  if (x > third * 2) return 'right'
  return y < rect.height / 2 ? 'up' : 'down'
}

/** Indicator geometry per zone, in % of the measured region (VS Code's
 *  constants: a directional drop always shows a HALF cell). */
export function indicatorStyleFor(zone: TabDropZone): Record<'top' | 'left' | 'width' | 'height', string> {
  switch (zone) {
    case 'left': return { top: '0', left: '0', width: '50%', height: '100%' }
    case 'right': return { top: '0', left: '50%', width: '50%', height: '100%' }
    case 'up': return { top: '0', left: '0', width: '100%', height: '50%' }
    case 'down': return { top: '50%', left: '0', width: '100%', height: '50%' }
    case 'center': return { top: '0', left: '0', width: '100%', height: '100%' }
  }
}
