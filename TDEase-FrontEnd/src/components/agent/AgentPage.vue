<!--
  AgentPage — the Agent conversation's full page: the one host of the approval
  dock (PermissionCardDock) and the session list.

  SessionBar owns session switching through its menu; Transcript, TurnHud and
  Composer fill the page below it. The conversation CONTROLLER (turn runtime,
  draft, slash registry) lives in the shared `agentConversation` singleton —
  the Workbench's right sidebar is a second VIEW of it, with its own composer,
  but there is still exactly one runtime and one approval surface.

  The turn state is still published to the shell through the same 2px edge
  indicator (VISUAL-SYSTEM.md §6.4) so "the Agent is acting" stays legible.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import Empty from '@/components/primitives/Empty.vue'
import AppButton from '@/components/primitives/AppButton.vue'
import ResizableSplit from '@/components/workbench/ResizableSplit.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useAgentStore } from '@/stores/agent'
import { useRunsStore } from '@/stores/runs'
import { useSubagentsStore } from '@/stores/subagents'
import { useUiLayoutStore, AGENT_SESSIONS_WIDTH_RANGE } from '@/stores/uiLayout'
import { useAgentTabsStore } from '@/stores/agentTabs'
import {
  desktopWorkspaceTextBridge,
  listWorkspaceSessionMetadata,
} from '@/services/agent/agentSessionStorage'
import { useWorkspaceOpener } from '@/composables/useWorkspaceOpener'
import { useWorkspaceRailPanel } from '@/composables/useWorkspaceRailPanel'
import { asWorkspaceId, asRelativePath } from '@/studio/domain/identity'
import SessionList from './SessionList.vue'
import SessionBar from './SessionBar.vue'
import Transcript from './Transcript.vue'
import Composer from './Composer.vue'
import EmptyState from './EmptyState.vue'
import PermissionCardDock from './PermissionCardDock.vue'
import AgentTabHost from './tabs/AgentTabHost.vue'
import ActivityCapsule from './ActivityCapsule.vue'
import SubagentPanel from './SubagentPanel.vue'
import JobPanel from './JobPanel.vue'
import { useSessionMetadataPersistence } from './useSessionMetadataPersistence'
import { AGENT_TURN_READOUT, type AgentTurnReadout } from './turnReadout'
import { countWorkspaceFiles } from './workspace-file-counts'
import { useAgentConversation } from './agentConversation'
import { setSideChatDraft } from './side-chat-drafts'
import type { TurnSettlement } from '@/agent/events'

export type AgentTurnState = 'idle' | 'acting' | 'suspended' | 'halted' | 'failed'

/** Stable empty fallback so a sessionless render passes one shared map, not a fresh allocation. */
const EMPTY_SETTLEMENTS: ReadonlyMap<string, TurnSettlement> = new Map()

const { t } = useI18n()
const workspaceStore = useWorkspaceStore()
const agentStore = useAgentStore()
// Instantiating the runs store here (not only on the Runs surface) starts
// its workspace watcher, so the empty state's run count reflects real
// history instead of a permanent "no runs yet" state.
const runsStore = useRunsStore()
const subagentsStore = useSubagentsStore()
const uiLayout = useUiLayoutStore()
const agentTabsStore = useAgentTabsStore()
const { pickAndOpen } = useWorkspaceOpener()

const { workspacePath, fileTree } = storeToRefs(workspaceStore)


// The conversation controller is a module singleton (agentConversation.ts)
// shared with the Workbench's right sidebar: one draft, one turn runtime, one
// slash registry — two views, never two hosts.
const {
  turn, composerInput, drafts, localMcpServers,
  refreshLocalMcpServers, sessionModelLabel, slashRegistry, dispatchSlash,
  sendFromComposer, stopTurn, dequeuePrompt,
} = useAgentConversation()
const composerRef = ref<InstanceType<typeof Composer> | null>(null)

// ── Measured composer clearance ─────────────────────────────────────────────
// The transcript's scroll padding and bottom fade track the FLOATING
// composer's real height (a wrapped toolbar or a grown multi-line input makes
// the card taller than any constant estimate — the old 3-row guess let the
// transcript tail slide underneath the card). The anchor is observed and the
// measured pixels are written onto the transcript element as the two
// clearance variables; Transcript.vue and its overlays all consume them.
const composerAnchorRef = ref<HTMLElement | null>(null)
const transcriptEl = ref<{ $el: HTMLElement } | null>(null)
let composerClearObserver: ResizeObserver | null = null

