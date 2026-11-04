<!--
  Composer — the Agent's input card.

  A rounded surface holding the autosizing textarea above a two-cluster toolbar.
  The toolbar carries only the per-turn controls that are high-frequency and
  belong next to the action that consumes them: Authority (whether side
  effects need approval). The Mindset switch lives one level up, centered in
  the SessionBar — it is a product-level choice, not a composer setting.
  The low-frequency runtime config — model (via the SessionBar's model
  picker), reasoning effort, context-window readout — lives in the
  `agent-settings` drawer, so the toolbar stays quiet.

  The `@`/`$`/`/` mention pickers live inside SlashInput; this component only
  frames them. `skills` is forwarded unchanged so the `$` picker's skill
  candidates stay live.

  Images ride two entries into the same recognition path
  (electron/agent/image-attachment.ts → base64 into the model for vision
  models): `@file:<path>` mentions for files already in the workspace, and the
  📎 / drag-drop attach flow here. Attached images stay OUT of the textarea —
  they are thumbnail chips only, and their `[attached_image: <rel>]` markers
  are composed into the message at send time. The transcript renders those
  markers as workspace embeds (markdown.ts), so the user sees the image they
  sent while the model receives the pixels.
-->
<template>
  <div class="composer" :class="{ 'composer--viz-on': settings.inlineVisualization }">
    <div
      class="composer__card"
      :class="{ 'composer__card--busy': busy, 'composer__card--dragging': dragging }"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <!-- Lit-mode sparkles: a handful of CSS-only stars drifting up the
           card's input band. Their own layer clips them to the card, so the
           SlashInput dropdown (a sibling) is never clipped. Reduced-motion
           parks them. -->
      <span v-if="settings.inlineVisualization" class="composer__sparkles" aria-hidden="true">
        <i v-for="n in 9" :key="n" class="composer__sparkle" :style="{ '--i': n }" />
      </span>
      <!-- Credential gate: the ACTIVE provider has no usable key — a send
           would die on the provider call, so it is paused (Send disabled,
           Enter refused) and this strip carries the one action that fixes
           it. Executing, not describing: the button hands the host an
           event, the host opens Settings on the providers section. -->
      <div v-if="credentialMissing" class="composer__credential" role="status">
        <span class="composer__credential-text">{{ t('agent.composer.credentialNotice') }}</span>
        <button type="button" class="composer__credential-action" @click="emit('configure-model')">
          {{ t('agent.composer.credentialAction') }}<span class="composer__credential-arrow" aria-hidden="true">→</span>
        </button>
      </div>
      <div class="composer__textarea-row">
        <SlashInput
          ref="slashInputRef"
          :model-value="modelValue"
          :placeholder="t('agent.composer.placeholder')"
          :commands="commands"
          :skills="skills"
          :mcp-servers="mcpServers"
          @update:model-value="emit('update:modelValue', $event)"
          @send="onSend"
          @slash="(name, args) => emit('slash', name, args)"
        />
      </div>

      <!-- Queued typed-ahead messages: sent into a busy session, they wait as
           chips here and run FIFO as the session's turns settle. The
           transcript does NOT show them yet — they enter it only when their
           turn actually starts (the event log is the record, not the queue). -->
      <div v-if="queued.length > 0" class="composer__queued" :aria-label="t('agent.composer.queued')">
        <span class="composer__queued-label">{{ t('agent.composer.queued') }}</span>
        <span v-for="(item, index) in queued" :key="`${index}-${item}`" class="composer__queued-chip">
          <span class="composer__queued-text">{{ item }}</span>
          <button
            type="button"
            class="composer__chip-x"
            :title="t('agent.composer.dequeue')"
            :aria-label="t('agent.composer.dequeue')"
            @click="emit('dequeue', index)"
          >×</button>
        </span>
      </div>

      <!-- Attached-image chips: the textarea never carries the markers — the
           chips are the only representation, and onSend composes their
           markers into the outgoing message. The notes tell the user what
           was ignored and whether the bound model can see images at all. -->
      <div v-if="attachedFiles.length > 0 || rejectedCount > 0" class="composer__attachments">
        <span v-for="att in attachedFiles" :key="att.relPath" class="composer__chip">
          <img class="composer__chip-thumb" :src="att.previewUrl" :alt="att.name" loading="lazy" decoding="async">
          <span class="composer__chip-name">{{ att.name }}</span>
          <button
            type="button"
            class="composer__chip-x"
            :title="t('agent.composer.removeAttachment')"
            :aria-label="t('agent.composer.removeAttachment')"
            @click="removeAttachment(att)"
          >×</button>
        </span>
        <span v-if="rejectedCount > 0" class="composer__chip-note">{{ t('agent.composer.attachRejected', { count: rejectedCount }) }}</span>
        <span v-if="attachedFiles.length > 0 && !modelSupportsImages" class="composer__chip-note composer__chip-note--warn">{{ t('agent.composer.attachedNoVision') }}</span>
      </div>

      <div class="composer__toolbar">
        <!-- Left cluster: what the next turn is ALLOWED to do — attach images,
             the permission axis, the mindset axis. Behavior switches only. -->
        <div class="composer__actions">
          <!-- The attach flow is dock-optional: the sidebar omits the upload
               UI entirely (dock is for steering, not for feeding files). -->
          <template v-if="attachments">
            <button
              type="button"
              class="composer__attach"
              :title="t('agent.composer.attach')"
              :aria-label="t('agent.composer.attach')"
              @click="attachInputRef?.click()"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <input
              ref="attachInputRef"
              type="file"
              class="composer__attach-input"
              accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
              multiple
              @change="onAttachPicked"
            >
          </template>
          <PermissionModeButton :model-value="authority" @update:model-value="emit('update:authority', $event)" />
        </div>

        <!-- Right cluster: how the turn RUNS — reasoning effort + context
             gauge readouts, then the round send/stop at the far edge. The
             hint shows only the two real, non-conflicting input behaviours
             (Enter sends, Shift+Enter inserts a newline) — both are handled
             inside SlashInput and never conflict with browser/OS shortcuts.
             Global page shortcuts (session nav etc.) are intentionally NOT
             advertised here: several collided with browser defaults (Ctrl+L,
             Ctrl+N) and one (Ctrl+K) was never wired on this surface. -->
        <div class="composer__controls">
          <!-- The hint names what Enter DOES right now: send on an idle
               session, queue on a busy one. Both are handled inside
               SlashInput and never conflict with browser/OS shortcuts. -->
          <span class="composer__hint">{{ busy ? t('agent.composer.hintQueued') : t('agent.composer.hint') }}</span>
          <!-- Inline-visual answers: one star, hollow when off and lit when
               on. State is read at dispatch and frozen into that turn's
               prompt; toggling later never rewrites an assembled turn. The
               lit state also dresses the whole composer (aurora border +
               drifting sparkles) so the answering mode is visible at a
               glance, not just remembered. -->
          <button
            type="button"
            class="composer__viz"
            :class="{ 'is-on': settings.inlineVisualization }"
            :aria-pressed="settings.inlineVisualization"
            :title="t('agent.composer.inlineVizTitle')"
            :aria-label="t('agent.composer.inlineVizTitle')"
            @click="settings.setInlineVisualization(!settings.inlineVisualization)"
          >
            <Star :size="16" :stroke-width="1.5" aria-hidden="true" />
          </button>
          <select
            class="composer__thinking"
            :value="thinkingLevel"
            :aria-label="t('agent.thinking.effortTitle')"
            :title="t('agent.thinking.effortTitle')"
            @change="onThinkingChange"
          >
            <option v-if="thinkingLevel === 'off'" value="off" disabled>{{ t('agent.thinking.level.off') }}</option>
            <option v-for="lvl in THINKING_LEVELS" :key="lvl.value" :value="lvl.value">{{ t(lvl.labelKey) }}</option>
          </select>
          <!-- Context-window readout: a quiet always-on gauge of how full the
               bound model's context is, sitting just left of Send so it is
               visible while composing. Hover/click opens the rich
               ContextUsagePanel (capacity bar, cache hit rates, usage
               windows) — the title tooltip remains for keyboard/AT users.
               Genuinely always-on: its existence must not depend on having a
               computed usage yet (a session switch, a fresh session, or turns
               that never settled report 0) — the gauge shows 0 / total until
               data lands, instead of popping in and out of the toolbar. -->
          <span
            class="composer__ctx-wrap"
            @mouseenter="openCtxPanel"
            @mouseleave="closeCtxPanel"
            @click="toggleCtxPanel"
          >
            <span
              role="img"
              class="composer__ctx"
              :class="[`composer__ctx--${ctxTone}`, { 'composer__ctx--open': ctxPanelOpen }]"
              :title="ctxTooltip"
              :aria-label="ctxTooltip"
            >
              <svg class="composer__ctx-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <circle class="composer__ctx-track" cx="7" cy="7" r="5.5" fill="none" stroke-width="2" />
                <circle
                  class="composer__ctx-fill"
                  cx="7" cy="7" r="5.5" fill="none" stroke-width="2"
                  stroke-linecap="round"
                  :stroke-dasharray="ctxRingDash"
                  transform="rotate(-90 7 7)"
                />
              </svg>
              <span class="composer__ctx-text">{{ ctxUsedLabel }}<span class="composer__ctx-sep"> / </span>{{ ctxTotalLabel }}</span>
            </span>
            <Transition name="ctx-panel">
              <ContextUsagePanel
                v-if="ctxPanelOpen"
                class="composer__ctx-panel"
                :tokens="ctxTokens"
                :window-size="ctxTotal || undefined"
                :last-hit-rate="ctxCacheHitRate"
              />
            </Transition>
          </span>
          <AppButton
            v-if="!busy"
            variant="primary"
            size="sm"
            class="composer__send"
            :disabled="!canSend"
            :aria-label="t('agent.composer.send')"
            :title="t('agent.composer.send')"
            @click="onSend(modelValue)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </AppButton>
          <!-- Busy with text in the input: enqueue (plus) sits beside stop —
               Enter already enqueues, this is the same action for pointers. -->
          <AppButton
            v-if="busy && canSend"
            variant="primary"
            size="sm"
            class="composer__enqueue"
            :aria-label="t('agent.composer.enqueue')"
            :title="t('agent.composer.enqueue')"
            @click="onSend(modelValue)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 5v14" />
              <path d="m19 12-7 7-7-7" />
            </svg>
          </AppButton>
          <AppButton
            v-if="busy"
            variant="danger"
            size="sm"
            class="composer__stop"
            :aria-label="t('agent.composer.stop')"
            :title="t('agent.composer.stopTitle')"
            @click="emit('stop')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
            </svg>
          </AppButton>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref, onBeforeUnmount } from 'vue'
