<!--
  CopyableId — mono, truncated-with-ellipsis identity, copy on click
  (VISUAL-SYSTEM.md §3.3, §9: "Every identity is copyable").

  `value` is the raw identifier; `prefix` is an optional decorative type tag
  (e.g. `sha256:`). Both the `title` attribute and the clipboard payload
  carry the *full*, untruncated `prefix + value` — the same string the user
  would see if nothing were truncated — so copy never silently drops the
  prefix a caller asked to display.

  Built on a native <button> for free keyboard reachability.
-->
<template>
  <button
    type="button"
    class="copyable-id mono"
    :title="fullValue"
    @click="copy"
  >
    <span class="copyable-id__text">{{ display }}</span>
    <span v-if="copied" class="copyable-id__confirm">{{ t('common.copyableId.copied') }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = withDefaults(defineProps<{
  value: string
  prefix?: string
  chars?: number
}>(), {
  chars: 8,
})

const { t } = useI18n()
const copied = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | undefined

const fullValue = computed(() => `${props.prefix ?? ''}${props.value}`)

const truncatedValue = computed(() => (
  props.value.length > props.chars
    ? `${props.value.slice(0, props.chars)}…`
    : props.value
))

const display = computed(() => `${props.prefix ?? ''}${truncatedValue.value}`)

async function copy() {
  try {
    await navigator.clipboard?.writeText(fullValue.value)
  } catch {
    // Clipboard access denied or unavailable — the full value remains
    // reachable via the `title` attribute regardless.
  }
  copied.value = true
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => { copied.value = false }, 1200)
}

onBeforeUnmount(() => {
  if (confirmTimer) clearTimeout(confirmTimer)
})
</script>

<style scoped>
.copyable-id {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  border: none;
  background: none;
  padding: 0;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: var(--radius-xs);
  transition: color var(--dur-instant) var(--ease-out);
}

.copyable-id:hover {
  color: var(--color-text);
}

.copyable-id:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}

.copyable-id__text {
  white-space: nowrap;
}

.copyable-id__confirm {
  font-family: var(--font-body);
  font-size: var(--text-label);
  color: var(--color-success-text);
}
</style>
