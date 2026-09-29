<script setup lang="ts">
/**
 * ToolGroupBlock — renders a list of tool calls behind one collapsible summary.
 *
 * ONE fold affordance for any count. A single tool used to render as a flat
 * "card" with no toggle and no way to collapse it; after a turn settled and
 * replayed from the log, the transcript stacked one un-collapsible card per
 * tool and read as a pile of boxes. Now every group — single or many — shows
 * the same summary row (label + status glyph) that expands on click to reveal
 * the full detail rows. The summary already carries the one-line essence
 * (tool name + truncated detail + a Check/Close status icon); the expanded body adds the
 * un-truncated detail + error.
 *
 * The expanded rows are registry business, not this component's: each call
 * goes through `tool-call/ToolCallRenderer`, so a per-tool surface lands as
 * one component + one registry entry without touching the fold machinery
 * here. The entry animation is likewise played ONCE per stable group key
 * (module-level LRU in the registry) — a virtual-scroller remount or the
 * live→settled id swap never replays it.
 *
 * Ported from openhanako ToolGroupBlock.tsx + ToolIndicator. i18n labels
 * are static Chinese (openhanako uses window.t with tool.{name}.{phase}
 * keys; TDEase chat has no per-tool i18n, so we synthesize a readable
 * label from the tool name + phase).
 */
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Close, Minus } from '@element-plus/icons-vue'
import Collapse from './Collapse.vue'
import ToolIcon from './ToolIcon.vue'
import ToolCallRenderer from './tool-call/ToolCallRenderer.vue'
import { hasPlayedEntryAnimation, markEntryAnimationPlayed } from './tool-call/registry'
import { extractToolDetail, extractToolFullDetail, isToolCallHiddenFromProcessUi } from '@/utils/tool-detail'
import { bareToolName, isToolFailure, toolActionKey, toolIconName, type ToolIconName } from '@/utils/tool-identity'
import { useTranscriptFoldState } from './transcript-fold-state'
import type { ToolCall } from '@/stores/chat-types'

const props = withDefaults(defineProps<{
  tools: ToolCall[]
  /**
   * A STABLE, UNIQUE-per-group key used to persist this group's collapse state
   * across DynamicScroller recycling. Callers MUST pass the tool_group block's
   * OWN id (b.id), not the parent message id: a single act can carry several
   * tool_group blocks (tools interleaved with text), and keying by message.id
   * makes them share one fold slot — opening one opens them all. Block ids are
   * stable for a settled turn (event:<seq>), so toggles made after a turn
   * settles persist for the rest of the session.
   */
  foldKey?: string
}>(), {
  foldKey: '',
})

const visibleTools = computed(() =>
  props.tools
    .filter(t => !isToolCallHiddenFromProcessUi(t))
    .map(t => ({
      ...t,
      detail: t.detail ?? extractToolDetail(t.name, t.args),
      // Full (un-truncated) detail for the expanded body. The summary shows the
      // truncated `detail.text`; opening the group reveals this in full.
      full: extractToolFullDetail(t.name, t.args),
    })),
)

// Collapse state lives in the transcript-wide fold-state map (keyed by the
// stable `foldKey`), not a local ref — so it survives scroller recycling and
// the streaming→settled id change. The previous local `ref` reset to
// `collapsed = true` on every remount, and the `watch(() => props.collapsed)`
// below it could even force it back to collapsed mid-session. Both gone.
const foldState = useTranscriptFoldState()
const foldStateKey = computed(() => `toolgroup:${props.foldKey}`)

/**
 * EVERY group defaults collapsed; one click expands it. That is the whole
 * policy — deliberately no shouldDefaultOpen exceptions: "a failed tool
 * defaults open" and "active-turn bash/write/edit default open" meant real
 * working turns (which almost always carry a failed probe or a live edit)
 * showed permanently expanded cards. Failures stay ANNOUNCED instead — the
 * summary line carries the count and the red status glyph; the detail is
 * one click away, same as everything else.
 */
const isCollapsed = computed(() => foldState.get(foldStateKey.value, true))
const toggle = () => foldState.set(foldStateKey.value, !isCollapsed.value)

