<!--
  AboutSettings — the legal surface inside the app. The NSIS installer shows
  the agreement once at install time; GPL-3.0 §0 additionally expects an
  interactive interface to carry "Appropriate Legal Notices" (copyright, no
  warranty, how to view the license) at any later time, and the agreement's
  Part II itself promises the full text ships with the install. This panel is
  both: a readable summary plus the agreement's full text, imported ?raw from
  the SAME file the installer license page consumes (electron/license-
  agreement.txt) — one source, zero drift between installer and app.
-->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { version } from '../../../package.json'
import licenseText from '../../../electron/license-agreement.txt?raw'

const { t } = useI18n()
const appVersion = version

// The file carries a UTF-8 BOM (NSIS renders it correctly); in the DOM it is
// an invisible first character inside <pre> — strip it.
const agreementText = computed(() => licenseText.replace(/^\uFEFF/, ''))

const summaries = computed(() => [
  { id: 'ai', title: t('workbench.settingsAbout.aiTerms.title'), text: t('workbench.settingsAbout.aiTerms.text') },
  { id: 'privacy', title: t('workbench.settingsAbout.privacy.title'), text: t('workbench.settingsAbout.privacy.text') },
  { id: 'openSource', title: t('workbench.settingsAbout.openSource.title'), text: t('workbench.settingsAbout.openSource.text') },
])
</script>

<template>
  <div class="settings-tab-content active" data-tab="about">
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">{{ t('workbench.settingsAbout.title') }}</h2>
      </div>
      <p class="section-lead">{{ t('workbench.settingsAbout.lead') }}</p>
      <div class="surface-card">
        <div class="row row-inline">
          <div class="row-text">
            <div class="row-label">TDEaseNexus <span class="version-badge">v{{ appVersion }}</span></div>
            <div class="row-hint">{{ t('workbench.settingsAbout.copyrightLine') }}</div>
          </div>
        </div>
        <div v-for="item in summaries" :key="item.id" class="row">
          <div class="row-text">
            <div class="row-label">{{ item.title }}</div>
            <div class="row-hint">{{ item.text }}</div>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <h2 class="section-title">{{ t('workbench.settingsAbout.fullTextTitle') }}</h2>
      </div>
      <p class="section-lead">{{ t('workbench.settingsAbout.fullTextLead') }}</p>
      <div class="surface-card">
        <pre class="license-text" :aria-label="t('workbench.settingsAbout.fullTextTitle')">{{ agreementText }}</pre>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ─── Section shell (matches the other settings panels) ─── */
.section { margin-bottom: 40px; }
.section:last-child { margin-bottom: 0; }
.section-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); }
.section-title { font-size: var(--text-lg); font-weight: 600; color: var(--color-text); letter-spacing: 0.05em; margin: 0; }
.section-lead { margin: -8px 0 var(--space-4); font-size: var(--text-sm); line-height: 1.5; color: var(--color-text-muted); }
.surface-card { display: flex; flex-direction: column; background: var(--color-bg-secondary); border: var(--line-w) solid var(--line-hairline); border-radius: 8px; }
.row { padding: var(--space-2) var(--space-4); position: relative; }
.row + .row::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px; background: var(--color-border);
}
.row-inline { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); }
.row-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.row-label { font-size: var(--text-md); color: var(--color-text); font-weight: 500; }
.row-hint { font-size: var(--text-label); color: var(--color-text-muted); line-height: 1.5; }

.version-badge {
  margin-left: var(--space-1-5);
  padding: 0 var(--space-1-5);
  font-size: 0.62rem;
  font-weight: 600;
  line-height: 1.6;
  border-radius: var(--radius-xs);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  vertical-align: 1px;
}

/* ─── Full text: one scroll context, verbatim as shipped ─── */
.license-text {
  margin: 0;
  padding: var(--space-4);
  max-height: 460px;
  overflow-y: auto;
  overscroll-behavior: contain;
  font-family: var(--font-mono, monospace);
  font-size: var(--text-label);
  line-height: 1.6;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