function syncComposerClear() {
  const anchor = composerAnchorRef.value
  const target = transcriptEl.value?.$el as HTMLElement | undefined
  if (!anchor || !target) return
  const height = anchor.offsetHeight
  if (height > 0) {
    target.style.setProperty('--composer-clear', `${height + 12}px`)
  }
}

// ── ActivityCapsule expanded state ──────────────────────────────────────────
// Owned here (not inside the capsule) because the transcript needs to know it
// too — when the capsule expands it overlays the transcript's right edge, so
// the transcript shifts left by the card width to stay readable. Auto-expands
// when a turn starts (the user wants to see progress), auto-collapses when it
// settles; manual clicks via the capsule toggle override this.
const capsuleExpanded = ref(false)
// Auto-expand the capsule on turn-start so the user sees progress — but only
// The page is the Agent's only surface now (the Workbench dock is gone), and
// the conversation is wide enough that the 248px card overlaying its right
// edge still leaves the text readable — so sending auto-expands it; a manual
// click still collapses it on demand.
watch(() => turn.sending.value, (sending) => {
  capsuleExpanded.value = sending
})

// The floating SubagentPanel — a third right-rail state, NOT an agentTabsStore
// tab. Toggled by Ctrl+Shift+D and the ActivityCapsule subagent row. Survives
// independently of the tab host: closing tabs does not close it.
const subagentPanelOpen = ref(false)
function toggleSubagentPanel(): void { subagentPanelOpen.value = !subagentPanelOpen.value }
// The floating JobPanel — a third right-rail state, the background-jobs
// analogue of SubagentPanel. Mutually exclusive with it via the v-if/else chain.
const jobPanelOpen = ref(false)
function toggleJobPanel(): void { jobPanelOpen.value = !jobPanelOpen.value }

// ── Per-session composer draft persistence ───────────────────────────────────
// The draft itself lives in the shared conversation singleton; the page keeps
// only the ORCHESTRATION of its primitives (swap on session change, clear on
// send, flush on teardown) — see onActiveSessionChange below for the ordering.

// Session records (title/timestamps/archived/mindset) delta-persist to the
// workspace's session.json files; the policy lives in the composable too.
useSessionMetadataPersistence(workspacePath)

// The ONE active-session-change orchestrator. Three side effects used to be
// three separate watchers on the same ref scattered across this file; a single
// ordered function states their relative priority explicitly (draft swap →
// history reload → tab reset) instead of leaving the order to watcher
// creation order.
watch(() => agentStore.activeId, (next, prev) => onActiveSessionChange(next, prev))

/**
 * Ordered side effects of an active-session switch:
 *   1. Draft swap — persist the previous session's draft first so a fast
 *      switch does not lose the last few chars, then hydrate the next.
 *   2. History reload — a session mid-turn holds its freshest state in
 *      memory: streamBuffer has been accumulating text_delta/thinking_delta
 *      into the live assistant message, but those deltas are TRANSIENT — they
 *      do not hit events.jsonl until the turn's `message.completed` commits.
 *      Reloading from disk now would replaceSessionProjection() the in-flight
 *      content with the older committed prefix, so the user would watch the
 *      stream "rewind" and lose everything streamed while they were away.
 *      Memory is authoritative while a turn runs; disk only wins once the
 *      turn settles (send() reloads on completion, and a finished session
 *      still reloads here).
 *   3. Tab reset — Agent tabs are session-scoped: the host never shows
 *      another session's assets. (Workspace switches re-run ensureSession and
 *      reset tabs through their own watcher below.)
 */
function onActiveSessionChange(next: string | null, prev: string | null): void {
  drafts.swap(next, prev)
  if (next && !agentStore.active?.turn.sending) void turn.loadHistory(next)
  agentTabsStore.reset()
}

const edgeState = computed<AgentTurnState>(() => (turn.suspended.value ? 'suspended' : turn.turnState.value))
// Counts walk the lazy directory cache as well as the seed tree, so data one
// level down counts once its listing has been fetched (see the preload below).
const fileCounts = computed(() => countWorkspaceFiles(fileTree.value, workspaceStore.directoryCache))

