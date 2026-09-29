<template>
  <div class="thinking-block">
    <details :open="open" @toggle="(e: ToggleEvent) => open = (e.target as HTMLDetailsElement).open">
      <summary class="thinking-summary" :class="{ 'is-live': !sealed }" @click.prevent="open = !open">
        <ToolIcon name="thought" />
        <span>{{ sealed ? t('agent.thinking.thought') : t('agent.thinking.thinking') }}</span>
        <!--
          Intent line: a folded block still answers "what is it thinking
          about" — the live block shows the reasoning's current tail (real
          thought, the same rule the HUD's thought-tail follows), the sealed
          block its opening line (what the reasoning was about). Raw text,
          never a canned label.
        -->
        <span v-if="!open && intentLine" class="thinking-intent" :title="intentLine">{{ intentLine }}</span>
        <!--
          The folded summary carries derived digests — how much reasoning the
          block holds, and how fast it is arriving — so a collapsed block still
          answers "is it working, how much, how fast" without expanding anything.
          While live these two numbers are the ONLY motion in the row (user
          directive): no dots, no sheen — a ticking count is the heartbeat.
        -->
        <span v-if="charCount > 0" class="thinking-count">· {{ t('agent.thinking.chars', { count: charCount.toLocaleString() }) }}</span>
        <span v-if="!sealed && ratePerSecond !== null" class="thinking-rate">· {{ t('agent.thinking.rate', { n: ratePerSecond.toLocaleString() }) }}</span>
        <span v-if="sealed && durationMs !== undefined" class="thinking-count">· {{ durationText }}</span>
        <span class="thinking-arrow" :class="{ open }" aria-hidden="true">›</span>
      </summary>
      <div v-if="open && content" class="thinking-body">
        {{ content }}
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ToolIcon from './ToolIcon.vue'
import { useTranscriptFoldState } from './transcript-fold-state'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  content: string
  sealed: boolean
  /** How long the reasoning segment ran (ms); stamped when the block seals. */
  durationMs?: number
  /**
   * Stable key (the block id) used to persist open state in the
   * transcript-wide fold-state map, so expansion survives DynamicScroller
   * recycling and the streaming→settled message-id swap. Without a key the
   * state falls back to a local ref (previous behaviour).
   */
  foldKey?: string
}>(), {
  durationMs: undefined,
  foldKey: '',
})

// Open state lives in the transcript-wide map when keyed — a local ref was
// lost on every remount, which is exactly what streaming re-renders and
// scroller recycling trigger; the panel felt impossible to keep open.
//
// DEFAULT is folded — always, live or sealed (user directive): watching the
// reasoning text stream by is noise; the ticking digest on the summary is the
// live signal, and the text stays one click away. An explicit toggle wins
// over the default and persists through recycling.
const foldState = useTranscriptFoldState()
const localOpen = ref(false)

/** The digest: how much reasoning the block carries. Derived, never stored —
 *  it is a presentation fact of the text the block already holds. */
const charCount = computed(() => props.content.length)

// ── Intent line ──────────────────────────────────────────────────────────────
// The folded summary's content voice: WHAT the reasoning is about, not just
// how much of it there is. Live → the tail (it is what the model is thinking
// right now; the head is often settled by the time you look); sealed → the
// first non-empty line (the thought's own opening statement). One line,
// whitespace collapsed, capped — the full text stays one click away.
const INTENT_CHARS = 64

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

const intentLine = computed<string | null>(() => {
  if (!props.content) return null
  if (!props.sealed) {
    const line = collapseWhitespace(props.content)
    if (!line) return null
    return line.length <= INTENT_CHARS ? line : `…${line.slice(-INTENT_CHARS)}`
  }
  const first = collapseWhitespace(props.content.split('\n').find((l) => l.trim()) ?? '')
  if (!first) return null
  return first.length <= INTENT_CHARS ? first : `${first.slice(0, INTENT_CHARS)}…`
})
const open = computed<boolean>({
  get: () => {
    if (props.foldKey) {
      const chosen = foldState.peek(`thinking:${props.foldKey}`)
      if (chosen !== undefined) return chosen
      return false
    }
    return localOpen.value
  },
  set: (v) => {
    if (props.foldKey) foldState.set(`thinking:${props.foldKey}`, v)
    else localOpen.value = v
  },
})

