<!--
  SubAgentCard — the inline, three-state subagent card in the transcript.

  This is the transcript-side companion to the inspector's SubagentList
  (palot sub-agent-card.tsx). Where the inspector shows every run for the
  session as a flat board, this card renders *one* subagent in line with the
  assistant text, so the reader sees "the Agent delegated this to a child"
  at the point in the conversation it happened.

  Three states, mirroring palot:
    - running  → expanded, purple border, pulsing icon, live elapsed
    - settled  → collapsed to a one-line summary (first finding line)
    - blocked  → amber "needs attention" tone, expanded

  Linking to the live record: the `subagent.spawn` tool call carries `role`
  and `task` in its args; the SubagentRegistry stamps each record with the
  same `role` and a createdAt. The card matches on role + recency (the most
  recent running/settled record for that role around the tool's timestamp),
  because the `subagentId` itself does not currently cross the IPC boundary
  in the tool.completed event (the registry's snapshot is the source of
  truth; the card reads it via the subagents store). If no record matches
  — e.g. the run pre-dates this renderer session — the card degrades to a
  static summary of the tool args, never an empty box.
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loading, CircleCheck, WarningFilled, CircleClose, ArrowDown } from '@element-plus/icons-vue'
import { useSubagentsStore } from '@/stores/subagents'
import type { SubagentStatus, SubagentState } from '@/studio/commands/registry'
import AppButton from '@/components/primitives/AppButton.vue'

const props = defineProps<{
  /** Role from the subagent.spawn tool args. */
  role: string
  /** Task text from the subagent.spawn tool args (truncated for display). */
  task: string
}>()

const { t } = useI18n()
const subagents = useSubagentsStore()

/**
 * Match the live record for this role. The registry's records are scoped to
 * the active parent session, and role names are unique enough within a turn
 * that the most recent record for the role is the right one. Ties go to the
 * running record (most actionable to surface).
 *
 * Cross-turn stickiness (B9): once a card binds to a record, it STAYS bound
 * to that record's subagentId even if a later turn spawns another subagent
 * with the same role. Without this, two cards for "spectral-analyzer" would
 * both jump to the newest running record — the old card's header (its tool
 * args) would then disagree with the body (the new run's live data). The
 * latch captures the subagentId the first time a record appears, then just
 * re-reads that same record by id on every update.
 */
const boundSubagentId = ref<string | undefined>(undefined)

const record = computed<SubagentStatus | undefined>(() => {
  const candidates = subagents.active.filter((r) => r.role === props.role)
  if (candidates.length === 0) return undefined
  // If we already latched onto a record that still exists, keep it.
  if (boundSubagentId.value) {
    const latched = candidates.find((r) => r.subagentId === boundSubagentId.value)
    if (latched) return latched
    // The latched record dropped out of the active set (e.g. registry
    // rotated). Fall through to re-bind.
    // eslint-disable-next-line vue/no-side-effects-in-computed-properties -- deliberate latch: rebind decision stays memoized with this computed's cache
    boundSubagentId.value = undefined
  }
  // First bind: prefer the running record (most actionable), else the most
  // recent settled one. Capture its id so future updates for the same role
  // do not steal this card.
  const running = candidates.find((r) => r.state === 'running')
  const chosen = running ?? [...candidates].sort((a, b) => b.createdAt - a.createdAt)[0]
  // eslint-disable-next-line vue/no-side-effects-in-computed-properties -- deliberate latch: capture the binding so later updates for the same role cannot steal this card
  if (chosen) boundSubagentId.value = chosen.subagentId
  return chosen
})

const state = computed<SubagentState | 'unknown'>(() => record.value?.state ?? 'unknown')
const isRunning = computed(() => state.value === 'running')