// The seed file tree lists only the Workspace root — directory children stay
// empty until expanded, so a Workspace whose data lives in a subdirectory
// (the common `data/` layout) used to count as "0 raw · 0 fasta" and the
// empty state showed its no-data setup hints over real data. Listing each
// top-level directory once (dot-dirs excepted — `.git`/`.tdease` never hold
// user data) gives the counts honest coverage without a full recursive scan.
watch(fileTree, (tree) => {
  for (const node of tree) {
    if (node.type === 'directory' && !node.name.startsWith('.') && !workspaceStore.isDirLoaded(node.path)) {
      void workspaceStore.loadDirLazy(node.path)
    }
  }
}, { immediate: true })

// A one-line summary of what the Agent can see in the open Workspace, fed to
// the Composer's context chip. Honest about what is actually available: no
// token count is wired from the runtime (the HUD tracks calls/elapsed, not
// tokens), so this shows file counts instead — the real currency of this
// surface. Empty when the Workspace has no scannable data yet.
const sessionsWidth = computed(() => uiLayout.agentSessionsWidth)
function onSessionsResize(px: number) {
  uiLayout.setAgentSessionsWidth(px)
}

// Provide the active session's messages. The Agent tab host's Plan view reads
// the plan off this same projection via the shared `useSessionTodos` composable,
// so the tab and the transcript can never disagree about what the model planned.
const activeMessages = computed(() => agentStore.active?.messages ?? [])
provide('chatMessages', activeMessages)

/**
 * The active session's history has not landed yet — either no session is
 * chosen (workspace metadata still being read) or the chosen one is restored
 * from metadata alone and its `loadHistory` is in flight. Feeds Transcript's
 * `loading` so an opened old session shows a skeleton instead of flashing the
 * "new conversation" empty state.
 */
const historyLoading = computed(() => {
  const active = agentStore.active
  return !active || !active.historyHydrated
})

// The settings drawer (AgentSettingsTab) reads the live turn's context-window
// and vision readout, but it mounts through the tab registry which takes no
// props. Provide the read-only projection of those refs so the drawer binds the
// SAME values the Composer used to — moved, not duplicated. The context-window
// number reflects the last bound session (it refreshes on Node's bindSession),
// so it lags a model switch by one turn; the drawer's banner says so.
const turnReadout: AgentTurnReadout = {
  contextTokensUsed: turn.contextTokensUsed,
  contextCacheHitRate: turn.contextCacheHitRate,
  contextWindow: turn.contextWindow,
  modelSupportsImages: turn.modelSupportsImages,
}
provide(AGENT_TURN_READOUT, turnReadout)

// The right sidebar is the Agent tab host when any tab is open; with no tabs it
// collapses to a floating ActivityCapsule (asset summary entry). Closing the
// last tab returns here automatically; clicking the capsule opens a tab back.
const hasOpenTabs = computed(() => agentTabsStore.tabs.length > 0)

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/**
 * Global keyboard shortcuts for the Agent surface (palot root-layout.tsx
 * pattern: one keydown handler, guard typing targets first).
 *
 *   Ctrl/Cmd+Shift+D — toggle the Activity panel open/closed
 *   Ctrl/Cmd+= / - / 0 — font zoom in/out/reset (lives in AppShell, not here)
 *   Ctrl/Cmd+N        — new session (Phase D, palot ⌘N)
 *   j / k             — previous / next session (Phase D, palot vim-style)
 *   double Esc        — abort the active turn (Phase D, palot double-Esc)
 *
 * `j/k` and `Esc` are guarded against typing targets so they never steal a
 * character the user is entering. Double-Esc uses a 350ms window — two taps
 * inside it abort; the first tap is left to do whatever else Esc does
 * (close a menu, blur the composer) so a single press is not eaten.
 */
let lastEscAt = 0
const DOUBLE_ESC_MS = 350

function stepSession(direction: 1 | -1) {
  const list = agentStore.sessions
  if (list.length < 2) return
  const current = agentStore.activeId
  const idx = list.findIndex((s) => s.id === current)
  if (idx < 0) return
  const next = list[(idx + direction + list.length) % list.length]
  if (next) agentStore.selectSession(next.id)
}

