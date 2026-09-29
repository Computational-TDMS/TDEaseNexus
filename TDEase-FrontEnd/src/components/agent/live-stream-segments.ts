/**
 * LiveStreamSegments — the ordered in-flight buffer for a live session view.
 *
 * `text_delta` / `thinking_delta` are an ORDERED interleaved stream, and the
 * synthetic blocks must render in exactly that arrival order — the previous
 * pair of scalars (liveThinking + liveText) rendered [all thinking, all text]
 * regardless of arrival, and never dropped thinking content when its
 * `thinking.recorded` commit landed, so the same reasoning rendered TWICE
 * (synthetic + canonical) until the whole message completed.
 *
 * The committed-event contract that makes dedup exact (translate-pi.ts): the
 * collector flushes the FULL accumulated segment into `thinking.recorded`
 * BEFORE every act event, and assistant text commits only via the final
 * `message.completed`. So at a `thinking.recorded` commit, every thinking
 * segment in this buffer is exactly the committed content and can be dropped
 * wholesale; text stays synthetic until `message.completed` clears it.
 */
import { computed, ref } from 'vue'

export interface LiveStreamSegment {
  /** Stable synthetic id (monotonic) — survives merges and sibling removals. */
  id: string
  kind: 'thinking' | 'text'
  text: string
  /**
   * Thinking only: the segment ended (text started or an act event committed).
   * Mirrors the main path's Thinking→Thought seal; a later thinking delta
   * starts a NEW segment rather than unsealing this one. Text segments carry
   * the field unused (always false) so the shape stays uniform.
   */
  sealed: boolean
}

export function createLiveStreamSegments() {
  let seq = 0
  const segments = ref<LiveStreamSegment[]>([])

  function appendThinkingDelta(text: string): void {
    const last = segments.value[segments.value.length - 1]
    if (last?.kind === 'thinking' && !last.sealed) {
      last.text += text
      return
    }
    segments.value.push({ id: `__live_seg_${++seq}__`, kind: 'thinking', text, sealed: false })
  }

  function appendTextDelta(text: string): void {
    // Answer text ends the open reasoning segment (the model moved on).
    const last = segments.value[segments.value.length - 1]
    if (last?.kind === 'thinking') last.sealed = true
    if (last?.kind === 'text') {
      last.text += text
      return
    }
    segments.value.push({ id: `__live_seg_${++seq}__`, kind: 'text', text, sealed: false })
  }

  /**
   * A `thinking.recorded` event committed: the canonical projection now owns
   * that reasoning verbatim, so the synthetic copy must go — or it renders a
   * second time beside the sealed block. At this commit the buffer's thinking
   * segments ARE the committed content (the collector flushes the full
   * accumulated segment before every act event), so dropping all of them is
   * exact, not approximate.
   */
  function commitThinking(): void {
    if (!segments.value.some(s => s.kind === 'thinking')) return
    segments.value = segments.value.filter(s => s.kind !== 'thinking')
  }

  /**
   * Any other act event committed: an open reasoning segment has ended (the
   * collector flushes reasoning before every act event) — seal it in place.
   */
  function sealOpenThinking(): void {
    const last = segments.value[segments.value.length - 1]
    if (last?.kind === 'thinking') last.sealed = true
  }

  /** The `message.completed` landed: all synthetic content is now canonical. */
  function commitMessage(): void {
    if (segments.value.length === 0) return
    segments.value = []
  }

  function clear(): void {
    segments.value = []
  }

  const hasContent = computed(() => segments.value.length > 0)

  return { segments, hasContent, appendThinkingDelta, appendTextDelta, commitThinking, sealOpenThinking, commitMessage, clear }
}

export type LiveStreamSegments = ReturnType<typeof createLiveStreamSegments>
