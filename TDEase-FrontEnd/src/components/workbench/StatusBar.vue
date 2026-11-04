<!--
  Full-width footer: workspace name, the Backend's connection state with an
  explicit reconnect action, and — on the right — the Runs/Logs dock toggles
  and the Agent sidebar toggle.

  The run count and the Backend state were both literal placeholder strings --
  the "0 running" count was a constant, and the Backend pill read "unknown"
  (legacy hardcoded copy) whether the Backend was healthy, unreachable or
  rejecting every request. A status bar that reports the same thing in all
  three states is worse than an empty one: it is the surface a user checks
  FIRST when something looks wrong, and it was answering "I don't know" by
  design. Both now read the stores that already hold the answer.

  The Runs/Logs toggles follow the editor convention (VS Code's panel toggles):
  the dock's switch lives in a fixed, always-visible bar instead of a button
  floating over the document. A click opens the dock on that tab; clicking the
  active toggle again closes it. The Agent toggle is the same convention for
  the Workbench's right-docked Agent sidebar.
-->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Refresh } from '@element-plus/icons-vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useRunsStore } from '@/stores/runs'
import { useSettingsStore } from '@/stores/settings'
import { useUiLayoutStore } from '@/stores/uiLayout'

const { t } = useI18n()
const workspaceStore = useWorkspaceStore()
const runsStore = useRunsStore()
const settingsStore = useSettingsStore()
const uiLayout = useUiLayoutStore()

const dockOpen = computed(() => uiLayout.panelVisible)
const runsToggleActive = computed(() => dockOpen.value && uiLayout.activityTab === 'runs')
const logsToggleActive = computed(() => dockOpen.value && uiLayout.activityTab === 'logs')
/** Open the panel on `tab`, or — if that tab is already front — close it. */
function toggleDockTab(tab: 'runs' | 'logs') {
  if (dockOpen.value && uiLayout.activityTab === tab) {
    uiLayout.togglePanelVisible()
    return
  }
  uiLayout.setActivityTab(tab)
  if (!dockOpen.value) uiLayout.togglePanelVisible()
}

/**
 * Three states, three words. `connected` is the Run event stream's own view of
 * the Backend, so this says what the app can actually do right now rather than
 * what a health endpoint said once at boot.
 */
const backendState = computed(() => {
  if (settingsStore.backendMode === 'disabled') return t('workbench.statusBar.backendIdle')
  if (settingsStore.backendConnecting) return t('workbench.statusBar.backendConnecting')
  // Preserve the writable compatibility flag used by tests and older callers;
  // the supervisor is the normal source of both values in production.
  if (settingsStore.backendConnected && settingsStore.backendState === 'offline') {
    return t('workbench.statusBar.backendConnected')
  }
  switch (settingsStore.backendState) {
    case 'online': return t('workbench.statusBar.backendConnected')
    case 'degraded': return t('workbench.statusBar.backendDegraded')
    case 'upgrading': return t('workbench.statusBar.backendUpgrading')
    case 'reconnecting': return t('workbench.statusBar.backendReconnecting')
    case 'incompatible': return t('workbench.statusBar.backendIncompatible')
    default: return t('workbench.statusBar.backendOffline')
  }
})

const retryTitle = computed(() => settingsStore.backendError
  ? t('workbench.statusBar.backendRetryWithError', { error: settingsStore.backendError })
  : t('workbench.statusBar.backendRetry'))

const workspaceName = computed(() => {
  const path = workspaceStore.workspacePath
  if (!path) return t('workbench.titleBar.workspacePlaceholder')
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
})
</script>

