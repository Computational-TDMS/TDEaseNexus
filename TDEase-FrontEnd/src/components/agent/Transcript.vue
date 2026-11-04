<!--
  Transcript — "the transcript is a projection." It
  renders exactly `buildTranscriptBlocks(messages, settlements)` — a pure
  function of `project.ts`'s `SessionProjection.messages` plus its
  `settlements` map — and nothing else. There is no locally-accumulated
  second block list here.

  Virtualized with `vue-virtual-scroller`'s `DynamicScroller`: block heights
  vary hugely (a one-line outcome chip vs. a multi-tool act), so height is
  measured, not assumed.

  `SessionTodoCard` is pinned below the scroller rather than sequenced into
  `blocks`. §8.4 maps `todo_write`'s `tool.requested`/`tool.completed` onto a
  `ToolGroupBlock` row, which the act already renders; a separate `plan`
  block would be a block no event produces. The card is instead a derived
  summary of the latest `todo_write` payload in the same projection, kept
  out of the block list so a mid-turn plan update rewrites the card in place
  and never reorders or displaces what the user is reading.

  Scrolling (Phase D-19, palot pattern):
    - ScrollOnLoad: a session loaded asynchronously jumps to the bottom
      *instantly* (behavior:'instant'), killing the top→bottom smooth
      animation that otherwise plays while the history streams in.
    - scroll-fade: a top/bottom gradient mask signals more content beyond the
      visible edge, mirroring palot's scroll-fade.
    - "Jump to start of response" pill: appears when a turn settles while the
      user is scrolled away; jumps back to the just-finished assistant
      message and auto-dismisses after 8s.
