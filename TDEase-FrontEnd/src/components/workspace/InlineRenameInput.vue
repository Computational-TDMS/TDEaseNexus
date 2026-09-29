<template>
  <input
    ref="inputRef"
    class="inline-rename-input"
    :disabled="disabled"
    :value="value"
    @input="value = ($event.target as HTMLInputElement).value"
    @click.stop
    @dblclick.stop
    @mousedown.stop
    @blur="commit"
    @keydown.enter.prevent.stop="commit"
    @keydown.escape.prevent.stop="cancel"
  />
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const props = defineProps<{
  initialValue: string
  disabled?: boolean
}>()
const emit = defineEmits<{ commit: [value: string]; cancel: [] }>()

const inputRef = ref<HTMLInputElement>()
const value = ref(props.initialValue)
// Guard against double-commit (Enter + blur both fire).
const finished = ref(false)

onMounted(() => {
  const el = inputRef.value
  if (!el) return
  el.focus()
  el.select()
})

function commit() {
  if (finished.value) return
  finished.value = true
  emit('commit', value.value)
}

function cancel() {
  if (finished.value) return
  finished.value = true
  emit('cancel')
}
</script>

<style scoped>
.inline-rename-input {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  font-family: var(--font-mono);
  line-height: 1.4;
  color: var(--color-text);
  background: var(--color-bg);
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-xs);
  outline: none;
  padding: 0 var(--space-1);
  /* One line shorter than the row so the border sits inside the row without
     cropping the surrounding grid cell. Tracks the density scale. */
  height: calc(var(--row-h-sm) - 6px);
  margin: 0;
}
.inline-rename-input:disabled {
  opacity: 0.6;
}
</style>
