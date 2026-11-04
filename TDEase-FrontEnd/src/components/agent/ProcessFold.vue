<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { formatDuration } from '@/utils/format'
/**
 * ProcessFold — per-message collapse wrapper for an assistant act.
 *
 * While a turn STREAMS, the act renders fully expanded — thinking, tool calls
 * and live text all visible, so the user can watch the work happen. Once the
 * turn SETTLES resolved (and nothing errored), the whole middle collapses
 * behind a single "✓ {intent | worked} · time · N calls" summary line:
 * thinking, tool groups AND the interim scratch texts that narrated them.
 * Only the REPORT stays visible — the act's trailing text run after its last
 * thinking/tool block. Opening the panel narrates the middle in true event
 * order: the interim texts read directly, while thinking and tool groups
 * stay one-click summary lines in their true positions — only what the user
 * clicks expands.
 *
 * The report-collapse (absorbActs) goes one level further for a RESOLVED
 * MULTI-ACT turn: the last text-bearing act is the report, and its panel
 * absorbs every act's process AND the other acts' interim commentary — the
 * other acts render nothing. The turn reads as one line over one report.
 *
 * The fold is gated on the turn's SETTLEMENT — the unambiguous "turn ended"
 * signal — not on a text-length threshold or the streaming flag. Both of those
 * raced at the msg-N → turn:<id>:act:<n> projection swap (the streaming flag is
 * derived from `turn.streaming ? lastAssistantId`, which points at the new id
 * before `turn.streaming` clears), so a mount-latched decision landed on the
 * wrong branch and the fold flickered mid-stream. The settlement arrives once,
 * after the turn, so a reactive decision on it cannot flip while streaming.
 *
 * What decides the fold is the turn's FINAL settlement — not the fate of
 * each step inside it. A resolved turn folds even when some of its tools
 * failed: real working turns routinely carry failed probes and retries, and
 * refusing to fold on any of them left the transcript permanently expanded
 * (the fold "never worked"). Failures stay ANNOUNCED instead of punching
 * through: the fold line carries their count, one click shows them in place.
 * Only a FAILED / BLOCKED / HALTED turn never folds — those outcomes must
 * stay visible in full.
 */
import { computed, onUnmounted, ref } from 'vue'
import Collapse from './Collapse.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolGroupBlock from './ToolGroupBlock.vue'
import MarkdownContent from './MarkdownContent.vue'
import { CircleCheckFilled, CopyDocument, Loading } from '@element-plus/icons-vue'
import TaskTreeCard from './TaskTreeCard.vue'
import { useSettingsStore } from '@/stores/settings'
import IconButton from '@/components/primitives/IconButton.vue'
import { renderBlockEntry } from '@/utils/markdown-blocks'
import { useTranscriptFoldState } from './transcript-fold-state'
import { bareToolName, isToolFailure } from '@/utils/tool-identity'
import SubAgentCard from './SubAgentCard.vue'
import type {
  AgentChatMessage,
  ContentBlock,
  ThinkingBlock as ThinkingBlockType,
  ToolGroupBlock as ToolGroupBlockType,
  TextBlock,
} from '@/stores/chat-types'
import type { ToolGroupBlock as ToolGroupBlockData } from '@/stores/chat-types'
import type { TurnSettlement } from '@/agent/events'

/**
 * Extract the inline SubAgentCard inputs (role, task) from a tool_group block
 * if it carries a `subagent.spawn` tool call. Returns `undefined` when the
 * group has no spawn — most groups do not, so this is a cheap scan. The card
 * itself subscribes to the live record from the subagents store; this helper
 * only hands it the request-side context from the tool args.
 *
 * First-principles: the SubAgentCard is a renderer of subagent run records,
 * not a second data source. It needs the role/task the Agent asked for (from
 * the tool args) so the reader can connect the inline card to the inspector
 * entry; the live state comes from the store.
 */
function subagentCardInputs(block: ToolGroupBlockData): { role: string; task: string } | undefined {
  const spawn = block.tools.find((tool) => bareToolName(tool.name) === 'subagent.spawn')
  if (!spawn?.args) return undefined
  const role = spawn.args.role
  const task = spawn.args.task
  if (typeof role !== 'string' || typeof task !== 'string') return undefined
  return { role, task }
}

