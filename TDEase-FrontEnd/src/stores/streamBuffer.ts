/**
 * StreamBuffer — non-reactive accumulator that assembles an inflight
 * assistant message from PIChunk deltas, flushed into the agent store on a
 * RAF-coalesced cadence.
 *
 * Ported from openhanako's StreamBuffer design (chat-types.ts:379). The
 * buffer lives OUTSIDE the reactive store: high-frequency text deltas would
 * thrash reactivity if each one touched the store directly. Instead we
 * accumulate here and flush at most once per animation frame, calling the
 * store's block-assembly methods (appendText / appendThinking / upsertTool).
 *
 * Placement is chronological: the store's assembly methods attach text,
 * thinking and tool groups at the end of the message (merging with an
 * immediately preceding block of the same kind), so every tool call renders
 * at the position it was actually issued — matching the order
 * `agent/events/project.ts` later re-projects from the event log.
 */
import type { useAgentStore } from './agent'
import type { ToolCall } from './chat-types'

/**
 * A partial tool update keyed by id. `tool.requested` carries a full ToolCall;
 * the later `tool.completed` carries only id + status fields (it has no `name`
 * in the event vocabulary — see vocabulary.ts `ToolCompletedEvent`). Both flow
 * through `upsertTool` as a patch merged onto any existing entry with the same
 * id, so the completion update cannot clobber the requested name/args.
 */
export type ToolPatch = Partial<ToolCall> & { id: string }

export interface StreamBufferState {
  textAcc: string
  thinkingAcc: string
  inThinking: boolean
  /**
   * The open thinking block must seal at the next flush. Set by the
   * thinking→text / thinking→tool transition (the reasoning segment ended);
   * processed by doFlush AFTER the final thinking write so the store seals
   * exactly the block that carries every accumulated delta.
   */
  sealQueued: boolean
  /** toolCallId → ToolCall, so results can patch the same entry. */
  pendingTools: Map<string, ToolCall>
}

export function createStreamBuffer(): StreamBufferState {
  return {
    textAcc: '',
    thinkingAcc: '',
    inThinking: false,
    sealQueued: false,
    pendingTools: new Map(),
  }
}

// Base cadence: one flush per animation frame (~16ms at 60fps) — append calls
// are coalesced by the `scheduled` flag, so every burst lands on the next rAF.

// Adaptive cadence. Per-flush downstream cost grows with the answer: the
// actively-streaming tail block re-renders its markdown on every store write,
// so on a tens-of-KB answer a flush every frame makes that O(size) re-render
// the dominant long-task source. Past ~16KiB of accumulated text (chars ≈
// bytes for typical answer prose, and render cost scales with chars), flush
// every 3rd frame instead — ~48ms at 60fps, far below what reading-speed text
// append can perceive, while cutting long-task frequency by ~2/3 exactly when
// each task is most expensive. Below the threshold keep the snappy 1-frame
// cadence. Deliberately no config surface.
const LARGE_FLUSH_CHARS = 16_384
const LARGE_FLUSH_FRAME_SKIPS = 2

export class StreamBuffer {
  private state: StreamBufferState
  private store: ReturnType<typeof useAgentStore>
  /**
   * The session this buffer belongs to. The store's block-assembly methods
   * take an explicit sessionId (not the implicit `active`), so a turn keeps
   * flushing to its own session even after the user has switched the active
   * view — the single-instance buffer that routed through `active` is what
   * crossed sessions' streams.
   */
  private readonly sessionId: string
  private messageId: string | null = null
  private rafId: number | null = null
  private scheduled = false
  /** Frames skipped by the adaptive cadence since the last flush (see scheduleFlush). */
  private frameSkips = 0
  /** Last values actually written to the store, so we skip no-op flushes. */
  private lastFlushedText = ''
  private lastFlushedThinking = ''
  /**
   * Per-tool identity of the last value actually written to the store (by
   * reference). upsertTool only replaces a pending entry's OBJECT when a patch
   * really changed it, so a reference compare tells doFlush exactly which
   * tools need a store write — the old key-list compare could not see content
   * changes (a completion patch keeps the key list identical), which is why
   * it used to re-upsert EVERY pending tool on every flush.
   */
  private lastFlushedTools = new Map<string, ToolCall>()
  /**
   * callId → the `event:<seq>` id a fresh tool_group should be minted with,
   * captured from the committed `tool.requested` event. The replay projection
   * names a group after its first tool's seq; matching it here keeps group ids
   * identical across the settle swap, so fold-state keyed by the group id
   * survives. Cleared with the rest of the buffer state on reset/attach.
   */
  private groupHints = new Map<string, string>()

  constructor(store: ReturnType<typeof useAgentStore>, sessionId: string) {
    this.store = store
    this.sessionId = sessionId
    this.state = createStreamBuffer()
  }

  /** The live reasoning segment's full text so far (non-reactive by design) —
   *  the status line's thought tail reads it on its own 250ms tick, so no
   *  per-delta reactive write is created. */
  get thinkingText(): string {
    return this.state.thinkingAcc
  }

  /** Bind the buffer to an inflight assistant message id. */
  attach(messageId: string): void {
    this.messageId = messageId
    this.reset()
  }

  reset(): void {
    this.state = createStreamBuffer()
    this.lastFlushedText = ''
    this.lastFlushedThinking = ''
    this.lastFlushedTools.clear()
    this.groupHints.clear()
    this.frameSkips = 0
  }

