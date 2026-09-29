<!--
  AgentTabStrip — the tab bar for the Agent page's right sidebar.

  A deliberately minimal version of `DocumentTabs`: no pinned/preview tiers,
  no dirty dot, no overflow menu (the Agent sidebar holds a few short-lived
  tabs, not a document editing surface). Each tab is a title + a close button;
  the active tab is marked; the ARIA tabs keyboard pattern (roving focus,
  Arrow/Home/End) is preserved from DocumentTabs.
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Close } from '@element-plus/icons-vue'
import IconButton from '@/components/primitives/IconButton.vue'
import { useAgentTabsStore } from '@/stores/agentTabs'
import { useSubagentsStore } from '@/stores/subagents'
import { vAutoAnimate } from '@formkit/auto-animate/vue'

const emit = defineEmits<{ 'open-subagents': [] }>()

const { t } = useI18n()
const tabsStore = useAgentTabsStore()
const subagentsStore = useSubagentsStore()

// A running/settled subagent is worth surfacing even while the user is browsing
// tabs — the ActivityCapsule (which carries the subagent row) is the tab host's
// v-else, so it is hidden whenever any tab is open. This trailing badge is the
// always-reachable entry point to the SubagentPanel while tabs cover the capsule.
// Visible while any subagent is running (live count) OR settled with a result
// worth reviewing (returned/blocked). Cancelled runs are dismissed, mirroring
// the capsule's own visibility rule.
const runningSubagents = computed(() => subagentsStore.runningCount)
const settledSubagents = computed(() =>
  subagentsStore.active.filter((r) => r.state === 'returned' || r.state === 'blocked').length,
)
const subagentTotal = computed(() => runningSubagents.value + settledSubagents.value)

// auto-animate: tabs slide in/out as they open/close. Duration/easing match
// the shell's design tokens.
const autoAnimateOpts = {
  duration: 220,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
}

const stripEl = ref<HTMLElement | null>(null)

const tabOrder = computed(() => tabsStore.orderedTabs.map((tab) => tab.id))

function tabbableIndex(id: string): 0 | -1 {
  const active = tabsStore.activeId
  if (active && tabOrder.value.includes(active)) return id === active ? 0 : -1
  return id === tabOrder.value[0] ? 0 : -1
}

function focusTab(id: string) {
  stripEl.value?.querySelector<HTMLElement>(`[data-tab="${id}"]`)?.focus()
}

function select(id: string) {
  tabsStore.select(id)
}

function close(id: string) {
  tabsStore.close(id)
}

function onTabKeydown(event: KeyboardEvent, id: string) {
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault()
    const order = tabOrder.value
    const i = order.indexOf(id)
    if (i === -1) return
    const dir = event.key === 'ArrowRight' ? 1 : -1
    const next = order[(i + dir + order.length) % order.length]
    if (next) { select(next); focusTab(next) }
  } else if (event.key === 'Home') {
    event.preventDefault()
    const first = tabOrder.value[0]
    if (first) { select(first); focusTab(first) }
  } else if (event.key === 'End') {
    event.preventDefault()
    const last = tabOrder.value[tabOrder.value.length - 1]
    if (last) { select(last); focusTab(last) }
  }
}
</script>

<template>
  <div
    v-if="tabsStore.tabs.length"
    ref="stripEl"
    v-auto-animate="autoAnimateOpts"
    class="agent-tab-strip"
    role="tablist"
    :aria-label="t('agent.tab.label')"
  >
    <div
      v-for="tab in tabsStore.orderedTabs"
      :key="tab.id"
      role="tab"
      class="agent-tab-strip__tab"
      :class="{ 'is-active': tab.id === tabsStore.activeId }"
      :data-tab="tab.id"
      :tabindex="tabbableIndex(tab.id)"
      :aria-selected="tab.id === tabsStore.activeId"
      :title="tab.title"
      @click="select(tab.id)"
      @keydown="onTabKeydown($event, tab.id)"
    >
      <span class="agent-tab-strip__title">{{ tab.title }}</span>
      <IconButton
        size="xs"
        class="agent-tab-strip__close"
        :aria-label="t('agent.tab.close')"
        @click.stop="close(tab.id)"
      >
        <Close />
      </IconButton>
    </div>

    <!-- Trailing subagent indicator: pinned to the strip's right edge so it
         stays reachable even when many tabs scroll the strip. Live (pulsing)
         while subagents run; green when only settled-with-result runs remain
         ("findings ready to review"). Clicking opens the floating
         SubagentPanel — the same surface Ctrl+Shift+D and the capsule row reach. -->
    <button
      v-if="subagentTotal > 0"
      type="button"
      class="agent-tab-strip__subagents"
      :class="runningSubagents > 0 ? 'is-live' : 'is-settled'"
      :title="t('agent.activity.viewSubagents')"
      :aria-label="t('agent.activity.viewSubagents')"
      @click="emit('open-subagents')"
    >
      <span class="agent-tab-strip__subagents-dot" aria-hidden="true" />
      <span class="agent-tab-strip__subagents-count">{{ subagentTotal }}</span>
    </button>
  </div>
</template>

<style scoped>
.agent-tab-strip {
  flex: none;
  display: flex;
  align-items: center;
  height: var(--header-h);
  min-height: var(--header-h);
  padding: 0 var(--space-2);
  gap: 2px;
  background: var(--color-bg-secondary);
  border-bottom: var(--line-w) solid var(--line-seam);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.agent-tab-strip::-webkit-scrollbar { display: none; }

.agent-tab-strip__tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: calc(var(--header-h) - 10px);
  max-width: 180px;
  padding: 0 var(--space-1-5) 0 var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  cursor: pointer;
  flex: 0 0 auto;
}
.agent-tab-strip__tab:hover { background: var(--color-bg-muted); }
/* Active = the chrome selection voice (interact), matching DocumentTabs and
   NavigatorPanel — a tab strip is one widget class and must speak one
   language wherever it docks. */
.agent-tab-strip__tab.is-active {
  background: var(--color-interact-soft);
  color: var(--color-interact-text);
}
.agent-tab-strip__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-tab-strip__close {
  flex: none;
}

/* Trailing subagent indicator. `margin-left: auto` pushes it to the right end
   of the flex row; `position: sticky; right: 0` keeps it pinned there when the
   strip scrolls horizontally, with the strip's own background masking tabs
   sliding under it. Height matches a tab so it sits on the strip's baseline. */
.agent-tab-strip__subagents {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: calc(var(--header-h) - 10px);
  margin-left: auto;
  padding: 0 var(--space-2);
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: 600;
  cursor: pointer;
  flex: 0 0 auto;
  position: sticky;
  right: 0;
  transition: background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.agent-tab-strip__subagents:hover { background: var(--color-hover); border-color: var(--color-border-control-hover); }
.agent-tab-strip__subagents:focus-visible { outline: 2px solid var(--color-ring); outline-offset: 1px; }

.agent-tab-strip__subagents-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.agent-tab-strip__subagents.is-live .agent-tab-strip__subagents-dot {
  background: var(--color-primary);
  box-shadow: 0 0 0 0 var(--color-primary-glow);
  animation: agent-tab-subagents-pulse 1.6s var(--ease-inout) infinite;
}
.agent-tab-strip__subagents.is-settled .agent-tab-strip__subagents-dot {
  background: var(--color-success);
}
@keyframes agent-tab-subagents-pulse {
  0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-primary) 60%, transparent); }
  70%  { box-shadow: 0 0 0 5px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .agent-tab-strip__subagents.is-live .agent-tab-strip__subagents-dot { animation: none; }
}
</style>