-->
<template>
  <div
    ref="regionEl"
    class="transcript-region"
    :class="{ 'is-scrolled-from-top': scrolledFromTop, 'is-scrolled-from-bottom': showJump, 'transcript--hydrating': hydrating, 'transcript-region--tickrail': turnTicks.length > 1 }"
  >
    <!-- Ambient backdrop: decorative, paints between the region's surface and
         the scroller content. A SLOT so the transcript stays a pure
         projection — whatever identity the host wants to carry (the Agent
         page's mode emblems) stays outside this component. -->
    <div v-if="$slots.backdrop" class="transcript-region__backdrop" aria-hidden="true">
      <slot name="backdrop" />
    </div>
    <DynamicScroller
      ref="scrollerRef"
      :key="scrollerRebuildKey"
      class="transcript"
      :items="blocks"
      key-field="id"
      :min-item-size="48"
      @scroll="onScroll"
    >
      <template #default="{ item, index, active }">
        <DynamicScrollerItem :item="item" :active="active" :data-index="index" :size-dependencies="[item.kind]">
          <div
            :ref="(el) => bindRowRef(item.kind === 'user' || item.kind === 'act' ? item.message.id : undefined, el)"
            class="transcript__row"
            :class="{ 'transcript__row--enter': enteringIds.has(item.id) }"
            :data-block-kind="item.kind"
            :style="{ '--row-stagger': staggerFor(index) }"
          >
            <div v-if="item.kind === 'user'" class="transcript__user" @mouseenter="hoveredUserId = item.message.id" @mouseleave="hoveredUserId = null">
              <div class="transcript__user-bubble">
                <span class="transcript__user-text">{{ item.message.content }}</span>
                <span
                  v-if="item.settlementHint"
                  class="transcript__user-cancelled"
                  :class="{ 'transcript__user-cancelled--failed': item.settlementHint === 'failed' }"
                >{{ item.settlementHint === 'failed' ? t('agent.transcript.failedChip') : t('agent.transcript.cancelled') }}</span>
                <button
                  v-if="item.message.content"
                  class="transcript__user-copy"
                  :class="{ 'transcript__user-copy--visible': hoveredUserId === item.message.id, 'transcript__user-copy--copied': copiedUserId === item.message.id }"
                  :title="t('agent.transcript.copy')"
                  :aria-label="t('agent.transcript.copy')"
                  @click="copyUserMessage(item.message.id, item.message.content ?? '')"
                >
                  <el-icon :size="12" aria-hidden="true"><CopyDocument /></el-icon>
                </button>
              </div>
            </div>

            <!-- Hidden role: a resolved multi-act turn's interim act — its
                 whole content lives inside the report act's fold panel, so
                 this row renders nothing (the row element stays bound for
                 scroll targets like the jump-to-response pill). -->
            <ProcessFold
              v-else-if="item.kind === 'act' && turnFold.get(item.id)?.role !== 'hidden'"
              :message="item.message"
              :streaming="item.message.id === streamingMessageId"
              :settlement="item.settlement"
              :intent="intents.get(item.message.id)"
              :show-plan="item.message.id === effectivePlanAnchorId"
              :absorb-acts="turnFold.get(item.id)?.absorb.length ? turnFold.get(item.id)!.absorb : undefined"
              @open-file="emit('open-file', $event)"
            />

            <TurnOutcomeCard v-else-if="item.kind === 'outcome'" :settlement="item.settlement" @continue="emit('continue-turn', item.turnId)" @answer="emit('answer-turn', item.turnId, $event)" />

            <!-- A failure is only worth the full card while it is the live tail.
               Once the conversation moved past that turn, the card collapses to
               a one-line note — the 402 you already handled must not shout
               forever from the middle of the history. -->
            <ErrorCard v-else-if="item.kind === 'failed'" :error="toStructuredError(item.settlement.error)" />

            <!-- Compaction marker: everything above this line was summarized
               away (manual /compact or automatic threshold/overflow). A quiet
               divider, not a card — the fact is "history got shorter here";
               the token delta is the run's own measurement when it gave one. -->
            <div
              v-else-if="item.kind === 'compaction'"
              class="transcript__compaction"
              role="separator"
              :aria-label="t('agent.transcript.compacted')"
            >
              <span class="transcript__compaction-line" aria-hidden="true" />
              <Archive :size="12" :stroke-width="2" aria-hidden="true" />
              <span>{{ t('agent.transcript.compacted') }}</span>
              <span v-if="item.block.tokensBefore !== undefined" class="transcript__compaction-tokens">{{ compactionDelta(item.block) }}</span>
              <span class="transcript__compaction-line" aria-hidden="true" />
            </div>
          </div>
        </DynamicScrollerItem>
      </template>

      <template #empty>
        <!-- History still being read off disk: a skeleton, never the "new
             conversation" empty state — that flash is what reads as a broken
             session. The skeleton lives inside the scroller so it inherits
             the same centered reading column as the rows it stands in for. -->
        <div v-if="loading" class="transcript__loading" role="status" :aria-label="t('agent.transcript.loadingHistory')">
          <div class="transcript__loading-hint">{{ t('agent.transcript.loadingHistory') }}</div>
          <div class="transcript__skeleton transcript__skeleton--user" />
          <div class="transcript__skeleton" style="width: 88%" />
          <div class="transcript__skeleton" style="width: 64%" />
          <div class="transcript__skeleton" style="width: 76%" />
        </div>
        <slot v-else name="empty" />
      </template>
    </DynamicScroller>

    <!-- Conversation bookmark rail: one tick per user turn at the region's
         left edge, the turn at the viewport top lit bright, click to jump.
         Pure projection — derived from the same `blocks` as the rows. -->
    <nav
      v-if="turnTicks.length > 1"
      class="transcript__tickrail"
      :aria-label="t('agent.transcript.turnNav')"
    >
      <button
        v-for="tick in turnTicks"
        :key="tick.id"
        type="button"
        class="transcript__tick"
        :class="{ 'transcript__tick--active': tick.id === activeTickId }"
        :title="tick.label || t('agent.transcript.turn')"
        :aria-label="tick.label || t('agent.transcript.turn')"
        @click="jumpToTurn(tick.index)"
      />
    </nav>

    <!-- Scroll-fade masks: top + bottom gradients that signal more content
         beyond the visible edge. Driven by `is-scrolled-from-*` on the region
         so the mask only paints where there is something to scroll to. -->
    <div class="transcript__fade transcript__fade--top" aria-hidden="true" />
    <div class="transcript__fade transcript__fade--bottom" aria-hidden="true" />

    <!-- Scroll-to-bottom pill: appears when the user has scrolled away from
         the tail. Click re-anchors. Mirrors openhanako's scroll FAB. -->
    <Transition name="jump-fade">
      <button
        v-if="showJump"
        type="button"
        class="transcript__jump"
        :aria-label="t('agent.transcript.jumpToBottom')"
        :title="t('agent.transcript.jumpToBottom')"
        @click="jumpToBottom"
      >
        <el-icon :size="16"><ArrowDown /></el-icon>
      </button>
    </Transition>

    <!-- "Jump to start of response" pill (palot pattern). Appears when a turn
         settles while the user is scrolled away from the tail; jumps to the
         first assistant block of that turn and auto-dismisses after 8s. -->
    <Transition name="jump-fade">
      <button
        v-if="showJumpToResponse"
        type="button"
        class="transcript__jump transcript__jump--to-response"
        :aria-label="t('agent.transcript.jumpToResponse')"
        :title="t('agent.transcript.jumpToResponse')"
        @click="jumpToResponseStart"
      >
        <el-icon :size="14"><Top /></el-icon>
        <span class="transcript__jump-label">{{ t('agent.transcript.jumpToResponse') }}</span>
      </button>
    </Transition>

    <!-- Compaction live divider: a manual /compact is summarizing through the
         real provider chain (seconds, not milliseconds). The settled divider
         replaces this the moment the `context.compacted` event lands and the
         projection re-reads — same geometry, so the swap is invisible. -->
    <Transition name="live-tail">
      <div
        v-if="compacting"
        class="transcript__compaction transcript__compaction--live"
        role="status"
        :aria-label="t('agent.transcript.compacting')"
      >
        <span class="transcript__compaction-line" aria-hidden="true" />
        <Archive :size="12" :stroke-width="2" aria-hidden="true" />
        <span>{{ t('agent.transcript.compacting') }}</span>
        <span class="transcript__livetail-dots" aria-hidden="true"><i /><i /><i /></span>
        <span class="transcript__compaction-line" aria-hidden="true" />
      </div>
    </Transition>

    <!-- Live tail: the turn was sent but the model has not produced its first
         token yet (phase `waiting`). Without this the transcript reads as dead
         air below the user's message. It is VIEW state pinned over the
         composer clearance — deliberately NOT a transcript block, so the
         projection stays pure (blocks are what the runtime recorded, never
         what the UI is currently waiting for). -->
    <Transition name="live-tail">
      <div v-if="pending" class="transcript__livetail" role="status" :aria-label="t('agent.transcript.working')">
        <span class="transcript__livetail-dots" aria-hidden="true"><i /><i /><i /></span>
        <span class="transcript__livetail-label">{{ t('agent.transcript.working') }}</span>
      </div>
    </Transition>

    <!-- Selection pill: floats over a text selection (ZCode's ask-AI entry,
         rendered by SelectionSideChatPane's flow). Fixed-positioned at the
         selection's top edge so virtualization and scroll never clip it;
         teleported to <body> because a `position: fixed` chip inside the
         page-switch track (`app-shell__track` carries the slide transform)
         resolves against the TRACK, not the viewport — the track's -1370px
         offset slid the pill off-screen for every selection. Hidden unless
         the host handles the flow (`selectionAsk`). -->
    <Teleport to="body">
      <button
        v-if="selectionAsk && selectionPill"
        type="button"
        class="transcript__ask-pill"
        :style="{ left: `${selectionPill.x}px`, top: `${selectionPill.y}px` }"
        @mousedown.prevent
        @click="askSelection"
      >
        {{ t('agent.transcript.askAi') }}
      </button>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, toRef, watch } from 'vue'
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import { ArrowDown, CopyDocument, Top } from '@element-plus/icons-vue'
import { Archive } from '@lucide/vue'
import ProcessFold from './ProcessFold.vue'
import TurnOutcomeCard from './TurnOutcomeCard.vue'
import ErrorCard from '@/components/primitives/ErrorCard.vue'
import { useI18n } from 'vue-i18n'
import { buildTranscriptBlocks, computeTurnFold } from './transcript-blocks'
import { FRAME_LAYOUT_SHIFT_EVENT } from './markdown-hydration'
import { computeIntents } from '@/composables/useSessionTodos'
import { TRANSCRIPT_FOLD_KEY } from './transcript-fold-state'
import { formatTokensK } from './turnReadout'
import type { AgentChatMessage, CompactionBlock } from '@/stores/chat-types'
import type { TurnSettlement } from '@/agent/events'
import type { SessionError } from '@/agent/events'
import type { StructuredError } from '@/studio/domain/errors'

const props = defineProps<{
  messages: ReadonlyArray<AgentChatMessage>
  settlements: ReadonlyMap<string, TurnSettlement>
  /** The assistant message currently receiving streamed deltas, if any. */
  streamingMessageId?: string | null
  /** Owning session id. A switch to another session re-arms the one-shot
   *  jump-to-bottom below; a re-projection of the SAME session (every turn
   *  end's `loadHistory` replaces the `messages` array) must not — watching
   *  array identity there yanked a scrolled-up reader to the bottom the
   *  moment the turn settled. */
  sessionId?: string | null
  /**
   * The turn was sent but the model has not produced anything yet (HUD phase
   * `waiting`, owned by AgentPage). Shows the live-tail pill; the transcript's
   * blocks stay untouched — this is view state, not projection content.
   */
  pending?: boolean
  /** A manual /compact is summarizing (view state — the settled divider is
   *  projection content and replaces this when the event lands). */
  compacting?: boolean
  /**
   * The owning session's history has not been read off disk yet (a session
   * restored from metadata whose `loadHistory` is still in flight). While
   * true with no blocks, the transcript shows a loading skeleton instead of
   * the `empty` slot — an opened old session must never flash "new
   * conversation" before its history lands.
   */
  loading?: boolean
  /** Host handles `ask-selection` (ZCode's ask-AI flow). The compact sidebar
   *  view opts out — its pill would cover half the pane. */
  selectionAsk?: boolean
}>()

const emit = defineEmits<{
  'continue-turn': [turnId: string]
  /** A blocked turn's one-tap answer: the chosen option becomes the next turn. */
  'answer-turn': [turnId: string, answer: string]
  /** Forwarded from ProcessFold when a Workspace file card is clicked. */
  'open-file': [file: { path: string; kind: 'image' | 'svg' | 'html' | 'table' | 'json' | 'text' | 'file'; name: string }]
  /** A non-collapsed text selection's "ask AI" click (side-chat entry). */
  'ask-selection': [text: string]
}>()

const { t } = useI18n()

const blocks = computed(() => buildTranscriptBlocks(props.messages, props.settlements))

// Act-message intents (act id → in_progress activeForm), derived from the plan
// in ONE traversal per recompute and handed down as a plain prop — never a
// per-ProcessFold walk, which would re-scan the whole projection per row.
const intents = computeIntents(toRef(props, 'messages'))
// The task tree anchors on the LATEST act the plan attributes work to, so the
// card rides the tail of the work as the turn advances (one card per session,
// never a copy per turn). Map iteration follows message order.
const planAnchorId = computed(() => {
  let last: string | undefined
  for (const id of intents.value.keys()) last = id
  return last
})

// ── The report-collapse ──────────────────────────────────────────────────────
// A resolved MULTI-act turn narrates no middle: the last text-bearing act is
// the report (its fold panel absorbs every act's process and interim texts —
// ProcessFold's absorbActs), and the other acts render nothing. Pure function
// over the blocks, same discipline as the rows themselves.
const turnFold = computed(() => computeTurnFold(blocks.value))

// The plan card rides the report act when its natural anchor (the latest act)
// was folded away inside the report's panel.
const effectivePlanAnchorId = computed(() => {
  const anchor = planAnchorId.value
  if (!anchor || turnFold.value.get(anchor)?.role !== 'hidden') return anchor
  const anchorBlock = blocks.value.find((b) => b.kind === 'act' && b.id === anchor)
  if (!anchorBlock || anchorBlock.kind !== 'act') return anchor
  for (const b of blocks.value) {
    if (b.kind === 'act' && b.turnId === anchorBlock.turnId && turnFold.value.get(b.id)?.role === 'report') {
      return b.id
    }
  }
  return anchor
})

// ── Live row entrance (the chat "flow" beat) ────────────────────────────────
// A block APPENDED while the user watches — the sent user message, a new
// turn's act, a compaction divider — eases in once. Two cases must NOT play
// it: rows the virtualizer remounts on scroll (a bare mount animation would
// re-play forever while browsing history), and the settle-time projection
// swap (live msg-N rows become canonical turn:* rows with the SAME content —
// re-animating them reads as a blink). The append test handles both: the
// animation fires only when every previous block survived AND the previous
// tail is still present, which a swap (its live ids vanish) never satisfies.
const enteringIds = ref<ReadonlySet<string>>(new Set())
const seenRowIds = new Set<string>()
let rowEnterTimer: ReturnType<typeof setTimeout> | undefined

watch(blocks, (next, prev) => {
  if (!prev) return
  for (const block of prev) seenRowIds.add(block.id)
  if (hydrating.value || next.length <= prev.length) return
  const prevTail = prev[prev.length - 1]
  if (!prevTail || !next.some((block) => block.id === prevTail.id)) return
  const fresh: string[] = []
  for (let i = prev.length; i < next.length; i += 1) {
    const block = next[i]
    if (block && !seenRowIds.has(block.id)) fresh.push(block.id)
  }
  if (fresh.length === 0) return
  enteringIds.value = new Set([...enteringIds.value, ...fresh])
  if (rowEnterTimer) clearTimeout(rowEnterTimer)
  rowEnterTimer = setTimeout(() => { enteringIds.value = new Set() }, 480)
})

/** A compaction divider means the message list was wholesale-rewritten —
 *  exactly the swap DynamicScroller's incremental diffing cannot follow (its
 *  internal size/window bookkeeping goes stale and later tail items stop
 *  mounting). Keying the scroller on the divider count rebuilds it once per
 *  compaction; ordinary turns (append-only) keep their scroller instance. */
const compactionCount = computed(() => blocks.value.reduce((n, block) => (block.kind === 'compaction' ? n + 1 : n), 0))

/**
 * Settled-card retirement — the show-once rule's DOM half.
 *
 * The projection drops an outcome/failed block the moment its turn is
 * superseded, but the virtualizer's view pool does NOT unmount removed
 * items: pooled views are kept mounted with `visibility: hidden`, so a
 * retired blocked-card kept its question text, its option buttons and its
 * custom-input row alive in the DOM and the accessibility tree (observed
 * non-deterministically as 2–3 mounted copies of one settled card — the
 * STATUS defect the e2e pins softly). Vue's declarative layer cannot reach
 * inside the pool; the one lever is rebuilding the scroller, which drops the
 * pool with it — the same lever compaction uses. Fired ONLY when the
 * settled-card count DECREASES (append-only turns keep their instance), and
 * the reader's scroll offset is restored across the rebuild so it never
 * reads as a jump.
 */
const settledCardCount = computed(() => blocks.value.reduce(
  (n, block) => (block.kind === 'outcome' || block.kind === 'failed' ? n + 1 : n),
  0,
))
const cardRetireBump = ref(0)
watch(settledCardCount, (now, was) => {
  if (now >= was) return
  const el = scrollerEl()
  const scrollTop = el?.scrollTop ?? null
  cardRetireBump.value += 1
  nextTick(() => {
    if (!followTail.value && scrollTop !== null) scrollerEl()?.scrollTo?.({ top: scrollTop, behavior: 'auto' as ScrollBehavior })
    else reanchor()
  })
})
const scrollerRebuildKey = computed(() => `${compactionCount.value}:${cardRetireBump.value}`)

// One fold map per transcript. Tool rows are virtualized and may be mounted
// more than once; providing this map keeps their expanded state stable.
const foldState = reactive(new Map<string, boolean>())
provide(TRANSCRIPT_FOLD_KEY, foldState)

// `turn.failed`'s SessionError carries only { code, message } — the two
// fields the log actually records. ErrorCard wants the full envelope
// (CORE-ARCHITECTURE.md §7.1); `domain`/`remedy`/`retryable` are not in the
// session vocabulary, so this fills the least-committal values rather than
// inventing a specific remedy the runtime never stated.
function toStructuredError(error: SessionError): StructuredError {
  return {
    code: error.code,
    domain: 'agent',
    message: error.message,
    remedy: t('agent.transcript.failedRemedy'),
    retryable: false,
  }
}

/** "152k → 18k" — the compaction's own before/after token counts, in the same
 *  compact voice as the context gauge. "—" when the summarizer reported no
 *  post-compaction estimate (Pi leaves it undefined on some paths). */
function compactionDelta(block: CompactionBlock): string {
  const before = block.tokensBefore ?? 0
  const after = block.tokensAfter !== undefined ? formatTokensK(block.tokensAfter) : '—'
  return `${formatTokensK(before)} → ${after}`
}

interface ScrollerHandle { scrollToBottom?: () => void; scrollToItem?: (index: number) => void; scrollToPosition?: (position: number) => void }
const scrollerRef = ref<ScrollerHandle | null>(null)

// Scroll-to-bottom pill state. `showJump` is true when the user is not within
// `JUMP_THRESHOLD` of the tail. Computed from the scroller's own scroll event
// (vue-virtual-scroller forwards it), so it stays accurate under streaming.
const JUMP_THRESHOLD = 80
const showJump = ref(false)
const followTail = ref(true)
// Top-edge fade: true when scrollTop > 0 (something above the viewport).
const scrolledFromTop = ref(false)

// ── Frame layout-compensation grace ──────────────────────────────────────────
//
// When an embedded media frame's box changes (first reveal, settled html
// height), the virtualizer compensates scrollTop with no reader input behind
// it. Raw distance-from-bottom would read that as the reader leaving the tail
// and unpin streaming — the "scroll jumps / tail escapes" defect over HTML
// figures. Hydration fires FRAME_LAYOUT_SHIFT_EVENT at every real box change;
// scrolls inside this grace are compensation, not intent: they never unpin,
// and a following reader is re-anchored to the tail (ZCode's `layout` scroll
// source, same rule).
const FRAME_LAYOUT_GRACE_MS = 180
let frameLayoutGraceUntil = 0
function markFrameLayoutShift(): void {
  frameLayoutGraceUntil = performance.now() + FRAME_LAYOUT_GRACE_MS
}

// Hover-copy state for user bubbles (assistant already has one in ProcessFold).
const hoveredUserId = ref<string | null>(null)
const copiedUserId = ref<string | null>(null)
// Timer that resets the copy button's "copied" state. Tracked so teardown can
// clear it (the previous inline setTimeout leaked past unmount).
let copyResetTimer: ReturnType<typeof setTimeout> | undefined

// Row-element refs keyed by message id, so "jump to start of response" can
// scrollIntoView the just-finished assistant message regardless of where the
// virtualizer placed it. Only `act`/`user` rows register; outcome/failed
// rows have no message id of their own.
const rowEls = new Map<string, HTMLElement>()
function bindRowRef(messageId: string | undefined, el: Element | unknown) {
  if (!messageId) return
  if (el instanceof HTMLElement) rowEls.set(messageId, el)
  else rowEls.delete(messageId)
}

// ── Conversation bookmark rail (the tick jump bar) ───────────────────────────
//
// A slim vertical rail on the transcript's left edge: one tick per USER turn
// (the conversation's bookmarks), the tick nearest the viewport top lit
// bright, click a tick to jump to that turn. Derived purely from `blocks` —
// same projection discipline as the rows themselves.
const TICK_CAP = 30
const turnTicks = computed(() => {
  const ticks: Array<{ id: string; index: number; label: string }> = []
  for (let i = 0; i < blocks.value.length; i += 1) {
    const block = blocks.value[i]
    if (block?.kind !== 'user') continue
    ticks.push({
      id: block.id,
      index: i,
      label: (block.message.content || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    })
  }
  // A very long session must not grow the rail past the viewport: keep the
  // latest turns (the scrollbar still reaches the earliest ones).
  return ticks.slice(-TICK_CAP)
})
const activeTickId = ref<string | null>(null)
let tickSyncFrame: ReturnType<typeof requestAnimationFrame> | null = null

/** The lit tick is the turn whose user message sits at/above the viewport
 *  top. Row elements are pooled (virtualized — only the window is mounted),
 *  so visibility reads the scroller's own `data-index` attributes. */
function syncActiveTick(): void {
  const el = scrollerEl()
  const region = regionEl.value
  if (!el || !region) return
  const regionRect = region.getBoundingClientRect()
  let firstVisible = Number.POSITIVE_INFINITY
  for (const row of el.querySelectorAll<HTMLElement>('[data-index]')) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom <= regionRect.top || rect.top >= regionRect.bottom) continue
    const index = Number(row.dataset.index)
    if (Number.isFinite(index)) firstVisible = Math.min(firstVisible, index)
  }
  if (!Number.isFinite(firstVisible)) return
  let current: string | null = null
  for (const tick of turnTicks.value) {
    if (tick.index <= firstVisible) current = tick.id
    else break
  }
  activeTickId.value = current ?? turnTicks.value[0]?.id ?? null
}

