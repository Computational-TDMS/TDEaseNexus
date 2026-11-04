<template>
  <div v-if="provider" class="pv-detail-inner">
    <!-- Header -->
    <div class="pv-detail-header">
      <h2 class="pv-detail-title">{{ provider.displayName }}</h2>
      <span v-if="isActive" class="pv-active-badge">{{ t('workbench.settings.providers.inUse') }}</span>
    </div>

    <!-- Credentials for api-key providers -->
    <div v-if="provider.authType === 'api-key'" class="pv-credentials">
      <!-- Name row (custom providers only): the display name lives in
           settings.json, not the catalog, so it edits like the rest. -->
      <Field v-if="custom" :label="t('workbench.settings.providers.name')" class="pv-cred-row">
        <template #default="{ id }">
          <input
            :id="id"
            v-model="customName"
            class="settings-input"
            type="text"
            spellcheck="false" autocomplete="off"
          />
        </template>
      </Field>

      <!-- API Key row -->
      <Field :label="t('workbench.settings.providers.apiKey')" class="pv-cred-row">
        <template #default="{ id }">
          <div class="pv-cred-keycol">
            <div class="pv-cred-key-row">
              <input
                :id="id"
                :type="keyVisible ? 'text' : 'password'"
                class="settings-input"
                :value="apiKey"
                :placeholder="configured ? t('workbench.settings.providers.apiKeyConfigured') : t('workbench.settings.providers.apiKeyPlaceholder')"
                spellcheck="false" autocomplete="off"
                @input="onKeyInput"
              />
              <button class="pv-cred-conn-icon" type="button" :title="keyVisible ? t('workbench.settings.providers.hide') : t('workbench.settings.providers.show')" @click="keyVisible = !keyVisible">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <template v-if="keyVisible">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" />
                  </template>
                  <template v-else>
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                  </template>
                </svg>
              </button>
            </div>
            <!-- Where the key comes from: the main window's open-handler routes
                 http(s) to the OS browser, so a plain anchor is enough. -->
            <a
              v-if="provider.keyUrl"
              class="pv-cred-keylink"
              :href="provider.keyUrl"
              target="_blank" rel="noreferrer noopener"
            >{{ t('workbench.settings.providers.getApiKey') }}</a>
          </div>
        </template>
      </Field>

      <!-- Base URL row -->
      <Field :label="t('workbench.settings.providers.baseUrl')" class="pv-cred-row">
        <template #default="{ id }">
          <div class="pv-cred-url-row">
            <input
              :id="id"
              class="settings-input"
              type="text" :value="baseUrl"
              :placeholder="provider.defaultBaseUrl || t('workbench.settings.providers.baseUrlPlaceholder')"
              spellcheck="false"
              :aria-invalid="baseUrlIssue ? 'true' : undefined"
              @input="onBaseUrlInput"
            />
            <p v-if="baseUrlIssue" class="pv-cred-error" role="alert">
              {{ t(`workbench.settings.providers.baseUrlIssue.${baseUrlIssue}`) }}
            </p>
            <p v-else-if="!baseUrl" class="pv-cred-hint">{{ t('workbench.settings.providers.baseUrlHint') }}</p>
          </div>
        </template>
      </Field>

      <!-- Save + clear + delete -->
      <div class="pv-cred-actions">
        <AppButton variant="primary" size="sm" class="pv-cred-save" :disabled="saving || !credDirty || baseUrlIssue !== null" :loading="saving" @click="saveCred">
          {{ savedTick ? t('workbench.settings.providers.saved') : t('workbench.settings.providers.saveConfig') }}
        </AppButton>
        <!-- The probe reads the PERSISTED config in the main process; while
             edits are unsaved the dirty Save button says so, and an invalid
             URL fails before any wire traffic. -->
        <AppButton
          variant="subtle" size="sm"
          :disabled="testing || baseUrlIssue !== null" :loading="testing"
          @click="onTestConnection"
        >
          {{ testing ? t('workbench.settings.providers.testing') : t('workbench.settings.providers.testConnection') }}
        </AppButton>
        <!-- Custom providers delete through the dedicated whole-entry action
             below: "clear credentials" would leave an empty ghost entry. -->
        <AppButton
          v-if="configured && !custom"
          variant="subtle" size="sm" class="pv-cred-clear"
          :class="{ armed: clearArmed }"
          @click="clearCred"
        >
          {{ clearArmed ? t('workbench.settings.providers.clearConfirm') : t('workbench.settings.providers.clearConfig') }}
        </AppButton>
        <AppButton
          v-if="custom"
          variant="subtle" size="sm" class="pv-cred-clear"
          :class="{ armed: deleteArmed }"
          @click="deleteProvider"
        >
          {{ deleteArmed ? t('workbench.settings.providers.deleteConfirm') : t('workbench.settings.providers.deleteProvider') }}
        </AppButton>
      </div>
      <p v-if="saveError" class="pv-cred-error" role="alert">{{ saveError }}</p>
      <p v-if="testVerdict" :class="['pv-test-verdict', testVerdict.ok ? 'ok' : 'fail']" role="status">
        {{ testVerdictText }}
      </p>
    </div>

    <!-- None / OAuth -->
    <p v-if="provider.authType === 'none'" class="pv-note">{{ t('workbench.settings.providers.noAuthNeeded') }}</p>

    <!-- OAuth account login (pi flows: ChatGPT sign-in / Anthropic account) -->
    <div v-if="supportsAccountLogin" class="pv-oauth">
      <div class="pv-oauth__row">
        <span :class="['pv-oauth__status', { on: authConfigured }]">
          {{ authConfigured ? t('workbench.settings.providers.loggedIn') : t('workbench.settings.providers.notLoggedIn') }}
          <template v-if="authConfigured && authLabel"> · {{ authLabel }}</template>
        </span>
        <AppButton v-if="!authBusy" size="sm" variant="subtle" class="pv-oauth__btn" @click="startLogin">
          {{ t('workbench.settings.providers.accountLogin') }}
        </AppButton>
        <AppButton v-else size="sm" variant="subtle" class="pv-oauth__btn" @click="cancelLogin">
          {{ t('workbench.settings.providers.loginCancel') }}
        </AppButton>
      </div>
      <p v-if="authError" class="pv-cred-error" role="alert">{{ authError }}</p>
      <p v-if="authNotifyText" class="pv-oauth__note">{{ authNotifyText }}</p>
      <div v-if="authPrompt" class="pv-oauth__prompt">
        <p class="pv-oauth__message">{{ authPrompt.message }}</p>
        <div
          v-if="authPrompt.type === 'text' || authPrompt.type === 'secret' || authPrompt.type === 'manual_code'"
          class="pv-cred-key-row"
        >
          <input
            v-model="promptValue"
            class="settings-input"
            :type="authPrompt.type === 'secret' ? 'password' : 'text'"
            :placeholder="authPrompt.placeholder"
            spellcheck="false" autocomplete="off"
            @keyup.enter="submitPrompt(authPrompt.promptId, promptValue)"
          />
          <AppButton size="sm" variant="primary" class="pv-oauth__btn" @click="submitPrompt(authPrompt.promptId, promptValue)">
            {{ t('workbench.settings.providers.loginSubmit') }}
          </AppButton>
        </div>
        <div v-else-if="authPrompt.type === 'select'" class="provider-models__list">
          <button
            v-for="opt in authPrompt.options" :key="opt.id"
            type="button" class="model-chip" :title="opt.description"
            @click="submitPrompt(authPrompt.promptId, opt.id)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
    </div>

    <!-- Models. A fresh custom provider has zero models — the manual entry
         below must stay reachable, hence the custom branch in the condition. -->
    <div v-if="provider.models.length > 0 || extraModels.length > 0 || custom" class="provider-models">
      <div class="provider-models__head">
        <h3 class="provider-models__title">{{ t('workbench.settings.providers.models') }}</h3>
        <span v-if="testResult" class="provider-models__meta pv-oauth__status on">{{ testResult }}</span>
        <span v-else-if="refreshMeta" class="provider-models__meta">{{ refreshMeta }}</span>
        <button
          v-if="provider.authType !== 'oauth'"
          class="pv-models-refresh" type="button"
          :disabled="refreshing"
          :title="refreshing ? t('workbench.settings.providers.modelsRefreshing') : t('workbench.settings.providers.modelsRefresh')"
          @click="onRefresh"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" :class="{ spinning: refreshing }">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
      </div>
      <div class="provider-models__list">
        <span
          v-for="m in provider.models" :key="m"
          :class="['model-chip', { active: m === selectedModel }]"
          @click="$emit('selectModel', m)"
        >{{ m }}</span>
        <span
          v-for="m in extraModels" :key="m"
          :class="['model-chip', 'model-chip--new', { active: m === selectedModel }]"
          @click="$emit('selectModel', m)"
        >{{ m }}<span class="model-chip__badge">{{ t('workbench.settings.providers.modelsNew') }}</span></span>
      </div>
      <p v-if="refreshError" class="pv-models-error" role="status">{{ refreshError }}</p>
      <!-- Manual model entry: a custom endpoint without a /models listing must
           still be usable — the typed id becomes the picker's truth. -->
      <div v-if="custom" class="provider-models__add">
        <input
          v-model="manualModel"
          class="settings-input provider-models__add-input"
          type="text"
          :placeholder="t('workbench.settings.providers.addModelPlaceholder')"
          spellcheck="false" @keyup.enter="addModel"
        />
        <AppButton size="sm" variant="subtle" :disabled="!manualModel.trim()" @click="addModel">
          {{ t('workbench.settings.providers.addModel') }}
        </AppButton>
      </div>
    </div>

    <!-- Per-model pricing (custom endpoints only): no vendor catalog prices
         these, so the cost column in statistics stays blind until the user
         declares one. An all-empty row clears that model's price. -->
    <div v-if="custom && pricingRows.length > 0" class="provider-pricing">
      <div class="provider-models__head">
        <h3 class="provider-models__title">{{ t('workbench.settings.providers.pricing.title') }}</h3>
        <span class="provider-models__meta">{{ t('workbench.settings.providers.pricing.unit') }}</span>
      </div>
      <div class="pricing-rows">
        <div class="pricing-row pricing-row--head" aria-hidden="true">
          <span class="pricing-model">{{ t('workbench.settings.providers.pricing.model') }}</span>
          <span>{{ t('workbench.settings.providers.pricing.input') }}</span>
          <span>{{ t('workbench.settings.providers.pricing.output') }}</span>
          <span>{{ t('workbench.settings.providers.pricing.cacheRead') }}</span>
          <span>{{ t('workbench.settings.providers.pricing.cacheWrite') }}</span>
        </div>
        <div v-for="modelId in pricingRows" :key="modelId" class="pricing-row">
          <span class="pricing-model" :title="modelId">{{ modelId }}</span>
          <input v-model="pricingDraft[modelId].input" class="settings-input pricing-input" type="number" min="0" step="any" spellcheck="false" autocomplete="off" />
          <input v-model="pricingDraft[modelId].output" class="settings-input pricing-input" type="number" min="0" step="any" spellcheck="false" autocomplete="off" />
          <input v-model="pricingDraft[modelId].cacheRead" class="settings-input pricing-input" type="number" min="0" step="any" spellcheck="false" autocomplete="off" />
          <input v-model="pricingDraft[modelId].cacheWrite" class="settings-input pricing-input" type="number" min="0" step="any" spellcheck="false" autocomplete="off" />
        </div>
      </div>
      <div class="pricing-actions">
        <AppButton size="sm" variant="primary" :disabled="pricingSaving || !pricingDirty" :loading="pricingSaving" @click="savePricing">
          {{ t('workbench.settings.providers.pricing.save') }}
        </AppButton>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/settings'