  appendText(delta: string): void {
    // Text arriving ends the open reasoning segment: the model has moved on to
    // the answer, so the thinking block must seal now — not when the whole
    // stream ends.
    this.endThinking()
    this.state.textAcc += delta
    this.scheduleFlush()
  }

  appendThinking(delta: string): void {
    this.state.inThinking = true
    this.state.thinkingAcc += delta
    this.scheduleFlush()
  }

  sealThinking(): void {
    this.endThinking()
    this.scheduleFlush()
  }

  /** Record the segment end; the seal itself lands on the next flush. */
  private endThinking(): void {
    if (!this.state.inThinking) return
    this.state.inThinking = false
    this.state.sealQueued = true
  }

  /**
   * `groupId` rides the committed `tool.requested` event: the id a FRESH
   * tool_group should carry so it matches the replay projection's group id
   * (see the store's `upsertTool`). Remembered per call id and handed to the
   * store on flush — including on the completion flush, in case the group is
   * still minted by that write.
   */
  upsertTool(patch: ToolPatch, groupId?: string): void {
    if (groupId) this.groupHints.set(patch.id, groupId)
    // MERGE, not replace. `tool.requested` arrives with the real name + args;
    // the later `tool.completed` patch carries only id/done/success/status
    // (it has no name field in the event vocabulary — vocabulary.ts
    // `ToolCompletedEvent`). A full `set` would drop name/args from the
    // requested entry and collapse every tool to a bare literal the instant it
    // finished. Patch onto the existing entry so absent keys are preserved;
    // the store's own `Object.assign` then only overwrites the keys the patch
    // actually supplies.
    const existing = this.state.pendingTools.get(patch.id)
    if (existing) {
      // Keep the SAME object when the patch changes nothing: doFlush compares
      // pending entries to the last flushed value by reference, so an inert
      // patch must not churn identity and trigger a redundant store write.
      let changed = false
      for (const key of Object.keys(patch)) {
        if (existing[key as keyof ToolCall] !== (patch as Record<string, unknown>)[key]) { changed = true; break }
      }
      if (changed) this.state.pendingTools.set(patch.id, { ...existing, ...patch })
    } else {
      this.state.pendingTools.set(patch.id, patch as ToolCall)
    }
    // A tool call issued after reasoning ends that segment too (think → act
    // with no prose in between): the thinking block seals while the tool runs.
    this.endThinking()
    this.scheduleFlush()
  }

  /**
   * Force an immediate flush of whatever is accumulated. Called when the
   * stream ends so the final state is reflected in the store before the
   * inflight flag drops. A reasoning segment still open at stream end closes
   * here (the common paths close it earlier — text or a tool call arriving).
   */
  async flushNow(): Promise<void> {
    this.cancelScheduled()
    this.endThinking()
    await this.doFlush()
  }

  private scheduleFlush(): void {
    if (this.scheduled) return
    this.scheduled = true
    // Single pending rAF, exactly as before; the adaptive cadence is expressed
    // as frame SKIPS inside that callback (re-arming the same rAF at most
    // LARGE_FLUSH_FRAME_SKIPS times), never as a second scheduler.
    const run = () => {
      if (
        this.state.textAcc.length > LARGE_FLUSH_CHARS
        && this.frameSkips < LARGE_FLUSH_FRAME_SKIPS
      ) {
        this.frameSkips += 1
        this.rafId = requestAnimationFrame(run)
        return
      }
      this.frameSkips = 0
      this.scheduled = false
      void this.doFlush()
    }
    this.rafId = requestAnimationFrame(run)
  }

  private cancelScheduled(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.scheduled = false
  }

  private async doFlush(): Promise<void> {
    if (!this.messageId) return
    const id = this.messageId

    // Thinking — only write when changed.
    if (this.state.thinkingAcc !== this.lastFlushedThinking) {
      // Replace rather than append: the store's appendThinking appends to an
      // open block, so we pass the delta = new - old.
      const delta = this.state.thinkingAcc.slice(this.lastFlushedThinking.length)
      if (delta) this.store.appendThinking(this.sessionId, id, delta)
      this.lastFlushedThinking = this.state.thinkingAcc
    }
    // Seal AFTER the final thinking write — the store seals the block that
    // now carries every accumulated delta and stamps its live duration. This
    // must NOT be gated on the thinking write above: when the last thinking
    // delta already flushed and text arrived afterwards, only the transition
    // (sealQueued) is new.
    if (this.state.sealQueued) {
      this.state.sealQueued = false
      this.store.sealThinking(this.sessionId, id)
    }

    // Text — write only the new suffix.
    if (this.state.textAcc !== this.lastFlushedText) {
      const delta = this.state.textAcc.slice(this.lastFlushedText.length)
      if (delta) this.store.appendText(this.sessionId, id, delta)
      this.lastFlushedText = this.state.textAcc
    }

    // Tools — upsert only entries whose value actually changed since the last
    // flush (reference compare; upsertTool preserves identity for inert
    // patches). The store dedups by id as a second belt-and-braces layer, but
    // a completion patch no longer re-upserts every OTHER pending tool.
    for (const tool of this.state.pendingTools.values()) {
      if (this.lastFlushedTools.get(tool.id) === tool) continue
      this.store.upsertTool(this.sessionId, id, tool, this.groupHints.get(tool.id))
      this.lastFlushedTools.set(tool.id, tool)
    }
  }
}
