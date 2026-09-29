<template>
  <el-dialog
    :model-value="show"
    :title="t('workbench.settings.providers.customDialog.title')"
    width="440px"
    :close-on-click-modal="false"
    @update:model-value="emit('update:show', $event)"
    @close="reset"
  >
    <div class="cpd-body">
      <!-- Presets: local servers with fixed ports prefill name+baseUrl and
           move focus to the key field — the manual chip is the clean slate. -->
      <div class="cpd-presets" role="group" :aria-label="t('workbench.settings.providers.customDialog.preset')">
        <button
          type="button"
          :class="['cpd-preset', { active: presetId === MANUAL_ENDPOINT_ID }]"
          @click="applyPreset(MANUAL_ENDPOINT_ID)"
        >
          {{ t('workbench.settings.providers.customDialog.presetManual') }}
        </button>
        <button
          v-for="preset in CUSTOM_ENDPOINT_PRESETS" :key="preset.id"
          type="button"
          :class="['cpd-preset', { active: presetId === preset.id }]"
          @click="applyPreset(preset.id)"
        >
          {{ preset.name }}
        </button>
      </div>
      <Field :label="t('workbench.settings.providers.customDialog.name')">
        <template #default="{ id }">
          <input
            :id="id"
            v-model="name"
            class="settings-input"
            type="text"
            :placeholder="t('workbench.settings.providers.customDialog.namePlaceholder')"
            spellcheck="false" autocomplete="off"
          />
        </template>
      </Field>
      <Field :label="t('workbench.settings.providers.baseUrl')">
        <template #default="{ id }">
          <input
            :id="id"
            v-model="baseUrl"
            class="settings-input"
            type="text"
            placeholder="https://api.example.com/v1"
            spellcheck="false" autocomplete="off"
            :aria-invalid="baseUrlIssue ? 'true' : undefined"
          />
          <p v-if="baseUrlIssue" class="pv-cred-error" role="alert">
            {{ t(`workbench.settings.providers.baseUrlIssue.${baseUrlIssue}`) }}
          </p>
          <p v-else-if="normalizedPreview" class="cpd-hint">
            {{ t('workbench.settings.providers.baseUrlNormalized', { url: normalizedPreview }) }}
          </p>
        </template>
      </Field>
      <Field :label="t('workbench.settings.providers.apiKey')">
        <template #default="{ id }">
          <input
            :id="id"
            ref="apiKeyField"
            v-model="apiKey"
            class="settings-input"
            type="password"
            :placeholder="t('workbench.settings.providers.apiKeyPlaceholder')"
            spellcheck="false" autocomplete="off"
          />
        </template>
      </Field>
      <p class="cpd-hint">{{ t('workbench.settings.providers.customDialog.hint') }}</p>
      <p v-if="error" class="pv-cred-error" role="alert">{{ error }}</p>
    </div>
    <template #footer>
      <AppButton size="sm" variant="subtle" @click="emit('update:show', false)">
        {{ t('workbench.settings.providers.customDialog.cancel') }}
      </AppButton>
      <AppButton size="sm" variant="primary" :loading="saving" :disabled="!valid" @click="save">
        {{ t('workbench.settings.providers.customDialog.save') }}
      </AppButton>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
/**
 * CustomProviderDialog — creation form for a user-defined OpenAI-compatible
 * endpoint. It only COLLECTS the four facts the runtime needs (name, baseUrl,
 * optional key, implicit openai-completions api) and hands them to the
 * settings store; live model discovery deliberately starts AFTER the save, in
 * ProviderDetail — discovery probes {baseUrl}/models with the stored key, and
 * a draft has nothing stored to probe with.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/settings'
import { getBaseUrlIssue, normalizeBaseUrlInput } from '@/services/catalog/provider-endpoint'
import { CUSTOM_ENDPOINT_PRESETS, MANUAL_ENDPOINT_ID } from '@/services/catalog/provider-endpoint-presets'
import Field from '../primitives/Field.vue'
import AppButton from '@/components/primitives/AppButton.vue'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [value: boolean]; saved: [providerId: string] }>()

const { t } = useI18n()
const settings = useSettingsStore()

const presetId = ref<string>(MANUAL_ENDPOINT_ID)
const name = ref('')
const baseUrl = ref('')
const apiKey = ref('')
const apiKeyField = ref<HTMLInputElement | null>(null)
const saving = ref(false)
const error = ref<string | null>(null)

function applyPreset(id: string) {
  presetId.value = id
  if (id === MANUAL_ENDPOINT_ID) return
  const preset = CUSTOM_ENDPOINT_PRESETS.find((candidate) => candidate.id === id)
  if (!preset) return
  name.value = preset.name
  baseUrl.value = preset.baseUrl
  // The endpoint is already decided — the key is the next fact to type.
  apiKeyField.value?.focus()
}

const baseUrlIssue = computed(() => getBaseUrlIssue(baseUrl.value))
/** The service root the paste will actually be saved as, when it differs —
 *  the trim must be visible, not something the user discovers post-save. */
const normalizedPreview = computed(() => {
  const normalized = normalizeBaseUrlInput(baseUrl.value)
  return normalized !== baseUrl.value.trim() ? normalized : ''
})

const valid = computed(() =>
  name.value.trim().length > 0
  && baseUrl.value.trim().length > 0
  && !baseUrlIssue.value)

watch(() => props.show, (show) => { if (show) reset() })

function reset() {
  presetId.value = MANUAL_ENDPOINT_ID
  name.value = ''
  baseUrl.value = ''
  apiKey.value = ''
  error.value = null
}

async function save() {
  saving.value = true
  error.value = null
  try {
    const id = await settings.createCustomProvider({
      name: name.value,
      baseUrl: normalizeBaseUrlInput(baseUrl.value),
      apiKey: apiKey.value || undefined,
    })
    emit('update:show', false)
    emit('saved', id)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.cpd-body { display: flex; flex-direction: column; gap: var(--space-3); }
.cpd-presets { display: flex; flex-wrap: wrap; gap: var(--space-1-5); }
.cpd-preset {
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-label);
  color: var(--color-text-secondary);
  background: var(--color-bg);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.cpd-preset:hover { border-color: var(--color-interact-hover); color: var(--color-text); }
.cpd-preset.active { border-color: var(--color-interact-text); background: var(--color-primary-soft); color: var(--color-interact-text); font-weight: 500; }
.cpd-hint {
  margin: 0;
  font-size: var(--text-label);
  color: var(--color-text-muted);
  line-height: 1.5;
}
.pv-cred-error {
  margin: 0;
  padding: var(--space-1-5) var(--space-2);
  font-size: var(--text-label);
  color: var(--status-failed);
  background: color-mix(in srgb, var(--status-failed) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--status-failed) 30%, transparent);
  border-radius: var(--radius-sm);
  word-break: break-word;
}
.settings-input {
  width: 100%;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  padding: var(--space-1-5) var(--space-2-5);
  outline: none;
  transition: border-color var(--dur-fast) var(--ease-out);
}
.settings-input:focus { border-color: var(--color-ring); }
.settings-input::placeholder { color: var(--color-text-muted); }
</style>