import type { ProviderInfo } from '@/services/catalog/providerCatalog'
import { getBaseUrlIssue, normalizeBaseUrlInput } from '@/services/catalog/provider-endpoint'
import {
  desktopProviderAuthBridge,
  type ProviderAuthPromptViewBridge,
} from '@/services/desktop/desktopBridge'
import Field from '../primitives/Field.vue'
import AppButton from '@/components/primitives/AppButton.vue'
import {
  desktopAgentProvidersBridge,
  type ProviderTestResultBridge,
  type ModelPricingBridge,
} from '@/services/desktop/desktopBridge'

const { t } = useI18n()
const props = defineProps<{ provider: ProviderInfo; selectedModel: string | null; custom?: boolean }>()
const emit = defineEmits<{ selectModel: [modelId: string]; saved: []; deleted: [] }>()
const settings = useSettingsStore()

const apiKey = ref('')
const baseUrl = ref('')
const configured = ref(false)
const keyVisible = ref(false)
const saving = ref(false)
// The Base URL as last persisted: the save button stays disabled until the
// form differs from this — clicking save with nothing typed must be a no-op,
// not a mystery write.
const savedBaseUrl = ref('')
const savedTick = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null
// Two-step clear: first click arms, second click within the window deletes.
const clearArmed = ref(false)
let clearTimer: ReturnType<typeof setTimeout> | null = null
// Custom-provider editing: display name + whole-entry delete (both two-step
// or dirty-guarded like the credential rows).
const customName = ref('')
const deleteArmed = ref(false)
let deleteTimer: ReturnType<typeof setTimeout> | null = null
const manualModel = ref('')