function scheduleTickSync(): void {
  if (tickSyncFrame !== null || typeof requestAnimationFrame !== 'function') { syncActiveTick(); return }
  tickSyncFrame = requestAnimationFrame(() => {
    tickSyncFrame = null
    syncActiveTick()
  })
}

watch(turnTicks, scheduleTickSync, { flush: 'post' })

function jumpToTurn(index: number): void {
  scrollerRef.value?.scrollToItem?.(index)
}

function onScroll(event: Event): void {
  const el = event.target as HTMLElement | null
  if (!el) return
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  if (performance.now() <= frameLayoutGraceUntil) {
    // Compensation for a frame box change, not reader intent: it must not
    // unpin the tail or flash the jump pill. A following reader is pulled
    // straight back to the tail; a scrolled-up reader keeps their position
    // (the compensation itself held their viewport stable).
    if (followTail.value) reanchor()
  } else {
    showJump.value = distanceFromBottom > JUMP_THRESHOLD
    followTail.value = distanceFromBottom <= JUMP_THRESHOLD
  }
  scrolledFromTop.value = el.scrollTop > 4
  scheduleTickSync()
}

function jumpToBottom(): void {
  showJump.value = false
  reanchor()
}

function copyUserMessage(id: string, text: string): void {
  if (!text) return
  navigator.clipboard?.writeText(text).catch(() => undefined)
  copiedUserId.value = id
  if (copyResetTimer) clearTimeout(copyResetTimer)
  copyResetTimer = setTimeout(() => {
    copiedUserId.value = null
    copyResetTimer = undefined
  }, 1400)
}