import AppButton from '@/components/primitives/AppButton.vue'
import ContextUsagePanel from './ContextUsagePanel.vue'
import SlashInput from './SlashInput.vue'
import PermissionModeButton, { type PermissionMode } from './PermissionModeButton.vue'
import { useComposerAttachments } from './useComposerAttachments'
import { useI18n } from 'vue-i18n'
import { Star } from '@lucide/vue'
import { useSettingsStore } from '@/stores/settings'
import type { SlashCommand } from '@/types'
import type { ThinkingLevel } from '@/contracts/agent-runtime'
import { AGENT_TURN_READOUT, formatTokensK as formatK } from './turnReadout'

const props = withDefaults(defineProps<{
  modelValue: string
  commands?: SlashCommand[]
  busy?: boolean
  /** Typed-ahead messages waiting for the busy session's turns to settle. */
  queued?: ReadonlyArray<string>
  authority?: PermissionMode
  /** Reasoning effort for the next turn. Five levels (no 'off'). */
  thinkingLevel?: ThinkingLevel
  /** Live Pi-session skills, forwarded to SlashInput's $-mention picker. */
  skills?: ReadonlyArray<{ name: string; description?: string }>
  mcpServers?: ReadonlyArray<string>
  /** Image-attach affordances (button, picker, drop). The dock omits them. */
  attachments?: boolean
  /** The active provider has no usable credential (settings store's single
   * configured rule). Send is paused and the credential strip shows; the
   * host owns the fixing navigation (`configure-model`). */
  credentialMissing?: boolean
}>(), {
  commands: () => [],
  busy: false,
  attachments: true,
  credentialMissing: false,
  queued: () => [],
  authority: 'auto',
  thinkingLevel: 'medium',
  skills: () => [],
  mcpServers: () => [],
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  send: [message: string]
  stop: []
  /** Remove one queued message by position (the chip's ×). */
  dequeue: [index: number]
  slash: [name: string, args: string]
  'update:authority': [value: PermissionMode]
  'update:thinkingLevel': [value: ThinkingLevel]
  /** The credential strip's action: open Settings on the providers section. */
  'configure-model': []
}>()

const { t } = useI18n()
const settings = useSettingsStore()
const slashInputRef = ref<InstanceType<typeof SlashInput> | null>(null)

// ── Image attach flow (📎 / drag-drop) ──────────────────────────────────────
// Chips carry thumbnails; the [attached_image: <rel>] markers never enter the
// textarea — onSend composes them into the outgoing message.
const attachInputRef = ref<HTMLInputElement | null>(null)
const {
  attachments: attachedFiles,
  rejectedCount,
  dragging,
  acceptFiles,
  remove: removeAttachment,
  composeMarkers,
  clear: clearAttachments,
} = useComposerAttachments()
// Provided by AgentPage (AGENT_TURN_READOUT); false until a model binds — the
// warn note on chips mirrors the old attach flow's semantics.

/** Only real file drags light up the drop affordance — text/URI drags pass. */
function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}
function onDragOver(event: DragEvent): void {
  if (!props.attachments) return
  if (!isFileDrag(event)) return
  event.preventDefault()
  dragging.value = true
}
function onDragLeave(event: DragEvent): void {
  if (!isFileDrag(event)) return
  dragging.value = false
}
function onDrop(event: DragEvent): void {
  if (!props.attachments || !isFileDrag(event)) return
  event.preventDefault()
  dragging.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length > 0) void acceptFiles(files)
}
function onAttachPicked(): void {
  const files = Array.from(attachInputRef.value?.files ?? [])
  attachInputRef.value!.value = ''
  if (files.length > 0) void acceptFiles(files)
}