/**
 * Ctrl+Shift+D opens the Agent tab host's Subagents view (a one-tap "what is
 * the Agent doing" affordance) and focuses the strip. The Activity panel is
 * gone; the right sidebar is now a tab host, so this shortcut opens a tab in
 * it rather than toggling a panel.
 */
function openActivityTab() {
  // Subagents are an ambient activity stream, not a pinned document — they live
  // in the floating SubagentPanel, not an agentTabsStore tab. Ctrl+Shift+D and
  // the ActivityCapsule row both toggle it.
  toggleSubagentPanel()
}

function onGlobalKeydown(event: KeyboardEvent) {
  const ctrl = event.ctrlKey || event.metaKey
  // Ctrl+L focuses the Composer from anywhere the Agent lives — full page or
  // docked into the Workbench (browser address-bar convention, adapted to
  // "jump to input"). The composer exists in both surfaces.
  if (ctrl && (event.key === 'l' || event.key === 'L')) {
    if (isTypingTarget(event.target)) return
    event.preventDefault()
    composerRef.value?.focus?.()
    return
  }
  if (ctrl && event.shiftKey && (event.key === 'D' || event.key === 'd')) {
    if (isTypingTarget(event.target)) return
    event.preventDefault()
    openActivityTab()
    return
  }
  // Ctrl+N + j/k + double-Esc act on the session list / live turn, which only
  // exist visibly on the Agent page — the page stays mounted (v-show) while
  // Workbench is front, so gate on visibility, not on mount.
  if (uiLayout.activePage !== 'agent') return
  if (ctrl && (event.key === 'n' || event.key === 'N')) {
    if (isTypingTarget(event.target)) return
    event.preventDefault()
    agentStore.createSession()
    return
  }
  // Plain j / k (no modifiers): session navigation. Only when not typing.
  if (!ctrl && !event.altKey && !event.shiftKey) {
    if (event.key === 'j' || event.key === 'k') {
      if (isTypingTarget(event.target)) return
      event.preventDefault()
      stepSession(event.key === 'j' ? 1 : -1)
      return
    }
    if (event.key === 'Escape') {
      // Double-Esc within the window aborts the active turn (palot pattern).
      // A single Esc is left alone so it can close a menu / blur the composer.
      const now = Date.now()
      if (now - lastEscAt <= DOUBLE_ESC_MS) {
        lastEscAt = 0
        if (turn.sending.value) {
          event.preventDefault()
          turn.stop()
        }
      } else {
        lastEscAt = now
      }
    }
  }
}


async function ensureSession(): Promise<void> {
  if (!workspaceStore.workspaceId) return
  try {
    await workspaceStore.ready()
    agentStore.bindWorkspace(workspaceStore.workspaceId)
    const records = await listWorkspaceSessionMetadata(desktopWorkspaceTextBridge(), workspacePath.value)
    agentStore.hydrateWorkspaceSessions(records)
  } catch (error) {
    // One unreadable session.json must not kill the whole page's boot: name
    // the failure loudly, then keep going with whatever hydrated.
    console.error('[agent] session boot failed:', error)
  }
  const hasExistingSession = agentStore.sessions.length > 0
  if (!hasExistingSession) agentStore.createSession()
  // Independent reads: the skill catalog and the transcript history share no
  // order, and serializing them delays the Agent surface's first paint.
  await Promise.all([
    turn.refreshLocalSkills(),
    hasExistingSession && agentStore.active ? turn.loadHistory(agentStore.active.id) : Promise.resolve(),
  ])
}

onMounted(() => {
  void ensureSession(); void refreshLocalMcpServers(); window.addEventListener('keydown', onGlobalKeydown)
  syncComposerClear()
  if (composerAnchorRef.value && typeof ResizeObserver !== 'undefined') {
    composerClearObserver = new ResizeObserver(syncComposerClear)
    composerClearObserver.observe(composerAnchorRef.value)
  }
})
onBeforeUnmount(() => {
  composerClearObserver?.disconnect()
  composerClearObserver = null
  void turn.disposeAll()
  window.removeEventListener('keydown', onGlobalKeydown)
  subagentsStore.teardown()
  // Flush any pending draft write so the user's half-finished sentence
  // survives a docked/full-page teardown or a workspace switch.
  drafts.flushActive()
})

