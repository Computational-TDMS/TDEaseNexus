<!--
  ActivityCapsule — the Agent page's right-sidebar collapsed state, as a
  top-right floating island with a local expand/collapse toggle.

  Two layers, kept strictly apart:

    1. THIS capsule — a floating preview. It has a local collapsed↔expanded
       toggle (click the pill). Collapsed it is a compact status badge
       (top-right). Expanded it is a small floating card that summarizes the
       turn, the mode, and the assets — WITHOUT taking any layout width. It
       floats over the conversation, so the conversation reclaims its full
       width while the sidebar is gone.

    2. The sidebar tab host (AgentTabHost) — the viewer. It opens only when the
       user clicks a row that points at real content (a subagent, a file
       file, the plan). THAT is a real layout column that narrows the
       conversation. The capsule is the preview; the tab host is the viewer.

  Position: anchored to the top-right of the conversation column, sitting just
  BELOW the SessionBar row (top = row-h + a small gap) so it never overlaps the
  title. Floats — takes no layout width.
-->
<script setup lang="ts">
import { computed, inject, ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Aim, DataLine, Document as DocumentIcon, List as ListIcon, MoreFilled, ArrowDown, ArrowUp, Tools } from '@element-plus/icons-vue'
import { type TurnHudState } from './TurnHud.vue'
import type { MindsetId } from '@/agent/prompt'
import { useAgentTabsStore } from '@/stores/agentTabs'
import { computeTodoStats, useSessionTodos } from '@/composables/useSessionTodos'
import { useAgentFilesStore } from '@/stores/agentFiles'
import { useSessionRunsStore } from '@/stores/sessionRuns'
import { useSubagentsStore } from '@/stores/subagents'
import { useJobsStore } from '@/stores/jobs'
import { toolActionKey } from '@/utils/tool-identity'
import ToolIcon from './ToolIcon.vue'
import type { AgentChatMessage } from '@/stores/chat-types'

/** The outcome of the last settled turn (null before the first turn). */
type TurnOutcome = 'resolved' | 'blocked' | 'halted' | 'failed' | 'cancelled' | null

const props = defineProps<{
  /** Live turn HUD state, for the turn dot label. */
  hud: TurnHudState
  /** Current mindset (analysis/workflow) — shown at rest so the mode is legible. */
  mindset: MindsetId
  /** Last settled turn's outcome — shown at rest as a small status tag. */
  lastOutcome: TurnOutcome
  /** True while a turn is in-flight. */
  sending: boolean
  /** Whether a turn is suspended waiting on approval. */
  suspended: boolean
  /** Expanded state — controlled by the parent (AgentPage) so it can shift the
   *  transcript aside when the card is open. */
  expanded: boolean
}>()

const emit = defineEmits<{
  'update:expanded': [value: boolean]
  /** Open the floating JobPanel (background shell jobs). */
  'open-jobs': []
}>()

const { t } = useI18n()
const agentTabsStore = useAgentTabsStore()
const agentFilesStore = useAgentFilesStore()
const subagentsStore = useSubagentsStore()
const sessionRunsStore = useSessionRunsStore()
const jobsStore = useJobsStore()

// Plan presence — the capsule shows a todo-count chip when a plan exists.
const messages = inject<Ref<ReadonlyArray<AgentChatMessage>>>('chatMessages', ref([]))
const { todos, completedCount, currentTask } = useSessionTodos(messages)
const hasPlan = computed(() => todos.value.length > 0)
/** The trajectory inspector row appears once the session has at least one turn. */
const hasTurns = computed(() => messages.value.some((message) => message.role === 'user'))

const runningSubagents = computed(() => subagentsStore.runningCount)
/** Settled subagents that still carry a result worth reviewing (returned/blocked).
 *  A cancelled run is user-dismissed, so it does not keep the row alive. */
const settledSubagents = computed(() =>
  subagentsStore.active.filter((r) => r.state === 'returned' || r.state === 'blocked').length,
)
/**
 * The row + pill chip stay alive while ANY subagent is worth a look — running OR
 * settled with a result. Before this, a returned subagent vanished from the
 * capsule the moment it settled, leaving no prompt to review its §6 findings
 * unless the user already knew about Ctrl+Shift+D. Subagents are deliberately
 * treated unlike runs here: a settled run lives on in the Runs history, but a
 * settled subagent's result exists ONLY in the SubagentPanel, so this row is the
 * sole surfaced entry point to it.
 */
