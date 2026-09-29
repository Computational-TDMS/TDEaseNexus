<!--
  SideBar — the narrow icon rail.

  A pure-icon vertical column (~56px), not a wide panel. It is global chrome:
  every interactive control is a small icon button stacked vertically. No text
  labels, no horizontal toolbars, no search field — the lightest possible rail.

  Layout, top → bottom:
    • Workspace (folder) button
    • Page switcher (Workbench / Agent) — the persistent counterpart to the
      edge handle: the active page is marked, so a user who wandered onto the
      Workbench is one obvious click from the Agent page
    • (flex spacer pushes the rest to the bottom — also the frameless drag
      region; the PAGE HANDLE is not here: it hangs on the window edge and
      follows the Agent window — see PageHandle.vue)
    • Settings
    • Density toggle
    • Language
    • Theme

  Frameless drag region: `-webkit-app-region: drag` on the rail's empty space
  (the spacer), `no-drag` on every interactive child. Getting this backwards is
  the classic Electron bug where buttons stop receiving clicks.
-->
<script setup lang="ts">
import { computed } from 'vue'
import { Setting, Expand, Fold, Grid, ChatDotRound } from '@element-plus/icons-vue'
import WorkspaceRailButton from '@/components/workspace/WorkspaceRailButton.vue'
import ThemeSwitcher from '@/components/theme/ThemeSwitcher.vue'
import LangSwitcher from '@/components/widgets/LangSwitcher.vue'
import { useUiLayoutStore } from '@/stores/uiLayout'
import { useDocumentsStore } from '@/stores/documents'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const uiLayout = useUiLayoutStore()
const documentsStore = useDocumentsStore()

/**
 * Opens Settings as a document on the Workbench page (the only page that hosts
 * documents). If the Agent page is front, the door slides back first — the
 * document surface lives behind it.
 */
function openSettings() {
  uiLayout.setActivePage('workbench')
  documentsStore.openSettings(t('workbench.rail.settings'))
}

const isCompact = computed(() => uiLayout.density === 'compact')
function toggleDensity() {
  uiLayout.setDensity(isCompact.value ? 'comfortable' : 'compact')
}

const isAgentPage = computed(() => uiLayout.activePage === 'agent')
</script>

<template>
  <nav
    class="side-bar"
    role="navigation"
    :aria-label="t('workbench.sidebar.label')"
    tabindex="-1"
  >
    <!-- ── TOP: workspace + page switcher ───────────────────────────────── -->
    <div class="side-bar__top no-drag">
      <WorkspaceRailButton />
      <div class="side-bar__divider" aria-hidden="true" />
      <!-- The always-visible page switcher: wherever the user wandered, one
           click on the Agent button is the way home (the edge handle moves
           with the active page; these two never move). -->
      <button
        type="button"
        class="side-bar__btn no-drag"
        :class="{ 'is-active': !isAgentPage }"
        :title="t('workbench.rail.workbench')"
        :aria-label="t('workbench.rail.workbench')"
        :aria-pressed="!isAgentPage"
        @click="uiLayout.setActivePage('workbench')"
      >
        <el-icon :size="18"><Grid /></el-icon>
      </button>
      <button
        type="button"
        class="side-bar__btn no-drag"
        :class="{ 'is-active': isAgentPage }"
        :title="t('workbench.rail.agent')"
        :aria-label="t('workbench.rail.agent')"
        :aria-pressed="isAgentPage"
        @click="uiLayout.setActivePage('agent')"
      >
        <el-icon :size="18"><ChatDotRound /></el-icon>
      </button>
    </div>

    <!-- Spacer fills the middle — also the frameless drag region. -->
    <div class="side-bar__spacer" aria-hidden="true" />

    <!-- ── BOTTOM: tools, stacked vertically ────────────────────────────── -->
    <div class="side-bar__bottom no-drag">
      <div class="side-bar__divider" aria-hidden="true" />

      <button
        type="button"
        class="side-bar__btn no-drag"
        :title="t('workbench.rail.settingsHint')"
        :aria-label="t('workbench.rail.settings')"
        @click="openSettings"
      >
        <el-icon :size="18"><Setting /></el-icon>
      </button>

      <button
        type="button"
        class="side-bar__btn no-drag"
        :class="{ 'is-active': isCompact }"
        :title="t('workbench.titleBar.densityToggle')"
        :aria-label="t('workbench.titleBar.densityToggle')"
        :aria-pressed="isCompact"
        @click="toggleDensity"
      >
        <el-icon :size="18"><Fold v-if="isCompact" /><Expand v-else /></el-icon>
      </button>

      <div class="side-bar__inline no-drag">
        <LangSwitcher />
      </div>

      <div class="side-bar__inline no-drag">
        <ThemeSwitcher />
      </div>
    </div>
  </nav>
</template>

<style scoped>
.side-bar {
  /* Narrow icon rail — never a wide panel. Every control is a small icon
     stacked vertically; no text labels, no horizontal rows. */
  flex: 0 0 56px;
  width: 56px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--space-2) 0;
  background: var(--color-bg-tertiary);
  /* Tonal layering (§1.1): no hairline on the rail edge. Crust chrome sits a
     full luminance step below the mantle page beside it, so the step — not a
     1px line — carries the separation. */
  user-select: none;
  z-index: var(--z-raised);
}

.side-bar__top,
.side-bar__bottom {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
}

/* The spacer is the frameless drag region. */
.side-bar__spacer {
  flex: 1 1 auto;
  -webkit-app-region: drag;
  min-height: 0;
}

.side-bar__divider {
  width: 24px;
  height: 1px;
  margin: var(--space-1) 0;
  background: var(--color-border-panel);
}

/* ── Icon buttons ──────────────────────────────────────────────────────────
   40px square, transparent, muted; hover lifts the text color; active marks
   the state with a filled chip. Navigation carries no hue (VISUAL-SYSTEM.md
   §4.2). */
.side-bar__btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: color var(--dur-instant) var(--ease-out), background-color var(--dur-instant) var(--ease-out);
}

.side-bar__btn:hover:not(:disabled) {
  color: var(--color-text);
  background: var(--color-bg-hover);
}

.side-bar__btn:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}

.side-bar__btn.is-active {
  color: var(--color-text);
  background: var(--color-bg-muted);
}

/* LangSwitcher / ThemeSwitcher render their own trigger; center each in a
   40px cell so it lines up with the icon buttons above/below. */
.side-bar__inline {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