const nameDirty = computed(() =>
  props.custom === true
  && customName.value.trim() !== ''
  && customName.value.trim() !== props.provider.displayName)
const credDirty = computed(() =>
  apiKey.value.trim() !== ''
  || baseUrl.value !== savedBaseUrl.value
  || nameDirty.value)
const baseUrlIssue = computed(() => getBaseUrlIssue(baseUrl.value))
/** Whether this browsed provider is the one sessions actually bind against. */
const isActive = computed(() => settings.provider === props.provider.id)
// `saveError` is null on success, a localized message on failure. A failed
// credential write used to disappear silently (try/finally, no catch): the
// button just un-disabled with no signal whether anything was persisted. The
// banner keeps the failure visible; it auto-clears after 6s so a stale error
// does not linger over a later success.
const saveError = ref<string | null>(null)
let saveErrorTimer: ReturnType<typeof setTimeout> | null = null

function setSaveError(message: string) {
  saveError.value = message
  if (saveErrorTimer) clearTimeout(saveErrorTimer)
  saveErrorTimer = setTimeout(() => { saveError.value = null }, 6000)
}

// Connection-test state lives BEFORE loadCred: the immediate watch calls
// loadCred during setup, and a declaration below would be a temporal dead
// zone at that moment (shipped once — the whole load aborted mid-flight).
const testing = ref(false)
const testVerdict = ref<ProviderTestResultBridge | null>(null)

