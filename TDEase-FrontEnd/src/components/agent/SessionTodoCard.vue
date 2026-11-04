<!--
  SessionTodoCard — the rendering half of `services/permissionMode.ts`'s
  `todo_write` tool.

  ("no block exists that no event produces") decides
  where this may live. `todo_write` produces `tool.requested` /
  `tool.completed`, which §8.4 already maps to a `ToolGroupBlock` row inside
  the act — so the plan is NOT a new transcript block; inventing one would
  add a block no event produces and duplicate the tool row. This card is a
  *derived, pinned summary* of the latest `todo_write` payload already in
  the projection: same events, no new block. Replacement semantics — the
  last `todo_write` call wins — because the tool takes the whole list every
  time.

  Position (Phase D-18, palot): pinned ABOVE the Composer, not below the
  scroller. The folded summary line surfaces "N of M completed · current
  task"; the list expands with a height animation. The card self-hides when
  the plan is empty.
-->
<template>
  <section v-if="todos.length" class="session-todo" :class="{ 'is-collapsed': collapsed }" :aria-label="t('workbench.sessionTodo.ariaLabel')">
    <button class="section-header" type="button" :aria-expanded="!collapsed" @click="collapsed = !collapsed">
      <span class="section-progress" aria-hidden="true">
        <span class="section-progress__bar" :style="{ '--progress': progressFraction }" />
      </span>
      <span class="section-summary">{{ completedCount }}/{{ todos.length }}</span>
      <span v-if="currentTask" class="section-current">{{ currentTask }}</span>
      <el-icon class="chevron" :class="{ collapsed }" :size="12"><ArrowDown /></el-icon>
    </button>
    <div class="todo-list-wrap" :class="{ 'is-open': !collapsed }">
      <ol class="todo-list">
        <li v-for="todo in todos" :key="todo.key" class="todo-item" :class="`is-${todo.status}`">
          <span class="todo-mark" aria-hidden="true">
            <el-icon v-if="todo.status === 'completed'" :size="13"><Check /></el-icon>
            <span v-else-if="todo.status === 'in_progress'" class="active-dot" />
          </span>
          <span class="todo-text">
            {{ todo.status === 'in_progress' ? todo.activeForm : todo.content }}
            <span class="todo-status-sr">{{ t(STATUS_KEY[todo.status]) }}</span>
          </span>
        </li>
      </ol>
    </div>
  </section>
</template>

<script setup lang="ts">
import { inject, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDown, Check } from '@element-plus/icons-vue'
import type { AgentChatMessage } from '@/stores/chat-types'
import { useSessionTodos, TODO_STATUS_KEY as STATUS_KEY } from '@/composables/useSessionTodos'

/**
 * The plan is read off whatever message list the host provides. Transcript.vue
 * provides the very projection it renders, so the card can never disagree with
 * the transcript about what the model planned.
 */
const messages = inject<Ref<ReadonlyArray<AgentChatMessage>>>('chatMessages', ref([]))
const collapsed = ref(true)

const { t } = useI18n()

// Shared plan read model — the Activity panel's Plan view and this card derive
// from the same projection, so the two can never disagree.
const { todos, completedCount, progressFraction, currentTask } = useSessionTodos(messages)

// Auto-expand while a turn is actively updating the plan (an in_progress
// task exists), auto-collapse when all are done — mirrors palot's "running
// default expanded, completed collapses to summary".
watch(() => todos.value.some((t) => t.status === 'in_progress'), (hasInProgress) => {
  if (hasInProgress) collapsed.value = false
  else if (todos.value.length > 0 && todos.value.every((t) => t.status === 'completed')) collapsed.value = true
}, { immediate: true })
</script>

<style scoped>
.session-todo {
  flex: none;
  padding: var(--space-1-5) var(--space-3);
  border-top: var(--line-w) solid var(--line-hairline);
  background: var(--color-bg-secondary);
}
.section-header {
  width: 100%;
  min-height: var(--control-h, 24px);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.section-header:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

/* Progress bar: a thin track with a filled segment. Reads at a glance how
   far through the plan the model is, without needing the count. */
.section-progress {
  position: relative;
  width: 48px;
  height: 4px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--color-border-panel);
  overflow: hidden;
}
.section-progress__bar {
  position: absolute;
  inset: 0 auto 0 0;
  width: var(--progress, 0%);
  background: var(--color-primary);
  border-radius: 50%;
  /* No width transition: layout-property animation is banned (§1.3), and the
     fill only moves on low-frequency data updates the user never watches. */
}
.section-summary {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--text-label);
  color: var(--color-text-muted, var(--color-text-muted));
}
.section-current {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chevron {
  flex-shrink: 0;
  color: var(--color-text-muted, var(--color-text-muted));
  transition: transform 160ms ease-out;
}
.chevron.collapsed { transform: rotate(-90deg); }

/* Height animation: the wrap uses a grid-rows trick (1fr ↔ 0fr) so the list
   expands/collapses smoothly regardless of row count. */
.todo-list-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--dur-normal) var(--ease-out);
}
.todo-list-wrap:not(.is-open) {
  grid-template-rows: 0fr;
}
.todo-list {
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: var(--space-1) 0 0;
  padding: 0 0 var(--space-1);
  list-style: none;
}
.session-todo.is-collapsed .todo-list { padding-bottom: 0; }
.todo-item {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  gap: var(--space-2);
  align-items: start;
  color: var(--color-text-muted, var(--color-text-muted));
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
}
.todo-mark {
  width: 15px;
  height: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: var(--line-w) solid var(--line-hairline);
  border-radius: 50%;
  color: var(--color-success-text);
}
.todo-status-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.is-completed .todo-text { color: var(--color-text-muted, var(--color-text-muted)); text-decoration: line-through; }
.is-completed .todo-mark { border-color: var(--color-success-text); background: var(--color-success-soft); }
.is-in_progress { color: var(--color-text, var(--color-text)); font-weight: 500; }
.is-in_progress .todo-mark { border-color: var(--color-primary); }
.active-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 16%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .chevron { transition: none; }
  .todo-list-wrap { transition: none; }
}
</style>