// The group's entry animation plays on the FIRST mount only; later remounts
// (DynamicScroller recycling, live→settled swap) render settled geometry
// with no motion (see registry's LRU note).
const playEntryAnimation = !hasPlayedEntryAnimation(foldStateKey.value)
onMounted(() => markEntryAnimationPlayed(foldStateKey.value))

const allDone = computed(() =>
  visibleTools.value.every(t => t.status !== 'running' && t.done),
)
// Cancelled is its own neutral state, never a failure (agentui status
// vocabulary): an interrupted call did not fail, the turn ended around it.
// The predicate lives in tool-identity.ts — the ONE copy, shared with
// ProcessFold's fold line so both surfaces count the same failures.
const failCount = computed(() => visibleTools.value.filter(isToolFailure).length)
const runningCount = computed(() => visibleTools.value.filter(t => t.status === 'running').length)
const isSingle = computed(() => visibleTools.value.length === 1)

const { t } = useI18n()

const summaryText = computed(() => {
  // Single tool: the summary line IS the tool — show its label, not a count.
  if (isSingle.value) return labelFor(visibleTools.value[0])
  const n = visibleTools.value.length
  if (allDone.value) {
    if (failCount.value > 0) return t('agent.toolGroup.ranToolsWithFailures', { count: n, failed: failCount.value })
    return t('agent.toolGroup.ranTools', { count: n })
  }
  return t('agent.toolGroup.runningTools', { count: runningCount.value })
})

/**
 * The summary line's title: the tool's action phrase ("运行命令") where one
 * exists, else its bare name. The raw tool name is deliberately NOT the
 * title — it is developer identity, revealed one level down in the expanded
 * body (.tool-name) where the audit's info hierarchy puts it.
 */
function labelFor(tool: ToolCall): string {
  const key = toolActionKey(tool.name)
  return key ? t(key) : bareToolName(tool.name)
}

/** Summary-glyph class per render status; `unknown` keeps the legacy failure look. */
function statusGlyphClass(status: ToolCall['status']): string {
  if (status === 'succeeded') return 'done'
  if (status === 'cancelled') return 'cancelled'
  return 'failed'
}

/**
 * The group's glyph — the lead tool's icon (a group is usually homogeneous;
 * when it is not, the lead tool is the one the user is tracking). The icon is
 * the row's identity marker, replacing the old category color stripe: it reads
 * without palette memory and inherits the quiet text voice.
 */
const icon = computed<ToolIconName>(() => {
  if (visibleTools.value.length === 0) return 'spark'
  return toolIconName(visibleTools.value[0].name)
})
</script>

<template>
  <div
    v-if="visibleTools.length"
    class="tool-group"
    :class="{ single: isSingle, 'tool-group--settled': !playEntryAnimation }"
  >
    <button
      type="button"
      class="tool-group-summary clickable"
      :class="{ running: !allDone }"
      :aria-expanded="!isCollapsed"
      @click="toggle"
    >
      <span class="tool-group-glyph tool-group-glyph--icon"><ToolIcon :name="icon" /></span>
      <span v-if="!isSingle" class="tool-group-glyph">
        <span
          v-if="allDone"
          class="tool-status"
          :class="failCount > 0 ? 'failed' : 'done'"
          aria-hidden="true"
        ><el-icon :size="14"><Close v-if="failCount > 0" /><Check v-else /></el-icon></span>
        <span v-else class="tool-dots" aria-hidden="true"></span>
      </span>
      <span class="tool-group-title">{{ summaryText }}</span>
      <span
        v-if="isSingle && visibleTools[0].detail?.text"
        class="tool-detail tool-group-detail"
        :title="visibleTools[0].detail.title || visibleTools[0].detail.text"
      >{{ visibleTools[0].detail.text }}</span>
      <span v-if="isSingle" class="tool-group-glyph tool-group-glyph--status">
        <span
          v-if="visibleTools[0].status !== 'running'"
          class="tool-status"
          :class="statusGlyphClass(visibleTools[0].status)"
          :title="visibleTools[0].status === 'cancelled' ? t('agent.toolGroup.cancelled') : undefined"
          aria-hidden="true"
        ><el-icon :size="14"><Check v-if="visibleTools[0].status === 'succeeded'" /><Minus v-else-if="visibleTools[0].status === 'cancelled'" /><Close v-else /></el-icon></span>
        <span v-else class="tool-dots" aria-hidden="true"></span>
      </span>
      <span class="tool-group-arrow" :class="{ open: !isCollapsed }" aria-hidden="true">›</span>
    </button>

    <!-- Expanded body: what the summary line did not already show (agentui
         tool-ui rule — an expansion adds information, never repeats it).
         Rows render through the registry, so per-tool surfaces slot in
         without this fold machinery changing. -->
    <Collapse :open="!isCollapsed">
      <div class="tool-group-content">
        <ToolCallRenderer
          v-for="tool in visibleTools"
          :key="tool.id"
          :tool="tool"
          :is-single="isSingle"
        />
      </div>
    </Collapse>
  </div>
