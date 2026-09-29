/**
 * agentTabs — the Pinia store backing the Agent page's right-sidebar tab host.
 *
 * This is the Agent-side twin of `documents.ts`, kept SEPARATE so the two
 * pages never fight over one active document. It mirrors `documents.ts`'s
 * open/select/close/MRU shape but is deliberately lighter:
 *
 *   • no persistence — Agent tabs are session-scoped (close the session, the
 *     tabs go). Restoring stale tabs across sessions has no value here.
 *   • no preview/pinned tiers — the right sidebar is a short-lived lookup
 *     surface, not an editing surface with tab tiers.
 *   • no dirty flag — these tabs view data, they do not edit it.
 *
 * View state, not truth (STUDIO-FRONTEND-BUSINESS-LOGIC.md §15.6): which Agent
 * tab is focused changes no domain fact. Deleting it loses nothing but focus.
 */
import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { agentTabId, type AgentTab, type AgentTabKey } from '@/studio/domain/agent-tab'

export const useAgentTabsStore = defineStore('agentTabs', () => {
  const tabs = ref<AgentTab[]>([])
  const activeId = ref<string | null>(null)
  /** Most-recently-focused order, newest first; drives close fallback. */
  const mru = ref<string[]>([])

  const active = computed<AgentTab | null>(() =>
    tabs.value.find((tab) => tab.id === activeId.value) ?? null)

  const activeKey = computed<AgentTabKey | null>(() => active.value?.key ?? null)

  /** Tabs in stable open order (oldest left), for the strip. */
  const orderedTabs = computed(() =>
    tabs.value.slice().sort((a, b) => a.openedAt - b.openedAt))

  function touchMru(id: string) {
    mru.value = [id, ...mru.value.filter((existing) => existing !== id)]
  }

  /**
   * Opens (or refocuses) a tab. Singleton kinds (subagents/files/plan/
   * evidence) collapse to one tab; `agent-file` is per-path. Always selects the
   * tab — opening is focusing.
   */
  function open(key: AgentTabKey, options: { title: string }): string {
    const id = agentTabId(key)
    const existing = tabs.value.find((tab) => tab.id === id)
    if (existing) {
      existing.title = options.title
      existing.lastActiveAt = Date.now()
      select(id)
      return id
    }
    const now = Date.now()
    const tab: AgentTab = { key, id, title: options.title, openedAt: now, lastActiveAt: now }
    tabs.value = [...tabs.value, tab]
    select(id)
    return id
  }

  /** Focus a tab by id. */
  function select(id: string) {
    const tab = tabs.value.find((t) => t.id === id)
    if (!tab) return
    activeId.value = id
    tab.lastActiveAt = Date.now()
    touchMru(id)
  }

  /**
   * Closes a tab. Falls back to the most-recently-focused remaining tab; if none
   * remain, the host shows its empty state.
   */
  function close(id: string) {
    tabs.value = tabs.value.filter((tab) => tab.id !== id)
    mru.value = mru.value.filter((existing) => existing !== id)
    if (activeId.value === id) {
      const next = mru.value[0]
      activeId.value = next ?? null
    }
  }

  /** Close every tab (used on session/workspace switch to reset the host). */
  function reset() {
    tabs.value = []
    activeId.value = null
    mru.value = []
  }

  return {
    tabs,
    activeId,
    mru,
    active,
    activeKey,
    orderedTabs,
    open,
    select,
    close,
    reset,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAgentTabsStore, import.meta.hot))
}
