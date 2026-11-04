<!--
  "Reuses `components/settings/*`." This is that reuse and nothing more: the
  components (`SettingsNav`, `GeneralSettings`, `ProviderDetail`,
  `McpSettings`, `StatisticsPanel`, `PermissionsSettings`) are mounted, the
  first five unchanged exactly as the deleted `pages/Settings.vue` mounted
  them. Deleting that page removed the only adapter for them and stranded
  all five (docs/STATUS.md); registering this document is the
  entry point they lost, so this is a connect, not a rewrite.

  The section is view state, not identity: `DocumentKey`'s `settings` variant
  carries no section field, so switching sections never opens a second tab.
  §5.7's "last section" default therefore lives here, in the document, the
  same way §7.2 keeps filters out of the command vocabulary.

  Section inventory, kept current: §5.7's original six named General ·
  Providers · MCP · Permissions · Appearance · Advanced; this document now
  mounts NINE real sections — General, Providers, MCP, Statistics,
  Permissions, Agent Tools, Sharing, Appearance, About (license & legal) —
  and no Advanced section exists in `components/settings/` to connect.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore, isCustomProviderId } from '@/stores/settings'
import { useDocumentsStore } from '@/stores/documents'
import type { ProviderInfo } from '@/services/catalog/providerCatalog'
import { FEATURED_PROVIDER_IDS } from '@/services/catalog/provider-definitions'
import SettingsNav from '@/components/settings/SettingsNav.vue'
import GeneralSettings from '@/components/settings/GeneralSettings.vue'
import ProviderDetail from '@/components/settings/ProviderDetail.vue'
import CustomProviderDialog from '@/components/settings/CustomProviderDialog.vue'
import StatisticsPanel from '@/components/settings/StatisticsPanel.vue'
import McpSettings from '@/components/settings/McpSettings.vue'
import PermissionsSettings from '@/components/settings/PermissionsSettings.vue'
import AgentToolsSettings from '@/components/settings/AgentToolsSettings.vue'
import SharingSettings from '@/components/settings/SharingSettings.vue'
import AppearanceSettings from '@/components/settings/AppearanceSettings.vue'
import AboutSettings from '@/components/settings/AboutSettings.vue'

const { t } = useI18n()
const settingsStore = useSettingsStore()
const documentsStore = useDocumentsStore()
const activeSection = ref('providers')
// Open on the provider sessions actually use — an empty detail pane teaches
// nothing and forces a second click on the obvious row.
const selectedProvider = ref<string | null>(settingsStore.provider)

// The palette's per-section entries ("Settings: Statistics") request their
// section through the documents store's one-shot ref; consume it here (fresh
// mount or already-open document alike) and clear it so a later plain
// "open Settings" never lands on a stale section.
watch(() => documentsStore.requestedSettingsSection, (section) => {
  if (!section) return
  activeSection.value = section
  documentsStore.requestedSettingsSection = null
}, { immediate: true })

const sectionTitle = computed(() => {
  switch (activeSection.value) {
    case 'general': return t('workbench.settings.section.general')
    case 'providers': return t('workbench.settings.section.providers')
    case 'mcp': return t('workbench.settings.section.mcp')
    case 'statistics': return t('workbench.settings.section.statistics')
    case 'permissions': return t('workbench.settingsPermissions.sectionTitle')
    case 'agent-tools': return t('workbench.settings.section.agentTools')
    case 'sharing': return t('workbench.settingsSharing.sectionTitle')
    case 'appearance': return t('workbench.settings.section.appearance')
    case 'about': return t('workbench.settings.section.about')
    default: return ''
  }
})

const refreshKey = ref(0)
// Store view (catalog + user-defined), not the static list: a custom provider
// appears the moment it exists, and its synthetic entry stays reactive to
// credential/model changes in settings.json.
const providerRows = computed(() => {
  void refreshKey.value
  return settingsStore.availableProviders().map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    custom: isCustomProviderId(provider.id),
    // The store's single configured rule (oauth/no-auth pass, api-key needs
    // the redacted flag) — same rule the Agent's model picker filters by.
    configured: settingsStore.isProviderConfigured(provider.id),
    modelCount: provider.models.length,
    authType: provider.authType,
    active: provider.id === settingsStore.provider,
  }))
})
function refreshRows() { refreshKey.value++ }

