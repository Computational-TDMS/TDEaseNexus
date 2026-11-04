<template>
  <div class="field" :class="{ 'is-invalid': !!error }">
    <label :for="controlId" class="field__label text-label">
      {{ label }}
      <span v-if="required" class="field__required" aria-hidden="true">*</span>
    </label>
    <p v-if="description" :id="descriptionId" class="field__description">{{ description }}</p>
    <div class="field__control">
      <slot :id="controlId" :describedby="describedBy" :invalid="!!error" />
    </div>
    <p v-if="error" :id="errorId" class="field__error" role="alert">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'

// this is where accessibility for every generated form
// is decided. The default slot receives the ids it must wire onto its
// control -- `id`, and `aria-describedby`/`aria-invalid` via the scoped
// slot props -- so every consumer gets the association right by construction.
const props = defineProps<{
  label: string
  description?: string
  error?: string
  required?: boolean
  /** Optional override; auto-generated when omitted so every Field is self-contained. */
  id?: string
}>()

const generatedId = useId()
const controlId = computed(() => props.id ?? `field-${generatedId}`)
const descriptionId = computed(() => `${controlId.value}-description`)
const errorId = computed(() => `${controlId.value}-error`)

const describedBy = computed(() => {
  const ids: string[] = []
  if (props.description) ids.push(descriptionId.value)
  if (props.error) ids.push(errorId.value)
  return ids.length > 0 ? ids.join(' ') : undefined
})
</script>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.field__label {
  color: var(--color-text-secondary);
}

.field__required {
  color: var(--color-error-text);
  margin-left: var(--space-1);
}

.field__description {
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
  color: var(--color-text-muted);
}

.field__control {
  margin-top: var(--space-1);
}

.field__error {
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
  color: var(--color-error-text);
}

.field.is-invalid .field__label {
  color: var(--color-error-text);
}
</style>
