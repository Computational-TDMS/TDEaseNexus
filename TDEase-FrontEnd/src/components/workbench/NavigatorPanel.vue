<!--
  NavigatorPanel — the shell's navigator composite view (Runs / Wiki / Files).

  Three sections, one active at a time. They project real, user-owned things,
  which is what §4 asks for ("each is a flat list or a tree of *user-owned*
  things"):

    - Runs (§4.2) — `RunsSection`, the run index.
    - Wiki (§4.4) — `WikiSection`, the workspace wiki.
    - Files — `FilesSection`, mounting the existing `FileTree`.

  The experimental Canvases/Evidence sections were removed (S-current keeps
  the workbench to shipped features); the Canvas feature itself was removed
  entirely on 2026-09-17.

  As a composite view it is hosted by CompositeViewHost on either side (left
  side bar by default, draggable to the auxiliary bar); it owns its own
  section tabs in its header, and the header is the view's drag source.
-->
<script setup lang="ts">
import { computed, ref, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { Files, Refresh, Histogram, Reading } from '@element-plus/icons-vue'
import AppButton from '@/components/primitives/AppButton.vue'
import RunsSection from '@/components/navigator/RunsSection.vue'
import FilesSection from '@/components/navigator/FilesSection.vue'
import WikiSection from '@/components/navigator/WikiSection.vue'
import { useUiLayoutStore, type NavigatorSection } from '@/stores/uiLayout'
import { useWorkspaceStore } from '@/stores/workspace'

const { t } = useI18n()
const uiLayout = useUiLayoutStore()
const workspaceStore = useWorkspaceStore()

/**
 * The three sections, switched from this panel's own header. A total record
 * over `NavigatorSection` means a section cannot be added without giving it a
 * tab here. Order is work-product first (runs); the full file tree — including
 * skill/config/data for advanced control — is last.
 */
const sections: ReadonlyArray<{ id: NavigatorSection; icon: Component }> = [
  { id: 'runs', icon: Histogram },
  { id: 'wiki', icon: Reading },
  { id: 'files', icon: Files },
]

const sectionTitleKey: Record<NavigatorSection, string> = {
  runs: 'workbench.rail.runs',
  files: 'workbench.rail.files',
  wiki: 'workbench.rail.wiki',
}

const activeSection = computed(() => uiLayout.activeNavigatorSection)

/**
 * The Files section is the one that reads the live filesystem, so the manual
 * refresh action is scoped to it — it reloads the root plus every expanded
 * directory. Chokidar keeps the tree live in Electron; this button is the
 * fallback for a missed/late event and the only refresh path in browser dev.
 */
const refreshing = ref(false)
const canRefresh = computed(
  () => activeSection.value === 'files' && workspaceStore.hasWorkspace,
)
async function refreshFileTree() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await workspaceStore.refreshExpanded()
  } finally {
    refreshing.value = false
  }
}
</script>

<template>
  <section
    class="navigator-panel"
    role="navigation"
    :aria-label="t('workbench.navigator.label')"
    tabindex="-1"
  >
    <header class="navigator-panel__header">
      <div class="navigator-panel__tabs" role="tablist" :aria-label="t('workbench.navigator.label')">
        <button
          v-for="section in sections"
          :key="section.id"
          type="button"
          role="tab"
          class="navigator-panel__tab"
          :class="{ 'is-active': activeSection === section.id }"
          :title="t(sectionTitleKey[section.id])"
          :aria-label="t(sectionTitleKey[section.id])"
          :aria-selected="activeSection === section.id"
          :data-section="section.id"
          @click="uiLayout.setActiveNavigatorSection(section.id)"
        >
          <el-icon :size="18"><component :is="section.icon" /></el-icon>
          <span class="navigator-panel__tab-label">{{ t(sectionTitleKey[section.id]) }}</span>
        </button>
      </div>
      <AppButton
        v-if="canRefresh"
        variant="subtle"
        size="sm"
        class="navigator-panel__refresh"
        :title="t('workbench.navigator.refresh')"
        :aria-label="t('workbench.navigator.refresh')"
        :disabled="refreshing"
        @click="refreshFileTree"
      >
        <template #icon>
          <el-icon :size="16" :class="{ 'is-spinning': refreshing }"><Refresh /></el-icon>
        </template>
      </AppButton>
    </header>

    <div class="navigator-panel__body">
      <RunsSection v-if="activeSection === 'runs'" />
      <FilesSection v-else-if="activeSection === 'files'" />
      <WikiSection v-else-if="activeSection === 'wiki'" />
    </div>
  </section>
</template>

<style scoped>
.navigator-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg-secondary);
  /* A composite view fills its host, sized by the host's split; no own
     border — the host seam carries the separation. */
}

.navigator-panel__header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--header-h);
  min-height: var(--header-h);
  padding: 0 var(--space-3);
  /* Tonal layering (VISUAL-SYSTEM.md §1.1): no hairline under the header.
     The body steps UP to --ctp-base below, so the luminance step — not a 1px
     line — carries the chrome-to-content separation, same as SessionBar. */
}

/* Refresh icon spins while a reload is in flight — same affordance the Viewer
   and Card refresh controls use elsewhere in the shell. */
.is-spinning {
  animation: navigator-refresh-spin 0.9s linear infinite;
}
@keyframes navigator-refresh-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.navigator-panel__tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow: hidden;
}

.navigator-panel__tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  height: 34px;
  padding: 0 var(--space-2);
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
  border-radius: var(--radius-md);
  white-space: nowrap;
  transition: color var(--dur-instant) var(--ease-out), background-color var(--dur-instant) var(--ease-out);
}

.navigator-panel__tab:hover {
  color: var(--color-text);
  background: var(--color-hover);
}

.navigator-panel__tab:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: -2px;
}

.navigator-panel__tab.is-active {
  /* The workbench chrome speaks the celadon lead voice (DESIGN.md §Two
     Voices): blue is the interact/data voice (links, tags, selection text)
     and used to bleed into chrome here, splitting the accent story on the
     very first screen. */
  color: var(--color-primary);
  background: var(--color-primary-soft);
}

/* Only the active tab spends horizontal room on its label; the rest stay
   icon-only so all three fit a 240px Navigator without wrapping. */
.navigator-panel__tab-label {
  display: none;
}

.navigator-panel__tab.is-active .navigator-panel__tab-label {
  display: inline;
}

.navigator-panel__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  /* Windows classic-scrollbar shift guard (see Transcript.vue). */
  scrollbar-gutter: stable;
  /* Steps UP one luminance level from the mantle shell, so content reads as
     sitting inside the chrome rather than level with it (VISUAL-SYSTEM.md §4.1
     surface ladder — same mantle→base step the Agent transcript uses). */
  background: var(--color-bg);
}
</style>
