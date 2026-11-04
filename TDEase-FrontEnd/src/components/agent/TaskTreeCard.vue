<!--
  TaskTreeCard — the session plan as a tree, in the transcript flow.

  Nodes are the plan's todos (the latest applied `todo_write`, via
  `useSessionTodos`); each node's branches are what its work PRODUCED —
  runs, subagents, background jobs, written files, opened views — read by
  the same single `walkPlan` pass that attributes tool calls to todos. There
  is no second data model: a branch exists exactly when a producing tool row
  exists in the transcript, and its live state comes from the owning store
  (sessionRuns / subagents), never from the card.

  The card is the default face of the Agent's work: with reasoning hidden
  (Settings → Appearance, or the toggle in this header) every act folds its
  thinking and raw tool calls behind one line, and progress reads here.
-->
<script setup lang="ts">
import { computed, inject, ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check } from '@element-plus/icons-vue'
import { Activity, Eye, EyeOff, FileText, PanelsTopLeft, Play, Sparkles } from '@lucide/vue'
import ToolIcon from './ToolIcon.vue'
import { computeTodoStats, useSessionTodos, type TodoProduct } from '@/composables/useSessionTodos'
import { useSessionRunsStore } from '@/stores/sessionRuns'
import { useSubagentsStore } from '@/stores/subagents'
import { useAgentTabsStore } from '@/stores/agentTabs'
import { useSettingsStore } from '@/stores/settings'
import { classifyKind, type AgentFileKind } from '@/stores/agentFiles'
import type { AgentChatMessage } from '@/stores/chat-types'
import type { RunStatus } from '@/studio/domain/run'
import type { SubagentState } from '@/studio/commands/registry'

// Static key maps (the i18n gate audits literal keys; no concatenation).
const RUN_STATUS_KEY: Record<RunStatus, string> = {
  QUEUED: 'agent.taskTree.runStatus.QUEUED',
  RUNNING: 'agent.taskTree.runStatus.RUNNING',
  SUCCEEDED: 'agent.taskTree.runStatus.SUCCEEDED',
  FAILED: 'agent.taskTree.runStatus.FAILED',
  CANCELLED: 'agent.taskTree.runStatus.CANCELLED',
}
const SUBAGENT_STATE_KEY: Record<SubagentState, string> = {
  running: 'agent.taskTree.subagentState.running',
  returned: 'agent.taskTree.subagentState.returned',
  blocked: 'agent.taskTree.subagentState.blocked',
  cancelled: 'agent.taskTree.subagentState.cancelled',
}

const emit = defineEmits<{
  'open-file': [file: { path: string; kind: AgentFileKind; name: string }]
}>()

const { t } = useI18n()
const messages = inject<Ref<ReadonlyArray<AgentChatMessage>>>('chatMessages', ref([]))
const { todos, completedCount } = useSessionTodos(messages)
const stats = computeTodoStats(messages)
const sessionRuns = useSessionRunsStore()
const subagents = useSubagentsStore()
const agentTabs = useAgentTabsStore()
const settings = useSettingsStore()

const collapsed = ref(false)