const visibleSubagents = computed(() => runningSubagents.value + settledSubagents.value)
const fileCount = computed(() => agentFilesStore.active.length)
const runCount = computed(() => sessionRunsStore.runningCount)
/** Running background jobs (long shell commands started via tdease.job.start). */
const runningJobs = computed(() => jobsStore.runningCount)

/** The runs the capsule lists: ONLY the runs this conversation dispatched
 *  (the sessionRuns store), live first, capped so a long session cannot flood
 *  the floating card. Each row opens the run's REAL page (RunDocument, via an
 *  `agent-run` tab) — runs are workspace data, not subagents, and never route
 *  through the SubagentPanel. */
const visibleRuns = computed(() =>
  [...sessionRunsStore.active]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 6))

/** Drives the count chip in the collapsed pill — every openable asset, including
 *  settled subagents awaiting review, so the chip does not silently drop to 0
 *  the moment the last running subagent returns. */
const assetTotal = computed(() => visibleSubagents.value + fileCount.value + runCount.value + runningJobs.value)

/**
 * The one-line status text in the collapsed pill. Priority (highest first):
 *   1. suspension — the approval gate is its own state (the agent is not
 *      working, the user is deciding; the stale loop phase would lie).
 *   2. currentTask — while working, the spine's in-progress intent says more
 *      than the loop phase ("Editing config" beats "Tools").
 *   3. phase — the generic loop phase when no plan carries an intent.
 * At rest the pill reports OUTCOME, not posture (the mode row in the card
 * already says the posture): a resolved turn names what it produced — the
 * capsule's own Files row is the destination — a blocked/failed turn names
 * the outcome, and the quiet outcomes keep the mindset label.
 */
const pillText = computed(() => {
  if (props.sending) {
    if (props.suspended) return t('agent.hud.awaitingUser')
    if (currentTask.value) return currentTask.value
    return t(`agent.hud.phase.${props.hud.phase}`)
  }
  if (props.lastOutcome === 'resolved') {
    const files = agentFilesStore.active
    if (files.length === 1) return t('agent.activity.pillDoneFile', { name: files[0].name })
    if (files.length > 1) return t('agent.activity.pillDoneFiles', { count: files.length })
    return t('agent.activity.pillDone')
  }
  if (props.lastOutcome === 'blocked' || props.lastOutcome === 'failed') {
    return t(`agent.transcript.outcome.${props.lastOutcome}`)
  }
  return t(`agent.sessionBar.mindset.${props.mindset}`)
})

/**
 * The live row's phase label — same rule as the pill. The activity beside it
 * is named the way the transcript names the tool (the shared action phrase),
 * so the capsule and the tool rows never disagree about what is running.
 */
const phaseText = computed(() =>
  props.suspended ? t('agent.hud.awaitingUser') : t(`agent.hud.phase.${props.hud.phase}`))
const activityText = computed(() => {
  const activity = props.hud.activity
  if (!activity || props.suspended) return ''
  const key = toolActionKey(activity)
  return key ? t(key) : activity
})

// ── Expand/collapse ─────────────────────────────────────────────────────────
// The expanded state is controlled by the parent (AgentPage) so the transcript
// can shift left to make room for the card. This component only emits toggles;
// the auto-expand-on-turn-start logic lives in the parent too.
function toggleExpand() { emit('update:expanded', !props.expanded) }

/**
 * Open a tab in the host — this flips the sidebar from capsule to host. Each
 * content row in the expanded card calls this. Opening the sidebar happens
 * ONLY from a real-content row click (subagent / file / plan), never from a
 * generic "expand" affordance — there is none.
 */
function openTab(kind: 'agent-files' | 'agent-plan' | 'agent-trajectory', label: string) {
  agentTabsStore.open({ kind }, { title: label })
}

// ── Task spine ───────────────────────────────────────────────────────────────
// The spine is the expanded card's single-track vertical timeline of the plan
// (one git-graph rail, nodes = todos). Tool calls are linear, so a branch is
// never rendered as a second track — the in-progress node carries a small
// branch TICK instead, counting the live background runs + subagents, and its
// click reuses the Runs row's own toggle so the two never disagree.
/** Live background work beside the spine's in-progress node. */
const branchCount = computed(() => runCount.value + runningSubagents.value)
/** Every spine node opens the plan viewer — the spine is a preview of the plan. */
function openSpinePlan(): void {
  openTab('agent-plan', t('agent.activity.spineOpenPlan'))
}

