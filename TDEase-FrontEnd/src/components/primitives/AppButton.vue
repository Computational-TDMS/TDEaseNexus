<!--
  AppButton — the one button primitive (VISUAL-SYSTEM.md §11).

  Wraps a native <button>, not `el-button`, so we own the focus ring and the
  loading behaviour completely. `type`, `aria-*` and `click` all reach the
  native element through Vue's default attribute fallthrough (single root
  element, `inheritAttrs` left on) — nothing extra to wire up.

  Loading must never change the button's width (§11): the label span is
  never removed from the DOM, only made invisible (`visibility: hidden`,
  which still reserves its box). The icon gutter is swapped for a spinner
  when one is supplied via the `icon` slot; without an `icon` slot the
  spinner overlays the (now-invisible) label using absolute positioning, so
  it borrows the label's reserved footprint instead of adding to it.
-->
<template>
  <button
    class="app-button"
    :class="[
      `app-button--${variant}`,
      `app-button--${size}`,
      { 'is-loading': loading },
    ]"
    :type="type"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <span v-if="$slots.icon" class="app-button__icon" aria-hidden="true">
      <span v-if="loading" class="app-button__spinner" />
      <slot v-else name="icon" />
    </span>

    <span
      class="app-button__label"
      :class="{ 'app-button__label--reserved': loading }"
    >
      <slot />
    </span>

    <span
      v-if="loading && !$slots.icon"
      class="app-button__spinner app-button__spinner--overlay"
      aria-hidden="true"
    />
  </button>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'primary' | 'default' | 'subtle' | 'danger'
  size?: 'sm' | 'md'
  loading?: boolean
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
}>(), {
  variant: 'default',
  size: 'md',
  loading: false,
  disabled: false,
  type: 'button',
})
</script>

<style scoped>
.app-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  font-family: var(--font-body);
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color var(--dur-instant) var(--ease-out),
    border-color var(--dur-instant) var(--ease-out),
    color var(--dur-instant) var(--ease-out);
  user-select: none;
}

.app-button:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}

.app-button:disabled {
  cursor: not-allowed;
  color: var(--color-text-disabled);
  border-color: transparent;
  background: var(--color-bg-tertiary);
}

/* ----- Sizes ----- */
.app-button--md {
  height: var(--control-h);
  padding: 0 var(--space-3);
  font-size: var(--text-base);
}

.app-button--sm {
  height: var(--row-h-sm);
  padding: 0 var(--space-2);
  font-size: var(--text-sm);
}

/* ----- Variants ----- */
.app-button--primary {
  background: var(--color-primary);
  color: var(--color-on-primary);
}
.app-button--primary:hover:not(:disabled) { background: var(--color-primary-hover); }
.app-button--primary:active:not(:disabled) { background: var(--color-primary-active); }

.app-button--default {
  background: var(--color-bg);
  color: var(--color-text);
  border-color: var(--color-border);
}
.app-button--default:hover:not(:disabled) {
  background: var(--color-bg-hover);
  border-color: var(--color-border-control-hover);
}
.app-button--default:active:not(:disabled) { background: var(--color-bg-active); }

.app-button--subtle {
  background: transparent;
  color: var(--color-text-muted);
}
.app-button--subtle:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text);
}
.app-button--subtle:active:not(:disabled) { background: var(--color-bg-active); }

.app-button--danger {
  background: var(--color-error);
  color: var(--color-on-primary);
}
.app-button--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-error) 88%, var(--color-bg-tertiary) 12%);
}
.app-button--danger:active:not(:disabled) {
  background: color-mix(in srgb, var(--color-error) 76%, var(--color-bg-tertiary) 24%);
}

/* ----- Icon gutter ----- */
.app-button__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 1em;
  height: 1em;
}

/* ----- Label: never removed, only hidden, so width never changes ----- */
.app-button__label {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}

.app-button__label--reserved {
  visibility: hidden;
}

/* ----- Spinner ----- */
.app-button__spinner {
  width: 1em;
  height: 1em;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
  border-top-color: currentColor;
  animation: app-button-spin 0.8s linear infinite;
}

.app-button__spinner--overlay {
  position: absolute;
  inset: 0;
  margin: auto;
}

@keyframes app-button-spin {
  to { transform: rotate(360deg); }
}
</style>