watch(workspacePath, () => { void turn.disposeAll().then(ensureSession) })
// Agent tabs are workspace-scoped too: a workspace switch re-runs
// ensureSession, and the session change fires the orchestrator above.
watch(workspacePath, () => agentTabsStore.reset())

// The composer's send path lives on the shared conversation singleton; the
// transcript's one-tap answers and the composer itself both route through it.
const onSend = sendFromComposer

/**
 * A file card (Workspace media produced by the Agent) was clicked in the
 * transcript. Opens the file as a tab in the Agent page's right sidebar
 * (FileDocument → MediaViewer for images/SVG, an HTML iframe for HTML) — the
 * asset stays in the Agent surface instead of forcing a jump to the Workbench.
 * The tab host reuses the same `FileDocument` the Workbench uses, so there is
 * one viewer, not two.
 */
/**
 * The selection pill's landing (ZCode's SelectionSideChatPane): spawn a side
 * session of the ACTIVE conversation, seed its composer with the quoted
 * selection, and open its tab. Nothing is auto-sent — the user adds their
 * question and presses Enter. The parent keeps its active slot throughout;
 * sends from the panel route by explicit sessionId.
 */
function onAskSelection(text: string) {
  const parentId = agentStore.activeId
  if (!parentId) return
  let side
  try {
    side = agentStore.createSideSession(parentId)
  } catch {
    return // unknown/degenerate parent — the pill should not have been there
  }
  setSideChatDraft(side.id, `${t('agent.sideChat.quotePrefix')}\n> ${text}\n`)
  agentTabsStore.open(
    { kind: 'agent-side-chat', sessionId: side.id, parentSessionId: parentId },
    { title: t('agent.sideChat.tabTitle') },
  )
}

function onOpenFile(file: { path: string; kind: 'image' | 'svg' | 'html' | 'table' | 'json' | 'text' | 'file'; name: string }) {
  const wsId = workspaceStore.workspaceId
  if (!wsId) return
  try {
    agentTabsStore.open(
      { kind: 'agent-file', workspaceId: asWorkspaceId(wsId), path: asRelativePath(file.path) },
      { title: file.name },
    )
  } catch {
    // asRelativePath throws on an absolute/escaping path; a file path that
    // cannot be made relative is not openable as a workspace file, so swallow.
  }
}

function onSelectGoal(message: string) {
  composerInput.value = message
}

// The empty state's setup row executes for real: the rail panel is the ONE
// workspace-choosing UI, shared with the Welcome card (the Agent page shows
// the same rail, so the popover opens right where the user is).
function onEmptySetup() {
  useWorkspaceRailPanel().open.value = true
}

function onNewSession() {
  agentStore.createSession()
}

async function onFork() {
  // Fork is refused mid-turn by useAgentTurn.fork itself; there is no cue to
  // surface here — the refusal is the store's decision, not the page's.
  await turn.fork()
}

/**
 * A halted turn's work is real; continuing is simply the next ordinary message,
 * so this puts the focus back in the composer rather than replaying anything.
 */
function onContinueTurn() {
  composerRef.value?.focus()
}

// A blocked turn offered one-tap options; the chosen option IS the answer,
// so it goes straight out as the next turn — no retyping.
function onAnswerTurn(_turnId: string, answer: string) {
  void onSend(answer)
}

async function onOpenWorkspace() {
  // Default fallback, not `null`: where no native picker exists (browser
  // dev) the composable seeds a demo workspace, so the affordance never
  // dies silently. In Electron the picker opens and cancel is a no-op.
  const opened = await pickAndOpen()
  if (opened) await ensureSession()
}

</script>