/** Per-todo call stats — same single walk as the plan itself (walkPlan). */
const todoStats = computeTodoStats(messages)
/** The spine's render model: each todo plus its right-side call meta — at
 *  most 3 tool-category chips (a sample; the count is the full truth, so
 *  there is no "+n") and the bare call count, rendered only when the todo
 *  actually took calls (>0). Information only: the meta never intercepts the
 *  node row's own open-plan click. */
const spineNodes = computed(() => todos.value.map((todo) => {
  const entry = todoStats.value.get(todo.key)
  return {
    todo,
    meta: entry && entry.calls > 0
      ? { icons: entry.icons.slice(0, 3), calls: entry.calls }
      : null,
  }
}))

// The subagent list lives inline in the capsule (collapsible), not behind a
// floating panel open. Collapsed by default so the resting capsule stays
// compact; expanding lists every active subagent, and each row opens that
// child's full conversation as an `agent-subagent` tab.
const subagentsExpanded = ref(false)
// Same pattern as the subagent list: collapsed inline, expanding lists the
// runs, each row opening the run's real page as an `agent-run` tab.
const runsExpanded = ref(false)

function openSubagentConversation(subagentId: string, role: string): void {
  agentTabsStore.open({ kind: 'agent-subagent', subagentId, role }, { title: role })
}

function openRun(run: { id: string; title: string }): void {
  agentTabsStore.open({ kind: 'agent-run', runId: run.id }, { title: run.title || run.id.slice(0, 10) })
}
</script>