async function loadCred() {
  apiKey.value = ''
  customName.value = props.provider.displayName
  testVerdict.value = null
  await settings.refreshAgentProviders()
  const summary = settings.providerSummary(props.provider.id)
  baseUrl.value = summary?.baseUrl ?? ''
  savedBaseUrl.value = baseUrl.value
  configured.value = summary?.configured === true
  // Live model list: fire-and-forget — main TTL-caches, so revisiting a
  // recently seen provider costs no network roundtrip.
  void settings.refreshProviderModels(props.provider.id)
  void loadPricing()
}
watch(() => props.provider.id, () => { void loadCred() }, { immediate: true })

// ── Per-model pricing (custom endpoints) ─────────────────────────────────────

/** Only settings-registered models can be priced — for custom providers
 *  `provider.models` IS that list (no static catalog floor). Discovered-only
 *  ids join after first use registers them. */
const pricingRows = computed(() => (props.custom === true ? props.provider.models : []))
const pricingDraft = ref<Record<string, { input: string; output: string; cacheRead: string; cacheWrite: string }>>({})
const savedPricing = ref<Record<string, ModelPricingBridge>>({})
const pricingSaving = ref(false)

async function loadPricing() {
  if (props.custom !== true) return
  await settings.refreshProviderPricing(props.provider.id)
  rebuildPricingDraft()
}

/** The draft mirrors the stored prices as display strings; number inputs keep
 *  the raw text so a half-typed value is never silently rewritten. */
function rebuildPricingDraft() {
  const stored = settings.providerModelPricing(props.provider.id)
  savedPricing.value = stored
  const draft: typeof pricingDraft.value = {}
  for (const modelId of pricingRows.value) {
    const cost = stored[modelId]
    draft[modelId] = cost
      ? {
          input: cost.input != null ? String(cost.input) : '',
          output: cost.output != null ? String(cost.output) : '',
          cacheRead: cost.cacheRead != null ? String(cost.cacheRead) : '',
          cacheWrite: cost.cacheWrite != null ? String(cost.cacheWrite) : '',
        }
      : { input: '', output: '', cacheRead: '', cacheWrite: '' }
  }
  pricingDraft.value = draft
}

// A hand-added model lands in the registered list via the parent's reactive
// refresh — the draft follows so the new row is priceable without a remount.
watch(pricingRows, rebuildPricingDraft)

