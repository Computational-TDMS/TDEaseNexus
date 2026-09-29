<!--
  ConfirmDialogHost — the single renderer for the confirmDialog store, mounted
  once in AppShell. The store holds the pending request (truth); this host is
  the only place that turns it into chrome. Text-prompt drafts live here
  (renderer-local) while the request — and its validate rule — stays in the
  store, so a queued next question never inherits the previous draft.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@/components/primitives/AppButton.vue'
import AppDialog from '@/components/primitives/AppDialog.vue'
import { useConfirmDialogStore } from '@/stores/confirmDialog'

const { t } = useI18n()
const store = useConfirmDialogStore()

const draft = ref('')
const error = ref<string | null>(null)

// Reset the draft (and any validation error) for each new request — a queued
// second prompt must open clean, not with the previous answer half-typed.
watch(
  () => store.pending,
  (next) => {
    draft.value = next?.kind === 'text' ? (next.options.initialValue ?? '') : ''
    error.value = null
  },
)

const head = computed(() => store.pending)

const confirmLabel = computed(() => {
  if (!head.value) return ''
  if (head.value.kind === 'notice') return head.value.options.okLabel ?? t('common.button.confirm')
  return head.value.options.confirmLabel ?? t('common.button.confirm')
})

const cancelLabel = computed(() =>
  head.value && head.value.kind !== 'notice'
    ? (head.value.options.cancelLabel ?? t('common.button.cancel'))
    : '',
)

function submitText() {
  if (!head.value || head.value.kind !== 'text') return
  const problem = head.value.options.validate?.(draft.value) ?? null
  if (problem) {
    error.value = problem
    return
  }
  store.acceptText(draft.value)
}

function onPrimary() {
  if (head.value?.kind === 'text') submitText()
  else store.accept()
}
</script>

<template>
  <AppDialog
    v-if="head"
    :key="head.id"
    :title="head.kind === 'notice' ? (head.options.title ?? '') : head.options.title"
    :danger="head.kind !== 'notice' && head.options.danger === true"
    @close="store.cancel()"
  >
    <p v-if="head.options.message">{{ head.options.message }}</p>
    <template v-if="head.kind === 'text'">
      <input
        v-model="draft"
        class="confirm-host__input"
        type="text"
        :placeholder="head.options.placeholder"
        data-autofocus
        @keydown.enter.prevent="submitText"
      />
      <p v-if="error" class="confirm-host__error">{{ error }}</p>
    </template>
    <template #footer>
      <AppButton
        v-if="head.kind !== 'notice'"
        :variant="head.kind === 'confirm' && head.options.danger ? 'default' : 'subtle'"
        :data-autofocus="head.kind === 'confirm' && head.options.danger ? true : undefined"
        @click="store.cancel()"
      >
        {{ cancelLabel }}
      </AppButton>
      <AppButton
        :variant="head.kind !== 'notice' && head.options.danger ? 'danger' : 'primary'"
        :data-autofocus="head.kind === 'confirm' && head.options.danger ? undefined : true"
        @click="onPrimary"
      >
        {{ confirmLabel }}
      </AppButton>
    </template>
  </AppDialog>
</template>

<style scoped>
.confirm-host__input {
  width: 100%;
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-2-5);
  font-size: var(--text-base);
  color: var(--color-text);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.confirm-host__input:focus {
  outline: none;
  border-color: var(--color-ring);
}

.confirm-host__error {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  color: var(--color-error-text);
}
</style>
