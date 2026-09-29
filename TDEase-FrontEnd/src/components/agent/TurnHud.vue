<!--
  `<phase> <phase-elapsed> · act N · calls used · elapsed/deadline` plus a Stop
  action. Purely presentational: every number it shows is the `state` prop,
  verbatim — it holds no budget logic and computes no numbers of its own, so a
  test can assert the HUD renders exactly what a runtime state object says,
  never a component-invented figure.

  The phase and its clock come from `src/agent/turn-phase.ts`: a phase is a
  presentation state DERIVED from runtime events (turn_started → waiting,
  thinking_delta → thinking, text_delta → responding, tool.requested →
  executing), never its own session event. Two clocks answer the two
  questions a running turn owes the user: what is it doing (phase elapsed)
  and how long has the whole turn taken (total elapsed).

  "Neutral until 80% of a budget, then amber" applies to elapsed time.

  While suspended the clock stops and the state is named: `state.waiting`
  swaps the phase slot to "等待确认" (the agent is not working — the user is
  deciding), the elapsed text to `waiting for you`, and freezes the clocks.
-->
<template>
  <div class="turn-hud">
    <!-- role="status" only on the phase label: it changes rarely. The
         calls/elapsed metrics update every 250ms, so wrapping the whole bar
         in a live region would make screen readers re-announce constantly. -->
    <span class="turn-hud__phase" :class="{ 'is-waiting': state.waiting }" role="status">{{ state.waiting ? t('agent.hud.awaitingUser') : phaseLabel }}<template v-if="state.activity"> · {{ activityLabel }}</template><template v-if="state.subject"> · <span class="turn-hud__subject" :title="state.subject">{{ state.subject }}</span></template><template v-if="state.thoughtTail"> · <span class="turn-hud__thought" :title="state.thoughtTail">{{ state.thoughtTail }}</span></template> <span class="mono">{{ formatClock(state.phaseElapsedMs) }}</span></span>
    <span class="turn-hud__sep" aria-hidden="true">·</span>
    <span class="turn-hud__act mono">{{ t('agent.hud.act', { n: state.act }) }}</span>
    <span class="turn-hud__sep" aria-hidden="true">·</span>
    <span class="turn-hud__metric mono">
      {{ t('agent.hud.calls', { count: state.calls }) }}
    </span>
    <span class="turn-hud__sep" aria-hidden="true">·</span>
    <span class="turn-hud__metric mono" :class="{ 'is-warning': !state.waiting && elapsedRatio >= 0.8 }">
      {{ state.waiting ? t('agent.hud.waiting') : t('agent.hud.elapsed', { elapsed: formatMs(state.elapsedMs), deadline: formatMs(state.deadlineMs) }) }}
    </span>

    <AppButton
      variant="subtle"
      size="sm"
      class="turn-hud__stop"
      :title="t('agent.hud.stopTurnHint')"
      :aria-label="t('agent.hud.stopTurnHint')"
      @click="emit('stop')"
    >
      {{ t('agent.hud.stopTurn') }}
    </AppButton>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AppButton from '@/components/primitives/AppButton.vue'
import { useI18n } from 'vue-i18n'
import { toolActionKey } from '@/utils/tool-identity'
import type { TurnPhase } from '@/agent/turn-phase'

export interface TurnHudState {
  phase: TurnPhase
  /** While executing: the tool name in flight — the map names its seam. */
  activity?: string
  /** While executing: the call's subject ("npm test", a file name) — the
   *  intent line's object, distilled from the call args (tool-identity.ts). */
  subject?: string
  /** While thinking: the live reasoning segment's tail — real thought text,
   *  never a canned label; refreshed at the HUD's own tick cadence. */
  thoughtTail?: string
  /** How long the current phase has been running (derived clock). */
  phaseElapsedMs: number
  /** 1-indexed act number within the turn. */
  act: number
  calls: number
  elapsedMs: number
  deadlineMs: number
  /** Suspended for approval — the clock is paused and reads "waiting". */
  waiting: boolean
}

const props = defineProps<{ state: TurnHudState }>()
const emit = defineEmits<{ stop: [] }>()

const { t } = useI18n()

const phaseLabel = computed(() => t(`agent.hud.phase.${props.state.phase}`))

/**
 * The in-flight tool, named the way the transcript names it — the action
 * phrase ("运行命令"), falling back to the raw name for unlisted tools. One
 * identity module (tool-identity.ts) feeds both surfaces, so the HUD and the
 * transcript's tool rows never disagree about what the agent is doing.
 */
const activityLabel = computed(() => {
  const activity = props.state.activity
  if (!activity) return ''
  const key = toolActionKey(activity)
  return key ? t(key) : activity
})

const elapsedRatio = computed(() => (props.state.deadlineMs > 0 ? props.state.elapsedMs / props.state.deadlineMs : 0))

function formatMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** Phase clock reads the way a glance reads: `8s` under a minute, `1:05` over. */
function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  return formatMs(ms)
}
</script>

<style scoped>
.turn-hud {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-top: var(--line-w) solid var(--line-seam);
  background: var(--color-bg);
  font-size: var(--text-label);
  color: var(--color-text-muted, var(--color-text-muted));
}

.turn-hud__sep {
  opacity: 0.5;
}

/* The HUD only renders while a turn is live, and the phase label is its
   running indicator — so it carries the live channel colour (The Living
   Channel Rule). The metrics beside it stay quiet. */
.turn-hud__phase {
  color: var(--color-live);
  font-weight: 500;
}

/* The intent line's object (tool subject / thought tail): real content, so it
   reads quieter than the phase but still legibly — muted, single-line, cut
   with an ellipsis (the full text rides the title tooltip). */
.turn-hud__subject,
.turn-hud__thought {
  display: inline-block;
  max-width: 32ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
  color: var(--color-text-muted);
  font-weight: 400;
}

.turn-hud__thought {
  font-style: italic;
}

/* Suspended at the approval gate is its own state, not a loop phase — the
   agent is not working, the user is deciding. It reads in the interact voice
   (the chrome's "your move" colour), not the live "working" celadon. */
.turn-hud__phase.is-waiting {
  color: var(--color-interact-text);
}

.turn-hud__metric.is-warning {
  /* The Latte block pulls --color-warning toward --ctp-text so it stays
     legible on the light mantle surface; no per-component override needed. */
  color: var(--color-warning-text);
}

.turn-hud__stop {
  margin-left: auto;
}
</style>