function reanchor(_planDelta?: unknown) {
  // `planDelta` is the height delta from SessionTodoCard's resize; the
  // re-anchor only needs to stick to the tail, so the value is ignored.
  nextTick(() => {
    const streaming = !!props.streamingMessageId
    // A wholesale projection swap (post-turn reload of the message list, a
    // compaction divider) can leave the scroller's internal window stale —
    // DOM-level scrollTo({top: scrollHeight}) then reads a height that no
    // longer matches the scroller's own accounting and new tail items never
    // mount. The scroller's own scrollToBottom re-derives its window, so on
    // the settle path it is the authority; only streaming keeps the raw
    // per-frame jump (scrollToBottom is heavier than a scrollTo per rAF).
    if (!streaming && typeof scrollerRef.value?.scrollToBottom === 'function') {
      scrollerRef.value.scrollToBottom()
      return
    }
    const el = scrollerEl()
    // `scrollTo` is absent in jsdom; fall back to the scroller's own method.
    if (el && typeof el.scrollTo === 'function') {
      // During streaming, `scrollHeight` lags one frame behind the new text
      // (DynamicScroller remeasures via ResizeObserver, which fires after
      // paint). Jumping instantly to the current scrollHeight lets the browser
      // paint the new tail at the right place without a smooth-scroll chase
      // that visibly lags. `behavior: 'auto'` (instant) is correct here: a
      // smooth animation toward a target that moves every frame reads as
      // stutter, not ease.
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
    }
    else scrollerRef.value?.scrollToBottom?.()
  })
}

