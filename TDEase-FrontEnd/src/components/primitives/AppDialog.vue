<!--
  AppDialog — the one dialog shell primitive (ZCode DESIGN.md's dialog layer,
  in this repo's own vocabulary).

  Teleported to <body> so pane overflow cannot clip it; --z-modal puts it
  above every in-app surface including the element-plus manager floor. Esc and
  a backdrop click emit `close` (the owner decides what close means — cancel,
  dismiss, abort); clicks inside the panel never do. Focus starts on the first
  `[data-autofocus]` descendant, else the panel itself, and Tab is trapped to
  the panel so keyboard focus cannot fall through to the frozen page behind.

  Body and footer are slots — this shell owns geometry, surface and stacking
  only, never button semantics (ConfirmDialogHost supplies those for the
  imperative confirm store; feature dialogs may reuse the shell directly).
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'

const props = defineProps<{
  title?: string
  danger?: boolean
  /** Narrow confirm width; pass false for feature dialogs that need room. */
  compact?: boolean
}>()

const emit = defineEmits<{ close: [] }>()

const panelEl = ref<HTMLElement | null>(null)

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
    return
  }
  // Minimal focus trap: forward Tab past the last focusable wraps to the
  // first, Shift+Tab before the first wraps to the last.
  if (event.key === 'Tab' && panelEl.value) {
    const focusables = Array.from(
      panelEl.value.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => !el.hasAttribute('disabled'))
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    } else if (event.shiftKey && (active === first || !panelEl.value.contains(active))) {
      event.preventDefault()
      last.focus()
    }
  }
}

onMounted(() => {
  const preferred = panelEl.value?.querySelector<HTMLElement>('[data-autofocus]')
  ;(preferred ?? panelEl.value)?.focus()
})
</script>

<template>
  <Teleport to="body">
    <!--
      The wrapper eats keydown for Esc/Tab; tabindex makes it focusable so Esc
      works even when nothing inside holds focus yet.
    -->
    <div class="app-dialog" tabindex="-1" @keydown="onKeydown">
      <div class="app-dialog__backdrop" @click="emit('close')" />
      <div
        ref="panelEl"
        class="app-dialog__panel"
        :class="{ 'app-dialog__panel--danger': props.danger, 'app-dialog__panel--wide': props.compact === false }"
        role="dialog"
        aria-modal="true"
        :aria-label="props.title"
        tabindex="-1"
      >
        <h2 v-if="props.title" class="app-dialog__title">{{ props.title }}</h2>
        <div class="app-dialog__body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="app-dialog__footer">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.app-dialog {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
  padding: var(--space-5);
  outline: none;
}

.app-dialog__backdrop {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--ctp-crust) 55%, transparent);
}

.app-dialog__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(420px, 100%);
  max-height: min(70vh, 560px);
  padding: var(--space-4);
  background: var(--elev-2-bg, var(--color-bg-secondary));
  border: 1px solid var(--line-seam-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-overlay);
  outline: none;
}

.app-dialog__panel--wide {
  width: min(640px, 100%);
}

.app-dialog__panel--danger .app-dialog__title {
  color: var(--color-error-text);
}

.app-dialog__title {
  margin: 0 0 var(--space-3);
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--color-text);
}

.app-dialog__body {
  min-height: 0;
  overflow: auto;
  font-size: var(--text-base);
  line-height: 1.5;
  color: var(--color-text-secondary);
  white-space: pre-line;
}

.app-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
</style>