/** Send composes the chips' markers onto the message (one newline-separated
   `[attached_image: …]` per chip, after the text) and starts the composer
   clean. The transcript renders the markers as workspace embeds; the Node
   side resolves them to model-visible pixels for vision models.
   The credential gate refuses here too: Enter inside SlashInput emits
   `send` through this handler, and a refused send must keep the draft in
   the textarea — not become a turn that dies on the provider call. */
function onSend(message: string): void {
  if (props.credentialMissing) return
  const markers = composeMarkers()
  emit('send', markers ? `${message}\n${markers}` : message)
  clearAttachments()
}

// Empty input disables Send visually. The handler already refuses empty
// messages; this just makes the button's state match that truth. A missing
// credential gates the same way — the strip above names why.
const canSend = computed(() => props.modelValue.trim().length > 0 && !props.credentialMissing)

// Context-window readout: the same live projection the agent-settings drawer
// reads. Provided by AgentPage, so Composer needs no new props. Null outside
// the provide scope (tests) — the pill simply stays absent. The window is
// unknown until a model is bound: then the total shows "—" and the ring stays
// empty — a fabricated 200k denominator would make the percentage a lie.
const readout = inject(AGENT_TURN_READOUT, null)
// Whether the bound model declares image input — gates the chips' warn note.
const modelSupportsImages = computed(() => readout?.modelSupportsImages.value ?? false)
// `null` occupancy = unknown (post-compaction / never bound): the ring renders
// empty and the label "—" — never a fabricated 0 or a stale settlement sum.
const ctxTokens = computed<number | null>(() => readout?.contextTokensUsed.value ?? null)
const ctxCacheHitRate = computed<number | null>(() => readout?.contextCacheHitRate.value ?? null)
const ctxTotal = computed(() => {
  const w = readout?.contextWindow.value
  return w && w > 0 ? w : null
})
const ctxPct = computed(() => ctxTotal.value && ctxTokens.value != null ? Math.min(100, Math.round((ctxTokens.value / ctxTotal.value) * 100)) : 0)
const ctxTone = computed<'neutral' | 'warning' | 'danger'>(() => {
  // PI-Desktop's remaining-based levels, restated on used: warning at ≤25%
  // free, critical at ≤10% free.
  if (ctxPct.value >= 90) return 'danger'
  if (ctxPct.value >= 75) return 'warning'
  return 'neutral'
})