const { t } = useI18n()

const props = withDefaults(defineProps<{
  message: AgentChatMessage
  streaming?: boolean
  /**
   * How the turn owning this act ended (`project.ts`'s settlement, attached
   * to the act block by `transcript-blocks.ts`). Absent while the turn is
   * still live — which is exactly why a streaming act never folds.
   */
  settlement?: TurnSettlement
  /**
   * Intent phrase for this act (the plan's in_progress `activeForm` at this
   * point in the transcript, from `computeIntents`). When present it REPLACES
   * the generic "worked" word on the fold line, so a collapsed act reads as
   * what it was doing. Already in the conversation's language — no i18n key.
   * Absent for acts that ran outside any plan: the fold line stays as-is.
   */
  intent?: string
  /** This act anchors the session's task tree (the latest act the plan
   *  attributes work to) — the card renders at the top of its bubble. */
  showPlan?: boolean
  /**
   * The report-collapse: this act is a RESOLVED multi-act turn's report, and
   * `absorbActs` carries EVERY act message of the turn in event order. The
   * fold panel then absorbs the whole middle — all acts' thinking/tool
   * groups PLUS the other acts' interim commentary texts (the report's own
   * text stays visible below the panel) — so the transcript reads as one
   * summary line over one report, not one mini-report per decision point.
   * Absent (single-act turn, live, or non-resolved) ⇒ solo behavior.
   */
  absorbActs?: AgentChatMessage[]
}>(), {
  streaming: false,
  settlement: undefined,
  intent: undefined,
  showPlan: false,
  absorbActs: undefined,
})

const emit = defineEmits<{
  /** Forwarded from MarkdownContent when a Workspace file card is clicked. */
  'open-file': [file: { path: string; kind: 'image' | 'svg' | 'html' | 'table' | 'json' | 'text' | 'file'; name: string }]
}>()


const blocks = computed<ContentBlock[]>(() => props.message.blocks ?? [])

// Process blocks = thinking + tool_group. Text always visible. Settled
// approvals no longer have their own block — they fold into the tool call
// (ToolCall.approval) and render inline on the tool row. LIVE pending
// approvals are owned by the `ApprovalModal` overlay, never the transcript.
const toolGroupBlocks = computed(() => blocks.value.filter((b): b is ToolGroupBlockType => b.type === 'tool_group'))
const textBlocks = computed(() => blocks.value.filter((b): b is TextBlock => b.type === 'text'))

// ── The fold panel: ONE chronological walk ──────────────────────────────────
//
// The panel must walk its source acts in EVENT order — reasoning beside the
// tool calls it produced, interim commentary where it was said. A
// type-grouped render (all thinking, then all tool groups, then all text)
// re-sorts settled history into a cluster the live view never showed. Solo
// (no absorbActs) this is the act's own process blocks; report mode it is
// every absorbed act's blocks plus the interim texts — see below.

type PanelItem =
  | { kind: 'thinking'; block: ThinkingBlockType }
  | { kind: 'tool'; block: ToolGroupBlockType }
  | { kind: 'text'; block: TextBlock }

// The REPORT text = the rendered act's TRAILING text run: every text block
// AFTER the act's last thinking/tool block. Texts interleaved BEFORE that
// point are narration of the middle ("scratch") — folded, they belong INSIDE
// the panel, interleaved with the very tools they narrate; dumped outside
// they leak the whole reasoning process the fold is supposed to hide. A
// multi-paragraph report keeps its full trailing run outside; an act that
// ends on tools has no report section at all.
const reportTextBlocks = computed<TextBlock[]>(() => {
  const list = blocks.value
  let lastProcess = -1
  for (let i = 0; i < list.length; i += 1) {
    const b = list[i]
    if (b && (b.type === 'thinking' || b.type === 'tool_group')) lastProcess = i
  }
  return list.slice(lastProcess + 1).filter((b): b is TextBlock => b.type === 'text')
})

