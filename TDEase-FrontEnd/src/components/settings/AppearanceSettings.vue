<!--
  AppearanceSettings — the long-named gap in SettingsDocument.

  SettingsDocument's header comment carried "Appearance ... is the honest
  remaining gap" for the whole life of the settings surface. This fills it
  with the three controls that are real today: font scale (Phase E of the
  palot inspector migration), density, and theme. No half-built toggles, no
  "coming soon" — only what actually works.

  Font scale drives the single `--font-scale` CSS variable on <html>, which
  every type token in unified-design-tokens.css multiplies by. The slider
  and stepper both call `setFontScale`; the live percentage reads back from
  the same store value. Density reuses `uiLayout.setDensity`, which writes
  `data-density` to <html>. Theme reads and writes the same `useThemeStore`
  the TitleBar's ThemeSwitcher does — one store, two affordances — so the
  two never disagree.
-->
<template>
  <div class="settings-tab-content active" data-tab="appearance">
    <!-- Font scale -->
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">{{ t('workbench.settings.appearance.fontScale') }}</h2>
      </div>
      <div class="surface-card">
        <Field :label="t('workbench.settings.appearance.fontSize')" :description="t('workbench.settings.appearance.fontScaleHint')">
          <template #default="{ id, describedby }">
            <div class="row-control row-control--font">
              <button
                type="button"
                class="settings-stepper"
                :disabled="fontScale <= FONT_SCALE_MIN"
                :title="t('workbench.settings.appearance.zoomOut')"
                @click="store.stepFontScale(-1)"
              >
                −
              </button>
              <input
                :id="id"
                type="range"
                class="settings-range"
                :min="FONT_SCALE_MIN"
                :max="FONT_SCALE_MAX"
                :step="FONT_SCALE_STEP"
                :value="fontScale"
                :aria-describedby="describedby"
                @input="store.setFontScale(Number(($event.target as HTMLInputElement).value))"
              />
              <button
                type="button"
                class="settings-stepper"
                :disabled="fontScale >= FONT_SCALE_MAX"
                :title="t('workbench.settings.appearance.zoomIn')"
                @click="store.stepFontScale(1)"
              >
                +
              </button>
              <span class="settings-stepper-value">{{ Math.round(fontScale * 100) }}%</span>
              <button
                type="button"
                class="settings-reset"
                :disabled="fontScale === 1"
                @click="store.resetFontScale()"
              >
                {{ t('workbench.settings.appearance.reset') }}
              </button>
            </div>
          </template>
        </Field>
        <p class="appearance-shortcut-hint">{{ t('workbench.settings.appearance.shortcutHint') }}</p>
      </div>
    </section>

    <!-- Density -->
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">{{ t('workbench.settings.appearance.density') }}</h2>
      </div>
      <div class="surface-card">
        <Field :label="t('workbench.settings.appearance.densityLabel')" :description="t('workbench.settings.appearance.densityHint')">
          <template #default="{ id }">
            <select :id="id" class="settings-select" :value="density" @change="onDensityChange">
              <option value="comfortable">{{ t('workbench.settings.appearance.densityComfortable') }}</option>
              <option value="compact">{{ t('workbench.settings.appearance.densityCompact') }}</option>
            </select>
          </template>
        </Field>
      </div>
    </section>

    <!-- Theme (same useThemeStore the TitleBar switcher uses) -->
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">{{ t('workbench.settings.appearance.theme') }}</h2>
      </div>
      <div class="surface-card">
        <Field :label="t('workbench.settings.appearance.themeLabel')" :description="t('workbench.settings.appearance.themeHint')">
          <template #default="{ id }">
            <select :id="id" class="settings-select" :value="currentTheme" @change="onThemeChange">
              <option v-for="(meta, theme) in themeMetadata" :key="theme" :value="theme">
                {{ meta.name }} · {{ t(`common.theme.mode.${meta.mode}`) }}
              </option>
            </select>
          </template>
        </Field>
      </div>
    </section>

    <!-- Agent transcript: reasoning inline or folded behind the task tree -->
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">{{ t('workbench.settings.appearance.agentTranscript') }}</h2>
      </div>
      <div class="surface-card">
        <Field :label="t('workbench.settings.appearance.showReasoning')" :description="t('workbench.settings.appearance.showReasoningHint')">
          <template #default>
            <el-switch :model-value="store.showReasoning" @update:model-value="store.setShowReasoning(Boolean($event))" />
          </template>
        </Field>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore, FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_STEP } from '@/stores/settings'
import { useUiLayoutStore } from '@/stores/uiLayout'
import { useThemeStore } from '@/stores/theme'
import { themeMetadata, type CatppuccinTheme } from '@/config/theme'
import Field from '../primitives/Field.vue'

const { t } = useI18n()
const store = useSettingsStore()
const uiLayout = useUiLayoutStore()
const themeStore = useThemeStore()

const fontScale = computed(() => store.fontScale)
const density = computed(() => uiLayout.density)
// Same store the TitleBar's ThemeSwitcher reads/writes — the two surfaces stay
// in sync because there is exactly one source of truth, not a DOM-attribute
// mirror of one. This replaces the old MutationObserver workaround that existed
// only because the comment above it claimed "there is no theme store yet".
const currentTheme = computed(() => themeStore.currentTheme)

function onDensityChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value as 'comfortable' | 'compact'
  uiLayout.setDensity(value)
}

function onThemeChange(event: Event) {
  themeStore.setTheme((event.target as HTMLSelectElement).value as CatppuccinTheme)
}
</script>

<style scoped>
/* Shared settings-panel scaffolding (mirrors GeneralSettings — each settings
   tab carries its own scoped copy rather than a shared import, so a tab can
   be read in isolation). */
.settings-tab-content { width: 100%; max-width: 100%; min-width: 0; }

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

.surface-card > .field .field__label {
  font-size: var(--text-md);
  font-weight: 500;
  color: var(--color-text);
}

.surface-card > .field .field__description {
  font-size: var(--text-label);
  color: var(--color-text-muted);
  line-height: 1.4;
}

.surface-card > .field .field__control {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: 0;
}

.row { padding: var(--space-2) var(--space-4); position: relative; }
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
.row-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.row-label { font-size: var(--text-md); color: var(--color-text); font-weight: 500; }
.row-hint { font-size: var(--text-label); color: var(--color-text-muted); line-height: 1.4; }
.row-control { flex-shrink: 0; display: flex; align-items: center; gap: var(--space-2); }

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
  transition: border-color var(--dur-normal) var(--ease-out);
  width: 200px;
}
.settings-select:focus { border-color: var(--color-ring); }

/* ── Appearance-specific ── */
.appearance-shortcut-hint {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-label);
  color: var(--color-text-muted);
}

.row-control--font {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.settings-stepper {
  width: 28px;
  height: 28px;
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: var(--text-md);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.settings-stepper:hover:not(:disabled) { background: var(--color-hover); }
.settings-stepper:disabled { opacity: 0.4; cursor: not-allowed; }

.settings-range {
  width: 140px;
  accent-color: var(--color-primary);
}

.settings-stepper-value {
  min-width: 44px;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  text-align: right;
}

.settings-reset {
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--text-sm);
  padding: 2px var(--space-2);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.settings-reset:hover:not(:disabled) { background: var(--color-hover); }
.settings-reset:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