<template>
  <div class="activity-capsule" :class="{ 'is-expanded': expanded }" :aria-label="t('agent.activity.label')">
    <!-- ── Collapsed: compact status badge ── -->
    <button
      v-if="!expanded"
      type="button"
      class="capsule-pill"
      :class="{ 'is-sending': sending, 'is-waiting': suspended }"
      :title="t('agent.activity.expand')"
      :aria-label="t('agent.activity.expand')"
      :aria-expanded="expanded"
      @click="toggleExpand"
    >
      <!-- Status indicator: pulse dot while running, outcome dot at rest. -->
      <span
        class="capsule-pill__indicator"
        :class="sending ? 'capsule-pill__indicator--live' : `capsule-pill__indicator--${lastOutcome ?? 'idle'}`"
        aria-hidden="true"
      />
      <!-- Inline status text. -->
      <span class="capsule-pill__text">{{ pillText }}</span>
      <!-- Asset count chip (if any). -->
      <span v-if="assetTotal > 0" class="capsule-pill__chip mono">{{ assetTotal }}</span>
      <el-icon :size="12" class="capsule-pill__chev" aria-hidden="true"><ArrowDown /></el-icon>
    </button>

    <!-- ── Expanded: floating preview card ── -->
    <div v-else class="capsule-card">
      <header class="capsule-card__header">
        <div class="capsule-card__heading">
          <span
            class="capsule-card__indicator"
            :class="sending ? 'capsule-card__indicator--live' : `capsule-card__indicator--${lastOutcome ?? 'idle'}`"
            aria-hidden="true"
          />
          <span class="capsule-card__title">{{ t('agent.activity.label') }}</span>
        </div>
        <button
          type="button"
          class="capsule-card__close"
          :title="t('agent.activity.collapse')"
          :aria-label="t('agent.activity.collapse')"
          @click="toggleExpand"
        >
          <el-icon :size="12"><ArrowUp /></el-icon>
        </button>
      </header>

      <div class="capsule-card__body">
        <!-- Turn status (while running) — informational, not a viewer entry. -->
        <div
          v-if="sending"
          class="capsule-row capsule-row--live capsule-row--static"
          :class="{ 'is-waiting': suspended }"
          :title="phaseText"
        >
          <span class="capsule-row__icon capsule-row__icon--dot" aria-hidden="true" />
          <span class="capsule-row__label">{{ phaseText }}</span>
          <span v-if="activityText" class="capsule-row__meta">{{ activityText }}</span>
          <span v-if="hud.subject && !suspended" class="capsule-row__meta capsule-row__meta--subject mono" :title="hud.subject">{{ hud.subject }}</span>
          <span v-if="suspended" class="capsule-row__meta capsule-row__meta--warn">{{ t('agent.hud.waiting') }}</span>
        </div>

        <!-- Task spine — single-track vertical timeline of the plan (git-graph
             rail). completed = filled dot + muted text; in_progress = larger
             pulsing dot + activeForm in the main text colour (the "current
             intent" row) + a branch tick when background work is live;
             pending = hollow dot. Every node opens the plan viewer. Removed
             entirely while no plan exists, so plan-less sessions stay clean. -->
        <div v-if="todos.length > 0" class="capsule-spine" :aria-label="t('agent.activity.spineTitle')">
          <p class="capsule-spine__title">{{ t('agent.activity.spineTitle') }}</p>
          <ul class="capsule-spine__list">
            <li v-for="{ todo, meta } in spineNodes" :key="todo.key" class="capsule-spine__item" :class="`is-${todo.status}`">
              <button
                type="button"
                class="capsule-spine__node"
                :title="t('agent.activity.spineOpenPlan')"
                :aria-label="`${t('agent.activity.spineOpenPlan')}: ${todo.activeForm || todo.content}`"
                @click="openSpinePlan()"
              >
                <span class="capsule-spine__dot" aria-hidden="true" />
                <span class="capsule-spine__text">
                  {{ todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content }}
                </span>
              </button>
              <!-- Branch tick — only on the in-progress node, only while
                   background runs/subagents are live. Same click as the Runs
                   row: it toggles the inline run list open. -->
              <button
                v-if="todo.status === 'in_progress' && branchCount > 0"
                type="button"
                class="capsule-spine__branch mono"
                :title="t('agent.activity.spineBranch', { count: branchCount })"
                :aria-label="t('agent.activity.spineBranch', { count: branchCount })"
                @click="runsExpanded = !runsExpanded"
              >
                {{ t('agent.activity.spineBranch', { count: branchCount }) }}
              </button>
              <!-- Call meta — the node's at-a-glance of the work it took: up
                   to 3 tool-category chips + the full call count. Not a
                   control: clicks pass through (pointer-events: none), the
                   node row keeps its open-plan click. -->
              <span
                v-if="meta"
                class="capsule-spine__meta"
                :title="t('agent.activity.spineCalls', { count: meta.calls })"
                :aria-label="t('agent.activity.spineCalls', { count: meta.calls })"
              >
                <span v-for="icon in meta.icons" :key="icon" class="capsule-spine__meta-chip" aria-hidden="true">
                  <ToolIcon :name="icon" />
                </span>
                <span class="capsule-spine__meta-count mono" aria-hidden="true">{{ meta.calls }}</span>
              </span>
            </li>
          </ul>
        </div>

        <!-- Mode (informational). -->
        <div class="capsule-row capsule-row--static">
          <span class="capsule-row__icon" aria-hidden="true"><MoreFilled /></span>
          <span class="capsule-row__label">{{ t('agent.sessionBar.mindsetLabel') }}</span>
          <span class="capsule-row__value">{{ t(`agent.sessionBar.mindset.${mindset}`) }}</span>
        </div>

        <!-- Last outcome (at rest). -->
        <div v-if="!sending && lastOutcome" class="capsule-row capsule-row--static">
          <span class="capsule-row__icon" aria-hidden="true">
            <span class="capsule-row__status-dot" :class="`capsule-row__status-dot--${lastOutcome}`" />
          </span>
          <span class="capsule-row__label">{{ t('agent.transcript.outcomeLabel') }}</span>
          <span class="capsule-row__value" :class="`capsule-row__value--${lastOutcome}`">{{ t(`agent.transcript.outcome.${lastOutcome}`) }}</span>
        </div>

        <!-- Trajectory inspector → the session's atoms as one row per turn
             (prompt, requests with their digest chain, tool calls, settlement). -->
        <button
          v-if="hasTurns"
          type="button"
          class="capsule-row"
          :title="t('agent.activity.viewTrajectory')"
          @click="openTab('agent-trajectory', t('agent.activity.viewTrajectory'))"
        >
          <el-icon :size="14" class="capsule-row__icon" aria-hidden="true"><DataLine /></el-icon>
          <span class="capsule-row__label">{{ t('agent.activity.viewTrajectory') }}</span>
        </button>

        <!-- Divider before asset rows. -->
        <div v-if="hasPlan || hasTurns || visibleSubagents > 0 || fileCount > 0 || visibleRuns.length > 0" class="capsule-card__divider" />

        <!-- Plan progress → opens plan viewer. -->
        <button
          v-if="hasPlan"
          type="button"
          class="capsule-row"
          :title="t('agent.activity.viewPlan')"
          @click="openTab('agent-plan', t('agent.activity.viewPlan'))"
        >
          <el-icon :size="14" class="capsule-row__icon" aria-hidden="true"><ListIcon /></el-icon>
          <span class="capsule-row__label">{{ t('agent.activity.viewPlan') }}</span>
          <span class="capsule-row__value mono">{{ completedCount }}/{{ todos.length }}</span>
        </button>

        <!-- Subagents → an inline, collapsible list (not a floating panel). The
             header row toggles the list; each child row opens that subagent's
             full conversation as an `agent-subagent` tab. The row stays visible
             while any subagent is worth a look: running (bold count) OR settled
             with a result (green count = "findings ready to review"). Cancelled
             runs are dismissed and do not keep the row alive. -->
        <button
          v-if="visibleSubagents > 0"
          type="button"
          class="capsule-row"
          :title="t('agent.activity.viewSubagents')"
          :aria-expanded="subagentsExpanded"
          @click="subagentsExpanded = !subagentsExpanded"
        >
          <el-icon :size="14" class="capsule-row__icon" aria-hidden="true"><Aim /></el-icon>
          <span class="capsule-row__label">{{ t('agent.activity.viewSubagents') }}</span>
          <span v-if="runningSubagents > 0" class="capsule-row__value mono">{{ runningSubagents }}</span>
          <span v-else class="capsule-row__value mono capsule-row__value--settled">{{ settledSubagents }}</span>
          <span class="capsule-row__chev" :class="{ 'is-open': subagentsExpanded }" aria-hidden="true">
            <el-icon :size="12"><ArrowDown /></el-icon>
          </span>
        </button>

        <!-- Inline subagent list (expanded). One compact row per active child;
             click opens its conversation tab. The capsule floats and grows
             downward, so a longer list does not displace the transcript. -->
        <div v-if="subagentsExpanded && visibleSubagents > 0" class="capsule-subagents">
          <button
            v-for="r in subagentsStore.active"
            v-show="r.state === 'running' || r.state === 'returned' || r.state === 'blocked'"
            :key="r.subagentId"
            type="button"
            class="capsule-subagent"
            :class="`is-${r.state}`"
            :title="r.role"
            @click="openSubagentConversation(r.subagentId, r.role)"
          >
            <span class="capsule-subagent__dot" aria-hidden="true" />
            <span class="capsule-subagent__role">{{ r.role }}</span>
            <span class="capsule-subagent__state">{{ r.state }}</span>
          </button>
        </div>

        <!-- Background jobs → opens the floating JobPanel. Visible while any
             background shell job is running or recently settled. -->
        <button
          v-if="runningJobs > 0 || jobsStore.active.length > 0"
          type="button"
          class="capsule-row"
          :title="t('agent.activity.viewJobs')"
          @click="emit('open-jobs')"
        >
          <el-icon :size="14" class="capsule-row__icon" aria-hidden="true"><Tools /></el-icon>
          <span class="capsule-row__label">{{ t('agent.activity.viewJobs') }}</span>
          <span class="capsule-row__value mono">{{ runningJobs }}</span>
        </button>

        <!-- Files → opens files viewer. -->
        <button
          v-if="fileCount > 0"
          type="button"
          class="capsule-row"
          :title="t('agent.activity.viewFiles')"
          @click="openTab('agent-files', t('agent.activity.viewFiles'))"
        >
          <el-icon :size="14" class="capsule-row__icon" aria-hidden="true"><DocumentIcon /></el-icon>
          <span class="capsule-row__label">{{ t('agent.activity.viewFiles') }}</span>
          <span class="capsule-row__value mono">{{ fileCount }}</span>
        </button>

        <!-- Runs → an inline, collapsible list (same pattern as subagents);
             each row opens that run's real page (RunDocument) as an
             `agent-run` tab. Runs are workspace data — they never route
             through the SubagentPanel. -->
        <button
          v-if="visibleRuns.length > 0"
          type="button"
          class="capsule-row"
          :title="t('agent.activity.viewRuns')"
          :aria-expanded="runsExpanded"
          @click="runsExpanded = !runsExpanded"
        >
          <span class="capsule-row__icon capsule-row__icon--run" aria-hidden="true">◎</span>
          <span class="capsule-row__label">{{ t('agent.activity.viewRuns') }}</span>
          <span v-if="runCount > 0" class="capsule-row__value mono">{{ runCount }}</span>
          <span class="capsule-row__chev" :class="{ 'is-open': runsExpanded }" aria-hidden="true">
            <el-icon :size="12"><ArrowDown /></el-icon>
          </span>
        </button>

        <!-- Inline run list (expanded). -->
        <div v-if="runsExpanded && visibleRuns.length > 0" class="capsule-subagents">
          <button
            v-for="run in visibleRuns"
            :key="run.id"
            type="button"
            class="capsule-subagent"
            :class="{ 'is-running': run.status === 'RUNNING' }"
            :title="run.title || run.id"
            @click="openRun(run)"
          >
            <span class="capsule-subagent__dot" aria-hidden="true" />
            <span class="capsule-subagent__role">{{ run.title || run.id.slice(0, 10) }}</span>
            <span class="capsule-subagent__state">{{ run.status.toLowerCase() }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.activity-capsule {
  /* Anchored to the top-right of the conversation area, sitting just below the
     SessionBar row (top = row-h + gap) so it never overlaps the title bar.
     Floats — takes no layout width. */
  position: absolute;
  right: var(--space-3);
  top: calc(var(--header-h) + var(--space-2));
  z-index: var(--z-elevated);
  pointer-events: auto;
}

/* ════════════════════════════════════════════════════════════════════════
   Collapsed — compact pill (Dynamic-Island style)
   ════════════════════════════════════════════════════════════════════════ */
.capsule-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  height: 28px;
  padding: 0 var(--space-1-5) 0 var(--space-2);
  border: none;
  /* Floating capsule: --radius-lg on a 28px control reads fully rounded without the banned 999px pill. */
  border-radius: var(--radius-lg);
  background: var(--elev-2-bg);
  box-shadow: var(--elev-2);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-label);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: box-shadow var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out);
}
.capsule-pill:hover {
  box-shadow: var(--elev-2), 0 0 0 1px var(--color-border-panel);
}
.capsule-pill:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}
.capsule-pill.is-sending {
  background: color-mix(in srgb, var(--color-live) 12%, var(--elev-2-bg));
}
.capsule-pill.is-waiting {
  background: color-mix(in srgb, var(--color-warning) 12%, var(--elev-2-bg));
}