const panelItems = computed<PanelItem[]>(() => {
  const source = props.absorbActs?.length ? props.absorbActs : [props.message]
  const outsideIds = new Set(reportTextBlocks.value.map((b) => b.id))
  const items: PanelItem[] = []
  for (const act of source) {
    const own = act.id === props.message.id
    for (const b of act.blocks ?? []) {
      if (b.type === 'thinking') items.push({ kind: 'thinking', block: b })
      else if (b.type === 'tool_group') items.push({ kind: 'tool', block: b })
      else if (b.type === 'text' && !(own && outsideIds.has(b.id))) items.push({ kind: 'text', block: b })
    }
  }
  return items
})

// Fold the act's work process (thinking + tool groups) behind a summary line
// once the turn has DEFINITIVELY settled resolved. This is reactive on the
// settlement — the unambiguous "turn ended" signal — not on the streaming flag
// and not latched at mount (see the header note for why those raced at the
// projection swap). During output there is no settlement, so shouldFold is
// false and the process stays fully visible; the fold appears exactly when the
// settlement lands, never mid-stream. A resolved turn folds EVEN IF some of
// its tools failed — the failure count rides the fold line (below), so
// failures stay announced without keeping the whole process expanded.
const isResolved = computed(() =>
  props.settlement?.kind === 'completed' && props.settlement.outcome === 'resolved'
)
// A panel item is anything worth folding: the act's own process, or — in
// report mode — any absorbed act's process/interim text.
const hasProcess = computed(() => panelItems.value.length > 0)
// The ONE failure predicate (tool-identity.ts) — the same count ToolGroupBlock
// announces on its summary line. A cancelled call that happens to carry an
// error text is not a failure: the turn ended around it. Report mode counts
// across every absorbed act (settlement usage is already turn-level).
const failedToolCount = computed(() => {
  const source = props.absorbActs?.length ? props.absorbActs : [props.message]
  return source.reduce(
    (sum, act) => sum + (act.blocks ?? []).reduce(
      (s, b) => (b.type === 'tool_group' ? s + b.tools.filter(isToolFailure).length : s),
      0,
    ),
    0,
 )
})
// Reasoning hidden (the default): the process also folds while the turn is
// LIVE — the summary line and the task tree carry the progress. A settled
// turn that did not resolve (failed / blocked / halted / cancelled) never
// folds, in either mode: those outcomes must stay visible in full.
const settings = useSettingsStore()
const isLive = computed(() => !props.settlement)
const shouldFold = computed(() =>
  hasProcess.value && (isResolved.value || (!settings.showReasoning && isLive.value)))
/** Live tool calls so far (the settled count comes from the settlement). */
const liveCallCount = computed(() =>
  toolGroupBlocks.value.reduce((n, g) => n + g.tools.length, 0))
const liveToolRunning = computed(() =>
  toolGroupBlocks.value.some((g) => g.tools.some((tool) => !tool.done)))

// The outer fold's state is persisted in the transcript-wide fold-state map
// (keyed by the message id, which is stable for a settled turn) rather than a
// local ref. Local refs were lost every time DynamicScroller recycled this
// row or `replaceSessionProjection` swapped the streaming `msg-N` for the
// settled `turn:<id>:act:<n>` — the user's expansion vanished.
const foldState = useTranscriptFoldState()
const foldStateKey = computed(() => `processfold:${props.message.id}`)
const isOpen = computed(() => {
  // shouldFold is false throughout streaming (no settlement yet), so the
  // process stays fully visible during output; only a settled fold reads the
  // persisted open/closed state.
  if (!shouldFold.value) return true
  return !foldState.get(foldStateKey.value, true)
})