/** An all-empty row parses to null = "unpriced" (clears the stored cost). */
function parsePricingRow(row: { input: string; output: string; cacheRead: string; cacheWrite: string } | undefined): ModelPricingBridge | null {
  if (!row) return null
  const rate = (value: string): number | null => {
    if (value.trim() === '') return null
    const n = Number(value)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  const input = rate(row.input)
  const output = rate(row.output)
  const cacheRead = rate(row.cacheRead)
  const cacheWrite = rate(row.cacheWrite)
  if (input === null && output === null && cacheRead === null && cacheWrite === null) return null
  return { input: input ?? 0, output: output ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0 }
}

function samePricing(a: ModelPricingBridge | null, b: ModelPricingBridge | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite
}

const pricingDirty = computed(() =>
  pricingRows.value.some((modelId) =>
    !samePricing(parsePricingRow(pricingDraft.value[modelId]), savedPricing.value[modelId] ?? null)))

async function savePricing() {
  pricingSaving.value = true
  try {
    for (const modelId of pricingRows.value) {
      const parsed = parsePricingRow(pricingDraft.value[modelId])
      if (samePricing(parsed, savedPricing.value[modelId] ?? null)) continue
      await settings.setProviderModelPricing(props.provider.id, modelId, parsed)
    }
    rebuildPricingDraft()
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    setSaveError(t('workbench.settings.providers.saveFailed', { error: message }))
  } finally {
    pricingSaving.value = false
  }
}

// ── Live model list (discovery + aggregator, merged additively) ──────────────

const refreshed = computed(() => settings.providerModelsRefresh(props.provider.id))
/** Models the refresh found beyond the curated static list. */
const extraModels = computed(() => {
  const result = refreshed.value
  if (!result?.models.length) return []
  return result.models.filter((modelId) => !props.provider.models.includes(modelId))
})
const refreshing = ref(false)
// Connection-test verdict: a forced refresh IS the connectivity test (the
// vendor listing is fetched with the user's credential). Shown until the
// provider changes or another refresh runs.
const testResult = ref<string | null>(null)
const refreshMeta = computed(() => {
  const result = refreshed.value
  if (!result || result.source === 'none' || !result.models.length) return ''
  const sourceLabel = t(`workbench.settings.providers.modelsSource.${result.source}`)
  return result.updatedAt ? `${sourceLabel} · ${new Date(result.updatedAt).toLocaleString()}` : sourceLabel
})
const refreshError = computed(() => refreshed.value?.error ?? '')

async function onRefresh() {
  refreshing.value = true
  testResult.value = null
  try {
    await settings.refreshProviderModels(props.provider.id, { force: true })
    const result = settings.providerModelsRefresh(props.provider.id)
    if (result?.error) testResult.value = null
    else if (result) testResult.value = `${t('workbench.settings.providers.connectionOk')} · ${result.models.length}`
  } finally {
    refreshing.value = false
  }
}

// ── Explicit connection test (typed verdict from the main process) ──────────

const testVerdictText = computed(() => {
  const verdict = testVerdict.value
  if (!verdict) return ''
  if (verdict.ok) {
    return verdict.modelCount != null
      ? t('workbench.settings.providers.testOk', { n: verdict.modelCount, ms: verdict.latencyMs ?? 0 })
      : t('workbench.settings.providers.testOkNoCount', { ms: verdict.latencyMs ?? 0 })
  }
  const code = verdict.code ?? 'network'
  return t(`workbench.settings.providers.testFail.${code}`, { detail: verdict.detail ?? '' })
})

async function onTestConnection() {
  const bridge = desktopAgentProvidersBridge()
  if (!bridge || testing.value) return
  testing.value = true
  testVerdict.value = null
  try {
    testVerdict.value = await bridge.testProvider(props.provider.id)
  } catch (cause) {
    testVerdict.value = {
      ok: false, code: 'network', latencyMs: null, modelCount: null,
      detail: cause instanceof Error ? cause.message : String(cause),
    }
  } finally {
    testing.value = false
  }
}

// ── OAuth account login (pi flows bridged over IPC) ──────────────────────────

// Mirror of OAUTH_PROVIDER_IDS in electron/agent/provider-auth.ts — the
// providers whose account login the runtime ships. api-key providers here
// (anthropic) keep their key field; this section is the alternative path.
const OAUTH_LOGIN_IDS = new Set(['openai-codex-oauth', 'anthropic'])
const supportsAccountLogin = computed(() =>
  OAUTH_LOGIN_IDS.has(props.provider.id) || props.provider.authType === 'oauth')

const authBusy = ref(false)
const authConfigured = ref(false)
const authLabel = ref('')
const authError = ref<string | null>(null)
const authNotifyText = ref<string | null>(null)
const authPrompt = ref<ProviderAuthPromptViewBridge | null>(null)
const promptValue = ref('')
let unsubscribeAuth: (() => void) | null = null

async function loadAuthStatus() {
  const bridge = desktopProviderAuthBridge()
  if (!bridge || !supportsAccountLogin.value) return
  try {
    const mine = (await bridge.status()).find((entry) => entry.id === props.provider.id)
    authConfigured.value = mine?.configured === true
    authLabel.value = mine?.label ?? mine?.source ?? ''
    // The pi catalog's model ids for this provider join the picker through
    // the same additive merge the live refresh feeds.
    if (mine?.models?.length) settings.noteOAuthModels(props.provider.id, mine.models)
  } catch { /* best-effort status */ }
}

function subscribeAuth() {
  const bridge = desktopProviderAuthBridge()
  if (!bridge) return
  unsubscribeAuth?.()
  unsubscribeAuth = bridge.onEvent((payload) => {
    if (payload.kind === 'notify') {
      const event = payload.event
      if (event.type === 'auth_url') {
        authNotifyText.value = t('workbench.settings.providers.browserOpened') + (event.instructions ? ` ${event.instructions}` : '')
      } else if (event.type === 'device_code') {
        authNotifyText.value = `${event.userCode} → ${event.verificationUri}`
      } else {
        authNotifyText.value = event.message
      }
    } else if (payload.kind === 'prompt') {
      authPrompt.value = payload.prompt
      promptValue.value = ''
    } else if (payload.kind === 'done') {
      authBusy.value = false
      authPrompt.value = null
      // A user-initiated cancel already closed its own state; surface real failures.
      if (!payload.ok && payload.error && !/cancel/i.test(payload.error)) authError.value = payload.error
      if (payload.ok) authNotifyText.value = null
      void loadAuthStatus()
    }
  })
}

async function startLogin() {
  const bridge = desktopProviderAuthBridge()
  if (!bridge) return
  authBusy.value = true
  authError.value = null
  authNotifyText.value = null
  authPrompt.value = null
  const result = await bridge.login(props.provider.id).catch((cause) => ({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }))
  authBusy.value = false
  if (!result.ok && result.error && !/cancel/i.test(result.error)) authError.value = result.error
}

function cancelLogin() {
  desktopProviderAuthBridge()?.cancel()
}

async function submitPrompt(promptId: string, value: string) {
  authPrompt.value = null
  await desktopProviderAuthBridge()?.resolvePrompt(promptId, value)
}

onMounted(() => {
  subscribeAuth()
  void loadAuthStatus()
})
onBeforeUnmount(() => {
  unsubscribeAuth?.()
  unsubscribeAuth = null
})

function onKeyInput(e: Event) { apiKey.value = (e.target as HTMLInputElement).value }
function onBaseUrlInput(e: Event) { baseUrl.value = (e.target as HTMLInputElement).value }

async function saveCred() {
  saving.value = true
  saveError.value = null
  // Paste-back hygiene: the operation endpoint a vendor's curl example hands
  // out is normalized to the service root, and the input reflects what was
  // actually stored — otherwise the dirty guard would keep seeing a diff.
  const storedBaseUrl = normalizeBaseUrlInput(baseUrl.value)
  try {
    await settings.setCredentials(props.provider.id, {
      apiKey: apiKey.value || undefined,
      baseUrl: storedBaseUrl || undefined,
    })
    if (nameDirty.value) {
      await settings.updateCustomProvider(props.provider.id, { name: customName.value })
    }
    apiKey.value = ''
    baseUrl.value = storedBaseUrl
    savedBaseUrl.value = storedBaseUrl
    configured.value = settings.providerSummary(props.provider.id)?.configured === true
    emit('saved')
    // Transient "saved" pulse on the button — success used to be silent.
    savedTick.value = true
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => { savedTick.value = false }, 3000)
    // The verdict belongs to the config it probed; a new save invalidates it.
    testVerdict.value = null
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    setSaveError(t('workbench.settings.providers.saveFailed', { error: message }))
  } finally {
    saving.value = false
  }
}