/* A settled file name rides in this span, so it needs a ceiling — the pill
   stays a badge, never a path viewer (the full path lives in the Files row). */
.capsule-pill__text {
  line-height: 1;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.capsule-pill__chev { opacity: 0.4; flex-shrink: 0; }

/* Asset count chip — a tiny rounded counter. */
.capsule-pill__chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--color-primary) 18%, transparent);
  color: var(--color-primary);
  font-size: var(--text-label);
  font-weight: 600;
  line-height: 1;
}

/* Status indicator dot — the heart of the pill. Pulses while live; static
   coloured dot at rest reflecting the last turn's outcome. */
.capsule-pill__indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-text-muted);
}
.capsule-pill__indicator--live {
  background: var(--color-primary);
  box-shadow: 0 0 0 0 var(--color-primary-glow);
  animation: capsule-pulse 1.6s var(--ease-inout) infinite;
}
.capsule-pill__indicator--resolved { background: var(--color-success); }
.capsule-pill__indicator--blocked  { background: var(--color-warning); }
.capsule-pill__indicator--failed   { background: var(--color-error); }
.capsule-pill__indicator--halted,
.capsule-pill__indicator--cancelled,
.capsule-pill__indicator--idle     { background: var(--color-text-muted); }

@keyframes capsule-pulse {
  0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-primary) 60%, transparent); }
  70%  { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}