// ── Context panel (hover/click popover) ──────────────────────────────────────
// Hover opens after a short intent delay, leave closes; click toggles for
// pointer and keyboard users (the panel itself stops click propagation so a
// click inside never toggles it closed).
const ctxPanelOpen = ref(false)
let ctxHoverTimer: ReturnType<typeof setTimeout> | null = null

function openCtxPanel() {
  if (ctxHoverTimer) clearTimeout(ctxHoverTimer)
  ctxHoverTimer = setTimeout(() => { ctxPanelOpen.value = true }, 180)
}
function closeCtxPanel() {
  if (ctxHoverTimer) { clearTimeout(ctxHoverTimer); ctxHoverTimer = null }
  ctxPanelOpen.value = false
}
function toggleCtxPanel() {
  if (ctxHoverTimer) { clearTimeout(ctxHoverTimer); ctxHoverTimer = null }
  ctxPanelOpen.value = !ctxPanelOpen.value
}
onBeforeUnmount(() => {
  if (ctxHoverTimer) clearTimeout(ctxHoverTimer)
})
const ctxUsedLabel = computed(() => ctxTokens.value == null ? '—' : formatK(ctxTokens.value))
const ctxTotalLabel = computed(() => ctxTotal.value ? formatK(ctxTotal.value) : '—')
const ctxCacheLabel = computed(() => {
  const hit = ctxCacheHitRate.value
  return hit == null ? null : `${Math.round(hit * 100)}%`
})
const ctxTooltip = computed(() => {
  const base = ctxTokens.value == null
    ? ctxTotal.value
      ? `— / ${ctxTotalLabel.value} ${t('agent.composer.ctxTokens')}`
      : t('agent.composer.ctxUnknown')
    : ctxTotal.value
      ? `${ctxUsedLabel.value} / ${ctxTotalLabel.value} ${t('agent.composer.ctxTokens')} (${ctxPct.value}%)`
      : `${ctxUsedLabel.value} ${t('agent.composer.ctxTokens')}`
  const cache = ctxCacheLabel.value
  return cache ? `${base} · ${t('agent.composer.ctxCache')} ${cache}` : base
})
// Ring geometry: a 14px circle of radius 5.5; the fill arc length is the used
// fraction of the circumference (0 when the window is unknown).
const CTX_CIRC = 2 * Math.PI * 5.5
const ctxRingDash = computed(() => `${(ctxPct.value / 100) * CTX_CIRC} ${CTX_CIRC}`)