const summaryLabel = computed(() => {
  const s = props.settlement
  if (s?.kind === 'completed') {
    // Intent wording when the plan attributes one to this act; the generic
    // "worked" only for acts that ran outside any plan.
    const worked = props.intent || t('agent.processFold.worked')
    const calls = t('agent.transcript.outcome.calls', { count: s.usage.tool_calls })
    const duration = formatDuration(s.usage.wall_clock_ms)
    const parts = [`${worked} ${duration} · ${calls}`]
    // The turn resolved, but some of its steps failed — say so on the fold
    // line instead of keeping the whole process expanded (see header note).
    if (failedToolCount.value > 0) parts.push(t('agent.processFold.failures', { count: failedToolCount.value }))
    return parts.join(' · ')
  }
  if (isLive.value) {
    const working = props.intent || t('agent.processFold.working')
    const n = liveCallCount.value
    return n > 0 ? `${working} · ${t('agent.transcript.outcome.calls', { count: n })}` : working
  }
  return t('agent.processFold.expandDetails')
})

const lastTextBlockId = computed(() => {
  const list = textBlocks.value
  return list.length ? list[list.length - 1].id : null
})

function toggle() {
  // Stored value is `collapsed`; the current open state implies the next one.
  foldState.set(foldStateKey.value, isOpen.value)
}

// aria-controls target for the fold summary toggle; stable per message.
const foldPanelId = computed(() => `process-fold-panel-${props.message.id}`)

// The per-block markdown render memo lives in utils/markdown-blocks.ts
// (module scope, shared across instances and virtualizer remounts) — see
// renderBlockEntry there. htmlFor hands MarkdownContent the joined HTML;
// blockHtmlsFor hands it the per-block HTML for the append-only reconcile.
function htmlFor(id: string, text: string): string {
  return renderBlockEntry(id, text).html
}

/** The per-block rendered HTML (same cache), for MarkdownContent's
 *  append-only reconcile — see renderBlockEntry. */
function blockHtmlsFor(id: string, text: string): string[] {
  return renderBlockEntry(id, text).htmls
}

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

function copyText() {
  navigator.clipboard?.writeText(textBlocks.value.map(b => b.text).join('\n\n'))
    .then(() => {
      copied.value = true
      clearTimeout(copiedTimer)
      copiedTimer = setTimeout(() => { copied.value = false }, 1400)
    })
    .catch(() => undefined)
}

onUnmounted(() => clearTimeout(copiedTimer))
</script>