type BranchState = 'live' | 'done' | 'failed' | 'idle'
interface Branch {
  key: string
  icon: typeof Play
  label: string
  detail?: string
  state: BranchState
  open?: () => void
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function branchOf(product: TodoProduct): Branch {
  switch (product.kind) {
    case 'run': {
      const run = sessionRuns.active.find((r) => r.id === product.runId)
      const status = run?.status
      const state: BranchState = status === 'RUNNING' || status === 'QUEUED' ? 'live'
        : status === 'SUCCEEDED' ? 'done'
          : status === 'FAILED' || status === 'CANCELLED' ? 'failed' : 'idle'
      const title = run?.title || product.runId.slice(0, 12)
      return {
        key: `run:${product.runId}`, icon: Play, label: title,
        detail: status ? t(RUN_STATUS_KEY[status]) : undefined,
        state,
        open: () => agentTabs.open({ kind: 'agent-run', runId: product.runId }, { title }),
      }
    }
    case 'subagent': {
      const record = product.subagentId
        ? subagents.byId(product.subagentId)
        : subagents.active.find((r) => r.role === product.role)
      const state: BranchState = record?.state === 'running' ? 'live'
        : record?.state === 'returned' ? 'done'
          : record?.state === 'blocked' ? 'failed' : 'idle'
      return {
        key: `sub:${product.callId}`, icon: Sparkles, label: product.role,
        detail: record ? t(SUBAGENT_STATE_KEY[record.state]) : undefined,
        state,
        open: record ? () => agentTabs.open({ kind: 'agent-subagent', subagentId: record.subagentId, role: record.role }, { title: record.role }) : undefined,
      }
    }
    case 'job':
      return { key: `job:${product.callId}`, icon: Activity, label: product.command, state: 'idle' }
    case 'file':
      return {
        key: `file:${product.path}`, icon: FileText, label: basename(product.path), detail: product.path, state: 'done',
        open: () => emit('open-file', { path: product.path, kind: classifyKind(product.path), name: basename(product.path) }),
      }
    case 'view':
      return {
        key: `view:${product.path}`, icon: PanelsTopLeft, label: basename(product.path),
        detail: product.viewer ? t('agent.taskTree.openedIn', { viewer: product.viewer }) : t('agent.taskTree.opened'),
        state: 'done',
        open: () => emit('open-file', { path: product.path, kind: classifyKind(product.path), name: basename(product.path) }),
      }
  }
}

const nodes = computed(() => todos.value.map((todo) => {
  const entry = stats.value.get(todo.key)
  return {
    todo,
    label: todo.status === 'in_progress' ? todo.activeForm : todo.content,
    icons: entry?.icons.slice(0, 3) ?? [],
    calls: entry?.calls ?? 0,
    branches: (entry?.products ?? []).map(branchOf),
  }
}))

const progress = computed(() => todos.value.length ? completedCount.value / todos.value.length : 0)
const allDone = computed(() => todos.value.length > 0 && completedCount.value === todos.value.length)

function toggleReasoning(): void {
  settings.setShowReasoning(!settings.showReasoning)
}
</script>

<template>
  <section v-if="todos.length" class="task-tree" :class="{ 'is-done': allDone }" :aria-label="t('agent.taskTree.ariaLabel')">
    <header class="task-tree__head">
      <button class="task-tree__title" type="button" :aria-expanded="!collapsed" @click="collapsed = !collapsed">
        <span class="task-tree__ring" :style="{ '--p': progress }" aria-hidden="true" />
        <span class="task-tree__name">{{ t('agent.taskTree.title') }}</span>
        <span class="task-tree__count num">{{ completedCount }}/{{ todos.length }}</span>
      </button>
      <button
        class="task-tree__reasoning"
        type="button"
        :aria-pressed="settings.showReasoning"
        :title="t(settings.showReasoning ? 'agent.taskTree.hideReasoning' : 'agent.taskTree.showReasoning')"
        @click="toggleReasoning"
      >
        <component :is="settings.showReasoning ? EyeOff : Eye" :size="14" :stroke-width="1.75" aria-hidden="true" />
        <span>{{ t(settings.showReasoning ? 'agent.taskTree.hideReasoning' : 'agent.taskTree.showReasoning') }}</span>
      </button>
    </header>

