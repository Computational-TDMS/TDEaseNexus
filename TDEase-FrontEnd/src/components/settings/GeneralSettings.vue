<template>
  <div class="settings-tab-content active" data-tab="general">
    <!-- Provider & Model -->
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">{{ t('workbench.settings.general.providerModel') }}</h2>
      </div>
      <div class="surface-card">
        <Field :label="t('workbench.settings.general.provider')">
          <template #default="{ id }">
            <select :id="id" v-model="selectedProvider" class="settings-select" @change="onProviderChange">
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.displayName }}</option>
            </select>
          </template>
        </Field>
        <Field :label="t('workbench.settings.general.model')">
          <template #default="{ id }">
            <select :id="id" v-model="selectedModel" class="settings-select">
              <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
            </select>
          </template>
        </Field>
      </div>
    </section>

    <section class="section">
      <div class="section-header"><h2 class="section-title">{{ t('workbench.settings.general.workflowService') }}</h2></div>
      <div class="surface-card">
        <Field :label="t('workbench.settings.general.service')">
          <template #default="{ id }">
            <select :id="id" v-model="backendMode" class="settings-select">
              <option value="disabled">{{ t('workbench.settings.general.notConnected') }}</option>
              <option value="local">{{ t('workbench.settings.general.local') }}</option>
              <option value="remote">{{ t('workbench.settings.general.remoteServer') }}</option>
            </select>
          </template>
        </Field>
        <Field v-if="backendMode === 'remote'" :label="t('workbench.settings.general.serverUrl')">
          <template #default="{ id }">
            <input :id="id" v-model="backendUrl" class="settings-input" :placeholder="t('workbench.settings.general.serverUrlPlaceholder')" />
          </template>
        </Field>
        <Field v-if="backendMode === 'remote'" :label="t('workbench.settings.general.serverToken')">
          <template #default="{ id }">
            <input
              :id="id"
              v-model="backendAccessToken"
              class="settings-input"
              type="password"
              autocomplete="off"
              :placeholder="backendTokenConfigured ? t('workbench.settings.general.serverTokenSaved') : t('workbench.settings.general.serverTokenPlaceholder')"
            />
          </template>
        </Field>
        <div v-if="backendMode !== 'disabled'" class="row row-inline">
          <div class="row-text"><div class="row-label">{{ backendConnected ? t('workbench.statusBar.backendConnected') : backendError || t('workbench.settings.general.notConnected') }}</div></div>
          <div class="row-control"><AppButton variant="primary" size="sm" class="settings-connect" @click="connectBackend">{{ t('workbench.settings.general.connect') }}</AppButton></div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-header"><h2 class="section-title">{{ t('workbench.settings.general.proxyTitle') }}</h2></div>
      <div class="surface-card">
        <Field :label="t('workbench.settings.general.proxyUrl')">
          <template #default="{ id }">
            <input :id="id" v-model="proxyUrl" class="settings-input" :placeholder="t('workbench.settings.general.proxyUrlPlaceholder')" />
          </template>
        </Field>
        <Field :label="t('workbench.settings.general.proxyNoProxy')">
          <template #default="{ id }">
            <input :id="id" v-model="proxyNoProxy" class="settings-input" :placeholder="t('workbench.settings.general.proxyNoProxyPlaceholder')" />
          </template>
        </Field>
        <div class="row row-inline">
          <div class="row-text">
            <div class="row-hint">{{ proxyJustSaved ? t('workbench.settings.general.proxySaved') : t('workbench.settings.general.proxyHint') }}</div>
          </div>
          <div class="row-control">
            <AppButton variant="primary" size="sm" class="settings-connect" :disabled="proxySaving" @click="saveProxy">{{ t('workbench.settings.general.proxySave') }}</AppButton>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-header"><h2 class="section-title">{{ t('workbench.settings.general.diagnostics') }}</h2></div>
      <div class="surface-card">
        <div class="row row-inline">
          <div class="row-text">
            <div class="row-label">{{ t('workbench.settings.general.logsLabel') }}</div>
            <div class="row-hint">{{ t('workbench.settings.general.logsHint') }}</div>
          </div>
          <div class="row-control">
            <AppButton size="sm" class="settings-connect" @click="openLogs">{{ t('workbench.settings.general.openLogs') }}</AppButton>
          </div>
        </div>
      </div>
    </section>

    <UpdateSettings />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useSettingsStore } from '@/stores/settings'
import { openDesktopLogs, desktopNetworkBridge } from '@/services/desktop/desktopBridge'
import Field from '../primitives/Field.vue'
import AppButton from '@/components/primitives/AppButton.vue'
import UpdateSettings from './UpdateSettings.vue'