<template>
  <div class="bubble-agent">
    <div class="agent-indicator" />
    <div class="bubble-body">
      <TaskTreeCard v-if="showPlan" class="bubble-plan" @open-file="emit('open-file', $event)" />
      <!-- Heavy message: fold the process trace under a summary line. -->
      <template v-if="shouldFold">
        <button class="fold-summary" :class="{ open: isOpen }" :aria-expanded="isOpen" :aria-controls="foldPanelId" @click="toggle">
          <span class="fold-arrow" :class="{ open: isOpen }">›</span>
          <el-icon v-if="isLive" class="fold-summary__glyph fold-summary__glyph--live" :class="{ spinning: liveToolRunning || streaming }" :size="14" aria-hidden="true"><Loading /></el-icon>
          <el-icon v-else class="fold-summary__glyph" :size="14" aria-hidden="true"><CircleCheckFilled /></el-icon>
          <span class="fold-title">{{ summaryLabel }}</span>
        </button>
        <Collapse :id="foldPanelId" :open="isOpen">
          <!-- The opened panel narrates the middle in event order: the
               interim scratch TEXTS read directly, while thinking and tool
               groups stay one-click summary lines in their true positions —
               only what the user clicks expands. -->
          <div class="fold-panel">
            <template v-for="item in panelItems" :key="item.block.id">
              <ThinkingBlock
                v-if="item.kind === 'thinking'"
                :content="item.block.text"
                :sealed="item.block.sealed"
                :duration-ms="item.block.durationMs"
                :fold-key="item.block.id"
              />
              <template v-else-if="item.kind === 'tool'">
                <ToolGroupBlock :fold-key="item.block.id" :tools="item.block.tools" />
                <SubAgentCard
                  v-if="subagentCardInputs(item.block)"
                  :role="subagentCardInputs(item.block)!.role"
                  :task="subagentCardInputs(item.block)!.task"
                />
              </template>
              <!-- An absorbed act's interim commentary: part of the middle,
                   visible only when the report's panel is opened. -->
              <MarkdownContent
                v-else
                :html="htmlFor(item.block.id, item.block.text)"
                :block-htmls="blockHtmlsFor(item.block.id, item.block.text)"
                @open-file="emit('open-file', $event)"
              />
            </template>
          </div>
        </Collapse>
      </template>

      <!-- Lightweight message: render everything inline in order. -->
      <template v-else>
        <template v-for="b in blocks" :key="b.id">
          <ThinkingBlock
            v-if="b.type === 'thinking'"
            :content="b.text"
            :sealed="b.sealed"
            :duration-ms="b.durationMs"
            :fold-key="b.id"
          />
          <template v-else-if="b.type === 'tool_group'">
            <ToolGroupBlock :fold-key="b.id" :tools="b.tools" />
            <SubAgentCard
              v-if="subagentCardInputs(b)"
              :role="subagentCardInputs(b)!.role"
              :task="subagentCardInputs(b)!.task"
            />
          </template>
          <MarkdownContent
            v-else-if="b.type === 'text'"
            :html="htmlFor(b.id, b.text)"
            :block-htmls="blockHtmlsFor(b.id, b.text)"
            :tail-fade-count="streaming && b.id === lastTextBlockId ? 6 : 0"
            :streaming="streaming"
            @open-file="emit('open-file', $event)"
          />
        </template>
      </template>

      <!-- Outside the panel, only the REPORT: the trailing text run after
           the act's last thinking/tool block. Everything interleaved before
           it (the scratch narration) lives inside the panel. Live pending
           approvals render in the ApprovalModal overlay, never here. -->
      <template v-if="shouldFold">
        <MarkdownContent v-for="b in reportTextBlocks" :key="b.id" :html="htmlFor(b.id, b.text)" :block-htmls="blockHtmlsFor(b.id, b.text)" :tail-fade-count="streaming && b.id === lastTextBlockId ? 6 : 0" :streaming="streaming" @open-file="emit('open-file', $event)" />
      </template>

      <div class="bubble-actions">
        <IconButton size="xs" class="bubble-action" :class="{ 'bubble-action--copied': copied }" :aria-label="t('agent.transcript.copy')" :title="t('agent.transcript.copy')" @click="copyText">
          <CopyDocument />
        </IconButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bubble-agent {
  display: flex;
  gap: 10px;
}
.agent-indicator {
  width: 3px;
  min-width: 3px;
  align-self: stretch;
  background: var(--color-primary);
  border-radius: 50%;
  opacity: 0.4;
}
.bubble-body {
  flex: 1;
  min-width: 0;
}

.fold-summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: var(--space-1) 0;
  padding: var(--space-1) 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text-muted);
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.fold-summary:hover { background: var(--color-hover); color: var(--color-text); }
.fold-summary.open { border-radius: var(--radius-sm) var(--radius-sm) 0 0; margin-bottom: 0; }

.fold-arrow {
  display: inline-block;
  font-size: var(--text-label);
  color: var(--color-text-muted);
  transition: transform var(--dur-fast) var(--ease-out);
}
.fold-arrow.open { transform: rotate(90deg); }

.fold-title { white-space: nowrap; }

.fold-summary__glyph { color: var(--status-succeeded); flex-shrink: 0; }
.fold-summary__glyph--live { color: var(--status-running); }
.fold-summary__glyph--live.spinning { animation: fold-spin 1.1s linear infinite; }
@keyframes fold-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .fold-summary__glyph--live.spinning { animation: none; } }
.bubble-plan { margin-bottom: var(--space-2); }

.fold-panel {
  margin: 0 0 var(--space-1);
  padding: 6px 10px;
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  background: var(--color-bg);
}

.bubble-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  margin-top: 6px;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.bubble-agent:hover .bubble-actions,
.bubble-agent:focus-within .bubble-actions { opacity: 1; }
.bubble-action {
  margin-left: auto;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--color-text-muted);
  padding: 2px;
  border-radius: var(--radius-xs);
}
.bubble-action:hover { color: var(--color-text); background: var(--color-hover); }
.bubble-action--copied { color: var(--color-success, var(--color-primary)); }
</style>
