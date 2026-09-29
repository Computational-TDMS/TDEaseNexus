/**
 * Tests for the extracted per-session composer draft persistence (audit
 * candidate 6): the composable owns the debounce/repo policy; the page only
 * orchestrates swap/clear/flush. These pin the policy's contract.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useSessionDrafts } from './useSessionDrafts'

/** The repository itself debounce-writes (200ms internal) on top of the
 *  composable's 500ms quiet period — advance past the inner layer. */
function flushRepoTimers() { vi.advanceTimersByTime(200) }

/** Test harness: runs the composable against switchable active/workspace ids.
 *  `watch` works outside a component instance — no mount needed. */
function mountDrafts() {
  const activeId = ref<string | null>(null)
  const workspaceId = ref<string | null>('ws-1')
  const composerInput = ref('')
  const drafts = useSessionDrafts({
    composerInput,
    activeId: () => activeId.value,
    workspaceId: () => workspaceId.value,
  })
  return { composerInput, activeId, workspaceId, drafts }
}

function stored(wsId: string | null, sessionId: string): string | undefined {
  const raw = window.localStorage.getItem(`tdease.ui.${wsId}.composerDraft.${sessionId}`)
  return raw === null ? undefined : JSON.parse(raw)
}

describe('useSessionDrafts', () => {
  beforeEach(() => { window.localStorage.clear() })
  afterEach(() => { vi.useRealTimers() })

  it('restore hydrates the composer from the stored draft, empty without a session', () => {
    window.localStorage.setItem('tdease.ui.ws-1.composerDraft.s1', JSON.stringify('hello'))
    const { drafts, composerInput } = mountDrafts()
    drafts.restore('s1')
    expect(composerInput.value).toBe('hello')
    drafts.restore(null)
    expect(composerInput.value).toBe('')
  })

  it('swap flushes the previous session immediately, then hydrates the next', async () => {
    vi.useFakeTimers()
    const { drafts, composerInput, activeId } = mountDrafts()
    activeId.value = 's1'
    composerInput.value = 'draft for s1'
    await nextTick()
    // Switch before ANY debounce fires: the previous session's text must be
    // handed to the repository now (it lands after the repo's own 200ms
    // internal write debounce), and the next session starts empty.
    drafts.swap('s2', 's1')
    flushRepoTimers()
    expect(stored('ws-1', 's1')).toBe('draft for s1')
    expect(composerInput.value).toBe('')
  })

  it('debounced typing persists after the quiet period under the active session', async () => {
    vi.useFakeTimers()
    const { drafts, composerInput, activeId } = mountDrafts()
    activeId.value = 's1'
    composerInput.value = 'still typing'
    await nextTick()
    vi.advanceTimersByTime(499)
    flushRepoTimers()
    expect(stored('ws-1', 's1')).toBeUndefined()
    vi.advanceTimersByTime(1)
    flushRepoTimers()
    expect(stored('ws-1', 's1')).toBe('still typing')
    // ...and the swap-flush cancels the pending write (no stale overwrite).
    activeId.value = 's2'
    drafts.swap('s2', 's1')
    composerInput.value = 'for s2'
    await nextTick()
    drafts.flushActive()
    flushRepoTimers()
    expect(stored('ws-1', 's2')).toBe('for s2')
  })

  it('clearActive writes an empty draft immediately (send must not race the debounce)', () => {
    vi.useFakeTimers()
    window.localStorage.setItem('tdease.ui.ws-1.composerDraft.s1', JSON.stringify('pending'))
    const { drafts, activeId } = mountDrafts()
    activeId.value = 's1'
    drafts.clearActive()
    flushRepoTimers()
    expect(stored('ws-1', 's1')).toBe('')
  })
})
