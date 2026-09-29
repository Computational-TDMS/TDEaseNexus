<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/settings'
import type { AgentToolSettingKey } from '@/contracts/agent-runtime'
import AppButton from '@/components/primitives/AppButton.vue'

const { t } = useI18n()
const store = useSettingsStore()

const groups: ReadonlyArray<{
  title: string
  items: ReadonlyArray<{ key: AgentToolSettingKey; label: string; hint: string }>
}> = [
  {
    title: 'execution',
    items: [
      { key: 'discovery', label: 'discovery', hint: 'discoveryHint' },
      { key: 'workflow', label: 'workflow', hint: 'workflowHint' },
      { key: 'runObservation', label: 'runObservation', hint: 'runObservationHint' },
      { key: 'runControl', label: 'runControl', hint: 'runControlHint' },
      { key: 'workspaceWrite', label: 'workspaceWrite', hint: 'workspaceWriteHint' },
      { key: 'shell', label: 'shell', hint: 'shellHint' },
    ],
  },
  {
    title: 'extensions',
    items: [
      { key: 'mcp', label: 'mcp', hint: 'mcpHint' },
    ],
  },
  {
    title: 'experimental',
    items: [
      { key: 'viewTools', label: 'viewTools', hint: 'viewToolsHint' },
    ],
  },
]

function update(key: AgentToolSettingKey, event: Event) {
  store.setAgentTool(key, (event.target as HTMLInputElement).checked)
}
</script>

<template>
  <div class="agent-tools-settings">
    <div class="settings-intro">
      <p>{{ t('workbench.settingsAgentTools.intro') }}</p>
      <AppButton variant="subtle" size="sm" class="reset-button" @click="store.resetAgentTools">
        {{ t('workbench.settingsAgentTools.reset') }}
      </AppButton>
    </div>

    <section v-for="group in groups" :key="group.title" class="tool-section">
      <h2 class="section-title">{{ t(`workbench.settingsAgentTools.${group.title}`) }}</h2>
      <div class="settings-surface">
        <label v-for="item in group.items" :key="item.key" class="tool-row">
          <span class="tool-copy">
            <span class="tool-label">{{ t(`workbench.settingsAgentTools.${item.label}`) }}</span>
            <span class="tool-hint">{{ t(`workbench.settingsAgentTools.${item.hint}`) }}</span>
          </span>
          <span class="toggle">
            <input
              class="toggle-input"
              type="checkbox"
              :checked="store.agentTools[item.key]"
              @change="update(item.key, $event)"
            >
            <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb" /></span>
          </span>
        </label>
      </div>
    </section>
  </div>
</template>

<style scoped>
.agent-tools-settings {
  width: min(760px, 100%);
}

.settings-intro {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-5);
  margin-bottom: 28px;
}

.settings-intro p {
  max-width: 68ch;
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-base);
  line-height: var(--text-base-lh);
}

.reset-button {
  flex: none;
  min-height: var(--control-h);
  padding: 0 var(--space-2-5);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
}

.reset-button:hover { background: var(--color-hover); }
.reset-button:focus-visible { outline: 2px solid var(--color-ring); outline-offset: 2px; }

.tool-section + .tool-section { margin-top: 28px; }

.section-title {
  margin: 0 0 var(--space-2-5);
  color: var(--color-text);
  font-size: var(--text-md);
  line-height: var(--text-md-lh);
  font-weight: 600;
  letter-spacing: 0;
}

.settings-surface {
  overflow: hidden;
  border: var(--line-w) solid var(--line-hairline);
  border-radius: 8px;
  background: var(--color-bg-secondary);
}

.tool-row {
  min-height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  padding: var(--space-2-5) 14px;
  cursor: pointer;
}

.tool-row + .tool-row { border-top: var(--line-w) solid var(--line-hairline); }
.tool-row:hover { background: var(--color-hover); }

.tool-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tool-label {
  color: var(--color-text);
  font-size: var(--text-base);
  line-height: var(--text-base-lh);
  font-weight: 500;
}

.tool-hint {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
}

.toggle {
  position: relative;
  flex: none;
  width: 34px;
  height: 20px;
}

.toggle-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.toggle-track {
  width: 34px;
  height: 20px;
  display: block;
  padding: 2px;
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg-active);
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}

.toggle-thumb {
  width: 14px;
  height: 14px;
  display: block;
  border-radius: 50%;
  background: var(--color-text-muted);
  transition: transform var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}

.toggle-input:checked + .toggle-track {
  border-color: var(--color-primary);
  background: var(--color-primary);
}

.toggle-input:checked + .toggle-track .toggle-thumb {
  transform: translateX(14px);
  background: var(--color-on-primary);
}

.toggle-input:focus-visible + .toggle-track {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}

@media (max-width: 720px) {
  .settings-intro { flex-direction: column; gap: var(--space-3); }
  .tool-row { align-items: flex-start; gap: var(--space-4); }
  .toggle { margin-top: 2px; }
}
</style>