/* ════════════════════════════════════════════════════════════════════════
   Expanded — floating preview card
   ════════════════════════════════════════════════════════════════════════ */
.capsule-card {
  display: flex;
  flex-direction: column;
  width: 248px;
  border-radius: var(--radius-lg);
  background: var(--elev-2-bg);
  box-shadow: var(--elev-2);
  overflow: hidden;
  animation: capsule-card-in var(--dur-fast) var(--ease-out);
}
/* Integer-pixel motion only — a fractional scale(0.98) rasterizes the card's
   text at 0.98× on its composited layer and reads blurry. */
@keyframes capsule-card-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

.capsule-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) var(--space-2) var(--space-1-5);
}
.capsule-card__heading {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
}
.capsule-card__title {
  font-size: var(--text-label);
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.6px;
}
.capsule-card__indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-text-muted);
}
.capsule-card__indicator--live {
  background: var(--color-primary);
  animation: capsule-pulse 1.6s var(--ease-inout) infinite;
}
.capsule-card__indicator--resolved { background: var(--color-success); }
.capsule-card__indicator--blocked  { background: var(--color-warning); }
.capsule-card__indicator--failed   { background: var(--color-error); }
.capsule-card__indicator--halted,
.capsule-card__indicator--cancelled,
.capsule-card__indicator--idle     { background: var(--color-text-muted); }

