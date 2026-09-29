<!--
  TrajectoryTab — the trajectory inspector, as vertical swimlanes.

  Three lanes (user · model · tools) share one downward seq axis inside each
  turn band: the model↔tools rhythm reads top-to-bottom, which is the shape a
  narrow sidebar wants. Chips stay minimal by design — every verbose fact
  (model ids, digest chain, usage, errors, full prompt, message previews)
  lives in the chip's native hover; the only click interaction is a request
  chip, which expands its digest row inline to load a snapshot body.

  Pure derived map — the same `sessionAtoms` the transcript projected; no
  second log, no extra IPC. Snapshot bodies live content-addressed beside the
  log (`snapshots/<digest>.md`).
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '@/stores/agent'
import { useWorkspaceStore } from '@/stores/workspace'
import { projectTrajectory } from '@/agent/events/trajectory'
import type { TrajectoryRequestRow, TrajectoryToolRow, TrajectoryTurnRow } from '@/agent/events/trajectory'
import { createWorkspacePromptSnapshotStore, desktopWorkspaceTextBridge } from '@/services/agent/agentSessionStorage'
import type { Sha256 } from '@/agent/prompt'

const { t, locale } = useI18n()
const agentStore = useAgentStore()
const workspaceStore = useWorkspaceStore()

const trajectory = computed(() => projectTrajectory(agentStore.active ? agentStore.atomsOf(agentStore.active.id) : []))
/** Newest turn first — the inspector answers "what just happened". */
const turns = computed(() => [...trajectory.value.turns].reverse())

// ── Swimlane rows ─────────────────────────────────────────────────────────────

type Lane = 'user' | 'model' | 'tools'

interface Chip {
  seq: number
  lane: Lane
  kind: 'prompt' | 'request' | 'thinking' | 'message' | 'tool'
  label: string
  hover: string
  request?: TrajectoryRequestRow
  tool?: TrajectoryToolRow
  failed?: boolean
  approved?: boolean
  declined?: boolean
}

type Row = { kind: 'chip'; chip: Chip } | { kind: 'detail'; request: TrajectoryRequestRow }

/**
 * Chip rows are a pure per-turn projection, memoized by turn id: the template
 * calls `rowsFor` on every render, and without the memo expanding one request
 * (an `expandedSeq` flip) rebuilt every turn's row array. Chip labels bake
 * t() output at build time, so locale joins the invalidation set.
 */
const chipRowsByTurn = computed(() => {
  void locale.value
  const map = new Map<string, Row[]>()
  for (const turn of turns.value) map.set(turn.turnId, chipRows(turn))
  return map
})

function chipRows(turn: TrajectoryTurnRow): Row[] {
  const promptChip: Chip = { seq: turn.seqStart, lane: 'user', kind: 'prompt', label: turn.userMessage, hover: turn.userMessage }
  const chips: Chip[] = [
    promptChip,
    ...turn.requests.map((request): Chip => ({
      seq: request.seq,
      lane: 'model',
      kind: 'request',
      label: t('agent.trajectory.chipRequest', { seq: request.requestSeq }),
      hover: `${request.model} · thinking ${request.thinkingLevel}\nsystem ${short(request.systemPromptDigest)} · context ${short(request.contextDigest)} · tools ${short(request.activeToolsDigest)}\n${t('agent.trajectory.hoverExpand')}`,
      request,
    })),
    ...turn.thinking.map((entry): Chip => ({
      seq: entry.seq,
      lane: 'model',
      kind: 'thinking',
      label: t('agent.trajectory.chipThinking'),
      hover: entry.preview || t('agent.trajectory.hoverEmptyReasoning'),
    })),
    ...turn.messages.map((entry): Chip => ({
      seq: entry.seq,
      lane: 'model',
      kind: 'message',
      label: t('agent.trajectory.chipReply'),
      hover: entry.preview || t('agent.trajectory.hoverEmptyMessage'),
    })),
    ...turn.tools.map((tool): Chip => ({
      seq: tool.seq,
      lane: 'tools',
      kind: 'tool',
      label: shortToolName(tool.name),
      hover: toolHover(tool),
      tool,
      failed: tool.ok === false,
      approved: tool.approval?.decision === 'approved',
      declined: tool.approval?.decision === 'declined',
    })),
  ].sort((left, right) => left.seq - right.seq)
  return chips.map((chip) => ({ kind: 'chip', chip }))
}

