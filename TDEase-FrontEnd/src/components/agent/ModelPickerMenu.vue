<!--
  ModelPickerMenu — the cascading model switcher under the SessionBar's model pill.

  Shaped like the runtime's own picker: the current pair on top, then one row
  per provider that is actually usable (the store's single configured rule —
  a provider without a key would only bind into guaranteed API failures),
  each expanding a flyout with that provider's merged model list, and a
  footer keeping the two management surfaces reachable: the per-turn runtime
  drawer (reasoning effort, context readout) and Settings → Providers (keys,
  custom endpoints, model discovery).

  Selection goes through `setModelFor` — the atomic pair write — so picking a
  model from another provider never strands `{active provider, browsed model}`
  mismatches at bind time. Discovery follows automatically: the store watches
  `provider` and refreshes that provider's live model list on switch.

  The flyout teleports to <body> and positions fixed from the row's rect: a
  plain absolutely-positioned child would be clipped by the provider list's
  `overflow-y` scroll container. The SessionBar's click-outside must `ignore`
  `.model-picker__submenu` accordingly, or the flyout's first click would
  close the picker before the selection lands.
-->
<template>
  <div class="model-picker" role="menu" :aria-label="t('agent.modelPicker.title')" @keydown.escape.stop="emit('close')">
    <!-- Current pair — display only; switching happens in the provider flyouts -->
    <div class="model-picker__current" :title="t('agent.modelPicker.current')">
      <span class="model-picker__current-provider">{{ currentProviderName }}</span>
      <span class="model-picker__current-model">
        <span class="model-picker__current-model-name">{{ settingsStore.model }}</span>
        <el-icon :size="14" aria-hidden="true"><Check /></el-icon>
      </span>
    </div>

    <div class="model-picker__list" @scroll="expanded = null">
      <div
        v-for="p in configuredProviders"
        :key="p.id"
        class="model-picker__provider"
        :class="{ 'model-picker__provider--open': expanded === p.id }"
      >
        <button
          type="button"
          role="menuitem"
          class="model-picker__provider-row"
          :aria-haspopup="true"
          :aria-expanded="expanded === p.id"
          @mouseenter="openFlyout(p.id, $event)"
          @focusin="openFlyout(p.id, $event)"
          @click="openFlyout(p.id, $event)"
        >
          <span class="model-picker__provider-name">{{ p.displayName }}</span>
          <el-icon :size="13" aria-hidden="true"><ArrowRight /></el-icon>
        </button>
      </div>
      <p v-if="configuredProviders.length === 0" class="model-picker__empty">{{ t('agent.modelPicker.empty') }}</p>
    </div>

    <div class="model-picker__footer">
      <button type="button" role="menuitem" class="model-picker__footer-row" @click="openRunSettings">
        {{ t('agent.modelPicker.runSettings') }}
      </button>
      <button type="button" role="menuitem" class="model-picker__footer-row" @click="openManageModels">
        {{ t('agent.modelPicker.manageModels') }}
      </button>
    </div>
  </div>

  <!-- The provider flyout — teleported so the list's scroll container cannot
       clip it; flipped to the row's right side when there is no room to the
       left (the pill sits at the bar's right edge, so left is the norm). -->
  <Teleport to="body">
    <div
      v-if="expandedProvider"
      class="model-picker__submenu"
      role="menu"
      :aria-label="expandedProvider.displayName"
      :style="flyoutStyle"
      @keydown.escape.stop="emit('close')"
    >
      <button
        v-for="m in expandedProvider.models"
        :key="m"
        type="button"
        role="menuitemradio"
        class="model-picker__model"
        :class="{ 'model-picker__model--active': isActivePair(expandedProvider.id, m) }"
        :aria-checked="isActivePair(expandedProvider.id, m)"
        @click="select(expandedProvider.id, m)"
      >
        <span class="model-picker__model-name">{{ m }}</span>
        <el-icon v-if="isActivePair(expandedProvider.id, m)" :size="14" aria-hidden="true"><Check /></el-icon>
      </button>
      <p v-if="expandedProvider.models.length === 0" class="model-picker__no-models">
        {{ t('agent.modelPicker.emptyModels') }}
      </p>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Check } from '@element-plus/icons-vue'
import { useSettingsStore } from '@/stores/settings'
import { useAgentTabsStore } from '@/stores/agentTabs'
import { useDocumentsStore } from '@/stores/documents'

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()
const settingsStore = useSettingsStore()
const agentTabsStore = useAgentTabsStore()
const documentsStore = useDocumentsStore()

/** Only usable providers, with their merged model list resolved once per render. */
const configuredProviders = computed(() =>
  settingsStore.availableProviders()
    .filter((p) => settingsStore.isProviderConfigured(p.id))
    .map((p) => ({ id: p.id, displayName: p.displayName, models: settingsStore.availableModels(p.id) })),
)