.capsule-card__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.capsule-card__close:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.capsule-card__close:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 1px;
}

.capsule-card__body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: var(--space-1) var(--space-1);
}

.capsule-card__divider {
  height: var(--line-w);
  margin: var(--space-1) var(--space-1);
  background: var(--line-seam);
}

/* ── Rows ── */
.capsule-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 7px var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--dur-instant) var(--ease-out);
}
.capsule-row:hover:not(.capsule-row--static) {
  background: var(--color-bg-hover);
}
.capsule-row:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: -1px;
}
.capsule-row--static { cursor: default; }

.capsule-row__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: 13px;
  line-height: 1;
}
.capsule-row__icon--dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-primary);
  animation: capsule-pulse 1.6s var(--ease-inout) infinite;
}
.capsule-row--live.is-waiting .capsule-row__icon--dot {
  background: var(--color-warning);
  animation: none;
}
.capsule-row__icon--resolved { color: var(--color-success); }
.capsule-row__icon--blocked  { color: var(--color-warning-text); }
.capsule-row__icon--failed   { color: var(--color-error-text); }
.capsule-row__icon--halted,
.capsule-row__icon--cancelled,
.capsule-row__icon--run      { color: var(--color-text-muted); }

/* Outcome glyph at rest: the same 8px dot language as the live row above,
   outcome-tinted and static — one glyph vocabulary per column. */
.capsule-row__status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}
.capsule-row__status-dot--resolved { color: var(--color-success); }
.capsule-row__status-dot--blocked  { color: var(--color-warning-text); }
.capsule-row__status-dot--failed   { color: var(--color-error-text); }
.capsule-row__status-dot--halted,
.capsule-row__status-dot--cancelled { color: var(--color-text-muted); }

.capsule-row__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
}
.capsule-row__value {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--color-text);
}
.capsule-row__value--resolved { color: var(--color-success); }
/* A settled subagent (returned/blocked) carries a §6 result worth reviewing —
   green reads "findings ready", distinct from the live bold count. */
.capsule-row__value--settled  { color: var(--color-success); }
.capsule-row__value--blocked  { color: var(--color-warning-text); }
.capsule-row__value--failed   { color: var(--color-error-text); }
.capsule-row__value--halted,
.capsule-row__value--cancelled { color: var(--color-text-muted); }
.capsule-row__meta {
  flex-shrink: 0;
  font-size: var(--text-label);
  color: var(--color-text-muted);
}
/* The tool subject: content, not a count — cut it, don't push the row wide. */
.capsule-row__meta--subject {
  min-width: 0;
  max-width: 14ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.capsule-row__meta--warn { color: var(--color-warning-text); }

/* Chevron on the collapsible subagent header — rotates 90°→0° on expand, the
   same rotating-glyph language as SubAgentCard's fold indicator. */
.capsule-row__chev {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--color-text-muted);
  opacity: 0.6;
  transform: rotate(-90deg);
  transition: transform var(--dur-fast) var(--ease-out);
}
.capsule-row__chev.is-open { transform: rotate(0deg); }

/* Inline subagent list — nested one level under the capsule-card body, each row
   indented slightly so it reads as a child of the Subagents header. Compact:
   state dot + truncated role + state tag. */