// Reasoning-effort selector (the composer's left cluster). Five levels — 'off'
// is deliberately absent; a session whose store still holds 'off' (set in the
// settings drawer) shows a disabled placeholder so the select never lies.
const THINKING_LEVELS: ReadonlyArray<{ value: ThinkingLevel; labelKey: string }> = [
  { value: 'low', labelKey: 'agent.thinking.level.low' },
  { value: 'medium', labelKey: 'agent.thinking.level.medium' },
  { value: 'high', labelKey: 'agent.thinking.level.high' },
  { value: 'xhigh', labelKey: 'agent.thinking.level.xhigh' },
  { value: 'max', labelKey: 'agent.thinking.level.max' },
]
function onThinkingChange(event: Event): void {
  emit('update:thinkingLevel', (event.target as HTMLSelectElement).value as ThinkingLevel)
}

defineExpose({ focus: () => (slashInputRef.value as unknown as { focus?: () => void } | null)?.focus?.() })
</script>

<style scoped>
.composer {
  /* The card floats on the transcript surface (tonal layering pilot): the
     transcript has stepped up to --ctp-base, and the Composer rises one more
     elevation level above it — no divider line anywhere. */
  padding: var(--space-2) var(--space-3) var(--space-3);
  background: transparent;
}

.composer__card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  /* The primary control of the surface reads as a floating object resting on
     the transcript, not a boxed strip: elevation-level-2 background + shadow,
     no border. On light themes the separation is carried by the shadow; on
     dark themes --elev-2-bg is a lighter surface0-derived tone, so the
     luminance step does the work the hairline used to do. */
  background: var(--elev-2-bg);
  border: none;
  border-radius: var(--radius-lg);
  padding: var(--space-2) var(--space-3);
  box-shadow: var(--elev-2);
  transition: box-shadow var(--dur-fast) var(--ease-out);
  /* Same reading measure as the transcript rows above it: a full-width card
     under a 720px column read as two different applications stacked. */
  width: 100%;
  max-width: var(--chat-column-width, 720px);
  margin: 0 auto;
}
.composer__card:focus-within {
  /* Focus is signalled by a layered ring, not the shared hard 2px band: a
     1px crisp edge plus a wide faint halo reads as "precise instrument" —
     the flat 2px band on a card this large read as a heavy outline. */
  box-shadow:
    var(--elev-2),
    0 0 0 1px color-mix(in srgb, var(--color-ring) 55%, transparent),
    0 0 0 5px color-mix(in srgb, var(--color-ring) 10%, transparent);
}
/*
  While a turn is running the card drops its hover lift (no "come type in me"
  invitation while the Agent is mid-act), but the focus ring STAYS: if the
  user is editing a follow-up prompt mid-turn the card must still show where
  the cursor lives.
*/
.composer__card--busy:focus-within {
  box-shadow:
    var(--elev-2),
    0 0 0 1px color-mix(in srgb, var(--color-ring) 55%, transparent),
    0 0 0 5px color-mix(in srgb, var(--color-ring) 10%, transparent);
}
/* A file drag hovers over the card: the drop target is the whole card. The
   primary tint is a quiet invitation, not the loud focus ring. */
