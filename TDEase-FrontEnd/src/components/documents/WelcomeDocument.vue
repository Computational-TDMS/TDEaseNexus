<!--
  WelcomeDocument — the Workbench's no-tab surface, and the first-run guide.

  Rendered by DocumentGroup whenever no document resolves, so an empty
  workbench is never a blank pane: the guide IS the default surface, not a tab
  that has to be opened (and closed) to get out of the way.

  Exactly THREE actions, in the order a first session actually needs them —
  open the workspace folder, ask the AI Agent to analyze data, configure the
  AI model — each card executes the real navigation it names, so the page
  doubles as the interface orientation it claims to be. No fourth thing: a
  launcher tutorial is not orientation.

  The spectrum above the title is the one deliberate exception to the page's
  stillness — it re-homes the boot splash's living spectrum
  (WelcomeSpectrum.vue), so the first-run surface picks up exactly where the
  splash handed off. The rest of the page stays still: a one-time entrance
  (rise + fade, 220ms); `prefers-reduced-motion` shows it instantly.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ChatDotRound, Folder, Setting } from '@element-plus/icons-vue'
import WelcomeSpectrum from './WelcomeSpectrum.vue'
import { useDocumentsStore } from '@/stores/documents'
import { useUiLayoutStore } from '@/stores/uiLayout'
import { useWorkspaceRailPanel } from '@/composables/useWorkspaceRailPanel'

const { t } = useI18n()
const documentsStore = useDocumentsStore()
const uiLayout = useUiLayoutStore()
const railPanel = useWorkspaceRailPanel()

/**
 * The three actions, each executing what its label says. The workspace card
 * opens THE workspace panel — the collapsible column beside the top-left
 * workspace button (recent workspaces + the folder picker) — not a parallel
 * picker of its own. One workspace-choosing UI, one place it lives.
 */
const cards = [
  {
    id: 'workspace',
    icon: Folder,
    title: () => t('workbench.welcome.workspaceTitle'),
    description: () => t('workbench.welcome.workspaceDescription'),
    run: () => { railPanel.open.value = true },
  },
  {
    id: 'agent',
    icon: ChatDotRound,
    title: () => t('workbench.welcome.agentTitle'),
    description: () => t('workbench.welcome.agentDescription'),
    run: () => uiLayout.setActivePage('agent'),
  },
  {
    id: 'model',
    icon: Setting,
    title: () => t('workbench.welcome.settingsTitle'),
    description: () => t('workbench.welcome.settingsDescription'),
    run: () => documentsStore.openSettings(t('workbench.rail.settings')),
  },
] as const
</script>

<template>
  <div class="welcome">
    <div class="welcome__inner">
      <!-- Brand lockup: the product's name and its Chinese name (kai face, the
           brand's Chinese voice) — the GUI counterpart of the splash wordmark,
           so the two surfaces name the product identically. -->
      <div class="welcome__brand">
        <span class="welcome__wordmark">TDEaseNexus</span>
        <span class="welcome__cn">TD通</span>
      </div>
      <!-- The splash's spectrum, re-homed: token-pure in every theme. -->
      <WelcomeSpectrum class="welcome__spectrum" />
      <h1 class="welcome__title">{{ t('workbench.welcome.title') }}</h1>
      <p class="welcome__description">{{ t('workbench.welcome.description') }}</p>
      <div class="welcome__cards">
        <button
          v-for="card in cards"
          :key="card.id"
          type="button"
          class="welcome__card"
          @click="card.run()"
        >
          <el-icon class="welcome__card-icon" :size="18" aria-hidden="true">
            <component :is="card.icon" />
          </el-icon>
          <span class="welcome__card-body">
            <span class="welcome__card-title">{{ card.title() }}</span>
            <span class="welcome__card-desc">{{ card.description() }}</span>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  overflow: auto;
  background: var(--color-bg);
}

.welcome__inner {
  max-width: 620px;
  margin: auto;
  padding: var(--space-6) var(--space-5);
  text-align: center;
}

.welcome__spectrum {
  width: min(560px, 100%);
  margin: 0 auto var(--space-4);
  animation: welcome-rise 220ms var(--ease-out) both;
}

.welcome__brand {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
  animation: welcome-rise 220ms var(--ease-out) both;
}

.welcome__wordmark {
  font-size: var(--text-sm);
  font-weight: 650;
  letter-spacing: 0.04em;
  color: var(--color-text);
}

/* Kai (楷体) — the brush stroke is the Chinese brand voice; the UI sans stays
   reserved for interface text. Falls back through the installed Chinese
   families, then serif, so a machine without KaiTi still renders. */
.welcome__cn {
  padding-left: var(--space-2);
  border-left: 1px solid var(--color-border);
  font-family: 'KaiTi', 'STKaiti', 'Kaiti SC', 'Noto Serif SC', 'Source Han Serif SC', 'SimSun', serif;
  font-size: var(--text-sm);
  letter-spacing: 0.16em;
  color: var(--color-text-muted);
}

.welcome__title {
  margin: 0;
  font-size: var(--text-xl);
  line-height: var(--text-xl-lh);
  font-weight: 600;
  color: var(--color-text);
  animation: welcome-rise 220ms var(--ease-out) 40ms both;
}

.welcome__description {
  margin: var(--space-3) auto 0;
  max-width: 58ch;
  font-size: var(--text-lg);
  line-height: var(--text-lg-lh);
  color: var(--color-text-muted);
  animation: welcome-rise 220ms var(--ease-out) 80ms both;
}

.welcome__cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);
  margin-top: var(--space-6);
  text-align: left;
  animation: welcome-rise 220ms var(--ease-out) 120ms both;
}

/* The card is a surface step, not a ghost: the old 1px-hairline + same-tone
   fill read as a limp outline on the paper (the "ghost card" anti-pattern).
   The deepened crust step now separates it from the base by itself; hover
   lifts via surface + shadow, never via a border color change. */
.welcome__card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2-5);
  padding: var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font: inherit;
  cursor: pointer;
  /* Buttons carry a UA `text-align: center` that beats the inherited
     `text-align: left` on .welcome__cards — declare it here or the card
     body renders centered against its top-left icon. */
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}

.welcome__card:hover {
  background: var(--color-bg-hover);
  box-shadow: var(--shadow-sm);
}

.welcome__card:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}

.welcome__card-icon {
  flex-shrink: 0;
  margin-top: 2px;
  /* The icon is the one accent on the card — the action voice, pointing at
     what the card does, instead of another gray glyph. */
  color: var(--icon-accent);
}

.welcome__card-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.welcome__card-title {
  font-size: var(--text-base);
  line-height: var(--text-base-lh);
  font-weight: 600;
}

.welcome__card-desc {
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
  color: var(--color-text-muted);
}

@keyframes welcome-rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* Narrow center column (Agent dock wide, small window): stack the cards. */
@media (max-width: 640px) {
  .welcome__cards {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .welcome__spectrum,
  .welcome__title,
  .welcome__description,
  .welcome__cta,
  .welcome__cards {
    animation: none;
  }
}
</style>