/*
 * Arrival rate (chars/s — the stream delivers characters, not tokens; token
 * usage only settles at end of turn). Measured from an anchor observation:
 * the first time this instance sees content it anchors (time, length), and
 * the rate is growth since the anchor. Anchoring on observation rather than
 * on "first delta ever" keeps the figure honest across scroller-recycler
 * remounts — a remount re-anchors and reconverges within a second instead of
 * dividing the whole accumulated text by milliseconds. Hidden until the
 * window is long enough to mean anything, and gone once sealed (a finished
 * block reports size, not speed).
 */
const anchor = ref<{ at: number; len: number } | null>(null)
watch(() => props.content, (text) => {
  if (anchor.value === null) anchor.value = { at: Date.now(), len: text.length }
}, { immediate: true })

const ratePerSecond = computed<number | null>(() => {
  // Read the length BEFORE the guards: computed tracking is dynamic, and an
  // early return here (which the first evaluation always takes, elapsed ~ 0)
  // would leave props.content out of the dependency set — the rate would
  // never recompute as deltas arrive and stay frozen at null.
  const len = props.content.length
  if (props.sealed || anchor.value === null) return null
  const elapsedSeconds = (Date.now() - anchor.value.at) / 1000
  if (elapsedSeconds < 1) return null
  return Math.max(1, Math.round((len - anchor.value.len) / elapsedSeconds))
})

/*
 * The settled block's headline fact: how long the reasoning took (the user
 * reads "已思考 · 8.4 秒", never a wall clock). Scaled precision — tenths
 * under ten seconds where the decimal carries signal, whole seconds to a
 * minute, clock notation beyond — keeps the digest one glance wide.
 */
const durationText = computed(() => {
  const seconds = (props.durationMs ?? 0) / 1000
  if (seconds < 10) return t('agent.thinking.durationSeconds', { n: seconds.toFixed(1) })
  if (seconds < 60) return t('agent.thinking.durationSeconds', { n: Math.round(seconds).toLocaleString() })
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}:${String(rest).padStart(2, '0')}`
})
</script>

<style scoped>
.thinking-block {
  margin: var(--space-1-5) 0;
  animation: hana-chat-soft-down-in 130ms ease-out both;
}

.thinking-summary {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  cursor: pointer;
  color: var(--color-text-muted);
  user-select: none;
  border: none;
  background: transparent;
  padding: 0;
  font-size: var(--text-sm);
  font-family: inherit;
  list-style: none;
}
/* Live voice without motion: the unsealed label sits in the live channel
   colour (The Living Channel Rule) — the ticking count beside it is the only
   thing that moves. Sealed blocks return to the muted voice. */
.thinking-summary.is-live {
  color: var(--color-live);
}
.thinking-summary::-webkit-details-marker { display: none; }
.thinking-summary:focus-visible { outline: 2px solid var(--color-ring); outline-offset: 2px; border-radius: var(--radius-xs); }

/* The digests read as metadata beside the label: upright (the summary is
   italic), quieter, tabular so a streaming count doesn't jitter. */
.thinking-count,
.thinking-rate {
  font-style: normal;
  font-size: var(--domain-text-meta);
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}

/* The intent line reads as the summary's content voice: quieter than the
   label, cut with an ellipsis, full text on the title tooltip. */
.thinking-intent {
  font-style: normal;
  font-size: var(--domain-text-meta);
  color: var(--color-text-muted);
  max-width: 44ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thinking-arrow {
  display: inline-block;
  font-style: normal;
  font-size: var(--text-label);
  transition: transform var(--dur-fast) var(--ease-out);
}
.thinking-arrow.open { transform: rotate(90deg); }

.thinking-body {
  margin-top: 6px;
  padding: 0 var(--space-3);
  /* 11px muted was below the 4.5:1 PRODUCT.md targets and unreadable in a long
     session — the two things a scientific tool cannot trade for compactness. */
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: 1.6;
  white-space: pre-wrap;
  font-family: var(--font-mono);
}

@media (prefers-reduced-motion: reduce) {
  .thinking-block { animation: none; }
}
</style>