<template>
  <section
    class="agent-page"
    :aria-label="t('workbench.agent.label')"
    tabindex="-1"
  >
    <div class="agent-page__edge" :class="`agent-page__edge--${edgeState}`" aria-hidden="true" />

    <template v-if="workspaceStore.hasWorkspace">
      <!--
        SessionList (left) | conversation + Activity surface (right). The
        SessionList is THIS page's left column — page-scoped, not global chrome
        (the Workbench page has no sessions; the Agent page has no file tree).
        It is a resizable split pane so the user can give it the width they
        want.

        The Activity panel is a real LAYOUT column: when open the conversation
        narrows to make room. It does NOT float over the conversation. When
        closed, the ActivityCapsule floats over the conversation's right edge
        (taking no layout width — closing is closing) and the conversation
        reclaims its full width. Live turn progress and the plan live INSIDE
        the panel (its header + Plan tab); the conversation column holds
        SessionBar, Transcript, approvals and the Composer.
      -->
      <ResizableSplit
        direction="horizontal"
        :size="sessionsWidth"
        :min="AGENT_SESSIONS_WIDTH_RANGE.min"
        :max="AGENT_SESSIONS_WIDTH_RANGE.max"
        :collapsible="true"
        :aria-label="t('workbench.agent.resizeSessions')"
        @update:size="onSessionsResize"
      >
        <template #first>
          <SessionList class="agent-page__sessions" @new="onNewSession" @fork="onFork" />
        </template>
        <template #second>
          <div class="agent-page__row">
            <div class="agent-page__conversation" :class="{ 'agent-page__conversation--capsule-open': capsuleExpanded && !hasOpenTabs }">
              <SessionBar
                :model-name="sessionModelLabel"
                @new="onNewSession"
                @fork="onFork"
              />

              <!-- `!compacting`: a manual /compact rides `sending=true`, so without
             this guard BOTH the working livetail AND the live compaction
             divider rendered stacked at the same bottom-center anchor — the
             "two animations at once" bug. The compaction divider IS the live
             state while compacting; the transcript never duplicates it. -->
              <Transcript
                ref="transcriptEl"
                class="agent-page__transcript"
                :messages="agentStore.active?.messages ?? []"
                :settlements="agentStore.active?.settlements ?? EMPTY_SETTLEMENTS"
                :session-id="agentStore.active?.id ?? null"
                :streaming-message-id="turn.streaming.value ? (agentStore.active?.messages.findLast?.((m) => m.role === 'assistant')?.id ?? null) : null"
                :pending="turn.sending.value && !agentStore.active?.turn.compacting && turn.hud.phase === 'waiting'"
                :compacting="agentStore.active?.turn.compacting ?? false"
                :loading="historyLoading"
                selection-ask
                @continue-turn="onContinueTurn"
                @answer-turn="onAnswerTurn"
                @open-file="onOpenFile"
                @ask-selection="onAskSelection"
              >
                <template #empty>
                  <!-- A failed history read must never wear the welcome state: the
                 record exists but is unreadable, and "new conversation" would
                 tell the user their history is gone. -->
                  <Empty
                    v-if="agentStore.active?.historyError"
                    :title="t('workbench.agent.historyErrorTitle')"
                    :description="t('workbench.agent.historyErrorDescription', { message: agentStore.active.historyError })"
                  />
                  <EmptyState
                    v-else
                    :raw-file-count="fileCounts.rawFileCount"
                    :fasta-file-count="fileCounts.fastaFileCount"
                    :run-count="runsStore.historyTotal"
                    @select="onSelectGoal"
                    @setup="onEmptySetup"
                  />
                </template>
              </Transcript>

              <!--
          Composer anchor: the Composer and the live approval dock share one
          positioning context. A permission decision is transient and
          time-sensitive, so it FLOATS above the Composer (position: absolute,
          bottom: 100%) like Raycast's confirm bar instead of docking in flow —
          an arriving approval no longer inserts a flex child into the column,
          so the transcript's geometry never changes and there is no layout
          jump. The ActivityCapsule (closed-state) floats here too, over the
          conversation's right edge.
        -->
              <div ref="composerAnchorRef" class="agent-page__composer-anchor">
                <PermissionCardDock />

                <Composer
                  ref="composerRef"
                  v-model="composerInput"
                  :commands="slashRegistry"
                  :skills="turn.skills.value"
                  :mcp-servers="localMcpServers"
                  :busy="turn.sending.value"
                  :queued="agentStore.active?.queuedPrompts ?? []"
                  :mindset="turn.mindset.value"
                  :authority="turn.permissionMode.value"
                  :thinking-level="turn.thinkingLevel.value"
                  @update:mindset="turn.mindset.value = $event"
                  @update:authority="turn.permissionMode.value = $event"
                  @update:thinking-level="turn.thinkingLevel.value = $event"
                  @send="onSend"
                  @stop="stopTurn"
                  @dequeue="dequeuePrompt"
                  @slash="dispatchSlash"
                />
              </div>
            </div>

            <!--
          Right sidebar — two states, toggled by whether any tab is open:
            • tabs open   → AgentTabHost (a real layout column; the conversation
                           narrows to make room)
            • no tabs     → ActivityCapsule (floats over the conversation's
                           right edge, no layout width; an asset-summary entry
                           that opens a tab on click)
          Closing the last tab returns to the capsule automatically. The host
          reuses the Workbench's viewers (FileDocument etc.), so one viewer per
          concern.

          This sidebar is the Agent's ambient activity surface, so it renders
          wherever the Agent renders — docked into the Workbench right column
          AND on the full Agent page. The capsule floats (no layout width), and
          opening a tab/panel auto-widens a narrow docked column so the viewer
          is actually reachable instead of silently opening off-screen. Only
          the SessionList split above is full-page-only; the activity rail is
          not.
        -->
            <!-- The floating SubagentPanel takes precedence when open: it is the
             ambient activity stream, independent of the tab host below. -->
            <SubagentPanel v-if="subagentPanelOpen" v-model:open="subagentPanelOpen" class="agent-page__tabs" />
            <JobPanel v-else-if="jobPanelOpen" v-model:open="jobPanelOpen" class="agent-page__tabs" />
            <AgentTabHost v-else-if="hasOpenTabs" class="agent-page__tabs" @open-subagents="toggleSubagentPanel" />
            <ActivityCapsule
              v-else
              v-model:expanded="capsuleExpanded"
              :hud="turn.hud"
              :mindset="turn.mindset.value"
              :last-outcome="turn.lastOutcome.value"
              :sending="turn.sending.value"
              :suspended="turn.suspended.value"
              @open-jobs="toggleJobPanel"
            />
          </div>
        </template>
      </ResizableSplit>
    </template>

    <!--
      No Workspace: the Agent genuinely cannot act, so it says so and offers the
      one action that changes that. This replaced copy that read "the Agent panel
      will be provided in S4" — a message about an unfinished delivery slice,
      shown by a finished Agent, to a user who has no idea what S4 is.
    -->
    <div v-else class="agent-page__empty">
      <Empty
        :title="t('workbench.agent.emptyTitle')"
        :description="t('workbench.agent.emptyDescription')"
      />
      <div class="agent-page__empty-actions">
        <AppButton variant="primary" @click="onOpenWorkspace">
          {{ t('workbench.agent.openWorkspace') }}
        </AppButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ── Stacking contract for the Agent surface ──────────────────────────────────
   One z scale, owned here so a new floating layer joins it instead of minting
   a fresh number:
     0    transcript content (the scroller)
     1    the live edge indicator (agent-page__edge)
     5    transcript scroll-fade masks · floating Composer anchor
     6    ActivityCapsule float · transcript live-tail pill
     10   transcript jump pills (jump-fade Transitions in Transcript.vue)
     15   PermissionCardDock (approvals float above the Composer)
     20   SessionBar session menu
     100  text-entry popups (SlashInput completion, PermissionModeButton popover)
   Rule: never skip past a band for a local fix — a thing that must cover the
   Composer lives at 15, not 99. */
