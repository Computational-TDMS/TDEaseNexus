<script setup lang="ts">
/**
 * ModeSelector — the Agent's working approach for the next turn.
 *
 * Orthogonal to the permission axis (ask/auto). The mode only affects the
 * system prompt composition — it does NOT grant or revoke tools (that's the
 * permission axis's job). This is a 2-state segmented control.
 *
 * Product-level placement (centered in the SessionBar), so the control reads
 * as a capsule switch in the ChatGPT/Codex vein: a quiet groove holds two
 * options, the active one lifts out as a pill (surface + shadow — the same
 * voice as the Welcome cards), and no eyebrow label stands above it. The two
 * options are named as two offerings, not "mode A/B": Workflow Analysis
 * (act: template → run → results) and Explore (investigate before acting).
 *
 * Workflow Analysis leads because it is the default: a fresh session is
 * expected to act, and Explore is the deliberate step back to investigation.
 */
import { computed, nextTick } from 'vue'
import type { MindsetId } from '@/agent/prompt'
import { useI18n } from 'vue-i18n'

type AgentMode = MindsetId

const props = defineProps<{
  modelValue: AgentMode
}>()

const emit = defineEmits<{
  'update:modelValue': [value: AgentMode]
}>()

const { t } = useI18n()

const MODES = computed(() => ([
  { value: 'workflow' as AgentMode, label: t('agent.sessionBar.mindset.workflow'), title: t('agent.sessionBar.mindset.workflowTitle') },
  { value: 'analysis' as AgentMode, label: t('agent.sessionBar.mindset.analysis'), title: t('agent.sessionBar.mindset.analysisTitle') },
]))

const current = computed(() => props.modelValue)

function select(value: AgentMode) {
  if (value !== current.value) emit('update:modelValue', value)
}

// Roving tabindex: the checked radio owns the single tab stop, the rest are
// -1, so the group is one Tab stop and arrow keys move within it (WAI-ARIA
// radiogroup pattern).
function tabindexFor(value: AgentMode): 0 | -1 {
  return current.value === value ? 0 : -1
}

function onKeydown(event: KeyboardEvent) {
  const idx = MODES.value.findIndex((m) => m.value === current.value)
  if (idx === -1) return
  let next = -1
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (idx + 1) % MODES.value.length
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (idx - 1 + MODES.value.length) % MODES.value.length
  else return
  event.preventDefault()
  const target = MODES.value[next]
  select(target.value)
  // Move focus to the newly-checked radio so roving tabindex tracks the caret.
  nextTick(() => {
    const el = document.activeElement
    const container = el?.closest?.('.mode-segmented')
    const btns = container?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    btns?.[next]?.focus()
  })
}
</script>

<template>
  <div class="mode-selector">
    <div
      class="mode-segmented"
      role="radiogroup"
      :aria-label="t('agent.sessionBar.mindsetLabel')"
      @keydown="onKeydown"
    >
      <button
        v-for="m in MODES"
        :key="m.value"
        type="button"
        role="radio"
        class="mode-btn"
        :class="{ active: current === m.value }"
        :title="m.title"
        :aria-checked="current === m.value"
        :tabindex="tabindexFor(m.value)"
        @click="select(m.value)"
      >
        {{ m.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.mode-selector {
  display: inline-flex;
  align-items: center;
}
/* The groove: one quiet inset track holding both options. No hairline border
   — the tonal step IS the track (the same "no ghost outline" voice as the
   Welcome/empty-state cards). */
.mode-segmented {
  display: inline-flex;
  height: 30px;
  padding: 3px;
  gap: 2px;
  flex-shrink: 0;
  border: none;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text-muted) 10%, transparent);
}
.mode-btn {
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  line-height: 1;
  padding: 0 14px;
  white-space: nowrap;
  cursor: pointer;
  border-radius: 999px;
  transition: background 160ms var(--ease-out), color 160ms var(--ease-out), box-shadow 160ms var(--ease-out);
}
.mode-btn:hover { color: var(--color-text); }
.mode-btn:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 1px;
}
/* The active option lifts out of the groove as a pill: raised surface +
   soft shadow, never a border change. The pill is the product voice this
   switch deserves at the top of the page — quiet, but unmistakably "on". */
.mode-btn.active {
  background: var(--color-bg);
  color: var(--color-text);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

@media (prefers-reduced-motion: reduce) {
  .mode-btn { transition: none; }
}
</style>
