<!--
  The resting conversation's center stage: the mode's HERO emblem (trident /
  scanning glass — MindsetHero) at reading-center, the goal hints beneath it.
  The hints SPLIT BY MINDSET — the two modes are two offerings, and they must
  honor that (the hero and the hints change with the mode; nothing else in
  the layout moves):
    Workflow Analysis → action goals (identify, plan a run)
    Explore           → question goals (overview, census, interpretation)
  Every offered goal must be actionable by the skill library: identification
  needs raw files (toppic-suite), results questions need runs (tdp-opensearch
  census; interpretation routes through toppic-suite / tdp-copilot /
  tdp-opensearch), workflow authoring is always available (workflow skill).
  With no data at all the first row is not a goal but the ONE setup action —
  opening the workspace-choosing panel EXECUTES on click (emit `setup`),
  because the Agent has no folder-picker tool: a setup prompt would only make
  it describe a click it cannot do. The question goal below it stays a
  composer fill.
-->
<template>
  <div class="agent-empty">
    <MindsetHero class="agent-empty__hero" :mindset="mindset" />
    <ul class="agent-empty__goals">
      <li v-if="setupAction" class="agent-empty__item" :style="{ '--enter-index': 0 }">
        <button type="button" class="agent-empty__goal" @click="emit('setup')">
          <el-icon class="agent-empty__goal-icon" :size="15" aria-hidden="true"><Folder /></el-icon>
          <span class="agent-empty__goal-text">{{ setupAction }}</span>
          <span class="agent-empty__goal-arrow" aria-hidden="true">→</span>
        </button>
      </li>
      <li
        v-for="(goal, i) in goals"
        :key="goal"
        class="agent-empty__item"
        :style="{ '--enter-index': setupAction ? i + 1 : i }"
      >
        <button type="button" class="agent-empty__goal" @click="emit('select', goal)">
          <span class="agent-empty__goal-text">{{ goal }}</span>
          <span class="agent-empty__goal-arrow" aria-hidden="true">→</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Folder } from '@element-plus/icons-vue'
import MindsetHero from './MindsetHero.vue'
import type { MindsetId } from '@/agent/prompt'

const props = withDefaults(defineProps<{
  rawFileCount?: number
  fastaFileCount?: number
  runCount?: number
  /** The active mindset — the goals honor the two offerings: Workflow
   *  Analysis suggests actions, Explore suggests questions. */
  mindset?: MindsetId
}>(), {
  rawFileCount: 0,
  fastaFileCount: 0,
  runCount: 0,
  mindset: 'workflow',
})

const emit = defineEmits<{ select: [message: string]; setup: [] }>()

const { t } = useI18n()

// Runs count as data too: a Workspace with completed runs but no raw/fasta
// files still has something real to ask about, so the "open a workspace
// folder" setup hint must not contradict it.
const hasData = computed(() => props.rawFileCount > 0 || props.fastaFileCount > 0 || props.runCount > 0)

// The one row that executes instead of filling the composer — present only
// while the Workspace has nothing to work on.
const setupAction = computed(() => (hasData.value ? null : t('agent.empty.setupOpenWorkspace')))

const goals = computed(() => {
  if (!hasData.value) {
    return [t('agent.empty.goalWhatNext')]
  }
  if (props.mindset === 'workflow') {
    // Workflow Analysis: the run's verbs. Plan is always available (workflow
    // authoring); identify needs raw files.
    const actions = [
      ...(props.rawFileCount > 0
        ? [t('agent.empty.goalIdentifyN', { count: props.rawFileCount })]
        : []),
      t('agent.empty.goalPlanAnalysis'),
    ]
    return actions
  }
  // Explore: questions only — nothing runs, everything is asked. With runs
  // in the Workspace the questions turn to them; without, they survey the
  // data at hand.
  const questions = [
    ...(props.rawFileCount > 0 ? [t('agent.empty.goalShowInside')] : []),
    ...(props.runCount > 0
      ? [t('agent.empty.goalCensus'), t('agent.empty.goalInterpret')]
      : [t('agent.empty.goalExploreData')]),
  ]
  return questions
})
</script>

<style scoped>
/* The empty state owns the first impression: it sits in the reading column,
   vertically centered in the transcript well, and reads as an invitation —
   not as a form. The scroller's own padding frames it; the min-height puts
   the block at optical center for the common dock heights without fighting
   the virtual scroller. */
.agent-empty {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--space-5);
  min-height: 46vh;
  max-width: var(--chat-column-width, 720px);
  margin: 0 auto;
  padding: var(--space-6) var(--space-3);
}

/* The hero owns the center; the goal list reads beneath it. */
.agent-empty__hero {
  flex-shrink: 0;
}

.agent-empty__goals {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

/* Staggered entrance: each card rises 40ms after its predecessor. Delay is
   index-driven via --enter-index so the list needs no JS timers. */
.agent-empty__item {
  animation: agent-empty-rise 320ms var(--ease-out) both;
  animation-delay: calc(60ms + var(--enter-index, 0) * 40ms);
}

.agent-empty__goal {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  text-align: left;
  padding: var(--space-2-5) var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-base);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}

/* Surface-step card, not a ghost outline (same treatment as the Welcome
   cards): hover lifts by surface + shadow; the trailing arrow slides toward
   the click so the row reads as "this fills the composer", not a label. */
.agent-empty__goal:hover {
  background: var(--color-bg-hover);
  box-shadow: var(--shadow-sm);
}
.agent-empty__goal:hover .agent-empty__goal-arrow {
  transform: translateX(2px);
  color: var(--color-primary);
}

.agent-empty__goal:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}

/* The setup row's folder glyph mirrors the trailing arrow: muted at rest,
   primary on hover, so "this row opens a place" reads at a glance. */
.agent-empty__goal-icon {
  flex-shrink: 0;
  color: var(--color-text-muted);
  transition: color var(--dur-fast) var(--ease-out);
}
.agent-empty__goal:hover .agent-empty__goal-icon {
  color: var(--color-primary);
}

.agent-empty__goal-text {
  flex: 1 1 auto;
  min-width: 0;
}

.agent-empty__goal-arrow {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  transition: transform var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}

@keyframes agent-empty-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .mindset-hero,
  .agent-empty__item {
    animation: none;
  }
  .agent-empty__goal,
  .agent-empty__goal-arrow {
    transition: none;
  }
}
</style>
