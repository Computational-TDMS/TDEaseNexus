<template>
  <section class="mcp-settings">
    <p class="description">{{ t('workbench.settings.mcp.description') }}</p>
    <div class="scope"><label><input v-model="scope" type="radio" value="system" @change="load" /> {{ t('workbench.settings.mcp.scopeSystem') }}</label><label><input v-model="scope" type="radio" value="workspace" :disabled="!workspace.hasWorkspace" @change="load" /> {{ t('workbench.settings.mcp.scopeWorkspace') }}</label></div>
    <template v-if="scope === 'system' || workspace.hasWorkspace">
      <textarea v-model="source" class="config" spellcheck="false" :aria-label="t('workbench.settings.mcp.configAria')" />
      <div class="actions">
        <span :class="['status', { error }]">{{ status }}</span>
        <AppButton variant="primary" size="sm" class="save" :disabled="saving" @click="save">{{ t('common.button.save') }}</AppButton>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useWorkspaceStore } from '@/stores/workspace'
import { desktopWorkspaceFileSystem } from '@/services/workspace/desktopWorkspace'
import { readSystemMcpConfig, writeSystemMcpConfig } from '@/services/desktop/desktopBridge'
import AppButton from '@/components/primitives/AppButton.vue'

const { t } = useI18n()
const workspace = useWorkspaceStore()
const source = ref('{\n  "mcpServers": {}\n}\n')
const status = ref('')
const error = ref(false)
const saving = ref(false)
const configPath = '.tdease/settings.json'
const scope = ref<'system' | 'workspace'>('system')
const fallback = '{\n  "mcpServers": {}\n}\n'

/** Read system MCP config, throwing the localized native-required error when absent. */
async function requireSystemConfig(): Promise<string> {
  const body = await readSystemMcpConfig()
  if (body === undefined) throw new Error(t('workbench.settings.mcp.errorNativeRequired'))
  return body
}

async function load() {
  try {
    error.value = false
    if (scope.value === 'system') {
      source.value = await requireSystemConfig()
      status.value = t('workbench.settings.mcp.statusSystem')
    } else {
      const fs = desktopWorkspaceFileSystem(workspace.workspacePath)
      if (await fs.exists(configPath)) {
        const settings = JSON.parse(await fs.readText(configPath)) as { mcp?: unknown }
        source.value = `${JSON.stringify(settings.mcp ?? { mcpServers: {} }, null, 2)}\n`
      } else source.value = fallback
      status.value = t('workbench.settings.mcp.statusWorkspace')
    }
  } catch (cause) {
    error.value = true
    status.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function save() {
  try {
    saving.value = true
    error.value = false
    const value = JSON.parse(source.value)
    if (!value || typeof value !== 'object' || ((value.servers === undefined && value.mcpServers === undefined)
      || (value.servers !== undefined && typeof value.servers !== 'object')
      || (value.mcpServers !== undefined && typeof value.mcpServers !== 'object'))) {
      throw new Error(t('workbench.settings.mcp.errorInvalid'))
    }
    const content = `${JSON.stringify(value, null, 2)}\n`
    if (scope.value === 'system') {
      // Surface the same native-required error before parsing, matching load().
      await requireSystemConfig()
      await writeSystemMcpConfig(content)
    } else {
      const fs = desktopWorkspaceFileSystem(workspace.workspacePath)
      await fs.mkdir('.tdease')
      const settings = await fs.exists(configPath) ? JSON.parse(await fs.readText(configPath)) : {}
      await fs.writeTextAtomic(configPath, `${JSON.stringify({ ...settings, mcp: value }, null, 2)}\n`)
    }
    status.value = t('workbench.settings.mcp.saved')
  } catch (cause) {
    error.value = true
    status.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.mcp-settings { max-width: 760px; }
.description, .notice, .status { font-size: var(--text-base); color: var(--color-text-muted); }
.scope { display: flex; gap: 18px; margin: var(--space-4) 0 10px; font-size: var(--text-base); color: var(--color-text-secondary); }
.scope label { display: flex; align-items: center; gap: var(--space-1-5); }
.notice { padding: var(--space-4); border: var(--line-w) solid var(--line-hairline); border-radius: var(--radius-sm); }
.config { width: 100%; min-height: 330px; resize: vertical; box-sizing: border-box; padding: var(--space-3); border: var(--line-w) solid var(--line-hairline); border-radius: var(--radius-sm); background: var(--color-bg-secondary); color: var(--color-text); font: var(--text-sm)/1.55 var(--font-mono); letter-spacing: 0; outline: none; }
.config:focus { border-color: var(--color-ring); }
.actions { display: flex; align-items: center; justify-content: space-between; margin-top: var(--space-3); }
.status.error { color: var(--color-error-text); }
.save { min-width: 64px; padding: var(--space-1-5) var(--space-3); border: 0; border-radius: var(--radius-xs); color: var(--color-on-primary); background: var(--color-primary); cursor: pointer; }
.save:disabled { opacity: .55; cursor: default; }
</style>