// ── List grouping: featured / custom / everything else (collapsed) ───────────
// The flat 30-row alphabetical wall forced every cold vendor onto a newcomer's
// first screen. Featured six stay uncollapsed (domestic trio + big three),
// user-defined providers always stay visible (hiding user data teaches
// nothing), and the long tail folds behind one toggle.
const featuredRank = new Map<string, number>(FEATURED_PROVIDER_IDS.map((id, index) => [id, index]))

const featuredRows = computed(() =>
  providerRows.value
    .filter((row) => featuredRank.has(row.id))
    .sort((a, b) => (featuredRank.get(a.id) ?? 0) - (featuredRank.get(b.id) ?? 0)))

const customRows = computed(() => providerRows.value.filter((row) => row.custom))

// Cold tail: configured first (a configured cold vendor must be one glance
// away when the group opens), then display name.
const otherRows = computed(() =>
  providerRows.value
    .filter((row) => !featuredRank.has(row.id) && !row.custom)
    .sort((a, b) =>
      Number(b.configured) - Number(a.configured)
      || a.displayName.localeCompare(b.displayName)))

const otherConfiguredCount = computed(() =>
  otherRows.value.filter((row) => row.configured).length)

interface ProviderGroup { key: string; label: string; rows: typeof providerRows.value }
const mainGroups = computed<ProviderGroup[]>(() => {
  const groups: ProviderGroup[] = [
    { key: 'featured', label: t('workbench.settings.providers.groupFeatured'), rows: featuredRows.value },
  ]
  if (customRows.value.length > 0) {
    groups.push({ key: 'custom', label: t('workbench.settings.providers.groupCustom'), rows: customRows.value })
  }
  return groups
})

// The cold group opens itself when the browsed-or-active provider lives
// there — the user's own active vendor must never sit behind a closed toggle.
const coldOpen = ref(false)
function coldContains(id: string | null): boolean {
  return id != null && otherRows.value.some((row) => row.id === id)
}
watch(() => [selectedProvider.value, settingsStore.provider] as const, ([browsed, active]) => {
  if (coldContains(browsed) || coldContains(active)) coldOpen.value = true
}, { immediate: true })

const selectedProviderInfo = computed<ProviderInfo | null>(() =>
  settingsStore.availableProviders().find((provider) => provider.id === selectedProvider.value) ?? null)

// Custom provider creation dialog + post-creation selection.
const customDialog = ref(false)
function onCustomSaved(providerId: string) {
  refreshRows()
  selectProvider(providerId)
}
function onCustomDeleted() {
  refreshRows()
  selectedProvider.value = settingsStore.provider
}

function selectProvider(id: string) { selectedProvider.value = id }
// Atomic pair write: the detail pane browses ANY provider while the active
// one stays put — selecting its chip must switch the pair together, or the
// persisted `{active provider, browsed model}` mismatches at bind time.
function onSelectModel(modelId: string) { settingsStore.setModelFor(selectedProvider.value ?? '', modelId) }
</script>