.agent-page {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg-secondary);
}

/* -- The edge indicator (VISUAL-SYSTEM.md §6.4): one element, five states, no
   text. The stop is the design -- "suspended" freezes at its current gradient
   position rather than animating, which is what makes it legible as "waiting on
   you" rather than "still working". Halted is neutral, never styled as a
   failure; failed uses the danger tone. -- */
.agent-page__edge {
  position: absolute;
  inset: 0 auto 0 0;
  width: 2px;
  z-index: var(--z-raised);
}

.agent-page__edge--idle { background: transparent; }

/* The acting state is the live channel (The Living Channel Rule): it gets
   the luminous --color-live teal, a wider 3px stroke, and a soft glow — the
   only edge state allowed to shine. The other four states stay at the quiet
   2px base width with their existing semantics untouched. */
.agent-page__edge--acting {
  width: 3px;
  background: linear-gradient(to bottom, transparent 0%, var(--color-primary) 50%, transparent 100%);
  background-size: 100% 200%;
  box-shadow: 0 0 8px var(--color-primary-glow);
  animation: agent-edge-travel 2.4s linear infinite;
}

.agent-page__edge--suspended {
  /* Stopped, not animating: a fixed segment at a fixed position. */
  background: linear-gradient(to bottom, transparent 0%, var(--color-warning) 50%, transparent 100%);
  background-size: 100% 200%;
  background-position: 0 30%;
}

