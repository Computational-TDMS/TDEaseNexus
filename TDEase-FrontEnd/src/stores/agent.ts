/**
 * Agent store — the composition root. A thin holder of session metadata, the
 * active turn's in-flight streaming blocks, and pending approvals, assembled
 * from four slices:
 *
 *   - agent-session-meta.ts  the session list, lifecycle, and projection intake
 *   - agent-turn-runtime.ts  per-session in-flight turn view state + prompt queue
 *   - agent-approvals.ts     pending tool approvals
 *   - agent-live-blocks.ts   incremental message/block assembly while streaming
 *
 * CORE-ARCHITECTURE.md §2: the session event log is
 * the one durable record of a conversation; a second, independently
 * persisted copy is a defect, not a cache. Session metadata and conversation
 * facts both live below the Workspace session directory. localStorage retains
 * only the currently selected session id per Workspace. `messages` still holds the current
 * turn's in-flight blocks (thinking/tool_group/text/permission, assembled
 * live by `StreamBuffer` while a turn streams — there is no other way to
 * show a response before it settles), and `replaceSessionProjection` is how
 * a session's *history* enters this store: from `agent/events/project.ts`'s
 * projection of the on-disk log, not from what this store remembers on its
 * own. `useAgentTurn.ts` is the composition root that calls it.
 *
 * The message model is the ContentBlock discriminated union (chat-types.ts).
 *
 * The store's public surface is spelled out key by key in the return below —
 * it is the contract every component consumes; slices stay internal.
 */

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { createSessionMetaSlice } from './agent-session-meta'
import { createTurnRuntimeSlice } from './agent-turn-runtime'
import { createApprovalQueueSlice } from './agent-approvals'
import { createLiveBlocksSlice } from './agent-live-blocks'

export type { AgentSession } from './agent-session-meta'
export type { SessionTurnRuntime } from './agent-turn-runtime'
export type { ApprovalDecision, ApprovalRequest } from './agent-approvals'

// ── Turn preferences (permission mode + reasoning effort) ─────────────────────
//
// These are TURN BEHAVIOR, not application preferences: they live here (the
// agent domain) rather than in settings.ts. Persistence stays where the file
// is — settings.json — but as a one-way write-back: the agent store is the
// runtime truth, settings hydrates it at boot, and every change here is
// mirrored INTO settings by the watcher below. The old shape was a two-way
// mirror (useAgentTurn held local refs initialized from settings and watched
// back), which made "who owns the value" a matter of reading four files.

/** `ask` gates every tool call behind an approval card; `auto` runs silent. */
export type PermissionMode = 'ask' | 'auto'

/** The canonical reasoning-effort union (mirrors the runtime contract). */
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevelValue = (typeof THINKING_LEVELS)[number]

export const useAgentStore = defineStore('agent', () => {
  const meta = createSessionMetaSlice()
  const turn = createTurnRuntimeSlice(meta.sessionOf)
  const approvals = createApprovalQueueSlice()
  const live = createLiveBlocksSlice(meta.sessionOf)

  // ── Turn preferences (runtime truth; settings.json is the persistence file) ──
  // Both default to the "just do it" end of their axis: a fresh session runs
  // (workflow) and does not stop for approval on every side effect (auto).
  const permissionMode = ref<PermissionMode>('auto')
  const thinkingLevel = ref<ThinkingLevelValue>('medium')

  /** Boot-time hydration from the persisted settings file (one-way, once). */
  function hydrateTurnPrefs(prefs: { permissionMode?: string; thinkingLevel?: string }): void {
    if (prefs.permissionMode === 'auto' || prefs.permissionMode === 'ask') permissionMode.value = prefs.permissionMode
    if (THINKING_LEVELS.includes(prefs.thinkingLevel as ThinkingLevelValue)) {
      thinkingLevel.value = prefs.thinkingLevel as ThinkingLevelValue
    }
  }

  /**
   * Write-back into the settings store whenever a preference changes here.
   * Wired lazily in `bindTurnPreferencePersistence()` (called from
   * useAgentTurn's setup, where the settings store is already in scope) to
   * keep this store free of a settings import cycle.
   */
  let persistTurnPrefs: ((prefs: { permissionMode: PermissionMode; thinkingLevel: ThinkingLevelValue }) => void) | null = null
  function bindTurnPreferencePersistence(
    sink: (prefs: { permissionMode: PermissionMode; thinkingLevel: ThinkingLevelValue }) => void,
  ): void {
    persistTurnPrefs = sink
    watch([permissionMode, thinkingLevel], ([mode, level]) => {
      persistTurnPrefs?.({ permissionMode: mode, thinkingLevel: level })
    })
  }

  // Viewing a session clears its unread settlement: the user is looking at it
  // now, so whatever landed while they were away has been seen. Centralized
  // here (not in each call site that flips `activeId`) so every path that makes
  // a session active — selectSession, createSession, bindWorkspace hydrate —
  // clears it consistently. The one cross-slice wire: metadata's active slot
  // drives the turn-runtime slice's unread flag.
  watch(meta.activeId, (id) => {
    if (id) turn.patchTurn(id, { unreadSettlement: false })
  })

  return {
    // session state
    sessions: meta.sessions,
    archivedSessions: meta.archivedSessions,
    allSessions: meta.allSessions,
    workspaceId: meta.workspaceId,
    activeId: meta.activeId,
    active: meta.active,
    contextTokensUsed: meta.contextTokensUsed,
    contextCacheHitRate: meta.contextCacheHitRate,
    pendingApprovals: approvals.pendingApprovals,
    // session lifecycle
    createSession: meta.createSession,
    selectSession: meta.selectSession,
    bindWorkspace: meta.bindWorkspace,
    hydrateWorkspaceSessions: meta.hydrateWorkspaceSessions,
    archiveSession: meta.archiveSession,
    patchTurn: turn.patchTurn,
    noteTurnFact: turn.noteTurnFact,
    // turn preferences
    permissionMode,
    thinkingLevel,
    hydrateTurnPrefs,
    bindTurnPreferencePersistence,
    patchContextUsage: turn.patchContextUsage,
    unarchiveSession: meta.unarchiveSession,
    createSideSession: meta.createSideSession,
    sideSessionsOf: meta.sideSessionsOf,
    sideSessions: meta.sideSessions,
    updateSessionTitle: meta.updateSessionTitle,
    replaceSessionProjection: meta.replaceSessionProjection,
    settleSessionProjection: meta.settleSessionProjection,
    markHistoryHydrated: meta.markHistoryHydrated,
    markHistoryError: meta.markHistoryError,
    appendCompactionDivider: live.appendCompactionDivider,
    atomsOf: meta.atomsOf,
    // approval queue
    pushApproval: approvals.pushApproval,
    resolveApproval: approvals.resolveApproval,
    // per-session prompt queue
    enqueuePrompt: turn.enqueuePrompt,
    dequeuePrompt: turn.dequeuePrompt,
    removeQueuedPrompt: turn.removeQueuedPrompt,
    // messages
    addMessage: live.addMessage,
    findMessage: live.findMessage,
    appendText: live.appendText,
    appendThinking: live.appendThinking,
    sealThinking: live.sealThinking,
    upsertTool: live.upsertTool,
    patchTool: live.patchTool,
    pushBlock: live.pushBlock,
    patchPermission: live.patchPermission,
  }
})