/**
 * Only the turn holding the expanded request pays the detail-row splice; every
 * other turn re-renders from its memoized array untouched.
 */
function rowsFor(turn: TrajectoryTurnRow): Row[] {
  const memo = chipRowsByTurn.value.get(turn.turnId) ?? []
  if (expandedSeq.value === null) return memo
  const rows = [...memo]
  const anchor = rows.find((row) => row.kind === 'chip' && row.chip.request?.seq === expandedSeq.value)
  if (anchor && anchor.kind === 'chip' && anchor.chip.request) {
    rows.splice(rows.indexOf(anchor) + 1, 0, { kind: 'detail', request: anchor.chip.request })
  }
  return rows
}

const laneColumn: Record<Lane, number> = { user: 1, model: 2, tools: 3 }

function shortToolName(name: string): string {
  return name.startsWith('tdease.') ? name.slice('tdease.'.length) : name
}

function toolHover(tool: TrajectoryToolRow): string {
  const lines = [tool.name, `call ${tool.callId}`]
  if (tool.approval) lines.push(`approval: ${tool.approval.decision}${tool.approval.reason ? ` — ${tool.approval.reason}` : ''}`)
  if (tool.error) lines.push(`${tool.error.code}: ${tool.error.message}`)
  if (tool.ok === undefined) lines.push(t('agent.trajectory.hoverStillOpen'))
  return lines.join('\n')
}

function short(digest: string): string {
  return `${digest.slice(0, 12)}…`
}

// ── Settlement + header ───────────────────────────────────────────────────────

function settlementLabel(turn: TrajectoryTurnRow): string {
  const settlement = turn.settlement
  if (!settlement) return t('agent.trajectory.settlementOpen')
  if (settlement.kind === 'completed') return t(`agent.transcript.outcome.${settlement.outcome}`)
  return t(`agent.transcript.outcome.${settlement.kind}`)
}

function settlementClass(turn: TrajectoryTurnRow): string {
  const settlement = turn.settlement
  if (!settlement) return 'is-open'
  if (settlement.kind === 'completed') return settlement.outcome === 'resolved' ? 'is-resolved' : `is-${settlement.outcome}`
  return `is-${settlement.kind}`
}

function settlementHover(turn: TrajectoryTurnRow): string {
  const settlement = turn.settlement
  const lines = [`${t('agent.trajectory.hoverMindset')} ${turn.mindset} · ${t('agent.trajectory.hoverModel')} ${turn.model}`, `${t('agent.trajectory.hoverPrompt')} ${short(turn.promptSnapshotDigest)}`]
  if (settlement?.kind === 'completed') {
    const usage = settlement.usage
    lines.push(`tokens in ${usage.input_tokens} · out ${usage.output_tokens} · ${Math.round(usage.wall_clock_ms / 100) / 10}s · ${usage.tool_calls} calls`)
    if (settlement.blocked) lines.push(`blocked: ${settlement.blocked.reason}\nneeded: ${settlement.blocked.needed}`)
  } else if (settlement?.kind === 'failed') {
    lines.push(`${settlement.error.code}: ${settlement.error.message}`)
  }
  return lines.join('\n')
}

// ── Snapshot bodies (lazy, on digest click) ──────────────────────────────────

const expandedSeq = ref<number | null>(null)
const expandedDigest = ref<string | null>(null)
const snapshotBody = ref<string | null>(null)
const snapshotLoading = ref(false)
/** Monotonic token for in-flight snapshot reads (see `loadSnapshot`). */
let snapshotLoadSeq = 0

function toggleRequest(request: TrajectoryRequestRow): void {
  if (expandedSeq.value === request.seq) {
    expandedSeq.value = null
    expandedDigest.value = null
    snapshotBody.value = null
    return
  }
  expandedSeq.value = request.seq
  expandedDigest.value = null
  snapshotBody.value = null
}