</template>

<style scoped>
.tool-group {
  position: relative;
  margin: var(--space-1) 0;
  /* No filled card surface and no category stripe: the group reads as a plain
     row whose leading SVG glyph (terminal/file/…) carries the identity — a
     mark the eye can find, not a colored bar it must learn. */
  border-radius: var(--radius-sm);
  animation: tool-group-in 110ms ease-out both;
}
@keyframes tool-group-in {
  from { opacity: 0; transform: translateY(2px); }
  to   { opacity: 1; transform: translateY(0); }
}
/* Recorded in the registry's LRU after the first play — remounts are quiet. */
.tool-group--settled { animation: none; }

.tool-group-summary {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-1) var(--space-1-5); border: 0;
  border-radius: var(--radius-sm);
  background: transparent; text-align: left;
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  line-height: 1.5;
  user-select: none;
}
.tool-group-summary.clickable { cursor: pointer; }
.tool-group-summary.clickable:hover { background: var(--color-hover); }
/* Running: dim the title so the live summary text still reads as "in flight",
   but the button stays clickable — users should be able to inspect partial
   state, not wait for completion to expand. */
.tool-group-summary.running .tool-group-title { opacity: 0.7; }
.tool-group-summary:focus-visible { outline: 2px solid var(--color-ring); outline-offset: -2px; }

.tool-group-title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-group-glyph { display: inline-flex; align-items: center; flex-shrink: 0; }
/* The identity glyph reads one step quieter than the title text — it marks
   the row, it is not the message. */
.tool-group-glyph--icon { color: var(--color-text-muted); }
.tool-group-detail { flex: 1; min-width: 0; }

.tool-group-arrow {
  margin-left: auto;
  font-size: var(--text-label);
  color: var(--color-text-muted);
  width: 0.8em;
  flex-shrink: 0;
  transition: transform var(--dur-fast) var(--ease-out);
}
.tool-group-arrow.open { transform: rotate(90deg); }

.tool-group-content {
  margin-top: 2px;
  padding: 2px 8px 4px 26px;
  /* Plain indent, no callout rule: the expanded body is subordinate to its
     summary line by geometry alone. */
}

.tool-detail {
  flex: 1;
  min-width: 0;
  font-size: var(--domain-text-meta);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-status { font-size: var(--text-sm); }
.tool-status.done { color: var(--color-success-text); }
.tool-status.failed { color: var(--color-error-text); }

/*
  CSS shimmer for the "running" cue. `::after` carries three dots revealed one
  at a time by a stepped width animation ("" → "." → ".." → "..." → ""). No JS
  timer, no ref, no re-render.
*/
.tool-dots {
  display: inline-block;
  margin-left: auto;
  font-weight: 700;
  letter-spacing: 0.1em;
  /* The running cue carries the live channel colour (The Living Channel
     Rule) — gray dots read as "static text", celadon dots read as "working". */
  color: var(--color-live);
  min-width: 1.5em;
}
.tool-dots::after {
  content: '...';
  display: inline-block;
  width: 0;
  overflow: hidden;
  animation: tool-dots-reveal 1.5s steps(4, end) infinite;
}
@keyframes tool-dots-reveal {
  0%   { width: 0; }
  100% { width: 1.5em; }
}

@media (prefers-reduced-motion: reduce) {
  .tool-dots::after { animation: none; width: 1.5em; }
}
</style>