.composer__card--dragging {
  box-shadow:
    var(--elev-2),
    0 0 0 1px color-mix(in srgb, var(--color-primary) 45%, transparent),
    0 0 0 5px color-mix(in srgb, var(--color-primary) 10%, transparent);
}

/* ── Credential gate strip (missing API key) ────────────────────────────── */
/* A paused composer must say why AND carry the fix: warning-tinted row, the
   reason left, the executing action right. Same calm voice as the warn notes
   on the attachment chips — this is a state, not an alarm. */
.composer__credential {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-1-5) var(--space-2);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-warning) 10%, transparent);
  color: var(--color-warning-text);
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
}
.composer__credential-text {
  min-width: 0;
}
.composer__credential-action {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  border: none;
  background: transparent;
  padding: 0;
  font: inherit;
  font-weight: 600;
  color: var(--color-primary);
  cursor: pointer;
}
.composer__credential-arrow {
  transition: transform var(--dur-fast) var(--ease-out);
}
.composer__credential-action:hover .composer__credential-arrow {
  transform: translateX(2px);
}
.composer__credential-action:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}

/* ── Queued typed-ahead messages (chips waiting for the busy session) ────── */
.composer__queued {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: 0 var(--space-1);
  font-size: var(--text-label);
}
.composer__queued-label {
  color: var(--color-text-muted);
  line-height: 1.6;
  flex-shrink: 0;
}
/* Same chip voice as the attachment chips, tinted toward the primary so
   "waiting to run" reads differently from "attached to the next message". */
.composer__queued-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  max-width: 100%;
  padding: 2px 2px 2px var(--space-2);
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  color: var(--color-text-secondary);
  overflow: hidden;
}
.composer__queued-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Attached-image chips (per-turn 📎 / drag-drop attachments) ──────────── */
.composer__attachments {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-1) 0;
  font-size: var(--text-label);
}
.composer__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 14rem;
  padding: 2px;
  padding-right: var(--space-1);
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-text-muted) 8%, transparent);
  color: var(--color-text-secondary);
  overflow: hidden;
}
/* The image itself is the chip's face — a small cover-cropped thumbnail, not
   an icon stand-in. Falls back to alt text while loading. */
.composer__chip-thumb {
  width: 28px;
  height: 28px;
  border-radius: calc(var(--radius-sm) - 1px);
  object-fit: cover;
  flex-shrink: 0;
  background: var(--color-bg);
}
.composer__chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.composer__chip-x {
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: 1;
  padding: 0 1px;
  cursor: pointer;
}
.composer__chip-x:hover { color: var(--color-error); }
.composer__chip-note {
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.composer__chip-note--warn { color: var(--color-warning-text); }

/* 📎 — same quiet instrument voice as its toolbar neighbours. */
.composer__attach {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--row-h);
  width: var(--row-h);
  padding: 0;
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.composer__attach:hover {
  border-color: color-mix(in srgb, var(--color-primary) 40%, var(--line-seam));
  color: var(--color-primary);
}
.composer__attach:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 1px;
}
.composer__attach-input {
  /* The input is invisible plumbing; the 📎 button drives it. */
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.composer__textarea-row {
  /* SlashInput fills the card width; its own autosize handles height. */
  min-width: 0;
}

/* Inside the card the textarea goes borderless — the card is the surface,
   so a second bordered box would be the nested-card tell. The focus state
   is carried by the card's own :focus-within ring instead. */
.composer__textarea-row :deep(.slash-textarea) {
  border: none;
  background: transparent;
  padding: var(--space-1);
  border-radius: 0;
  min-height: 1.6em;
}
.composer__textarea-row :deep(.slash-textarea:focus) {
  border-color: transparent;
}
.composer__textarea-row :deep(.slash-textarea::placeholder) {
  color: var(--color-text-muted, var(--color-text-muted));
}

.composer__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: nowrap;
}

