<!--
  IconButton — the square, icon-only counterpart to AppButton (VISUAL-SYSTEM.md §11).

  The workbench chrome is full of icon-only affordances — tab close, rail
  toggles, toolbar actions, overflow menus. Before this primitive existed,
  every one of them re-implemented the same shape: a native `<button>`, square,
  centred icon, transparent background, hover/active/focus states, and an
  aria-label standing in for the absent text. Three divergent shapes had
  accumulated (the Composer comment referenced a "shared icon-button shape"
  that did not exist). This is that shape, owned in one place.

  `aria-label` is REQUIRED and not defaulted: an icon with no accessible name is
  invisible to assistive tech. Pass the label through i18n like any string.
  `type`, `aria-*` and `click` all reach the native element through Vue's
  default attribute fallthrough.
-->
<template>
  <button
    type="button"
    class="icon-button"
    :class="[`icon-button--${size}`, { 'is-active': active }]"
    :disabled="disabled"
  >
    <el-icon :size="iconSize"><slot /></el-icon>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  /** Square footprint. `sm`/`md` track the density scale; `xs` for in-tab affordances. */
  size?: 'xs' | 'sm' | 'md'
  /** Visual pressed/selected state. Carries no hue unless `tone="accent"`. */
  active?: boolean
  disabled?: boolean
}>(), {
  size: 'md',
  active: false,
  disabled: false,
})

// el-icon size scales with the footprint so the glyph never overflows the box.
const iconSize = computed(() => ({ xs: 12, sm: 14, md: 16 }[props.size]))
</script>

<style scoped>
.icon-button {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    background-color var(--dur-instant) var(--ease-out),
    border-color var(--dur-instant) var(--ease-out),
    color var(--dur-instant) var(--ease-out);
  user-select: none;
}

.icon-button:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.icon-button:active:not(:disabled) {
  background: var(--color-bg-active);
}

.icon-button:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}

.icon-button:disabled {
  color: var(--color-text-disabled);
  cursor: not-allowed;
}

.icon-button.is-active {
  color: var(--color-text);
  background: var(--color-primary-soft);
}

/* Sizes — square, on the density scale. */
.icon-button--xs {
  width: 18px;
  height: 18px;
}

.icon-button--sm {
  width: var(--row-h-sm);
  height: var(--row-h-sm);
}

.icon-button--md {
  width: var(--control-h);
  height: var(--control-h);
}
</style>