/** Three-state fold: running expands, settled collapses to the summary line. */
const expanded = ref(true)
const effectiveExpanded = computed(() => {
  if (isRunning.value) return true
  return expanded.value
})
/**
 * The body always has something to show (the task text at minimum, plus a
 * summary or live cancel affordance depending on state), so the fold is always
 * actionable. The earlier guard `if (!isSettled && !isRunning) return` left the
 * arrow visible but clicks dead in the blocked/unknown states — a fold
 * indicator that does nothing on click is worse than none.
 */
function toggle() {
  expanded.value = !expanded.value
}

const stateMeta = computed<{ icon: typeof Loading; tone: string; label: string }>(() => {
  switch (state.value) {
    case 'running': return { icon: Loading, tone: 'is-running', label: t('agent.subagent.state.running') }
    case 'returned': return { icon: CircleCheck, tone: 'is-returned', label: t('agent.subagent.state.returned') }
    case 'blocked': return { icon: WarningFilled, tone: 'is-blocked', label: t('agent.subagent.state.blocked') }
    case 'cancelled': return { icon: CircleClose, tone: 'is-cancelled', label: t('agent.subagent.state.cancelled') }
    default: return { icon: Loading, tone: 'is-unknown', label: t('agent.subagent.state.running') }
  }
})

const summaryLine = computed(() => {
  const r = record.value
  if (!r) return props.task
  if (r.error) return r.error.message
  const findings = r.result?.findings
  const first = findings?.[0]
  if (first && typeof first === 'object' && 'raw' in first && typeof (first as { raw: unknown }).raw === 'string') {
    return String((first as { raw: string }).raw).split('\n')[0]
  }
  if (typeof first === 'string') return first.split('\n')[0]
  return props.task
})

function elapsedLabel(elapsedS: number | undefined): string {
  if (!elapsedS) return ''
  if (elapsedS < 60) return `${elapsedS}s`
  const m = Math.floor(elapsedS / 60)
  const s = elapsedS % 60
  return `${m}m ${s}s`
}

function cancel() {
  const id = record.value?.subagentId
  if (id) subagents.cancel(id)
}
</script>

<template>
  <div class="subagent-card" :class="stateMeta.tone" :aria-expanded="effectiveExpanded">
    <button type="button" class="subagent-card__head" @click="toggle">
      <el-icon :size="14" class="subagent-card__icon"><component :is="stateMeta.icon" /></el-icon>
      <span class="subagent-card__role">{{ role }}</span>
      <span class="subagent-card__state">{{ stateMeta.label }}</span>
      <span v-if="record?.elapsedS" class="subagent-card__elapsed">{{ elapsedLabel(record.elapsedS) }}</span>
      <!--
        The fold indicator is a single chevron that ROTATES rather than swaps
        glyph: collapsed → points right (▸, "open me"), expanded → points down
        (▾, "I'm open below"). The previous `‹/›` pair got both wrong — it was
        a horizontal arrow on a vertical fold, and the direction was inverted
        (expanded showed `‹` pointing left at nothing). A rotating chevron also
        animates the state change instead of snapping between two characters.
      -->
      <span v-if="!isRunning" class="subagent-card__arrow" :class="{ 'is-open': effectiveExpanded }" aria-hidden="true">
        <el-icon :size="12"><ArrowDown /></el-icon>
      </span>
    </button>

    <div v-if="effectiveExpanded" class="subagent-card__body">
      <p v-if="!record" class="subagent-card__task">{{ task }}</p>
      <p v-else-if="isRunning" class="subagent-card__task">{{ task }}</p>

      <p v-if="record && !isRunning" class="subagent-card__summary">{{ summaryLine }}</p>

      <dl v-if="record?.result?.confidence" class="subagent-card__meta">
        <dt>{{ t('agent.subagent.confidence') }}</dt>
        <dd>{{ record.result.confidence }}</dd>
      </dl>

      <div v-if="record && isRunning" class="subagent-card__actions">
        <AppButton variant="danger" size="sm" class="subagent-card__cancel" @click.stop="cancel">{{ t('agent.subagent.cancel') }}</AppButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.subagent-card {
  margin: var(--space-1-5) 0;
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  overflow: hidden;
  font-size: var(--text-sm);
  animation: subagent-card-in 140ms var(--ease-out) both;
}
@keyframes subagent-card-in {
  from { opacity: 0; transform: translateY(2px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Status hue lives in a soft background tint + the leading status icon
   (subagent-card__icon), not a side-stripe border. VISUAL-SYSTEM.md bans the
   decorative border-left accent; the icon already carries the same hue. */
.subagent-card.is-running {
  border-color: color-mix(in srgb, var(--status-running) 40%, var(--line-hairline));
  background: color-mix(in srgb, var(--status-running) 8%, var(--color-bg-secondary));
  animation: subagent-card-in 140ms var(--ease-out) both, subagent-pulse 2.4s var(--ease-inout) infinite;
}
.subagent-card.is-returned { background: color-mix(in srgb, var(--status-succeeded) 8%, var(--color-bg-secondary)); }
.subagent-card.is-blocked { background: color-mix(in srgb, var(--color-warning) 10%, var(--color-bg-secondary)); }
.subagent-card.is-cancelled { background: color-mix(in srgb, var(--status-cancelled) 8%, var(--color-bg-secondary)); }

@keyframes subagent-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-running) 0%, transparent); }
  50% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--status-running) 18%, transparent); }
}

