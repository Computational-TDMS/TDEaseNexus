<template>
  <div ref="wrapperRef" class="perm-selector" :class="{ open: open }">
    <button
      type="button"
      class="perm-btn"
      :class="`perm-${modelValue}`"
      :title="label"
      :aria-label="label"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click.stop="toggleOpen"
      @keydown.escape.prevent="closeAndRestoreFocus"
    >
      <!-- auto: shield icon (silent, no approval cards) -->
      <svg v-if="modelValue === 'auto'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3.5 19 6v5.4c0 4.1-2.7 7.5-7 9.1-4.3-1.6-7-5-7-9.1V6l7-2.5Z" />
      </svg>
      <!-- ask: question mark (approval card per side effect) -->
      <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.7-2.5 2-2.5 4" />
        <path d="M12 17h.01" />
      </svg>
      <span class="perm-btn__label">{{ shortLabel }}</span>
    </button>

    <!-- Dropdown -->
    <div v-if="open" class="perm-dropdown" role="menu" :aria-label="label">
      <button
        v-for="m in MODES"
        :key="m"
        type="button"
        class="perm-option"
        :class="{ active: m === modelValue, [`opt-${m}`]: true }"
        role="menuitemradio"
        :aria-checked="m === modelValue"
        @click="select(m)"
      >
        <svg v-if="m === 'auto'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3.5 19 6v5.4c0 4.1-2.7 7.5-7 9.1-4.3-1.6-7-5-7-9.1V6l7-2.5Z" />
        </svg>
        <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.7-2.5 2-2.5 4" /><path d="M12 17h.01" />
        </svg>
        <span>{{ labels[m] }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * PermissionModeButton — the permission axis selector (ask / auto).
 *
 * Orthogonal to the agent mindset axis (executor/explorer). Two levels:
 *   ask  → side-effecting tools surface an ApprovalModal per call
 *   auto → side effects run silently (no modal), still recorded in tool_group
 *
 * Re-exports PermissionMode from the canonical source (permissionMode.ts) so
 * there is a single type definition across the codebase.
 */
import { computed, nextTick, ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { type PermissionMode } from '@/services/agent/permissionMode'
export type { PermissionMode }

// `auto` first: it is the default, and the menu's first row is where a
// default belongs (the same "execute first" order the mindset selector uses).
const MODES: PermissionMode[] = ['auto', 'ask']

const props = withDefaults(defineProps<{
  modelValue: PermissionMode
}>(), {
  modelValue: 'auto',
})

const emit = defineEmits<{
  'update:modelValue': [value: PermissionMode]
}>()

const { t } = useI18n()
const open = ref(false)
const wrapperRef = ref<HTMLDivElement>()
const triggerRef = ref<HTMLButtonElement | null>(null)

const labels = computed<Record<PermissionMode, string>>(() => ({
  ask: t('agent.permissionMode.askLabel'),
  auto: t('agent.permissionMode.autoLabel'),
}))

const label = computed(() => labels.value[props.modelValue])
// The trigger carries the short word (询问/自动 · Ask/Auto); the long
// `permissionMode.*Label` strings stay as title/aria only — an icon-only
// trigger this small was the quietest control on the toolbar and easy to
// misread as decoration.
const shortLabel = computed(() => t(`agent.sessionBar.authority.${props.modelValue}`))

function toggleOpen() {
  open.value = !open.value
  if (open.value) triggerRef.value = document.activeElement as HTMLButtonElement | null
}

function closeAndRestoreFocus() {
  if (!open.value) return
  open.value = false
  nextTick(() => triggerRef.value?.focus())
}

function select(m: PermissionMode) {
  open.value = false
  if (m !== props.modelValue) {
    emit('update:modelValue', m)
  }
}

function onClickOutside(e: MouseEvent) {
  if (wrapperRef.value && !wrapperRef.value.contains(e.target as Node)) {
    open.value = false
  }
}

onMounted(() => document.addEventListener('mousedown', onClickOutside))
onUnmounted(() => document.removeEventListener('mousedown', onClickOutside))
</script>

<style scoped>
.perm-selector {
  position: relative;
  flex-shrink: 0;
}

.perm-btn {
  height: var(--row-h);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border-panel);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  white-space: nowrap;
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.perm-btn:hover {
  border-color: color-mix(in srgb, var(--color-primary) 40%, var(--color-border-panel));
  color: var(--color-primary);
}
.perm-btn:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 1px;
}

/* tde-amber/green already pass AA per-color across all four themes; use semantic success/warning directly */
.perm-auto { color: var(--color-success-text); }
.perm-ask { color: var(--color-warning-text); }

.perm-selector.open .perm-btn {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

/* Dropdown */
.perm-dropdown {
  position: absolute;
  bottom: calc(100% + var(--space-1));
  left: 0;
  background: var(--elev-2-bg, var(--color-bg));
  border: 1px solid var(--color-border-panel);
  border-radius: var(--radius-md);
  box-shadow: var(--elev-2);
  z-index: var(--z-floating);
  min-width: 180px;
  padding: var(--space-1);
}

.perm-option {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: var(--text-sm);
  cursor: pointer;
  border-radius: var(--radius-xs);
  text-align: left;
  white-space: nowrap;
}
.perm-option:hover {
  background: var(--color-hover);
}
.perm-option.active {
  background: color-mix(in srgb, var(--color-primary) 10%, var(--color-bg));
  color: var(--color-primary);
}
</style>
