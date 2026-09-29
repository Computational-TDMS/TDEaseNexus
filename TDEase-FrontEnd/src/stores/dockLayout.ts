// dockLayout — the deep module behind workbench dock size memory.
//
// A dock's durable layout is its PROPORTION of the window axis (VSCode's
// SplitView proportions), never a px: a layout restored on a differently
// sized window comes back proportional. The px a component binds is a live
// projection clamped into the dock's range; the ratio is what persist()
// writes and what restore() derives px from. This module owns that duality
// so no caller has to know it exists — callers say "set this dock to 300px
// as measured against this container" and "restore from the snapshot".
//
// Not a Pinia store: `stores/uiLayout.ts` composes one DockMemory per dock
// and owns the collapse flags, the dock-side flags and the persist trigger.

import { ref, type Ref } from 'vue'

export interface DockRange {
  min: number
  max: number
}

export interface DockMemorySpec {
  /** Persisted px key — the live projection, kept for pre-ratio layouts. */
  pxKey: string
  /** Persisted ratio key — the durable proportion. */
  ratioKey: string
  /** The dock's bounds; a function because a dock's axis (and so its
   *  bounds) can change at runtime — the panel flips bottom|right. */
  range: () => DockRange
  /** Fallback when neither ratio nor any px key is stored. */
  defaultPx: number
  /** Older px keys tried after `pxKey`, before the default. */
  legacyPxKeys?: string[]
}

/** The read half of UiStateRepository — restore only needs reads. */
export interface DockSnapshotReader {
  read<T>(workspaceId: string, key: string, fallback: T): T
}

export interface DockMemory {
  /** Live size in px, always within the dock's range. */
  px: Ref<number>
  /** Durable proportion of the axis; 0 = never captured. */
  ratio: Ref<number>
  /**
   * A resize (drag/keyboard). Clamps into the range; captures the ratio only
   * for a real size — a px below the range minimum is a collapse artifact
   * (a sash snap emits size 0), and capturing it would overwrite the
   * expanded proportion the collapse is supposed to preserve.
   */
  setPx(value: number, containerSize: number): void
  /**
   * Restore from a snapshot: a valid stored ratio (0 < r ≤ 1) maps onto
   * `axisSize` before the range clamp; otherwise the legacy px keys apply;
   * otherwise the default. The ratio ref is restored too, so a persist()
   * after restore cannot clobber the stored proportion with 0.
   */
  restore(repo: DockSnapshotReader, workspaceId: string, axisSize: number): void
  /**
   * Re-derive the live px after the dock's AXIS changed (a window resize).
   * The ratio is the durable truth, so a captured proportion maps onto the
   * new axis exactly as restore() maps it at boot; a dock whose proportion
   * was never captured only gives way to the — possibly tighter — range.
   * Deliberately never captures a ratio: a resize must not re-learn the
   * layout from a window the user happened to be dragging.
   */
  reproject(axisSize: number): void
  /** The [key, value] pairs this dock contributes to a persist pass. */
  entries(): Array<[string, unknown]>
}

function clamp(value: number, range: DockRange): number {
  if (range.max < range.min) return range.min
  return Math.min(Math.max(value, range.min), range.max)
}

function readRatio(repo: DockSnapshotReader, workspaceId: string, key: string): number {
  const value = repo.read<unknown>(workspaceId, key, 0)
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : 0
}

function readPx(repo: DockSnapshotReader, workspaceId: string, key: string): number | null {
  const value = repo.read<unknown>(workspaceId, key, null)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function createDockMemory(spec: DockMemorySpec): DockMemory {
  const px = ref<number>(clamp(spec.defaultPx, spec.range()))
  const ratio = ref<number>(0)

  function setPx(value: number, containerSize: number): void {
    const range = spec.range()
    px.value = clamp(value, range)
    // Guard on the RAW value: the clamped px always sits at or above the
    // minimum, so it can never tell an artifact from a real size.
    if (containerSize > 0 && value >= range.min) ratio.value = px.value / containerSize
  }

  function restore(repo: DockSnapshotReader, workspaceId: string, axisSize: number): void {
    const range = spec.range()
    const stored = readRatio(repo, workspaceId, spec.ratioKey)
    ratio.value = stored
    if (stored > 0 && axisSize > 0) {
      px.value = clamp(Math.round(stored * axisSize), range)
      return
    }
    for (const key of [spec.pxKey, ...(spec.legacyPxKeys ?? [])]) {
      const legacy = readPx(repo, workspaceId, key)
      if (legacy != null) {
        px.value = clamp(legacy, range)
        return
      }
    }
    px.value = clamp(spec.defaultPx, range)
  }

  function reproject(axisSize: number): void {
    if (ratio.value > 0 && axisSize > 0) {
      px.value = clamp(Math.round(ratio.value * axisSize), spec.range())
      return
    }
    px.value = clamp(px.value, spec.range())
  }

  function entries(): Array<[string, unknown]> {
    return [
      [spec.pxKey, px.value],
      [spec.ratioKey, ratio.value],
    ]
  }

  return { px, ratio, setPx, restore, reproject, entries }
}