    <ol v-show="!collapsed" class="task-tree__nodes">
      <li
        v-for="(node, index) in nodes"
        :key="node.todo.key"
        class="tnode"
        :class="[`is-${node.todo.status}`, { 'is-last': index === nodes.length - 1 }]"
      >
        <div class="tnode__row">
          <span class="tnode__mark" aria-hidden="true">
            <el-icon v-if="node.todo.status === 'completed'" :size="10"><Check /></el-icon>
          </span>
          <span class="tnode__label">{{ node.label }}</span>
          <span v-if="node.calls > 0" class="tnode__meta" :title="t('agent.activity.spineCalls', { count: node.calls })">
            <span v-for="icon in node.icons" :key="icon" class="tnode__chip"><ToolIcon :name="icon" /></span>
            <span class="num">{{ node.calls }}</span>
          </span>
        </div>
        <ul v-if="node.branches.length" class="tnode__branches">
          <li v-for="branch in node.branches" :key="branch.key" class="tbranch" :class="`is-${branch.state}`">
            <component
              :is="branch.open ? 'button' : 'div'"
              class="tbranch__row"
              :type="branch.open ? 'button' : undefined"
              :title="branch.detail"
              @click="branch.open?.()"
            >
              <component :is="branch.icon" class="tbranch__icon" :size="14" :stroke-width="1.75" aria-hidden="true" />
              <span class="tbranch__label">{{ branch.label }}</span>
              <span v-if="branch.detail" class="tbranch__detail">{{ branch.detail }}</span>
              <span class="tbranch__dot" aria-hidden="true" />
            </component>
          </li>
        </ul>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.task-tree {
  border-radius: var(--radius-md);
  background: var(--color-bg);
  padding: var(--space-2) var(--space-3) var(--space-2);
}
.task-tree__head { display: flex; align-items: center; gap: var(--space-2); }
.task-tree__title {
  display: inline-flex; align-items: center; gap: var(--space-2);
  border: 0; background: none; padding: 2px 0; font: inherit; color: var(--color-text); cursor: pointer;
}
.task-tree__name { font-size: var(--text-sm); font-weight: 600; }
.task-tree__count { font-size: var(--text-sm); color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
.task-tree__ring {
  width: 14px; height: 14px; border-radius: 50%;
  background: conic-gradient(var(--color-live) calc(var(--p) * 360deg), var(--color-border) 0);
  mask: radial-gradient(circle, transparent 4px, #000 4.5px);
  transition: background var(--dur-normal) var(--ease-out);
}
.task-tree.is-done .task-tree__ring { background: var(--status-succeeded); }
.task-tree__reasoning {
  margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
  border: 0; background: none; padding: 3px 8px; border-radius: var(--radius-sm);
  font: inherit; font-size: var(--text-label); color: var(--color-text-muted); cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.task-tree__reasoning:hover { background: var(--color-hover); color: var(--color-text); }

.task-tree__nodes { list-style: none; margin: var(--space-2) 0 0; padding: 0; }

/* One rail: each node draws the segment down to the next node. */
.tnode { position: relative; padding-left: 22px; }
.tnode::before {
  content: ''; position: absolute; left: 6px; top: 16px; bottom: -4px; width: 2px;
  background: var(--color-border);
}
.tnode.is-completed::before { background: color-mix(in srgb, var(--status-succeeded) 55%, transparent); }
.tnode.is-last::before { display: none; }

.tnode__row { display: flex; align-items: center; gap: var(--space-2); min-height: 30px; }
.tnode__mark {
  position: absolute; left: 0; top: 8px; width: 14px; height: 14px; border-radius: 50%;
  display: grid; place-items: center; color: var(--color-on-primary);
  border: 2px solid var(--color-border-panel-strong); background: var(--color-bg-card);
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.tnode.is-completed .tnode__mark { background: var(--status-succeeded); border-color: var(--status-succeeded); }
.tnode.is-in_progress .tnode__mark {
  background: var(--status-running); border-color: var(--status-running);
  animation: tnode-breathe 2.2s var(--ease-inout) infinite;
}
@keyframes tnode-breathe {
  0%, 100% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--status-running) 18%, transparent); }
  50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--status-running) 10%, transparent); }
}
.tnode__label { font-size: var(--text-sm); color: var(--color-text-muted); min-width: 0; }
.tnode.is-in_progress .tnode__label { color: var(--color-text); }
.tnode.is-completed .tnode__label { color: var(--color-text-secondary); }
.tnode__meta {
  margin-left: auto; display: inline-flex; align-items: center; gap: 4px;
  font-size: var(--text-label); color: var(--color-text-muted); pointer-events: none;
}
.tnode__chip {
  display: grid; place-items: center; width: 20px; height: 20px; border-radius: 6px;
  background: var(--color-hover);
}

/* Branches: elbow connectors off the node, one per produced thing. */
.tnode__branches { list-style: none; margin: 0 0 var(--space-1); padding: 0; }
.tbranch { position: relative; padding-left: 18px; }
.tbranch::before {
  content: ''; position: absolute; left: 4px; top: -4px; height: 18px; width: 10px;
  border-left: 1.5px solid var(--color-border); border-bottom: 1.5px solid var(--color-border);
  border-bottom-left-radius: 6px;
}
.tbranch__row {
  display: flex; align-items: center; gap: 6px; width: 100%; min-height: 26px;
  border: 0; background: none; padding: 2px 8px; border-radius: var(--radius-sm);
  font: inherit; font-size: var(--text-label); color: var(--color-text-secondary); text-align: left;
}
button.tbranch__row { cursor: pointer; transition: background var(--dur-fast) var(--ease-out); }
button.tbranch__row:hover { background: var(--color-hover); }
.tbranch__icon { flex: none; color: var(--color-text-muted); }
.tbranch__label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.tbranch__detail { color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.tbranch__dot { margin-left: auto; flex: none; width: 7px; height: 7px; border-radius: 50%; background: transparent; }
.tbranch.is-live .tbranch__dot { background: var(--status-running); animation: tnode-breathe 2.2s var(--ease-inout) infinite; }
.tbranch.is-done .tbranch__dot { background: var(--status-succeeded); }
.tbranch.is-failed .tbranch__dot { background: var(--status-failed); }

@media (prefers-reduced-motion: reduce) {
  .tnode.is-in_progress .tnode__mark, .tbranch.is-live .tbranch__dot { animation: none; }
}
</style>
