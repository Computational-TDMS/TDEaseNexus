<!--
  TurnOutcomeCard — `turn.completed` block: an outcome
  chip (check/question/minus-circle icon: Resolved / Blocked / Halted) plus usage.

  "A halted turn is not an error. `Halted · budget exhausted` renders in
  neutral with the findings listed and a `Continue in a new turn` action.
  Rendering a halt as a failure teaches users to distrust turns that did
  most of the job" — so `is-halted` gets the same neutral chrome as
  `is-resolved`, never the danger styling `turn.failed` uses (ErrorCard,
  rendered separately for that event).

  A blocked turn additionally renders `BlockedCard` with the question
  `tdease.session.reportBlocked` recorded — "a question, not a paragraph".
-->
<template>
  <section class="turn-outcome" :class="`is-${settlement.outcome}`" role="status">
    <header class="turn-outcome__head">
      <el-icon class="turn-outcome__glyph" :size="14" aria-hidden="true"><component :is="glyph" /></el-icon>
      <span class="turn-outcome__label">{{ label }}</span>
      <span class="turn-outcome__usage mono">{{ usageText }}</span>
    </header>

    <BlockedCard
      v-if="settlement.outcome === 'blocked' && settlement.blocked"
      :reason="settlement.blocked.reason"
      :needed="settlement.blocked.needed"
      :options="settlement.blocked.options"
      @answer="emit('answer', $event)"
    />

    <AppButton v-if="settlement.outcome === 'halted'" variant="subtle" size="sm" class="turn-outcome__continue" @click="emit('continue')">
      {{ t('agent.transcript.outcome.continueInNewTurn') }}
    </AppButton>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { CircleCheckFilled, QuestionFilled, RemoveFilled } from '@element-plus/icons-vue'
import AppButton from '@/components/primitives/AppButton.vue'
import BlockedCard from './BlockedCard.vue'
import { useI18n } from 'vue-i18n'
import { formatDuration, formatTokensK } from '@/utils/format'
import type { TurnSettlement } from '@/agent/events'

const props = defineProps<{
  settlement: Extract<TurnSettlement, { kind: 'completed' }>
}>()

const emit = defineEmits<{ continue: []; answer: [option: string] }>()

const { t } = useI18n()

const glyph = computed(() => {
  switch (props.settlement.outcome) {
    case 'resolved': return CircleCheckFilled
    case 'blocked': return QuestionFilled
    case 'halted': return RemoveFilled
    default: return CircleCheckFilled
  }
})

const label = computed(() => t(`agent.transcript.outcome.${props.settlement.outcome}`))

const usageText = computed(() => {
  const usage = props.settlement.usage
  const calls = t('agent.transcript.outcome.calls', { count: usage.tool_calls })
  const duration = formatDuration(usage.wall_clock_ms)
  const tokens = t('agent.transcript.outcome.tokens', { count: formatTokensK(usage.input_tokens + usage.output_tokens) })
  return `${calls} · ${duration} · ${tokens}`
})
</script>

<style scoped>
.turn-outcome {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: var(--space-2) 0;
  padding: var(--space-2) var(--space-1);
}

.turn-outcome__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.turn-outcome__glyph {
  color: var(--status-succeeded);
}

.is-blocked .turn-outcome__glyph { color: var(--color-primary); }
/* Halted is a neutral state, never styled as a failure. */
.is-halted .turn-outcome__glyph { color: var(--color-text-muted); }

.turn-outcome__label {
  font-weight: 600;
  color: var(--color-text);
  font-size: var(--text-base, 13px);
}

.turn-outcome__usage {
  color: var(--color-text-muted, var(--color-text-muted));
  font-size: var(--text-label, 11px);
}

.turn-outcome__finding-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: var(--space-1) 0 0;
  padding: 0;
  list-style: none;
  font-size: var(--text-label, 11px);
}

.turn-outcome__finding-list li {
  display: flex;
  gap: var(--space-2);
  color: var(--color-text-secondary);
}

.turn-outcome__continue {
  align-self: flex-start;
}
</style>