/** The scroller's scrollable element. vue-virtual-scroller exposes it as the
 *  component root `$el`; the typed handle does not, so reach through safely. */
function scrollerEl(): HTMLElement | null {
  const ref = scrollerRef.value as unknown as { $el?: HTMLElement } | null
  return ref?.$el ?? null
}

// ── ScrollOnLoad (Phase D-19) ─────────────────────────────────────────────────
//
// When a session's history loads asynchronously (switching sessions, first
// load), jump to the bottom *instantly* — kill the top→bottom smooth
// animation that otherwise plays while the messages stream in.
//
// The one-shot is armed by SESSION identity, not `messages` array identity:
// `replaceSessionProjection` swaps the array at every turn end, and a watcher
// on the array treated each of those swaps as a fresh load — snapping a
// scrolled-up reader (e.g. studying a figure while the turn settles) back to
// the bottom. The empty→non-empty transition below still catches the
// same-session async first load (app start, workspace re-open), where no
// session switch ever fires.
let didInitialScroll = false
watch(() => props.sessionId, () => {
  didInitialScroll = false
  ensureInitialScroll()
}, { flush: 'post' })
watch(() => blocks.value.length > 0, (hasContent) => {
  if (hasContent) ensureInitialScroll()
}, { flush: 'post' })

function ensureInitialScroll() {
  if (didInitialScroll || blocks.value.length === 0) return
  didInitialScroll = true
  playHydration()
  nextTick(() => {
    const el = scrollerEl()
    if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'instant' as ScrollBehavior })
    else scrollerRef.value?.scrollToBottom?.()
  })
}

// ── Hydration cascade ─────────────────────────────────────────────────────────
//
// The moment a session's content first appears (cold disk load, session
// switch, first message), rows fade-and-rise in with a small stagger instead
// of popping in as one wall of text. `ensureInitialScroll` is exactly that
// moment (one-shot per session, armed by session identity), so the cascade
// rides it: rows visible at the tail cascade bottom-up, and the window closes
// right after so streaming blocks and scroll-reveals mount without animation.
const HYDRATE_STAGGER_CAP = 8
const HYDRATE_WINDOW_MS = 900
const hydrating = ref(false)
let hydrateTimer: ReturnType<typeof setTimeout> | undefined

/** Distance from the newest block, capped — the visible tail is what the
 *  virtualizer mounts on load, so the cap bounds the cascade to it. */
function staggerFor(index: number): number {
  return Math.max(0, Math.min(blocks.value.length - 1 - index, HYDRATE_STAGGER_CAP))
}

function playHydration(): void {
  hydrating.value = true
  if (hydrateTimer) clearTimeout(hydrateTimer)
  hydrateTimer = setTimeout(() => {
    hydrating.value = false
    hydrateTimer = undefined
  }, HYDRATE_WINDOW_MS)
}

// ── Selection pill ────────────────────────────────────────────────
// ZCode's ask-AI entry: a non-collapsed selection inside this transcript
// floats a pill at the selection's top edge. The pill is fixed-positioned
// (virtualization cannot clip it), re-anchored on every scroll via a capture
// listener (scroll does not bubble), and collapses the selection when clicked
// — the ask has consumed the quote.

const regionEl = ref<HTMLElement | null>(null)
const selectionPill = ref<{ text: string; x: number; y: number } | null>(null)

function refreshSelectionPill(): void {
  if (!props.selectionAsk) { selectionPill.value = null; return }
  const root = regionEl.value
  const sel = document.getSelection()
  if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.anchorNode || !root.contains(sel.anchorNode)) {
    selectionPill.value = null
    return
  }
  // Collapse whitespace runs: a quote spanning line breaks reads as one line.
  const text = sel.toString().replace(/\s+/g, ' ').trim()
  if (!text) { selectionPill.value = null; return }
  const rect = sel.getRangeAt(0).getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) { selectionPill.value = null; return }
  const half = 44
  // The chip renders ABOVE the selection (translate(-50%, -135%)), so a
  // selection on the first visible line lifts it out of the viewport — x is
  // clamped but y must be too, or the one affordance that opens the flow is
  // unreachable exactly where transcripts open (the top line).
  const pillLift = 44
  selectionPill.value = {
    text,
    x: Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8),
    y: Math.max(rect.top, pillLift),
  }
}

