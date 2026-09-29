<template>
  <div class="schema-form" role="group">
    <Field
      v-for="field in fields"
      :key="field.key"
      :label="field.title"
      :description="field.description"
      :required="field.required"
      :error="errors?.[field.key]"
    >
      <template #default="{ id, describedby, invalid }">
        <div v-if="field.shape === 'unsupported'" class="schema-form__unsupported">
          <p class="schema-form__unsupported-notice">{{ t('common.error.unsupportedSchema', { type: field.rawType }) }}</p>
          <pre class="schema-form__unsupported-preview mono">{{ formatPreview(field.rawSchema) }}</pre>
        </div>

        <p v-else-if="readonly" :id="id" class="schema-form__static">{{ formatStatic(field) }}</p>

        <el-input
          v-else-if="field.shape === 'string'"
          :id="id"
          :model-value="asString(field.value)"
          :aria-describedby="describedby"
          :aria-invalid="invalid"
          @update:model-value="updateField(field.key, $event)"
        />

        <el-input
          v-else-if="field.shape === 'multiline'"
          :id="id"
          type="textarea"
          :model-value="asString(field.value)"
          :aria-describedby="describedby"
          :aria-invalid="invalid"
          @update:model-value="updateField(field.key, $event)"
        />

        <el-select
          v-else-if="field.shape === 'enum'"
          :id="id"
          :model-value="field.value"
          :aria-describedby="describedby"
          :aria-invalid="invalid"
          @update:model-value="updateField(field.key, $event)"
        >
          <el-option v-for="option in field.options" :key="option" :label="option" :value="option" />
        </el-select>

        <el-input-number
          v-else-if="field.shape === 'number'"
          :id="id"
          :model-value="asNumber(field.value)"
          :min="field.minimum"
          :max="field.maximum"
          :aria-describedby="describedby"
          :aria-invalid="invalid"
          @update:model-value="updateField(field.key, $event)"
        />

        <el-switch
          v-else-if="field.shape === 'boolean'"
          :id="id"
          :model-value="!!field.value"
          :aria-describedby="describedby"
          @update:model-value="updateField(field.key, $event)"
        />

        <div v-else-if="field.shape === 'path'" class="schema-form__path">
          <el-input
            :id="id"
            :model-value="asString(field.value)"
            :aria-describedby="describedby"
            :aria-invalid="invalid"
            @update:model-value="updateField(field.key, $event)"
          />
          <AppButton size="sm" variant="default" @click="emit('pick-path', field.key)">
            {{ t('common.button.browse') }}
          </AppButton>
        </div>

        <el-select
          v-else-if="field.shape === 'array-enum'"
          :id="id"
          multiple
          :model-value="asArray(field.value)"
          :aria-describedby="describedby"
          @update:model-value="updateField(field.key, $event)"
        >
          <el-option v-for="option in field.options" :key="option" :label="option" :value="option" />
        </el-select>
      </template>
    </Field>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from './AppButton.vue'
import Field from './Field.vue'

const { t } = useI18n()

// one implementation of the JSON-Schema-to-form
// renderer, shared by the palette, the read-only approval card, and any
// inline form the UI needs. Exactly six shapes are supported; anything else
// is a signal the command is too large, not a signal to grow this renderer.

export interface JSONSchemaProperty {
  type?: string
  format?: string
  enum?: ReadonlyArray<string>
  minimum?: number
  maximum?: number
  items?: { enum?: ReadonlyArray<string> }
  title?: string
  description?: string
  default?: unknown
  [key: string]: unknown
}

export interface JSONSchemaObject {
  type: 'object'
  title?: string
  description?: string
  properties: Readonly<Record<string, JSONSchemaProperty>>
  required?: ReadonlyArray<string>
}

type FieldShape =
  | 'string'
  | 'multiline'
  | 'enum'
  | 'number'
  | 'boolean'
  | 'path'
  | 'array-enum'
  | 'unsupported'

interface ResolvedField {
  key: string
  shape: FieldShape
  title: string
  description?: string
  required: boolean
  value: unknown
  options?: ReadonlyArray<string>
  minimum?: number
  maximum?: number
  rawType: string
  rawSchema: JSONSchemaProperty
}

const props = defineProps<{
  schema: JSONSchemaObject
  modelValue: Record<string, unknown>
  readonly?: boolean
  errors?: Record<string, string>
}>()

const emit = defineEmits<{
  'update:modelValue': [value: Record<string, unknown>]
  'pick-path': [key: string]
}>()

function classifyShape(schema: JSONSchemaProperty): FieldShape {
  if (schema.type === 'string') {
    if (isStringArray(schema.enum)) return 'enum'
    if (schema.format === 'path') return 'path'
    if (schema.format === 'multiline') return 'multiline'
    return 'string'
  }
  if (schema.type === 'number' || schema.type === 'integer') return 'number'
  if (schema.type === 'boolean') return 'boolean'
  if (schema.type === 'array' && isStringArray(schema.items?.enum)) return 'array-enum'
  return 'unsupported'
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

const fields = computed<ResolvedField[]>(() => {
  const required = new Set(props.schema.required ?? [])
  return Object.entries(props.schema.properties ?? {}).map(([key, propSchema]) => {
    const shape = classifyShape(propSchema)
    const rawValue = props.modelValue?.[key]
    const value = rawValue !== undefined ? rawValue : propSchema.default
    return {
      key,
      shape,
      title: propSchema.title ?? key,
      description: propSchema.description,
      required: required.has(key),
      value,
      options: shape === 'enum' ? propSchema.enum : shape === 'array-enum' ? propSchema.items?.enum : undefined,
      minimum: propSchema.minimum,
      maximum: propSchema.maximum,
      rawType: propSchema.type ?? 'unknown',
      rawSchema: propSchema,
    }
  })
})

function updateField(key: string, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function asArray(value: unknown): ReadonlyArray<string> {
  return isStringArray(value) ? value : []
}

function formatStatic(field: ResolvedField): string {
  const value = field.value
  if (value === undefined || value === null || value === '') return '—'
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—'
  if (typeof value === 'boolean') return value ? t('common.button.yes') : t('common.button.no')
  return String(value)
}

function formatPreview(schema: JSONSchemaProperty): string {
  try {
    return JSON.stringify(schema, null, 2)
  } catch {
    return String(schema)
  }
}
</script>

<style scoped>
.schema-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.schema-form__static {
  margin: 0;
  font-size: var(--text-base);
  line-height: var(--text-base-lh);
  color: var(--color-text);
}

.schema-form__path {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.schema-form__path .el-input {
  flex: 1;
}

.schema-form__unsupported {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border: var(--line-w) dashed var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg-muted);
}

.schema-form__unsupported-notice {
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
  color: var(--color-warning-text);
}

.schema-form__unsupported-preview {
  margin: 0;
  max-height: 160px;
  overflow: auto;
  color: var(--color-text-muted);
}
</style>