async function loadSnapshot(digest: string): Promise<void> {
  if (expandedDigest.value === digest && snapshotBody.value !== null) return
  // Sequence guard: digest A's read may resolve after the user clicked
  // digest B — a late write would park A's body under B's heading.
  const request = ++snapshotLoadSeq
  expandedDigest.value = digest
  snapshotBody.value = null
  const root = workspaceStore.workspacePath
  const sessionId = agentStore.active?.id
  if (!root || !sessionId) return
  snapshotLoading.value = true
  try {
    const store = createWorkspacePromptSnapshotStore(desktopWorkspaceTextBridge(), root, sessionId)
    const content = await store.read(digest as Sha256)
    if (request !== snapshotLoadSeq) return
    snapshotBody.value = content ?? t('agent.trajectory.snapshotNotFound')
  } catch (error) {
    if (request !== snapshotLoadSeq) return
    snapshotBody.value = t('agent.trajectory.snapshotReadFailed', {
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    if (request === snapshotLoadSeq) snapshotLoading.value = false
  }
}
</script>

<template>
  <section class="traj-tab">
    <header class="traj-tab__header">
      <span class="traj-tab__title">{{ t('agent.trajectory.title') }}</span>
      <span class="traj-tab__totals mono">
        {{ t('agent.trajectory.totals', { turns: trajectory.turns.length, requests: trajectory.totalRequests, calls: trajectory.totalToolCalls }) }}
      </span>
    </header>

    <p v-if="turns.length === 0" class="traj-tab__empty">
      {{ t('agent.trajectory.empty') }}
    </p>

    <ul v-else class="traj-tab__list">
      <li v-for="turn in turns" :key="turn.turnId" class="traj-tab__turn">
        <div class="traj-tab__turn-head" :title="settlementHover(turn)">
          <span class="traj-tab__seq mono">#{{ turn.seqStart }}</span>
          <span
            class="traj-tab__settlement"
            :class="settlementClass(turn)"
          >{{ settlementLabel(turn) }}</span>
        </div>

        <div class="traj-tab__lanes">
          <div class="traj-tab__lane-head traj-tab__lane-head--user">{{ t('agent.trajectory.laneUser') }}</div>
          <div class="traj-tab__lane-head traj-tab__lane-head--model">{{ t('agent.trajectory.laneModel') }}</div>
          <div class="traj-tab__lane-head traj-tab__lane-head--tools">{{ t('agent.trajectory.laneTools') }}</div>

          <template v-for="(row, index) in rowsFor(turn)" :key="row.kind === 'chip' ? row.chip.seq : `detail-${row.request.seq}`">
            <div
              v-if="row.kind === 'chip'"
              class="traj-tab__chip"
              :class="[`traj-tab__chip--${row.chip.kind}`, {
                'is-failed': row.chip.failed,
                'is-approved': row.chip.approved,
                'is-declined': row.chip.declined,
                'is-clickable': row.chip.kind === 'request',
              }]"
              :style="{ gridRow: index + 2, gridColumn: laneColumn[row.chip.lane] }"
              :title="row.chip.hover"
              @click="row.chip.kind === 'request' && toggleRequest(row.chip.request!)"
            >
              <span v-if="row.chip.kind === 'tool'" class="traj-tab__tool-state">{{ row.chip.tool!.ok === undefined ? '·' : row.chip.tool!.ok ? '✓' : '✗' }}</span>
              <span class="traj-tab__chip-label">{{ row.chip.label }}</span>
            </div>

            <div v-else class="traj-tab__detail" :style="{ gridRow: index + 2, gridColumn: '1 / -1' }">
              <span class="traj-tab__detail-meta">{{ row.request.model }} · {{ row.request.thinkingLevel }}</span>
              <span class="traj-tab__digests">
                <button
                  v-for="digest of [row.request.systemPromptDigest, row.request.contextDigest, row.request.activeToolsDigest]"
                  :key="digest"
                  type="button"
                  class="traj-tab__digest mono"
                  :class="{ 'is-expanded': expandedDigest === digest }"
                  :title="digest"
                  @click="loadSnapshot(digest)"
                >{{ short(digest) }}</button>
              </span>
              <pre
                v-if="expandedDigest !== null
                  && [row.request.systemPromptDigest, row.request.contextDigest, row.request.activeToolsDigest].includes(expandedDigest)
                  && snapshotBody !== null"
                class="traj-tab__snapshot"
              >{{ snapshotLoading ? t('agent.trajectory.loading') : snapshotBody }}</pre>
            </div>
          </template>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* Speaks the shared token ladder only: text-label/base sizes, hairline seams,
   tertiary surface for chips, status-text tones for settlements. An earlier
   draft used Element Plus internals (--el-*) + raw px sizes, which bypassed
   the theme system and rendered this inspector off-voice in every theme. */
