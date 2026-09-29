<script setup lang="ts">
/**
 * ModeSelector — the Agent's working approach for the next turn.
 *
 * Orthogonal to the permission axis (ask/auto). The mode only affects the
 * system prompt composition — it does NOT grant or revoke tools (that's the
 * permission axis's job). This is a 2-state segmented control.
 *
 * Execute leads because it is the default: a fresh session is expected to act,
 * and Explore is the deliberate step back to investigation.
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
  { value: 'executor' as AgentMode, label: t('agent.sessionBar.mindset.executor'), title: t('agent.sessionBar.mindset.executorTitle') },
  { value: 'explorer' as AgentMode, label: t('agent.sessionBar.mindset.explorer'), title: t('agent.sessionBar.mindset.explorerTitle') },
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
    <span :id="'mode-selector-label'" class="mode-label">{{ t('agent.sessionBar.mindsetLabel') }}</span>
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
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: var(--text-sm);
}

.mode-label {
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: var(--domain-text-meta);
}

.mode-segmented {
  display: inline-flex;
  /* The toolbar's standard control height — the segmented frame spans the
     same row as the permission/effort controls beside it. */
  height: var(--row-h);
  /* Never shrink below the labels' width: squeezed buttons would wrap the
     CJK two-character mode labels into vertical stacks. */
  flex-shrink: 0;
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-xs);
  overflow: hidden;
}

.mode-btn {
  border: none;
  border-right: var(--line-w) solid var(--line-seam);
  background: var(--color-bg);
  color: var(--color-text-secondary);
  font-size: var(--text-sm);
  padding: 0 var(--space-3);
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.mode-btn:last-child { border-right: none; }
.mode-btn:hover { background: var(--color-hover); color: var(--color-text); }
/* Selected segment = the control-selection voice: soft celadon tint + the
   darker active step of the primary ramp, not a solid color block — a solid
   fill is the loudest object in the composer toolbar and misanchors the eye
   in what is otherwise a quiet instrument panel. */
.mode-btn.active {
  background: var(--color-primary-soft);
  color: var(--color-primary-active);
  font-weight: 600;
}
</style>