function askSelection(): void {
  const pill = selectionPill.value
  if (!pill) return
  emit('ask-selection', pill.text)
  document.getSelection()?.removeAllRanges()
  selectionPill.value = null
}

onMounted(() => {
  document.addEventListener('selectionchange', refreshSelectionPill)
  regionEl.value?.addEventListener('scroll', refreshSelectionPill, { passive: true, capture: true })
  window.addEventListener(FRAME_LAYOUT_SHIFT_EVENT, markFrameLayoutShift)
})
onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', refreshSelectionPill)
  regionEl.value?.removeEventListener('scroll', refreshSelectionPill, { capture: true } as EventListenerOptions)
  window.removeEventListener(FRAME_LAYOUT_SHIFT_EVENT, markFrameLayoutShift)
  selectionPill.value = null
})

onMounted(ensureInitialScroll)
onMounted(scheduleTickSync)

// Clean up every deferred timer/frame on teardown. The component previously
// had no onBeforeUnmount, so a copy's 1400ms reset, the jump-to-response
// pill's 8s autohide, and a pending re-anchor rAF all fired against detached
// refs / unmounted DOM after a page switch or workspace teardown.
onBeforeUnmount(() => {
  if (jumpToResponseTimer) { clearTimeout(jumpToResponseTimer); jumpToResponseTimer = undefined }
  if (copyResetTimer) { clearTimeout(copyResetTimer); copyResetTimer = undefined }
  if (hydrateTimer) { clearTimeout(hydrateTimer); hydrateTimer = undefined }
  if (rowEnterTimer) { clearTimeout(rowEnterTimer); rowEnterTimer = undefined }
  if (tickSyncFrame !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(tickSyncFrame)
    tickSyncFrame = null
  }
  if (reanchorFrame !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(reanchorFrame)
    reanchorFrame = null
  }
})

// ── "Jump to start of response" pill (Phase D-19) ────────────────────────────
//
// When a turn settles (streamingMessageId goes from set → null) while the user
// is scrolled away from the tail, surface a pill that jumps back to the start
// of the just-finished assistant reply. Auto-dismisses after 8s (palot). The
// "start of response" is the message id that was streaming — captured before
// the null transition lands.
const JUMP_TO_RESPONSE_AUTOHIDE_MS = 8000
const showJumpToResponse = ref(false)
const responseStartMessageId = ref<string | null>(null)
let jumpToResponseTimer: ReturnType<typeof setTimeout> | undefined
watch(() => props.streamingMessageId, (now, prev) => {
  // Capture the id of the assistant message that was streaming, then surface
  // the pill the moment streaming ends — but only if the user is scrolled up
  // (the pill would be noise if they are already at the tail).
  if (prev && !now) {
    responseStartMessageId.value = prev
    if (!followTail.value) {
      showJumpToResponse.value = true
      if (jumpToResponseTimer) clearTimeout(jumpToResponseTimer)
      jumpToResponseTimer = setTimeout(() => { showJumpToResponse.value = false }, JUMP_TO_RESPONSE_AUTOHIDE_MS)
    }
  } else if (now) {
    // A new turn started: hide the pill from the previous turn.
    showJumpToResponse.value = false
    if (jumpToResponseTimer) clearTimeout(jumpToResponseTimer)
  }
})