<template>
  <footer
    class="status-bar"
    role="contentinfo"
    :aria-label="t('workbench.statusBar.label')"
  >
    <span class="status-bar__brand">TDEaseNexus</span>
    <span class="status-bar__sep" aria-hidden="true">·</span>
    <span class="status-bar__item status-bar__item--workspace" :title="workspaceName">{{ workspaceName }}</span>
    <span class="status-bar__sep" aria-hidden="true">·</span>
    <span
      class="status-bar__item status-bar__item--backend"
      :data-state="settingsStore.backendState"
    ><span
      class="status-bar__backend-dot"
      :data-state="settingsStore.backendState"
      aria-hidden="true"
    />{{ backendState }}</span>
    <button
      v-if="settingsStore.backendMode !== 'disabled'"
      class="status-bar__retry"
      type="button"
      :title="retryTitle"
      :aria-label="retryTitle"
      :disabled="settingsStore.backendConnecting"
      @click="settingsStore.connectBackend()"
    >
      <el-icon :size="14" :class="{ 'is-spinning': settingsStore.backendConnecting }"><Refresh /></el-icon>
      <span>{{ t('workbench.statusBar.backendReconnect') }}</span>
    </button>
    <span class="status-bar__spacer" />

    <!-- Follow agent: whether the Agent's view.* opens take focus. -->
    <button
      type="button"
      class="status-bar__panel-toggle status-bar__follow"
      :class="{ 'is-active': settingsStore.followAgent }"
      :aria-pressed="settingsStore.followAgent"
      :title="t('workbench.statusBar.followAgentHint')"
      @click="settingsStore.setFollowAgent(!settingsStore.followAgent)"
    >
      <span class="status-bar__follow-dot" aria-hidden="true" />
      {{ t('workbench.statusBar.followAgent') }}
    </button>

    <!-- Runs/Logs dock toggles + the Agent sidebar toggle: fixed chrome, never
         floating over content. -->
    <div class="status-bar__panels" role="group" :aria-label="t('workbench.activityDock.label')">
      <button
        type="button"
        class="status-bar__panel-toggle"
        :class="{ 'is-active': runsToggleActive }"
        :aria-pressed="runsToggleActive"
        :title="t('workbench.statusBar.toggleRuns')"
        @click="toggleDockTab('runs')"
      >
        {{ t('workbench.activityDock.tabRuns') }}
        <span v-if="runsStore.runningCount" class="status-bar__panel-badge">{{ runsStore.runningCount }}</span>
      </button>
      <button
        type="button"
        class="status-bar__panel-toggle"
        :class="{ 'is-active': logsToggleActive }"
        :aria-pressed="logsToggleActive"
        :title="t('workbench.statusBar.toggleLogs')"
        @click="toggleDockTab('logs')"
      >
        {{ t('workbench.activityDock.tabLogs') }}
      </button>
    </div>
  </footer>
</template>

<style scoped>
.status-bar__follow { display: inline-flex; align-items: center; gap: 6px; }
.status-bar__follow-dot {
  width: 7px; height: 7px; border-radius: 50%;
  box-shadow: inset 0 0 0 1.5px var(--color-text-muted);
  transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.status-bar__follow.is-active .status-bar__follow-dot {
  background: var(--color-live);
  box-shadow: none;
}
.status-bar {
  flex: none;
  display: flex;
  align-items: center;
  height: var(--row-h-sm);
  min-height: var(--row-h-sm);
  padding: 0 var(--space-3);
  gap: var(--space-2);
  background: var(--color-bg-tertiary);
  /* Tonal layering (§1.1): no hairline above the bar. The crust chrome sits a
     full luminance step below the surfaces above it, so the step — not a 1px
     line — carries the separation (SessionBar pilot). */
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.status-bar__brand {
  color: var(--color-text);
  font-weight: 600;
  letter-spacing: 0.02em;
}

.status-bar__item {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-bar__item--workspace {
  color: var(--color-text);
  font-weight: 500;
  max-width: 30ch;
}

.status-bar__item--backend {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
}

/* Backend connection indicator dot — the one "living" signal on the bar.
   The Living Channel Rule (VISUAL-SYSTEM.md §5/§6.4): only states that are
   actively working the connection may carry --color-live and its glow; settled
   states stay static (online = success tone, degraded = warning, offline =
   muted). A disabled backend shows no dot — silence, not a grey circle. */
.status-bar__backend-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-text-muted);
  transition: background-color var(--dur-fast) var(--ease-out);
}
/* Live: connecting / reconnecting / upgrading — the channel is being worked. */
.status-bar__backend-dot[data-state="connecting"],
.status-bar__backend-dot[data-state="reconnecting"],
.status-bar__backend-dot[data-state="upgrading"] {
  background: var(--color-live);
  box-shadow: 0 0 0 0 var(--color-live-glow);
  animation: status-bar-backend-pulse 1.6s var(--ease-inout) infinite;
}
/* Settled & healthy. */
.status-bar__backend-dot[data-state="online"] { background: var(--color-success); }
/* Settled but unhealthy. */
.status-bar__backend-dot[data-state="degraded"] { background: var(--color-warning); }
/* Settled & broken. */
.status-bar__backend-dot[data-state="offline"],
.status-bar__backend-dot[data-state="incompatible"] { background: var(--color-text-muted); }
/* Disabled backend — no dot at all. */
.status-bar__backend-dot[data-state="disabled"] { display: none; }

@keyframes status-bar-backend-pulse {
  0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-live) 60%, transparent); }
  70%  { box-shadow: 0 0 0 5px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}

