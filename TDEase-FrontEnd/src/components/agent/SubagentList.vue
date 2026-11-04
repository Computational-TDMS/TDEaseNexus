<!--
  SubagentList — the inspector's Subagents tab content.

  A flat list of run records for the active parent session. Each row is a
  status line (role, state, elapsed) with a cancel affordance while running,
  expanding to a findings summary when the run settles. This is the read-side
  mirror of `electron/agent/subagent-registry.ts` RunRecord → SubagentStatus;
  there is no second data model here.

  The three-state inline SubAgentCard (palot sub-agent-card.tsx) lives in the
  transcript itself (Phase B step 11); this list is the aggregate view, so it
  stays linear and dense — the inspector is for "what is running / ran",
  the transcript card is for "what this one child said".
-->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loading, CircleCheck, WarningFilled, CircleClose, Aim } from '@element-plus/icons-vue'
import AppButton from '@/components/primitives/AppButton.vue'
import Empty from '@/components/primitives/Empty.vue'
import type { SubagentStatus, SubagentState } from '@/studio/commands/registry'

const props = withDefaults(defineProps<{
  records: ReadonlyArray<SubagentStatus>
  /** True while the store's initial list() is in flight; suppresses the
   *  empty state so it does not flash before the first snapshot lands. */
  loading?: boolean
}>(), {
  loading: false,
})

const emit = defineEmits<{ cancel: [subagentId: string] }>()

const { t } = useI18n()

const hasRecords = computed(() => props.records.length > 0)

/**
 * Sort running first (most actionable), then by most-recent createdAt. The
 * registry's own ordering is insertion order; the inspector is a status board,
 * so the live runs come to the top regardless of spawn order.
 */
const ordered = computed(() => {
  const weight: Record<SubagentState, number> = { running: 0, blocked: 1, returned: 2, cancelled: 3 }
  return [...props.records].sort((a, b) => {
    const dw = weight[a.state] - weight[b.state]
    return dw !== 0 ? dw : b.createdAt - a.createdAt
  })
})

const stateMeta: Record<SubagentState, { icon: typeof Loading; tone: string; label: string }> = {
  running: { icon: Loading, tone: 'is-running', label: t('agent.subagent.state.running') },
  returned: { icon: CircleCheck, tone: 'is-returned', label: t('agent.subagent.state.returned') },
  blocked: { icon: WarningFilled, tone: 'is-blocked', label: t('agent.subagent.state.blocked') },
  cancelled: { icon: CircleClose, tone: 'is-cancelled', label: t('agent.subagent.state.cancelled') },
}

function elapsedLabel(elapsedS: number | undefined): string {
  if (!elapsedS) return ''
  if (elapsedS < 60) return `${elapsedS}s`
  const m = Math.floor(elapsedS / 60)
  const s = elapsedS % 60
  return `${m}m ${s}s`
}

/** Best one-line summary of a settled run's findings (palot SubAgentCard pattern). */
function findingPreview(record: SubagentStatus): string {
  if (record.error) return record.error.message
  const findings = record.result?.findings
  if (!findings || findings.length === 0) return ''
  const first = findings[0]
  if (first && typeof first === 'object' && 'raw' in first && typeof (first as { raw: unknown }).raw === 'string') {
    return String((first as { raw: string }).raw).split('\n')[0]
  }
  if (typeof first === 'string') return first.split('\n')[0]
  return ''
}
</script>

<template>
  <div class="subagent-list">
    <!-- Static icon, not the `Loading` spinner — a spinner here reads as
         "loading forever". Hidden while the first fetch is in flight. -->
    <Empty v-if="!hasRecords && !props.loading" :icon="Aim" :title="t('agent.inspector.empty.subagents')" />

    <ul v-else class="subagent-list__items">
      <li
        v-for="record in ordered"
        :key="record.subagentId"
        class="subagent-item"
        :class="stateMeta[record.state].tone"
      >
        <div class="subagent-item__head">
          <el-icon :size="14" class="subagent-item__state-icon">
            <component :is="stateMeta[record.state].icon" />
          </el-icon>
          <span class="subagent-item__role">{{ record.role }}</span>
          <span class="subagent-item__state-label">{{ stateMeta[record.state].label }}</span>
          <span v-if="record.elapsedS" class="subagent-item__elapsed">{{ elapsedLabel(record.elapsedS) }}</span>
          <AppButton
            v-if="record.state === 'running'"
            variant="subtle"
            size="sm"
            class="subagent-item__cancel"
            :title="t('agent.subagent.cancel')"
            :aria-label="t('agent.subagent.cancel')"
            @click="emit('cancel', record.subagentId)"
          >
            {{ t('agent.subagent.cancel') }}
          </AppButton>
        </div>

        <p v-if="findingPreview(record)" class="subagent-item__preview">{{ findingPreview(record) }}</p>

        <dl v-if="record.result?.confidence" class="subagent-item__meta">
          <dt>{{ t('agent.subagent.confidence') }}</dt>
          <dd>{{ record.result.confidence }}</dd>
        </dl>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.subagent-list {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  padding: var(--space-2);
}

.subagent-list__items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
}

.subagent-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
}

/* Status hue as a soft background tint, not a side-stripe border. The leading
   status icon already carries the same hue; the border-left accent is a banned
   decorative pattern (VISUAL-SYSTEM.md absolute bans). */
.subagent-item.is-running { background: color-mix(in srgb, var(--status-running) 8%, var(--color-bg-secondary)); }
.subagent-item.is-returned { background: color-mix(in srgb, var(--status-succeeded) 8%, var(--color-bg-secondary)); }
.subagent-item.is-blocked { background: color-mix(in srgb, var(--color-warning) 10%, var(--color-bg-secondary)); }
.subagent-item.is-cancelled { background: color-mix(in srgb, var(--status-cancelled) 8%, var(--color-bg-secondary)); }

.subagent-item__head {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
}

.subagent-item__state-icon {
  flex-shrink: 0;
}
.subagent-item.is-running .subagent-item__state-icon { color: var(--status-running); animation: subagent-spin 1.4s linear infinite; }
.subagent-item.is-returned .subagent-item__state-icon { color: var(--status-succeeded); }
.subagent-item.is-blocked .subagent-item__state-icon { color: var(--color-warning-text); }
.subagent-item.is-cancelled .subagent-item__state-icon { color: var(--status-cancelled); }

@keyframes subagent-spin {
  to { transform: rotate(360deg); }
}

.subagent-item__role {
  font-weight: 600;
  font-size: var(--text-sm);
  color: var(--color-text, var(--color-text));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subagent-item__state-label {
  font-size: var(--text-label);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
  margin-left: auto;
}

.subagent-item__elapsed {
  font-family: var(--font-mono);
  font-size: var(--text-mono);
  color: var(--color-text-muted);
}

.subagent-item__cancel {
  margin-left: var(--space-1);
}

.subagent-item__preview {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}

.subagent-item__meta {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--text-label);
  color: var(--color-text-muted);
}
.subagent-item__meta dt { text-transform: uppercase; letter-spacing: 0.04em; }
.subagent-item__meta dd { margin: 0; color: var(--color-text, var(--color-text)); }

@media (prefers-reduced-motion: reduce) {
  .subagent-item.is-running .subagent-item__state-icon { animation: none; }
}
</style>