function jumpToResponseStart() {
  const id = responseStartMessageId.value
  showJumpToResponse.value = false
  if (jumpToResponseTimer) clearTimeout(jumpToResponseTimer)
  if (!id) return
  nextTick(() => {
    const el = rowEls.get(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

watch(() => blocks.value.length, () => {
  if (followTail.value) reanchor()
})

// Streaming appends tokens *inside* an existing block, so the block count
// does not change and the watcher above never fires — during a long streamed
// answer the view would stay put. Re-anchor on the streaming message's text
// growth instead, rAF-throttled (deltas can arrive faster than frames), and
// only while the user is following the tail — a scrolled-up user keeps their
// reading position.
//
// NOTE: assistant messages carry `blocks` (not `content`); streaming appends to
// the last text block's `.text`. Summing text-block lengths tracks real growth.
const streamingContentLength = computed(() => {
  const id = props.streamingMessageId
  if (!id) return 0
  const msg = props.messages.find((m) => m.id === id)
  if (!msg) return 0
  // User messages carry content; assistant messages carry blocks.
  if (msg.content) return msg.content.length
  return (msg.blocks ?? [])
    .filter((b) => b.type === 'text')
    .reduce((sum, b) => sum + (b as { text: string }).text.length, 0)
})
let reanchorFrame: ReturnType<typeof requestAnimationFrame> | null = null
watch(streamingContentLength, () => {
  if (!followTail.value || reanchorFrame !== null) return
  if (typeof requestAnimationFrame !== 'function') { reanchor(); return }
  reanchorFrame = requestAnimationFrame(() => {
    reanchorFrame = null
    if (followTail.value) reanchor()
  })
})

defineExpose({ blocks })
</script>

<style scoped>
/* The region is the flex child the dock sizes; the scroller takes what is
   left after the pinned plan card, so the card never scrolls away and the
   transcript's own scroll position is unaffected by plan updates. */
.transcript-region {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  /* Tonal layering pilot (Direction A: hierarchy by luminance steps, not hairlines):
     the transcript sits ONE luminance step UP from the shell (mantle → base),
     so the content "wells up" out of the page and no border is needed to
     separate it from the SessionBar above or the Composer below. The same
     variable feeds the scroll-fade masks so they dissolve into exactly the
     surface the scroller paints. */
  --transcript-bg: var(--color-bg);
  background: var(--transcript-bg);
}

/* The ambient backdrop layer: below the scroller (which sits at
   --z-content) and the fade masks, above the region's own surface. */
.transcript-region__backdrop {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
}

.transcript {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* Windows/Chromium classic scrollbars are not overlays: the first
     appearance would shift all content ~8px. Stable gutter reserves the
     space up front (also on DocumentGroup/NavigatorPanel scrollers). */
  scrollbar-gutter: stable;
  /* The virtualizer is the ONLY scrollTop compensator here: it adjusts for
     size changes above the viewport itself, so the browser's native scroll
     anchoring would double-compensate the same change — the overshoot read
     as the scroll jumping backward over embedded HTML figures. Same rule
     ZCode's timeline sets (overflowAnchor: none on its content column). */
  overflow-anchor: none;
  /* Right padding absorbs the ActivityCapsule's inset when its card is open
     (--capsule-inset, set by AgentPage on the conversation column). Default 0
     so the transcript is full-width when the capsule is collapsed.
     Bottom padding clears the floating Composer card: the Composer is
     position:absolute over the transcript's bottom edge, so without enough
     scroll padding the last lines disappear under the card. --composer-clear
     (set by AgentPage, ~the card's resting height) reserves that space so
     content can scroll fully into view above the card. Default falls back to a
     safe constant if the var is absent (e.g. in isolation/tests). */
  padding: var(--space-4) calc(var(--space-3) + var(--capsule-inset, 0px)) var(--composer-clear, 140px) var(--space-3);
  /* No padding transition: the capsule inset/composer clearance are layout
     properties, animating layout is banned (VISUAL-ROLLOUT-PLAN §1.3), and
     transform can't express an inset — so the padding change applies
     instantly. */
  /* The scroll-fade masks are siblings layered over the scroller; the
     scroller's own content scrolls underneath them. */
  position: relative;
  z-index: var(--z-content);
}

/* Scroll-fade masks (Phase D-19). Pointer-events: none so they never block a
   scroll-drag; they paint only when there is content beyond that edge. */
.transcript__fade {
  position: absolute;
  left: 0;
  right: 0;
  height: 24px;
  pointer-events: none;
  z-index: var(--z-seam);
  opacity: 0;
  transition: opacity var(--dur-normal) var(--ease-out);
}
.transcript__fade--top {
  top: 0;
  background: linear-gradient(to bottom, var(--transcript-bg) 0%, transparent 100%);
}
.transcript__fade--bottom {
  bottom: 0;
  background: linear-gradient(to top, var(--transcript-bg) 0%, transparent 100%);
}
/* Only paint the mask where there is something to scroll toward. */
.transcript-region.is-scrolled-from-top .transcript__fade--top { opacity: 1; }
.transcript-region.is-scrolled-from-bottom .transcript__fade--bottom { opacity: 1; }

.transcript__row {
  /* Centered fixed-width column (openhanako's --chat-column-width pattern):
     on ultrawide screens the markdown no longer stretches edge-to-edge, and
     the user/assistant rhythm reads at a comfortable measure. Narrow viewports
     get the full width. */
  max-width: var(--chat-column-width, 720px);
  margin: 0 auto;
  width: 100%;
  padding: 0 var(--space-1);
}

/* Hydration cascade: while the window is open (content just arrived for this
   session), rows fade-and-rise bottom-up — the tail (what the user is
   reading) lands first, earlier rows follow. transform/opacity only, so the
   virtualizer's height measurements are untouched. */
.transcript--hydrating .transcript__row {
  animation: transcript-hydrate var(--dur-slow) var(--ease-out) both;
  animation-delay: calc(var(--row-stagger, 0) * 45ms);
}
@keyframes transcript-hydrate {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Live row entrance: a block appended while the user watches (sent message,
   a new turn's act, a compaction divider) eases in once — the chat's "flow"
   beat. Gated by the enteringIds set (see the blocks watch), so virtualizer
   scroll-remounts and the settle-time projection swap never replay it.
   transform/opacity only, per the virtualization contract. */
.transcript__row--enter {
  animation: transcript-row-in var(--dur-slow, 220ms) var(--ease-out, ease-out) both;
}
@keyframes transcript-row-in {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* History-loading skeleton: a quiet stand-in in the same reading column —
   one user bubble block, then assistant-rhythm lines, shimmering. */
.transcript__loading {
  max-width: var(--chat-column-width, 720px);
  margin: 0 auto;
  padding: var(--space-4) var(--space-1);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.transcript__loading-hint {
  color: var(--color-text-muted, var(--color-text-muted));
  font-size: var(--text-label);
}
.transcript__skeleton {
  height: 14px;
  border-radius: var(--radius-xs);
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--color-text) 7%, transparent) 30%,
    color-mix(in srgb, var(--color-text) 14%, transparent) 50%,
    color-mix(in srgb, var(--color-text) 7%, transparent) 70%
  );
  background-size: 200% 100%;
  animation: transcript-skeleton 1.4s ease-in-out infinite;
}
.transcript__skeleton--user {
  align-self: flex-end;
  width: 42%;
  height: 34px;
  border-radius: var(--radius-md);
}
@keyframes transcript-skeleton {
  from { background-position: 200% 0; }
  to   { background-position: -200% 0; }
}

.transcript__user {
  display: flex;
  justify-content: flex-end;
  padding: var(--space-2) 0;
}

/* Compaction divider: hairlines reaching both edges of the reading column
   with a centered, quiet label. The quietest voice on the page on purpose —
   it marks that history got shorter, it is not an event to read. */
.transcript__compaction {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) 0;
  color: var(--color-text-muted);
  font-size: var(--text-label);
  line-height: 1;
  white-space: nowrap;
}

.transcript__compaction-line {
  flex: 1;
  height: var(--line-w);
  background: var(--line-hairline);
}

.transcript__compaction-tokens {
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

/* Live compaction: same divider geometry as the settled marker, plus the
   working dots. Pinned over the composer clearance like the live-tail pill,
   centered on the reading column so the hard-swap into the settled divider
   (a scroller row in the same column) reads as one continuous element. */
.transcript__compaction--live {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(var(--composer-clear, 140px) + var(--space-4));
  z-index: var(--z-elevated);
  width: min(100%, var(--chat-column-width, 720px));
  margin-top: 0;
  color: var(--color-text-secondary);
}

.transcript__compaction--live .transcript__livetail-dots i {
  background: var(--color-primary);
}

.transcript__user-bubble {
  position: relative;
  max-width: 85%;
  padding: var(--space-2) var(--space-3);
  /* Uniform radius: flat borderless bubble, the modern chat idiom — the old
     2px pinched corner read as a dated speech-balloon tail. */
  border-radius: var(--radius-md);
  /* A solid same-temperature tint, not the translucent soft token over the
     rosewater-warm hover border it used to pair with — that mix read as mud.
     10% celadon into the paper base keeps one voice and enough separation
     from both the transcript surface and the assistant side. */
  background: color-mix(in srgb, var(--color-primary) 10%, var(--color-bg));
  border: none;
  color: var(--color-text);
  font-size: var(--text-md);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.transcript__user-text {
  /* Inline so the copy button can float at the bubble's bottom-right. */
  display: inline;
}

.transcript__user-copy {
  position: absolute;
  right: 6px;
  bottom: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: currentColor;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.transcript__user-copy--visible {
  opacity: 0.6;
}
/* Keyboard parity: the copy button is reachable by Tab, so reveal it when
   focus lands inside the bubble, matching the hover-driven --visible state. */
.transcript__user-bubble:focus-within .transcript__user-copy {
  opacity: 0.6;
}
.transcript__user-copy--visible:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
}
.transcript__user-cancelled--failed {
  color: color-mix(in srgb, var(--status-failed) 70%, var(--color-text-muted));
  border-color: color-mix(in srgb, var(--status-failed) 30%, var(--line-hairline));
}

.transcript__user-cancelled {
  display: inline-block;
  margin-left: var(--space-2);
  padding: 0 var(--space-1-5);
  font-size: 0.62rem;
  line-height: 1.5;
  color: var(--color-text-muted);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-xs);
  white-space: nowrap;
  vertical-align: 1px;
}

.transcript__user-copy--copied {
  opacity: 1;
  color: var(--color-success, var(--color-primary));
}

/* Conversation bookmark rail — one tick per user turn at the left edge,
   the viewport-top turn lit bright, click jumps. The scroller reserves the
   rail's width via extra left padding (stable, set when the rail exists at
   all — never toggling mid-scroll), so ticks never sit under text. */
.transcript-region--tickrail .transcript {
  padding-left: calc(var(--space-3) + 30px);
}
.transcript__tickrail {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  max-height: 72%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  padding-left: 6px;
  z-index: var(--z-float);
}
.transcript__tick {
  /* A 16×12 hit area whose visible bar is the 16×2 content box
     (background-clip: content-box) — small mark, comfortable target. */
  appearance: none;
  border: none;
  padding: 5px 0;
  width: 16px;
  background-color: var(--color-border);
  background-clip: content-box;
  border-radius: 1px;
  cursor: pointer;
  transition: width var(--dur-fast, 120ms) var(--ease-out, ease-out), background-color var(--dur-fast, 120ms) var(--ease-out, ease-out);
}
.transcript__tick:hover {
  background-color: var(--color-text-muted);
}
.transcript__tick--active {
  width: 24px;
  background-color: var(--color-text);
}

/* Scroll-to-bottom pill. Anchored bottom-RIGHT, just above the floating
   Composer's clearance (VSCode's scroll-to-bottom convention): the composer
   card now shares the centered reading column, so a bottom-center pill would
   land ON the card — and on the live-tail pill, which owns that center spot
   while a turn is waiting. 36px circle, restrained shadow + border. */
.transcript__jump {
  position: absolute;
  bottom: calc(var(--composer-clear, 140px) + var(--space-4));
  right: var(--space-3);
  z-index: var(--z-float);
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-lg);
  background: var(--elev-2-bg, var(--color-bg));
  color: var(--color-text-muted, var(--color-text-muted));
  box-shadow: var(--elev-2);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
/* "Jump to start of response" carries a label, so it is a pill not a circle. */
.transcript__jump--to-response {
  width: auto;
  padding: 0 var(--space-2-5);
  height: 30px;
  font-size: var(--text-label);
}
.transcript__jump-label {
  white-space: nowrap;
}
.transcript__jump:hover {
  color: var(--color-primary);
  border-color: color-mix(in srgb, var(--color-primary) 40%, var(--line-seam));
}
.transcript__jump:focus-visible {
  outline: 2px solid var(--color-ring, var(--color-ring));
  outline-offset: 2px;
}

/* ── Live tail (phase `waiting`) ───────────────────────────────────────────────
   A quiet pill pinned just above the floating Composer: three celadon dots
   breathing in sequence + the working label. The breathing is a pure-CSS
   opacity/scale stagger — no timers, no re-renders. */
.transcript__livetail {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(var(--composer-clear, 140px) + var(--space-4));
  z-index: var(--z-elevated);
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2-5);
  border-radius: var(--radius-lg);
  background: var(--elev-2-bg, var(--color-bg));
  box-shadow: var(--shadow-sm);
  color: var(--color-text-muted);
  font-size: var(--text-label);
  pointer-events: none;
}
.transcript__livetail-dots {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.transcript__livetail-dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-live);
  animation: livetail-breathe 1.2s var(--ease-out) infinite;
}
.transcript__livetail-dots i:nth-child(2) { animation-delay: 150ms; }
.transcript__livetail-dots i:nth-child(3) { animation-delay: 300ms; }
@keyframes livetail-breathe {
  0%, 100% { opacity: 0.25; transform: scale(0.85); }
  40%      { opacity: 1;    transform: scale(1); }
}
/* Selection pill: quiet identity pill at the selection's top edge — the
   interact voice (the app's "this is a link-like action" pair), fixed so
   virtualization can't clip it. mousedown is prevented so clicking never
   collapses the selection before the ask reads it. */
.transcript__ask-pill {
  position: fixed;
  transform: translate(-50%, -135%);
  z-index: var(--z-floating);
  padding: 3px 10px;
  border: var(--line-w) solid color-mix(in srgb, var(--color-interact) 35%, transparent);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-interact-text);
  font-size: var(--text-label);
  line-height: 1.5;
  cursor: pointer;
  box-shadow: var(--shadow-md);
}
.transcript__ask-pill:hover {
  background: var(--color-interact-soft);
}
.transcript__ask-pill:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}

.transcript__livetail-label {
  white-space: nowrap;
}

.live-tail-enter-active { transition: opacity var(--dur-normal) var(--ease-out), transform var(--dur-normal) var(--ease-out); }
.live-tail-leave-active { transition: opacity var(--dur-fast) var(--ease-in), transform var(--dur-fast) var(--ease-in); }
.live-tail-enter-from,
.live-tail-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(4px);
}

.jump-fade-enter-active {
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.jump-fade-leave-active {
  transition: opacity var(--dur-fast) var(--ease-in);
}
.jump-fade-enter-from,
.jump-fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@media (prefers-reduced-motion: reduce) {
  .transcript__user-copy,
  .transcript__jump,
  .transcript__tick {
    transition: none;
  }
  /* History arrives without the cascade; the skeleton holds still. */
  .transcript--hydrating .transcript__row {
    animation: none;
  }
  /* The live entrance likewise: the block simply appears. */
  .transcript__row--enter {
    animation: none;
  }
  .transcript__skeleton {
    animation: none;
  }
  .jump-fade-enter-active,
  .jump-fade-leave-active {
    transition: opacity var(--dur-instant);
  }
  .jump-fade-enter-from,
  .jump-fade-leave-to {
    transform: translateY(0);
  }
  /* The live tail keeps its presence, drops the motion. */
  .transcript__livetail-dots i {
    animation: none;
    opacity: 0.7;
  }
  .live-tail-enter-active,
  .live-tail-leave-active {
    transition: opacity var(--dur-instant);
  }
  .live-tail-enter-from,
  .live-tail-leave-to {
    transform: translateX(-50%);
  }
}
</style>