<template>
  <div class="settings-document">
    <div class="settings-body">
      <!-- `:model-value`, not `v-model`: `SettingsNav` reports through its
           own `select` event and declares no `update:modelValue`. -->
      <SettingsNav :model-value="activeSection" @select="activeSection = $event" />

      <div class="settings-main">
        <div class="settings-section-heading">
          <h1 class="settings-section-title">{{ sectionTitle }}</h1>
        </div>

        <GeneralSettings v-if="activeSection === 'general'" />

        <div v-else-if="activeSection === 'providers'" class="settings-section-content">
          <div class="pv-layout">
            <div class="pv-list">
              <template v-for="group in mainGroups" :key="group.key">
                <div class="pv-list-group-label">{{ group.label }}</div>
                <button
                  v-for="provider in group.rows"
                  :key="provider.id"
                  :class="['pv-list-item', { selected: selectedProvider === provider.id, dim: !provider.configured }]"
                  @click="selectProvider(provider.id)"
                >
                  <span class="pv-status-dot" :class="{ on: provider.configured }" />
                  <span class="pv-list-item-name">{{ provider.displayName }}</span>
                  <span v-if="provider.active" class="pv-active-badge">{{ t('workbench.settings.providers.inUse') }}</span>
                  <span v-else-if="provider.custom" class="pv-custom-badge">{{ t('workbench.settings.providers.customBadge') }}</span>
                  <span v-else-if="provider.modelCount > 0" class="pv-list-item-count">{{ provider.modelCount }}</span>
                </button>
              </template>

              <template v-if="otherRows.length > 0">
                <button class="pv-list-toggle" type="button" @click="coldOpen = !coldOpen">
                  <span class="pv-chevron" :class="{ collapsed: !coldOpen }" aria-hidden="true" />
                  <span class="pv-list-item-name">{{ t('workbench.settings.providers.moreProviders') }}</span>
                  <span v-if="otherConfiguredCount > 0" class="pv-list-item-count">{{ otherConfiguredCount }}</span>
                </button>
                <!-- grid-rows 1fr↔0fr: smooth collapse regardless of row count
                     (the SessionTodoCard pattern). -->
                <div class="pv-cold-wrap" :class="{ 'is-open': coldOpen }">
                  <div class="pv-cold-list">
                    <button
                      v-for="provider in otherRows"
                      :key="provider.id"
                      :class="['pv-list-item', { selected: selectedProvider === provider.id, dim: !provider.configured }]"
                      @click="selectProvider(provider.id)"
                    >
                      <span class="pv-status-dot" :class="{ on: provider.configured }" />
                      <span class="pv-list-item-name">{{ provider.displayName }}</span>
                      <span v-if="provider.active" class="pv-active-badge">{{ t('workbench.settings.providers.inUse') }}</span>
                      <span v-else-if="provider.custom" class="pv-custom-badge">{{ t('workbench.settings.providers.customBadge') }}</span>
                      <span v-else-if="provider.modelCount > 0" class="pv-list-item-count">{{ provider.modelCount }}</span>
                    </button>
                  </div>
                </div>
              </template>

              <button class="pv-list-add" type="button" @click="customDialog = true">
                <span class="pv-list-add-icon" aria-hidden="true">+</span>
                <span>{{ t('workbench.settings.providers.addCustom') }}</span>
              </button>
            </div>

            <div class="pv-detail">
              <ProviderDetail
                v-if="selectedProviderInfo"
                :key="selectedProvider ?? ''"
                :provider="selectedProviderInfo"
                :selected-model="settingsStore.model"
                :custom="isCustomProviderId(selectedProviderInfo.id)"
                @select-model="onSelectModel"
                @saved="refreshRows"
                @deleted="onCustomDeleted"
              />
              <div v-else class="pv-empty">{{ t('workbench.settings.providers.emptyHint') }}</div>
            </div>
          </div>
          <CustomProviderDialog :show="customDialog" @update:show="customDialog = $event" @saved="onCustomSaved" />
        </div>

        <McpSettings v-else-if="activeSection === 'mcp'" />

        <StatisticsPanel v-else-if="activeSection === 'statistics'" />

        <PermissionsSettings v-else-if="activeSection === 'permissions'" />

        <AgentToolsSettings v-else-if="activeSection === 'agent-tools'" />
        <SharingSettings v-else-if="activeSection === 'sharing'" />

        <AppearanceSettings v-else-if="activeSection === 'appearance'" />
        <AboutSettings v-else-if="activeSection === 'about'" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-document {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg);
}

.settings-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.settings-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  padding: var(--space-5) 40px 40px;
}

.settings-section-heading {
  margin: 0 0 var(--space-6) 0;
}

.settings-section-title {
  font-family: var(--font-body);
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--color-text);
  margin: 0;
  letter-spacing: 0;
}

.settings-section-content {
  width: 100%;
  max-width: 100%;
  min-width: 0;
}