.composer__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 1;
  min-width: 0;
  flex-wrap: wrap;
  row-gap: var(--space-1);
}

/* Reasoning-effort selector — sits beside the mindset/permission switches at
   the same standard control height; quieter through borderless-adjacent
   styling and muted color, not through being small. */
.composer__viz {
  display: inline-grid;
  place-items: center;
  width: calc(var(--row-h) + 2px);
  height: calc(var(--row-h) + 2px);
  border: var(--line-w) solid transparent;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out),
    filter var(--dur-fast) var(--ease-out);
}
/* 1.125 × 16px = 18px — integer landing size; 1.08 left the glyph at 17.28px. */
.composer__viz:hover { color: var(--color-text); transform: scale(1.125); }
/* Hollow star off; lit star on: the fill carries the state, no label needed. */
.composer__viz.is-on {
  color: var(--color-primary);
  filter: drop-shadow(0 0 5px color-mix(in srgb, var(--color-primary) 60%, transparent));
}
.composer__viz.is-on :deep(svg), .composer__viz.is-on svg {
  fill: currentColor;
}
.composer__viz:focus-visible {
  outline: var(--focus-w) solid var(--color-focus);
  outline-offset: 1px;
}
/* Lit composer: an aurora border (Cursor-style slow conic sweep) hugging the
   card edge behind the composer surface. Kept to 1.5px and mid alpha so the
   input stays the quietest element even while dressed. */
/* The aurora is a BORDER, never a wash: the conic gradient is masked down
   to a ring that hugs the INPUT CARD (the component root is a larger,
   transparent wrapper — ringing it drew a stray far-away box). Ring sits
   2px outside the card's own border and stays fully saturated. */
.composer--viz-on .composer__card {
  border-color: transparent;
}
.composer--viz-on .composer__card::before {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: inherit;
  padding: 2px;
  background: conic-gradient(from var(--viz-angle, 0deg),
    var(--color-primary), #d16ba5 14%, #7a5cff 28%, #2aa8c0 42%, #58a55c 56%,
    #e0b05e 70%, var(--color-primary) 84%, #7a5cff 100%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  /* Shorthands first: a later `mask:` would reset mask-composite to `add`
     and the ring would become a full-card wash. */
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  animation: composer-aurora 6s linear infinite;
  opacity: 0.95;
  pointer-events: none;
  z-index: 1;
}
@property --viz-angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}
@keyframes composer-aurora {
  to { --viz-angle: 360deg; }
}
/* Sparkles: seven tiny stars rising and fading inside the top band. Staggered
   by --i so they never sync; parked under reduced motion. */
.composer__sparkles {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  border-radius: inherit;
  z-index: 2;
}
.composer__sparkle {
  position: absolute;
  top: 70%;
  left: calc(4% + var(--i) * 11%);
  width: 8px;
  height: 8px;
  clip-path: polygon(50% 0, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%);
  background: linear-gradient(180deg, #ffd66b, #ff8fb1 55%, #9d7bff);
  filter: drop-shadow(0 0 3px rgba(255, 214, 107, 0.8));
  opacity: 0;
  animation: composer-sparkle 4.2s ease-in-out infinite;
  animation-delay: calc(var(--i) * 0.45s);
}
@keyframes composer-sparkle {
  0% { transform: translateY(8px) scale(0.5) rotate(0deg); opacity: 0; }
  16% { opacity: 1; }
  45% { transform: translateY(-16px) scale(1) rotate(40deg); opacity: 0.8; }
  75%, 100% { transform: translateY(-34px) scale(0.6) rotate(90deg); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .composer--viz-on .composer__card::before { animation: none; }
  .composer__sparkle { animation: none; opacity: 0; }
}
/* Thinking effort reads as one of the toolbar's quiet controls — the same
   ghost idiom as the star, not a boxed input. Native select chrome (the
   white field + heavy caret) is replaced by a small inline chevron. */
.composer__thinking {
  height: calc(var(--row-h) + 2px);
  border: var(--line-w) solid transparent;
  border-radius: var(--radius-sm);
  background-color: transparent;
  color: var(--color-text-muted);
  font: inherit;
  font-size: var(--text-sm);
  padding: 0 20px 0 8px;
  max-width: 9rem;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%238c8fa1' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 6px center;
  transition: color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out);
}
.composer__thinking:hover {
  color: var(--color-text);
  background-color: var(--color-bg-hover);
}
.composer__thinking:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 1px;
  background-color: var(--color-bg-hover);
}

