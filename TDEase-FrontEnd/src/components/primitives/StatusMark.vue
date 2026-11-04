<!--
  StatusMark — the run-lifecycle status language (VISUAL-SYSTEM.md §5).

  The single most-repeated visual element in the product, and the *only*
  component allowed to render it: no document component may reimplement
  these marks or hold a second inline SVG for run state.

  Every status carries a distinct shape, not just a distinct hue, so the
  vocabulary survives achromatopsia:
    queued    — hollow ring
    running   — 270° arc, rotating
    succeeded — filled disc + check
    failed    — filled disc + cross
    cancelled — filled disc + slash
  `stale` overlays a 6% diagonal hairline hatch on top of any of the above
  (§5.1) — it is a fact about freshness, not a sixth status.

  Reduced motion (§6.10) removes the rotation but never the arc shape: the
  running mark keeps its 270° arc and gains a slow opacity breath instead.
  It must never collapse into the queued ring.
-->
<template>
  <span
    class="status-mark"
    :class="[`status-mark--${size}`, { 'status-mark--running': status === 'running' }]"
    role="img"
    :aria-label="ariaLabel"
    :title="label ? undefined : ariaLabel"
  >
    <svg
      class="status-mark__svg"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <defs v-if="stale">
        <pattern
          :id="hatchId"
          width="4"
          height="4"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="4" stroke="var(--color-text)" stroke-width="1" />
        </pattern>
      </defs>

      <circle
        v-if="status === 'queued'"
        class="status-mark__shape status-mark__shape--queued"
        cx="8" cy="8" r="6"
        fill="none"
        stroke="var(--status-queued)"
        stroke-width="2"
      />

      <circle
        v-else-if="status === 'running'"
        class="status-mark__shape status-mark__shape--running status-mark__arc"
        cx="8" cy="8" r="6"
        fill="none"
        stroke="var(--status-running)"
        stroke-width="2"
        stroke-linecap="round"
        stroke-dasharray="28.3 9.4"
        transform="rotate(-90 8 8)"
      />

      <g v-else-if="status === 'succeeded'" class="status-mark__shape status-mark__shape--succeeded">
        <circle cx="8" cy="8" r="6" fill="var(--status-succeeded)" />
        <path
          d="M5 8.3 L7.1 10.4 L11.2 6"
          fill="none"
          stroke="var(--color-on-primary)"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </g>

      <g v-else-if="status === 'failed'" class="status-mark__shape status-mark__shape--failed">
        <circle cx="8" cy="8" r="6" fill="var(--status-failed)" />
        <path
          d="M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5"
          stroke="var(--color-on-primary)"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </g>

      <g v-else-if="status === 'cancelled'" class="status-mark__shape status-mark__shape--cancelled">
        <circle cx="8" cy="8" r="6" fill="var(--status-cancelled)" />
        <line
          x1="4.6" y1="11.4" x2="11.4" y2="4.6"
          stroke="var(--color-on-primary)"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </g>

      <circle
        v-if="stale"
        class="status-mark__hatch"
        cx="8" cy="8" r="6"
        :fill="`url(#${hatchId})`"
        fill-opacity="0.06"
      />
    </svg>

    <span v-if="label" class="status-mark__label">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

const props = withDefaults(defineProps<{
  status: RunStatus
  stale?: boolean
  size?: 'sm' | 'md'
  label?: string
}>(), {
  stale: false,
  size: 'md',
})

const { t } = useI18n()

const hatchId = `status-mark-hatch-${useId()}`

const statusText = (status: RunStatus): string => {
  switch (status) {
    case 'queued': return t('common.status.task.queued')
    case 'running': return t('common.status.task.running')
    case 'succeeded': return t('common.status.task.succeeded')
    case 'failed': return t('common.status.task.failed')
    case 'cancelled': return t('common.status.task.cancelled')
  }
}

const ariaLabel = computed(() => (
  props.stale ? `${statusText(props.status)} (stale)` : statusText(props.status)
))
</script>

<style scoped>
.status-mark {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text);
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
}

.status-mark__svg {
  display: block;
  flex: none;
}

.status-mark--md .status-mark__svg { width: 16px; height: 16px; }
.status-mark--sm .status-mark__svg { width: 12px; height: 12px; }

.status-mark__label {
  white-space: nowrap;
}

/* ----- Running: 270deg arc, rotating ----- */
.status-mark__arc {
  transform-box: fill-box;
  transform-origin: center;
  animation: status-mark-spin 1.2s linear infinite;
}

/* Breathing halo (The Living Channel Rule): the running mark is a live
   channel, so it is the ONLY status allowed to glow — a soft pulsing ring in
   --color-live-glow around the SVG's circular bounds. Gated on the running
   state via the root modifier, so no idle/succeeded/failed mark can shine. */
.status-mark--running .status-mark__svg {
  border-radius: 50%;
  animation: status-mark-halo 1.8s ease-in-out infinite;
}

@keyframes status-mark-halo {
  0%, 100% { box-shadow: 0 0 0 0 var(--color-primary-glow); }
  50% { box-shadow: 0 0 6px 2px var(--color-primary-glow); }
}

@keyframes status-mark-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes status-mark-breathe {
  from { opacity: 0.35; }
  to { opacity: 1; }
}

/* Reduced motion (VISUAL-SYSTEM.md §6.10): the global rule in
   unified-design-tokens.css forces every animation-duration to 0.01ms via
   a `*` selector. A class selector has higher specificity than the
   universal selector, so this rule wins even though both are !important —
   the arc gets a real, slow breathing animation instead of being frozen
   into invisibility, and it never changes shape. */
@media (prefers-reduced-motion: reduce) {
  .status-mark__arc {
    animation-name: status-mark-breathe !important;
    animation-duration: 2.4s !important;
    animation-timing-function: ease-in-out !important;
    animation-iteration-count: infinite !important;
    animation-direction: alternate !important;
  }
  /* The halo's pulse is motion, so it degrades to a static 2px ring — the
     live channel keeps its glow, it just stops breathing. `animation: none`
     needs !important to beat the global `*` freeze (same specificity trick
     as the arc above), otherwise the halo would stick at its 0% keyframe
     (0 0 0 0 — invisible). */
  .status-mark--running .status-mark__svg {
    animation: none !important;
    box-shadow: 0 0 0 2px var(--color-primary-glow);
  }
}
</style>
