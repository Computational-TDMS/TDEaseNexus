/**
 * useSessionDrafts — per-session composer draft persistence, extracted from
 * AgentPage (architecture audit candidate 6).
 *
 * Each session keeps its own composer draft, restored on switch and saved
 * 500ms after the user stops typing (palot pattern). The draft is pure view
 * state — losing it costs the user nothing but a half-finished sentence — so
 * it lives in the same workspace-scoped UI-state repository as pane widths,
 * keyed by sessionId. A draft for a deleted session is just stale text the
 * user clears; it never breaks a restore (the UiStateRepository port's rule 2
 * is about *handles* that expire, not about text).
 *
 * The page keeps only the ORCHESTRATION of these primitives: one watcher on
 * the active session calls `swap(next, prev)` in its ordered sequence, `send`
 * calls `clearActive()`, teardown calls `flushActive()`.
 */
import { watch, type Ref } from 'vue'
import { createLocalUiStateRepository } from '@/services/storage/uiStateRepository'

export function useSessionDrafts(options: {
  /** The live composer text, shared with the page's Composer v-model. */
  composerInput: Ref<string>
  activeId: () => string | null | undefined
  workspaceId: () => string | null | undefined
}) {
  const repo = createLocalUiStateRepository()
  const DRAFT_DEBOUNCE_MS = 500
  let timer: ReturnType<typeof setTimeout> | undefined

  function key(sessionId: string): string {
    return `composerDraft.${sessionId}`
  }

  function cancelTimer(): void {
    if (timer) { clearTimeout(timer); timer = undefined }
  }

  /** Hydrate the composer from the session's stored draft ('' without a session/workspace). */
  function restore(sessionId: string | null | undefined): void {
    const wsId = options.workspaceId()
    options.composerInput.value = sessionId && wsId
      ? repo.read<string>(wsId, key(sessionId), '')
      : ''
  }

  /** Write NOW for a concrete session — no debounce. Switch-flush, send-clear, teardown. */
  function writeNow(sessionId: string | null | undefined, value: string): void {
    const wsId = options.workspaceId()
    if (!sessionId || !wsId) return
    cancelTimer()
    repo.write(wsId, key(sessionId), value)
  }

  // Debounced persist of the live input. Installed here so the debounce
  // policy lives with the repository it feeds; the page never sees the timer.
  watch(options.composerInput, () => {
    const sessionId = options.activeId()
    const wsId = options.workspaceId()
    if (!sessionId || !wsId) return
    cancelTimer()
    timer = setTimeout(() => {
      repo.write(wsId, key(sessionId), options.composerInput.value)
    }, DRAFT_DEBOUNCE_MS)
  })

  /**
   * The switch primitive: flush the PREVIOUS session's draft first (a fast
   * switch must not lose the last few chars), then hydrate the next.
   */
  function swap(next: string | null | undefined, prev: string | null | undefined): void {
    writeNow(prev, options.composerInput.value)
    restore(next)
  }

  /** Send cleared the box: the draft must be empty IMMEDIATELY, not after the
   *  debounce — otherwise the empty write races a scheduled non-empty one. */
  function clearActive(): void {
    writeNow(options.activeId(), '')
  }

  /** Teardown flush so the half-finished sentence survives unmount / workspace switch. */
  function flushActive(): void {
    writeNow(options.activeId(), options.composerInput.value)
  }

  return { restore, swap, clearActive, flushActive }
}