.status-bar__sep {
  color: var(--color-text-disabled);
}

/* Runs/Logs dock toggles (right cluster): quiet text buttons that light up
   with the interact tone while their tab is front — same active language as
   the Navigator tabs, so "which panel is open" reads the same everywhere. */
.status-bar__panels {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.status-bar__panel-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  height: 22px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
  transition: color var(--dur-instant) var(--ease-out), background-color var(--dur-instant) var(--ease-out);
}

.status-bar__panel-toggle:hover {
  color: var(--color-text);
  background: var(--color-hover);
}

.status-bar__panel-toggle:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: -2px;
}

.status-bar__panel-toggle.is-active {
  color: var(--color-interact-text);
  background: var(--color-interact-soft);
}

/* Live-run badge on the Runs toggle — the only count on the bar, replacing
   the old "N running" text item. */
.status-bar__panel-badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--status-running);
  color: var(--color-on-primary);
  font-size: var(--text-label);
  line-height: 16px;
  text-align: center;
}

/* The Agent toggle's live dot: the living channel (§1.2) — only an acting or
   decision-awaiting Agent lights it, and it is a static glow, not animation. */
.status-bar__panel-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-live);
  box-shadow: 0 0 5px var(--color-live-glow);
}

.status-bar__spacer {
  flex: 1 1 auto;
}

.status-bar__retry {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 82px;
  height: 20px;
  padding: 0 7px;
  color: var(--color-text);
  background: var(--elev-1-bg);
  /* Light themes carry the float as shadow (--elev-1); dark themes invert to a
     1px hairline (--elev-1-border resolves only on dark themes, per the elevation
     ladder in unified-design-tokens.css). A real border avoids the box-shadow
     `none, …` syntax trap — `none` cannot share a comma-separated shadow list. */
  border: 1px solid var(--elev-1-border, transparent);
  border-radius: var(--radius-lg);
  box-shadow: var(--elev-1);
  cursor: pointer;
  transition: box-shadow var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}

.status-bar__retry:hover:not(:disabled) {
  color: var(--color-text);
  background: var(--color-bg-hover);
  border-color: var(--line-seam);
}

.status-bar__retry:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 1px;
}

.status-bar__retry:disabled {
  cursor: default;
  opacity: 0.65;
}

.is-spinning {
  animation: status-bar-spin 900ms linear infinite;
}

@keyframes status-bar-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .is-spinning { animation: none; }
  /* Reduced motion removes the pulse, never the colour that marks the channel
     live (VISUAL-SYSTEM.md §6.10 — same rule as the Agent edge indicator). */
  .status-bar__backend-dot[data-state="connecting"],
  .status-bar__backend-dot[data-state="reconnecting"],
  .status-bar__backend-dot[data-state="upgrading"] {
    animation: none;
    box-shadow: 0 0 0 2px var(--color-live-glow);
  }
}
</style>