.traj-tab {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2-5) var(--space-3);
}
.traj-tab__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.traj-tab__title {
  font-weight: 600;
  font-size: var(--text-base);
  color: var(--color-text);
}
.traj-tab__totals {
  font-size: var(--text-label);
  color: var(--color-text-muted);
}
.traj-tab__empty {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  margin: var(--space-2) 0;
}
.traj-tab__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2-5);
}
.traj-tab__turn {
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  padding: var(--space-1-5) var(--space-2) var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
}
.traj-tab__turn-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-label);
  color: var(--color-text-secondary);
  cursor: default;
}
.traj-tab__seq { opacity: 0.55; }
.traj-tab__settlement {
  font-size: var(--text-label);
  padding: 0 var(--space-1-5);
  border-radius: var(--radius-lg);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
}
.traj-tab__settlement.is-resolved { color: var(--color-success-text); }
.traj-tab__settlement.is-blocked { color: var(--color-warning-text); }
.traj-tab__settlement.is-failed { color: var(--color-error-text); }
.traj-tab__settlement.is-open { opacity: 0.6; }

/* ── The three vertical lanes: one downward seq axis ── */
.traj-tab__lanes {
  display: grid;
  grid-template-columns: 30% 33% 37%;
  gap: 3px var(--space-1);
  align-items: stretch;
}
.traj-tab__lane-head {
  font-size: var(--text-label);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
  opacity: 0.7;
  border-bottom: var(--line-w) solid var(--line-hairline);
  padding-bottom: 2px;
}
.traj-tab__chip {
  min-width: 0;
  border-radius: var(--radius-xs);
  border: var(--line-w) solid transparent;
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: var(--text-label);
  line-height: 1.4;
  padding: 1px var(--space-1);
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: default;
}
.traj-tab__chip-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.traj-tab__chip--prompt {
  background: var(--color-primary-soft);
  color: var(--color-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  /* line-clamp only bites with overflow:hidden — without it the whole prompt
     expands the chip into one tall color block that swallows the lane. */
  overflow: hidden;
  white-space: normal;
  max-height: 32px;
}
.traj-tab__chip--prompt .traj-tab__chip-label { white-space: normal; }
.traj-tab__chip--request {
  background: var(--color-interact-soft);
  color: var(--color-interact-text);
  font-weight: 600;
}
.traj-tab__chip.is-clickable { cursor: pointer; }
.traj-tab__chip--thinking { opacity: 0.75; font-style: italic; }
.traj-tab__chip--message { background: var(--color-bg-muted); }
.traj-tab__chip--tool code, .traj-tab__chip--tool .traj-tab__chip-label { font-family: var(--font-mono); }
.traj-tab__chip--tool.is-failed { border-color: color-mix(in srgb, var(--color-error) 35%, transparent); }
.traj-tab__chip--tool.is-approved { border-color: color-mix(in srgb, var(--color-success) 35%, transparent); }
.traj-tab__chip--tool.is-declined { border-color: color-mix(in srgb, var(--color-error) 25%, transparent); }
.traj-tab__tool-state { flex: none; width: 10px; text-align: center; }
.traj-tab__chip--tool:not(.is-failed) .traj-tab__tool-state { color: var(--color-success-text); }
.traj-tab__chip--tool.is-failed .traj-tab__tool-state { color: var(--color-error-text); }

.traj-tab__detail {
  border: var(--line-w) dashed var(--line-hairline);
  border-radius: var(--radius-xs);
  padding: var(--space-1) var(--space-1-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.traj-tab__detail-meta { font-size: var(--text-label); color: var(--color-text-muted); }
.traj-tab__digests { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.traj-tab__digest {
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-secondary);
  padding: 0 4px;
  font-size: var(--text-label);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.traj-tab__digest:hover { border-color: color-mix(in srgb, var(--color-primary) 40%, var(--line-hairline)); color: var(--color-text); }
.traj-tab__digest.is-expanded { border-color: var(--color-primary); color: var(--color-text); }
.traj-tab__snapshot {
  margin: 0;
  padding: var(--space-1-5);
  max-height: 220px;
  overflow: auto;
  font-size: var(--text-label);
  line-height: 1.5;
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  border-radius: var(--radius-xs);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