.capsule-subagents {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 var(--space-1);
  /* auto-animate handles the header; this list mounts/unmounts as a block. */
}
.capsule-subagent {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  width: 100%;
  padding: 5px var(--space-2) 5px var(--space-4);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-label);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--dur-instant) var(--ease-out);
}
.capsule-subagent:hover { background: var(--color-bg-hover); }
.capsule-subagent:focus-visible { outline: 2px solid var(--color-ring); outline-offset: -1px; }
.capsule-subagent__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-text-muted);
}
.capsule-subagent.is-running .capsule-subagent__dot {
  background: var(--color-primary);
  box-shadow: 0 0 0 0 var(--color-primary-glow);
  animation: capsule-pulse 1.6s var(--ease-inout) infinite;
}
.capsule-subagent.is-returned .capsule-subagent__dot { background: var(--color-success); }
.capsule-subagent.is-blocked .capsule-subagent__dot { background: var(--color-warning); }
.capsule-subagent__role {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}
.capsule-subagent__state {
  flex-shrink: 0;
  font-size: var(--text-label);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

/* ── Task spine — single-track vertical timeline of the plan ──
   One 2px rail (git-graph style); every item owns its rail segment via
   ::before so the line starts at the first dot's centre and ends at the
   last one's. Dots ride the rail: completed = filled success dot, in_progress
   = larger pulsing primary dot, pending = hollow. The dot's outer box is a
   fixed 10px square with the visual circle drawn by ::after — that keeps
   every dot centred on the same axis regardless of its visual size. */
.capsule-spine {
  padding: var(--space-1) var(--space-2) var(--space-1);
  animation: capsule-spine-in var(--dur-fast) var(--ease-out);
}
@keyframes capsule-spine-in {
  from { opacity: 0; transform: translateY(-2px); }
  to   { opacity: 1; transform: translateY(0); }
}
.capsule-spine__title {
  margin: 0 0 var(--space-1);
  font-size: var(--text-label);
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.6px;
}
.capsule-spine__list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.capsule-spine__item {
  position: relative;
  display: flex;
  align-items: center;
}
/* The rail segment — 2px, centred under the dots (dot centre x = 7px). */
.capsule-spine__item::before {
  content: '';
  position: absolute;
  left: 6px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--color-border);
}
.capsule-spine__item:first-child::before { top: 11px; }
.capsule-spine__item:last-child::before { bottom: calc(100% - 11px); }

.capsule-spine__node {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  margin-left: 2px;
  padding: 5px var(--space-1);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  font-size: var(--text-label);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--dur-instant) var(--ease-out);
}
.capsule-spine__node:hover { background: var(--color-bg-hover); }
.capsule-spine__node:focus-visible { outline: 2px solid var(--color-ring); outline-offset: -1px; }

/* Fixed 10px outer box; visual circle via ::after so all dots share one axis. */
.capsule-spine__dot {
  position: relative;
  width: 10px;
  height: 10px;
  flex-shrink: 0;
}
.capsule-spine__dot::after {
  content: '';
  position: absolute;
  inset: 1px;
  box-sizing: border-box;
  border-radius: 50%;
  background: var(--color-border);
}
.is-completed .capsule-spine__dot::after { background: var(--color-success); }
.is-pending .capsule-spine__dot::after {
  background: transparent;
  border: 1.5px solid var(--color-text-muted);
}
.is-in_progress .capsule-spine__dot::after {
  inset: 0;
  background: var(--color-primary);
  animation: capsule-pulse 1.6s var(--ease-inout) infinite;
}

.capsule-spine__text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The current-intent row: activeForm in the main text colour, slightly
   weighted, so it reads as "what the agent is doing right now". */
.is-in_progress .capsule-spine__text {
  color: var(--color-text);
  font-weight: 600;
}

/* Branch tick — hangs beside the in-progress node while background runs /
   subagents are live. Information only: a tick, not a second track. */
.capsule-spine__branch {
  flex-shrink: 0;
  margin-right: var(--space-1);
  padding: 1px var(--space-1-5);
  border: none;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  color: var(--color-text-muted);
  font-size: var(--text-label);
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.capsule-spine__branch:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.capsule-spine__branch:focus-visible { outline: 2px solid var(--color-ring); outline-offset: 1px; }

/* Call meta — the node's right-side chips + count. Information only: the
   whole meta is pointer-transparent so the node row's open-plan click keeps
   the full row. No animation, so reduced-motion needs nothing here. */
.capsule-spine__meta {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  margin-right: var(--space-1);
  pointer-events: none;
}
/* A category chip: a small rounded square, neutral tint, quiet glyph.
   Icon box snaps to 12px with stroke-width 2 → exactly 1 rendered stroke px
   at DPR 1 (12/24 viewBox scale × 2); 10px/1.75 was 0.73px = fuzzy. */
.capsule-spine__meta-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-text-muted) 12%, transparent);
  color: var(--color-text-muted);
}
.capsule-spine__meta-chip :deep(.tool-icon) {
  width: 12px;
  height: 12px;
  stroke-width: 2;
}
.capsule-spine__meta-count {
  font-size: var(--text-label);
  color: var(--color-text-muted);
}

@media (prefers-reduced-motion: reduce) {
  .capsule-pill__indicator--live,
  .capsule-row__icon--dot,
  .capsule-card__indicator--live,
  .is-in_progress .capsule-spine__dot::after { animation: none; }
  .capsule-card,
  .capsule-spine { animation: none; }
  .capsule-pill,
  .capsule-card__close,
  .capsule-row,
  .capsule-spine__node,
  .capsule-spine__branch { transition: none; }
}
</style>