/** Two-step clear: arm, then confirm within the window. The apiKey is never
 *  readable again, so an accidental single click must not destroy it. */
async function clearCred() {
  if (!clearArmed.value) {
    clearArmed.value = true
    if (clearTimer) clearTimeout(clearTimer)
    clearTimer = setTimeout(() => { clearArmed.value = false }, 3000)
    return
  }
  clearArmed.value = false
  saveError.value = null
  try {
    await settings.clearCredentials(props.provider.id)
    apiKey.value = ''
    baseUrl.value = ''
    savedBaseUrl.value = ''
    configured.value = false
    emit('saved')
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    setSaveError(t('workbench.settings.providers.saveFailed', { error: message }))
  }
}

/** Whole-entry delete for custom providers (two-step, like clearCred). The
 *  parent reacts to `deleted` by dropping the selection — this provider id
 *  ceases to exist and nothing may keep browsing it. */
async function deleteProvider() {
  if (!deleteArmed.value) {
    deleteArmed.value = true
    if (deleteTimer) clearTimeout(deleteTimer)
    deleteTimer = setTimeout(() => { deleteArmed.value = false }, 3000)
    return
  }
  deleteArmed.value = false
  saveError.value = null
  try {
    await settings.removeCustomProvider(props.provider.id)
    emit('deleted')
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    setSaveError(t('workbench.settings.providers.saveFailed', { error: message }))
  }
}