.pv-layout {
  display: flex;
  gap: 0;
  /* A seam-split master-detail region, not a card-in-a-card: the old
     secondary-fill + hairline border + shadow box was the ghost-card
     container pattern sitting inside an already-scrolled page (2026-09-05
     review). Height fills the settings main column so the INNER list scrolls
     in place — one scroll context per region, no nested-window look. */
  height: calc(100vh - 280px);
  min-height: 320px;
  max-width: 100%;
  min-width: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  position: relative;
  overflow: hidden;
}

.pv-list {
  width: 33.33%;
  flex-shrink: 0;
  border-right: var(--line-w) solid var(--line-seam);
  background: var(--color-bg-tertiary);
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-1) 0;
  overflow-y: auto;
  background: transparent;
}

.pv-list-group-label {
  font-size: 0.62rem;
  font-weight: 600;
  color: var(--color-primary);
  padding: var(--space-2) var(--space-3) 2px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.75;
}

.pv-list-item {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-1-5) var(--space-3);
  background: none;
  border: none;
  border-left: var(--line-stripe-w) solid transparent;
  cursor: pointer;
  text-align: left;
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--color-text-secondary);
  transition: all 0.15s ease;
  width: 100%;
  text-overflow: ellipsis;
}

.pv-list-item:hover { background: var(--color-primary-soft); }
.pv-list-item.dim { opacity: 0.45; }
.pv-list-item.dim:hover { opacity: 0.7; }
.pv-list-item.dim.selected { opacity: 1; }
.pv-list-item.selected {
  border-left-color: var(--color-primary);
  color: var(--color-primary);
  font-weight: 500;
}

.pv-list-item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pv-list-item-count {
  font-size: var(--text-label);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.pv-active-badge {
  padding: 0 var(--space-1);
  font-size: 0.56rem;
  font-weight: 600;
  line-height: 1.6;
  color: var(--color-primary);
  background: var(--color-primary-soft);
  border-radius: var(--radius-xs);
  flex-shrink: 0;
  white-space: nowrap;
}

.pv-custom-badge {
  padding: 0 var(--space-1);
  font-size: 0.56rem;
  line-height: 1.6;
  color: var(--color-text-muted);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-xs);
  flex-shrink: 0;
  white-space: nowrap;
}

.pv-list-add {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding: var(--space-1-5) var(--space-2);
  font-size: var(--text-label);
  color: var(--color-text-muted);
  background: none;
  border: var(--line-w) dashed var(--line-hairline);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.pv-list-add:hover { color: var(--color-text); border-color: var(--color-border-control-hover); }
.pv-list-add-icon { font-size: var(--text-md); line-height: 1; }

/* ─── Cold-tail toggle ─── */
.pv-list-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  margin-top: var(--space-2);
  padding: var(--space-1-5) var(--space-3);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-family: var(--font-body);
  font-size: var(--text-base);
  color: var(--color-text-muted);
  transition: color var(--dur-fast) var(--ease-out);
  width: 100%;
}
.pv-list-toggle:hover { color: var(--color-text); }
.pv-list-toggle .pv-list-item-name { flex: 1; }

.pv-chevron {
  width: 5px;
  height: 5px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg);
  transition: transform 160ms ease-out;
  flex-shrink: 0;
}
.pv-chevron.collapsed { transform: rotate(-90deg); }

/* Height animation via the grid-rows trick — collapse stays smooth no matter
   how many cold rows hide inside. */
.pv-cold-wrap {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--dur-normal) var(--ease-out);
}
.pv-cold-wrap:not(.is-open) { grid-template-rows: 0fr; }
.pv-cold-list {
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .pv-cold-wrap { transition: none; }
  .pv-chevron { transition: none; }
}

.pv-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-muted);
  flex-shrink: 0;
  opacity: 0.4;
}

.pv-status-dot.on {
  background: var(--color-success);
  opacity: 1;
}

.pv-detail {
  flex: 1;
  min-width: 0;
  padding: var(--space-4);
  overflow-y: auto;
  background: transparent;
}

.pv-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-muted);
  font-size: var(--text-base);
}
</style>
