<!--
  SettingsNav — the settings rail, PI-Desktop style: sections grouped under
  small group headings, with the search box filtering across labels and
  keywords. A group heading shows only while at least one of its sections
  matches the query.
-->
<template>
  <nav class="settings-nav">
    <div class="search-shell">
      <el-icon :size="15" class="search-icon" aria-hidden="true"><Search /></el-icon>
      <input v-model="query" class="search-input" type="search" :placeholder="t('workbench.settings.searchPlaceholder')" :aria-label="t('workbench.settings.searchPlaceholder')" @keydown.escape="query = ''" />
      <IconButton v-if="query" size="xs" class="search-clear" :aria-label="t('workbench.settings.clearSearch')" @click="query = ''">
        <Close />
      </IconButton>
    </div>

    <template v-for="group in visibleGroups" :key="group.label">
      <div class="nav-group-label">{{ group.label }}</div>
      <button
        v-for="tab in group.tabs"
        :key="tab.id"
        :class="['nav-item', { active: modelValue === tab.id }]"
        @click="$emit('select', tab.id)"
      >
        <el-icon :size="16" aria-hidden="true"><component :is="tab.icon" /></el-icon>
        <span>{{ tab.label }}</span>
      </button>
    </template>

    <div v-if="visibleGroups.length === 0" class="nav-empty">{{ t('workbench.settings.noSectionMatch') }}</div>
  </nav>
</template>

<script setup lang="ts">
import { computed, ref, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Search,
  Close,
  Setting,
  SetUp,
  Tools,
  DataBoard,
  Lock,
  Operation,
  Brush,
  Share,
  Document,
} from '@element-plus/icons-vue'
import IconButton from '@/components/primitives/IconButton.vue'

defineProps<{ modelValue: string }>()
defineEmits<{ select: [id: string] }>()

const { t } = useI18n()

const query = ref('')

interface SettingsTab {
  id: string
  labelKey: string
  icon: Component
  kw: string[]
}

interface SettingsGroup {
  labelKey: string
  tabs: SettingsTab[]
}

/**
 * The information architecture, one total record: every section appears in
 * exactly one group. Order is the user's reading order — personal surface
 * first, then the Agent's brain (model/permissions/tools/MCP), then
 * workspace-wide panels.
 */
const groups: SettingsGroup[] = [
  {
    labelKey: 'workbench.settings.group.preferences',
    tabs: [
      { id: 'general', labelKey: 'workbench.settings.section.general', icon: Setting, kw: ['general','通用','启动','通知','backend','服务'] },
      { id: 'appearance', labelKey: 'workbench.settings.section.appearance', icon: Brush, kw: ['appearance','外观','font','字体','zoom','缩放','density','密度','theme','主题'] },
    ],
  },
  {
    labelKey: 'workbench.settings.group.agent',
    tabs: [
      { id: 'providers', labelKey: 'workbench.settings.section.providers', icon: SetUp, kw: ['provider','模型','api','供应商','key','密钥'] },
      { id: 'permissions', labelKey: 'workbench.settingsPermissions.sectionTitle', icon: Lock, kw: ['permission','权限','deny','ask','allow','grant','revoke','撤销','授权'] },
      { id: 'agent-tools', labelKey: 'workbench.settings.section.agentTools', icon: Operation, kw: ['agent','tools','工具','能力','mcp','skill'] },
      { id: 'mcp', labelKey: 'workbench.settings.section.mcp', icon: Tools, kw: ['mcp','工具','connector','连接器','server'] },
    ],
  },
  {
    labelKey: 'workbench.settings.group.workspace',
    tabs: [
      { id: 'sharing', labelKey: 'workbench.settingsSharing.sectionTitle', icon: Share, kw: ['share','分享','web','lan','token','令牌','访问'] },
      { id: 'statistics', labelKey: 'workbench.settings.section.statistics', icon: DataBoard, kw: ['usage','用量','统计','token','费用','图表'] },
    ],
  },
  {
    // The legal surface: GPL-3.0 §0 expects "Appropriate Legal Notices" to
    // stay reachable in the interface — not only on the installer's one-shot
    // license page.
    labelKey: 'workbench.settings.group.about',
    tabs: [
      { id: 'about', labelKey: 'workbench.settings.section.about', icon: Document, kw: ['about','license','legal','privacy','terms','eula','gpl','关于','许可','协议','条款','隐私','版本'] },
    ],
  },
]

const visibleGroups = computed(() => {
  const q = query.value.trim().toLowerCase()
  return groups
    .map((group) => ({
      ...group,
      label: t(group.labelKey),
      tabs: group.tabs
        .map((tab) => ({ ...tab, label: t(tab.labelKey) }))
        .filter((tab) => !q || tab.label.toLowerCase().includes(q) || tab.kw.some((k) => k.toLowerCase().includes(q))),
    }))
    .filter((group) => group.tabs.length > 0)
})
</script>

<style scoped>
.settings-nav {
  width: 190px;
  flex-shrink: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  padding: var(--space-1) var(--space-2);
  border-right: var(--line-w) solid var(--line-seam);
  overflow-x: hidden;
  overflow-y: auto;
}

/* ─── Search ─── */
.search-shell {
  position: relative;
  display: flex;
  align-items: center;
  min-height: var(--row-h);
  margin: 0 0 var(--space-2);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.search-icon {
  position: absolute;
  left: var(--space-2-5);
  pointer-events: none;
  opacity: 0.64;
}

.search-input {
  width: 100%;
  height: var(--row-h);
  min-width: 0;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--color-text);
  background: color-mix(in srgb, var(--color-border) 56%, transparent);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  outline: none;
  padding: 0 var(--space-6) 0 var(--space-4);
  letter-spacing: 0;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}

.search-input::placeholder { color: color-mix(in srgb, var(--color-text-muted) 76%, transparent); }
.search-input::-webkit-search-cancel-button { display: none; }

.search-input:focus {
  background: var(--color-bg-secondary);
  border-color: color-mix(in srgb, var(--color-primary) 32%, var(--line-seam));
  box-shadow: var(--shadow-focus);
}

.search-clear {
  position: absolute;
  right: var(--space-1-5);
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-text-muted) 14%, transparent);
  border: none;
  border-radius: 50%;
  padding: 0;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.search-clear:hover { color: var(--color-text); background: color-mix(in srgb, var(--color-text-muted) 22%, transparent); }

/* ─── Group headings: the PI-Desktop rail register — a quiet small-caps
       label, not a section of its own. ─── */
.nav-group-label {
  margin: var(--space-2) var(--space-3) 0;
  font-size: var(--text-label);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  opacity: 0.78;
  user-select: none;
}

.nav-empty {
  padding: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

/* ─── Nav items ─── */
.nav-item {
  font-family: var(--font-body);
  text-align: left;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-base);
  color: var(--color-text-muted);
  background: none;
  border: none;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  letter-spacing: 0.02em;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.nav-item svg { flex-shrink: 0; opacity: 0.7; }
.nav-item.active svg { opacity: 1; }
.nav-item:hover { background: var(--color-hover); color: var(--color-text); }
.nav-item.active {
  background: var(--color-interact-soft);
  color: var(--color-interact-text);
  font-weight: 600;
}
</style>