/** Hand-typed model id (custom endpoints without a /models listing). */
async function addModel() {
  const modelId = manualModel.value.trim()
  if (!modelId) return
  try {
    await settings.addProviderModel(props.provider.id, modelId)
    manualModel.value = ''
    if (!props.provider.models.includes(modelId)) emit('saved')
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    setSaveError(t('workbench.settings.providers.saveFailed', { error: message }))
  }
}

onBeforeUnmount(() => {
  if (saveErrorTimer) clearTimeout(saveErrorTimer)
  if (savedTimer) clearTimeout(savedTimer)
  if (clearTimer) clearTimeout(clearTimer)
  if (deleteTimer) clearTimeout(deleteTimer)
})
</script>

<style scoped>
.pv-detail-inner { max-width: 560px; }

.pv-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-4);
}

.pv-detail-title {
  font-size: var(--text-lg);
  font-weight: 600;
  margin: 0;
  color: var(--color-text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pv-note { font-size: var(--text-base); color: var(--color-text-muted); margin: 0; }

/* ─── Active-pair badge ─── */
.pv-active-badge {
  padding: 0 var(--space-1-5);
  font-size: 0.62rem;
  font-weight: 600;
  line-height: 1.6;
  color: var(--color-primary);
  background: var(--color-primary-soft);
  border-radius: var(--radius-xs);
  flex-shrink: 0;
  white-space: nowrap;
}

/* ─── OAuth account login ─── */
.pv-oauth {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  margin-bottom: var(--space-4);
  padding-bottom: var(--space-4);
  border-bottom: var(--line-w) solid var(--line-hairline);
}
.pv-oauth__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.pv-oauth__status {
  font-size: var(--text-label);
  color: var(--color-text-muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pv-oauth__status.on { color: var(--status-ok, var(--color-success)); }
.pv-oauth__btn { flex-shrink: 0; }
.pv-oauth__note {
  margin: 0;
  font-size: var(--text-label);
  color: var(--color-text-secondary);
  word-break: break-word;
}
.pv-oauth__prompt {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  padding: var(--space-2);
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
}
.pv-oauth__message {
  margin: 0;
  font-size: var(--text-label);
  color: var(--color-text);
  word-break: break-word;
}

/* ─── Credentials (exact OpenHanako pv-cred-*) ─── */
.pv-credentials {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  margin-bottom: var(--space-4);
  padding-bottom: var(--space-4);
  border-bottom: var(--line-w) solid var(--line-hairline);
}

.pv-cred-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 28px;
}

/* Field overrides to match the horizontal credential row layout */
.pv-credentials > .field.pv-cred-row {
  flex-direction: row;
  gap: var(--space-2);
}

.pv-credentials > .field.pv-cred-row .field__label {
  font-size: var(--text-label);
  color: var(--color-text-muted);
  width: 72px;
  flex-shrink: 0;
}

.pv-credentials > .field.pv-cred-row .field__control {
  flex: 1;
  min-width: 0;
  margin-top: 0;
}

.pv-cred-key-row {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  flex: 1;
  min-width: 0;
}

.pv-cred-url-row {
  flex: 1;
  min-width: 0;
}

.pv-cred-conn-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s ease;
}
.pv-cred-conn-icon:hover { color: var(--color-interact-hover); border-color: var(--color-border-control-hover); }

.pv-cred-save {
  font-family: var(--font-body);
  font-size: var(--text-label);
  padding: var(--space-1-5) var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--color-primary);
  color: var(--color-on-primary);
  cursor: pointer;
  white-space: nowrap;
}

.pv-cred-error {
  margin: 0;
  padding: var(--space-1-5) var(--space-2);
  font-size: var(--text-label);
  color: var(--status-failed);
  background: color-mix(in srgb, var(--status-failed) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--status-failed) 30%, transparent);
  border-radius: var(--radius-sm);
  align-self: flex-start;
  max-width: 100%;
  word-break: break-word;
}

/* Connection-test verdict: success speaks in the ok channel, failure reuses
   the error channel — the same discipline as the OAuth status line. */