.composer__controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  /* May shrink so the hint text absorbs narrow docks (<400px) instead of
     the cluster overflowing past the card's right edge. */
  flex-shrink: 1;
  min-width: 0;
}

/* Send/Stop — the toolbar's terminal action as one round button at the far
   right (attach + behavior switches live on the left; readouts + this on the
   right). Icon-only: the label rides aria-label/title. The two-class
   selector out-specifies AppButton's own sm rectangle so the circle holds. */
.composer__controls .composer__send,
.composer__controls .composer__enqueue,
.composer__controls .composer__stop {
  flex-shrink: 0;
  width: var(--row-h);
  height: var(--row-h);
  padding: 0;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.composer__send svg,
.composer__stop svg { display: block; }

.composer__hint {
  font-size: var(--text-label);
  line-height: var(--text-label-lh);
  color: var(--color-text-muted, var(--color-text-muted));
  white-space: nowrap;
  /* Truncate with ellipsis under pressure; the full text is duplicated in
     tooltips/titles, so nothing is lost when the dock is too narrow. */
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  /* Only show the hint when the input could actually use it — hover/focus
     on the card. Keeps the toolbar quiet at rest. */
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.composer__card:hover .composer__hint,
.composer__card:focus-within .composer__hint {
  opacity: 1;
}

/* Context-window gauge pill: an always-on, read-only ring + "used / total"
   label. It never shrinks (the hint absorbs narrow docks); its tone escalates
   neutral → warning → danger as the window fills. The wrap anchors the hover
   panel (popover above, right-aligned to the card edge). */
.composer__ctx-wrap {
  position: relative;
  display: inline-flex;
}
.composer__ctx--open {
  background: color-mix(in srgb, var(--color-text-muted) 14%, transparent);
}
.composer__ctx-panel {
  position: absolute;
  bottom: calc(100% + 10px);
  right: 0;
  z-index: var(--z-popover);
}
.ctx-panel-enter-active,
.ctx-panel-leave-active {
  transition: opacity var(--dur-fast, 0.15s) var(--ease-out), transform var(--dur-fast, 0.15s) var(--ease-out);
}
.ctx-panel-enter-from,
.ctx-panel-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
.composer__ctx {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px var(--space-2);
  height: var(--row-h);
  border: none;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-text-muted) 8%, transparent);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: 1;
  white-space: nowrap;
  max-width: 220px;
  cursor: help;
  flex-shrink: 0;
  transition: background var(--dur-fast) var(--ease-out);
}
.composer__ctx:hover {
  background: color-mix(in srgb, var(--color-text-muted) 14%, transparent);
}
.composer__ctx-ring { flex-shrink: 0; }
.composer__ctx-track { stroke: color-mix(in srgb, var(--color-text-muted) 30%, transparent); }
.composer__ctx-fill { transition: stroke-dasharray var(--dur-fast) var(--ease-out); }
.composer__ctx--neutral .composer__ctx-fill { stroke: var(--color-primary); }
.composer__ctx--warning .composer__ctx-fill { stroke: var(--color-warning); }
.composer__ctx--danger  .composer__ctx-fill { stroke: var(--color-error); }
.composer__ctx--warning { color: var(--color-warning); }
.composer__ctx--danger  { color: var(--color-error); }
.composer__ctx-text {
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.composer__ctx-sep { opacity: 0.5; }

@media (prefers-reduced-motion: reduce) {
  .composer__card,
  .composer__card:hover,
  .composer__card:focus-within,
  .composer__hint {
    transition: none;
  }
}
</style>