.agent-page__edge--halted { background: var(--color-text-muted); }
.agent-page__edge--failed { background: var(--color-error); }

@keyframes agent-edge-travel {
  from { background-position: 0 -100%; }
  to { background-position: 0 100%; }
}

@media (prefers-reduced-motion: reduce) {
  /* Reduced motion removes the travel, never the colour that distinguishes the
     five states (VISUAL-SYSTEM.md §6.10). The static glow stays: it is not
     motion, and it is what marks the channel as live. */
  .agent-page__edge--acting {
    animation: none !important;
    background: var(--color-primary);
  }
}

.agent-page__row {
  /* The conversation column and the Agent tab host are flex siblings. The
     conversation flexes to fill; the tab host takes a fixed share so an open
     tab narrows the conversation rather than overlaying it.
     position: relative anchors the floating ActivityCapsule (top-right). */
  position: relative;
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.agent-page__conversation {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  position: relative;
}
/* When the ActivityCapsule card is open it overlays the transcript's top-right
   corner. The capsule FLOATS over the transcript (same layer as the Composer),
   so the column itself must NOT gain padding — that would expose the column's
   background behind the transcript and break the floating illusion. Instead we
   drive a CSS var (--capsule-inset) that the Transcript folds into its own
   content padding, so the transcript keeps its background and only the text
   shifts left. The var animates, so the shift feels like the conversation
   making room, not a jump. Only when the capsule is the active right surface. */
.agent-page__conversation--capsule-open {
  --capsule-inset: calc(248px + var(--space-3) + var(--space-2));
}

.agent-page__tabs {
  flex: 0 0 38%;
  min-width: 280px;
  max-width: 520px;
}

.agent-page__sessions {
  width: 100%;
  height: 100%;
}
.agent-page__transcript {
  flex: 1 1 auto;
  min-height: 0;
  /* The transcript spans the full column height; the Composer floats over
     its bottom (see .agent-page__composer-anchor). The clearance variables
     are MEASURED, not estimated: AgentPage observes the anchor's real height
     and writes the pixel values here (JS below), because the card's height
     varies — a wrapped toolbar, a grown multi-line input — and the old
     3-row estimate let the transcript tail slide underneath the card. The
     literals below are only the pre-measurement defaults. */
  --composer-clear: calc(var(--row-h) * 3 + var(--space-4));
  --composer-float-h: calc(var(--composer-clear) + 12px);
  /* Bottom fade: only the band that actually sits behind the floating card
     softens out. The band is measured at runtime (--composer-float-h =
     --composer-clear + 24px), so live overlays (livetail pill, jump button)
     that sit above the card render at full opacity instead of fading away. */
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - var(--composer-float-h)), transparent 100%);
  mask-image: linear-gradient(to bottom, #000 calc(100% - var(--composer-float-h)), transparent 100%);
}

/* The Composer + floating approvals dock share this positioning context. The
   Composer is a floating island: absolutely positioned at the bottom-center
   of the conversation column, so the transcript fills the full width behind
   it and there is no horizontal color seam between transcript and composer.
   The card's own elevation (shadow + raised surface) carries it off the
   transcript surface; no divider line. */
.agent-page__composer-anchor {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-seam);
  pointer-events: none;
}
/* The anchor is a click-through scrim; re-enable pointer events on the
   Composer card so the transcript remains scrollable in the gap around the
   floating card. The approval dock re-enables its own pointer events in its
   component styles, so it needs no entry here. */
.agent-page__composer-anchor > :deep(.composer) {
  pointer-events: auto;
}

.agent-page__empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
}

.agent-page__empty-actions {
  display: flex;
  gap: var(--space-2);
}
</style>