.pv-test-verdict {
  margin: var(--space-1) 0 0;
  padding: var(--space-1-5) var(--space-2);
  font-size: var(--text-label);
  border-radius: var(--radius-sm);
  align-self: flex-start;
  max-width: 100%;
  word-break: break-word;
}
.pv-test-verdict.ok {
  color: var(--status-ok, var(--color-success));
  background: color-mix(in srgb, var(--status-ok, var(--color-success)) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--status-ok, var(--color-success)) 30%, transparent);
}
.pv-test-verdict.fail {
  color: var(--status-failed);
  background: color-mix(in srgb, var(--status-failed) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--status-failed) 30%, transparent);
}

.pv-cred-hint {
  margin: var(--space-1) 0 0;
  font-size: 0.62rem;
  color: var(--color-text-muted);
}

.pv-cred-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
  align-self: flex-start;
}
.pv-cred-clear.armed {
  color: var(--status-failed);
  border-color: color-mix(in srgb, var(--status-failed) 40%, transparent);
}

/* ─── Shared input (matches .settings-input in OpenHanako) ─── */
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

.pv-cred-key-row .settings-input { padding-right: var(--space-6); font-family: var(--font-mono); font-size: var(--text-label); letter-spacing: 0.02em; }

/* Vendor console link under the key input (featured providers only). */
.pv-cred-keycol { flex: 1; min-width: 0; }
.pv-cred-keylink {
  display: inline-block;
  margin-top: var(--space-1);
  font-size: 0.62rem;
  color: var(--color-primary);
  text-decoration: none;
}
.pv-cred-keylink:hover { text-decoration: underline; }

/* ─── Models section (extracted from inline styles) ─── */
.provider-models { margin-top: var(--space-2); }
.provider-models__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-2);
}
.provider-models__title {
  font-size: var(--text-label);
  font-weight: 600;
  color: var(--color-text-secondary);
  margin: 0;
}
.provider-models__meta {
  font-size: var(--text-label);
  color: var(--color-text-muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pv-models-refresh {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-left: auto;
  background: none;
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s ease;
}
.pv-models-refresh:hover:not(:disabled) { color: var(--color-interact-hover); border-color: var(--color-border-control-hover); }
.pv-models-refresh:disabled { cursor: default; opacity: 0.6; }
.pv-models-refresh .spinning { animation: pv-models-spin 0.9s linear infinite; }
@keyframes pv-models-spin { to { transform: rotate(360deg); } }
.provider-models__list { display: flex; flex-wrap: wrap; gap: var(--space-1-5); }

.provider-models__add { display: flex; align-items: center; gap: var(--space-1-5); margin-top: var(--space-2); }
.provider-models__add .settings-input { max-width: 260px; padding: var(--space-1) var(--space-2); }

.pv-models-error {
  margin: var(--space-1-5) 0 0;
  font-size: var(--text-label);
  color: var(--color-text-muted);
  word-break: break-word;
}

/* ─── Model chips ─── */
.model-chip {
  padding: var(--space-1-5) var(--space-2-5);
  font-size: var(--text-label);
  font-family: var(--font-mono);
  color: var(--color-text-secondary);
  background: var(--color-bg);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.model-chip:hover { border-color: var(--color-interact-hover); color: var(--color-text); }
.model-chip.active { border-color: var(--color-interact-text); background: var(--color-primary-soft); color: var(--color-interact-text); font-weight: 500; }

/* Discovered-only chip: dashed border marks it as not in the curated list. */
.model-chip--new { border-style: dashed; }
.model-chip__badge {
  margin-left: var(--space-1);
  padding: 0 var(--space-1);
  font-size: 0.6rem;
  font-family: var(--font-body);
  line-height: 1.4;
  color: var(--color-primary);
  background: var(--color-primary-soft);
  border-radius: var(--radius-xs);
}

/* ─── Per-model pricing (custom endpoints) ─── */
.provider-pricing { margin-top: var(--space-2); }
.pricing-rows { display: flex; flex-direction: column; gap: var(--space-1-5); }
.pricing-row {
  display: grid;
  grid-template-columns: minmax(96px, 1.4fr) repeat(4, minmax(64px, 1fr));
  gap: var(--space-1-5);
  align-items: center;
}
.pricing-row--head {
  font-size: var(--domain-text-meta);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.pricing-model {
  font-family: var(--font-mono);
  font-size: var(--text-label);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pricing-input {
  padding: var(--space-1) var(--space-1-5);
  font-family: var(--font-mono);
  font-size: var(--text-label);
  text-align: right;
}
/* Hide the number spinners — a price is typed, not stepped. */
.pricing-input::-webkit-outer-spin-button,
.pricing-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.pricing-input[type='number'] { -moz-appearance: textfield; appearance: textfield; }
.pricing-actions { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2); }
</style>