const { t } = useI18n()
const store = useSettingsStore()
// Store view, not the static catalog: user-defined providers appear here the
// moment they exist (the store merges them into availableProviders()).
const providers = computed(() => store.availableProviders())
const selectedProvider = ref(store.provider)
const selectedModel = ref(store.model)
const { backendMode, backendUrl, backendAccessToken, backendTokenConfigured, backendConnected, backendError } = storeToRefs(store)
const connectBackend = store.connectBackend

async function openLogs() {
  // False outside Electron (browser dev) — nothing to open there.
  await openDesktopLogs()
}

// ── Unified network proxy (B1) ──────────────────────────────────────────────
// The form hydrates from the main-process settings block; saving persists AND
// applies live (env + dispatcher + updater session) without a restart.
const proxyUrl = ref('')
const proxyNoProxy = ref('')
const proxySaving = ref(false)
const proxyJustSaved = ref(false)

onMounted(async () => {
  const current = await desktopNetworkBridge()?.readProxy().catch(() => undefined)
  if (current) {
    proxyUrl.value = current.url
    proxyNoProxy.value = current.noProxy
  }
})

async function saveProxy() {
  const bridge = desktopNetworkBridge()
  if (!bridge || proxySaving.value) return
  proxySaving.value = true
  try {
    const next = await bridge.writeProxy({ url: proxyUrl.value, noProxy: proxyNoProxy.value })
    // The normalized form comes back — an invalid URL degrades to '' (off).
    proxyUrl.value = next.url
    proxyNoProxy.value = next.noProxy
    proxyJustSaved.value = true
    setTimeout(() => { proxyJustSaved.value = false }, 2500)
  } finally {
    proxySaving.value = false
  }
}

// Discovered models join the curated list through the store's merged view.
const models = computed(() => store.availableModels(selectedProvider.value))

function onProviderChange() {
  // Atomic pair write; the store auto-picks a model for the new provider.
  store.setProvider(selectedProvider.value)
  selectedModel.value = store.model
}

// Atomic writes both ways: the model offered belongs to the provider shown
// locally, so the pair must be written together (the store deduplicates).
watch(selectedModel, (v) => { if (v) store.setModelFor(selectedProvider.value, v) })
// External switches (settings document, agent tab) reflect back into the
// local selects so this panel can never write a stale pair.
watch(() => store.provider, (v) => {
  if (v !== selectedProvider.value) {
    selectedProvider.value = v
    selectedModel.value = store.model
  }
})
watch(() => store.model, (v) => {
  if (v && selectedProvider.value === store.provider && v !== selectedModel.value) selectedModel.value = v
})
</script>

<style scoped>
.settings-tab-content { width: 100%; max-width: 100%; min-width: 0; }

/* ─── Section ─── */
.section { margin-bottom: 40px; }
.section:last-child { margin-bottom: 0; }

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.section-title {
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--color-text);
  letter-spacing: 0.05em;
  margin: 0;
}

/* ─── Card surface ─── */
.surface-card {
  display: flex;
  flex-direction: column;
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: 8px;
}

/* Field overrides to match the horizontal row layout */
.surface-card > .field {
  padding: var(--space-2) var(--space-4);
  position: relative;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.surface-card > .field + .field::before,
.surface-card > .field + .row::before,
.surface-card > .row + .field::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: var(--color-border);
}

.surface-card > .field .field__label {
  font-size: var(--text-md);
  color: var(--color-text);
  font-weight: 500;
}

.surface-card > .field .field__control {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: 0;
}

/* ─── Row ─── */
.row {
  padding: var(--space-2) var(--space-4);
  position: relative;
}

.row + .row::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: var(--color-border);
}

.row-inline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.row-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.row-label {
  font-size: var(--text-md);
  color: var(--color-text);
  font-weight: 500;
}

.row-hint {
  font-size: var(--text-label);
  color: var(--color-text-muted);
  line-height: 1.4;
}

.row-control {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* ─── Inputs ─── */
.settings-input {
  width: 100%;
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  padding: var(--space-1-5) var(--space-2-5);
  outline: none;
  transition: border-color 0.2s ease;
}
.settings-input:focus { border-color: var(--color-ring); }
.settings-input::placeholder { color: var(--color-text-muted); }

.settings-select {
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  padding: var(--space-1-5) var(--space-2-5);
  outline: none;
  cursor: pointer;
  transition: border-color 0.2s ease;
  width: 200px;
}
.settings-select:focus { border-color: var(--color-ring); }
.settings-connect { height: var(--space-6); padding: 0 var(--space-3); border: 1px solid var(--color-primary); border-radius: var(--radius-sm); background: var(--color-primary); color: white; cursor: pointer; }
</style>