const currentProviderName = computed(() =>
  settingsStore.availableProviders().find((p) => p.id === settingsStore.provider)?.displayName
    ?? settingsStore.provider,
)

/** The provider flyout the pointer/keyboard is on — one at a time, like a native submenu. */
const expanded = ref<string | null>(null)
const expandedProvider = computed(() =>
  configuredProviders.value.find((p) => p.id === expanded.value) ?? null,
)

// Fixed position captured from the row's rect at open time (hover/focus/click
// all funnel here, so the flyout follows exactly the row being entered).
const SUBMENU_W = 264
const FLYOUT_GAP = 4
const VIEWPORT_EDGE = 8
const flyoutStyle = ref<Record<string, string>>({})

function openFlyout(providerId: string, evt: Event) {
  const rect = (evt.currentTarget as HTMLElement).getBoundingClientRect()
  expanded.value = providerId
  const left = rect.left - SUBMENU_W - FLYOUT_GAP
  flyoutStyle.value = {
    top: `${Math.max(VIEWPORT_EDGE, rect.top)}px`,
    left: `${left >= VIEWPORT_EDGE ? left : rect.right + FLYOUT_GAP}px`,
  }
}

// A window resize can strand the fixed flyout away from its row — closing the
// whole picker is the honest response (same as click-outside).
function onResize() { emit('close') }
onMounted(() => window.addEventListener('resize', onResize))
onScopeDispose(() => window.removeEventListener('resize', onResize))

function isActivePair(providerId: string, modelId: string): boolean {
  return settingsStore.provider === providerId && settingsStore.model === modelId
}

function select(providerId: string, modelId: string) {
  settingsStore.setModelFor(providerId, modelId)
  emit('close')
}

function openRunSettings() {
  agentTabsStore.open({ kind: 'agent-settings' }, { title: t('agent.settingsTab.title') })
  emit('close')
}

function openManageModels() {
  documentsStore.openSettings(undefined, 'providers')
  emit('close')
}
</script>

<style scoped>
/* Same tonal layering as the session menu (elev-2 panel over the bar). */
.model-picker {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: var(--z-dockbar);
  width: 264px;
  background: var(--elev-2-bg, var(--color-bg));
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-md);
  box-shadow: var(--elev-2);
  overflow: hidden;
}

.model-picker__current {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--line-w) solid var(--line-seam);
}
.model-picker__current-provider {
  font-size: var(--text-label);
  color: var(--color-text-muted, var(--color-text-muted));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-picker__current-model {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  color: var(--color-text, var(--color-text));
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
.model-picker__current-model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-picker__current-model .el-icon {
  color: var(--color-primary);
  flex-shrink: 0;
}

.model-picker__list {
  max-height: 320px;
  overflow-y: auto;
  padding: var(--space-1);
}

.model-picker__provider-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  width: 100%;
  border: none;
  background: none;
  color: var(--color-text, var(--color-text));
  font: inherit;
  font-size: var(--text-sm);
  text-align: left;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.model-picker__provider-row:hover,
.model-picker__provider--open .model-picker__provider-row {
  background: var(--color-hover);
}
.model-picker__provider-row:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: -2px;
}
.model-picker__provider-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-picker__provider-row .el-icon {
  color: var(--color-text-muted, var(--color-text-muted));
  flex-shrink: 0;
}

/* Fixed (coordinates injected inline at open time) — see the header note. */
.model-picker__submenu {
  position: fixed;
  width: 264px;
  max-height: 320px;
  overflow-y: auto;
  padding: var(--space-1);
  background: var(--elev-2-bg, var(--color-bg));
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-md);
  box-shadow: var(--elev-2);
  z-index: var(--z-dockbar);
}
.model-picker__model {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  width: 100%;
  border: none;
  background: none;
  color: var(--color-text, var(--color-text));
  font: inherit;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  text-align: left;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.model-picker__model:hover {
  background: var(--color-hover);
}
.model-picker__model:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: -2px;
}
.model-picker__model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-picker__model--active .el-icon {
  color: var(--color-primary);
  flex-shrink: 0;
}

.model-picker__no-models,
.model-picker__empty {
  margin: 0;
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-label);
  color: var(--color-text-muted, var(--color-text-muted));
}

.model-picker__footer {
  display: flex;
  flex-direction: column;
  padding: var(--space-1);
  border-top: var(--line-w) solid var(--line-seam);
}
.model-picker__footer-row {
  border: none;
  background: none;
  color: var(--color-text-secondary, var(--color-text-secondary));
  font: inherit;
  font-size: var(--text-sm);
  text-align: left;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.model-picker__footer-row:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.model-picker__footer-row:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: -2px;
}

@media (prefers-reduced-motion: reduce) {
  .model-picker__provider-row,
  .model-picker__model,
  .model-picker__footer-row { transition: none; }
}
</style>