.subagent-card__head {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  width: 100%;
  padding: var(--space-1-5) var(--space-2);
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: var(--color-text);
}
.subagent-card__icon { flex-shrink: 0; }
.subagent-card.is-running .subagent-card__icon { color: var(--status-running); animation: subagent-spin 1.4s linear infinite; }
.subagent-card.is-returned .subagent-card__icon { color: var(--status-succeeded); }
.subagent-card.is-blocked .subagent-card__icon { color: var(--color-warning-text); }
.subagent-card.is-cancelled .subagent-card__icon { color: var(--status-cancelled); }

@keyframes subagent-spin { to { transform: rotate(360deg); } }

.subagent-card__role {
  font-weight: 600;
  font-size: var(--text-sm);
  color: var(--color-text, var(--color-text));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subagent-card__state {
  font-size: var(--text-label);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
  margin-left: auto;
}

.subagent-card__elapsed {
  font-family: var(--font-mono);
  font-size: var(--text-mono);
  color: var(--color-text-muted);
}

/*
  The chevron points right when collapsed (▸ "open me") and rotates 90° to
  point down when expanded (▾ "I'm open below"). One glyph, animated — no
  character swap, no inverted direction.
*/
.subagent-card__arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--color-text-muted);
  transform: rotate(-90deg);
  transition: transform var(--dur-fast) var(--ease-out);
}
.subagent-card__arrow.is-open {
  transform: rotate(0deg);
}

.subagent-card__body {
  padding: 0 var(--space-2) var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.subagent-card__task,
.subagent-card__summary {
  margin: 0;
  font-size: var(--text-sm);
  line-height: 1.45;
  color: var(--color-text-secondary);
}
.subagent-card__summary {
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
}

.subagent-card__meta {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--text-label);
  color: var(--color-text-muted);
}
.subagent-card__meta dt { text-transform: uppercase; letter-spacing: 0.04em; }
.subagent-card__meta dd { margin: 0; color: var(--color-text, var(--color-text)); }

.subagent-card__actions {
  display: flex;
  gap: var(--space-1);
  margin-top: var(--space-1);
}

.subagent-card__cancel {
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--text-label);
  padding: 2px var(--space-2);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.subagent-card__cancel:hover { background: var(--color-hover); }

@media (prefers-reduced-motion: reduce) {
  .subagent-card { animation: none; }
  .subagent-card.is-running { animation: none; }
  .subagent-card.is-running .subagent-card__icon { animation: none; }
}
</style>
