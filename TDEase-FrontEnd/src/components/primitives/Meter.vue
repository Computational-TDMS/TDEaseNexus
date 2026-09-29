<!--
  Meter — determinate progress only (VISUAL-SYSTEM.md §7.6, §11).

  "Progress that has a real denominator uses a determinate meter. Progress
  that does not must never fake one." There is deliberately no prop for an
  indeterminate state — it cannot be requested, only a `value`/`max` pair
  can. Renders the `ready / declared` two-part text
  plus a hairline bar.
-->
<template>
  <div class="meter" :class="[`meter--${tone}`, `meter--${density}`]">
    <div v-if="label" class="meter__header">
      <span class="meter__label">{{ label }}</span>
      <span class="meter__value numeric">{{ value }} / {{ max }}</span>
    </div>

    <div
      class="meter__track"
      role="progressbar"
      :aria-valuenow="value"
      :aria-valuemin="0"
      :aria-valuemax="max"
      :aria-label="label ?? `${value} of ${max}`"
    >
      <div class="meter__fill" :style="{ transform: `scaleX(${percent / 100})` }" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  value: number
  max: number
  label?: string
  tone?: 'neutral' | 'warning' | 'danger'
  /**
   * Track thickness only — never a change of meaning. `compact` is the hairline
   * used inline in dense chrome (the turn HUD's context readout); `comfortable`
   * is the thicker track a settings/report surface reads at.
   */
  density?: 'compact' | 'comfortable'
}>(), {
  tone: 'neutral',
  density: 'compact',
})

const percent = computed(() => {
  if (props.max <= 0) return 0
  return Math.min(100, Math.max(0, (props.value / props.max) * 100))
})
</script>

<style scoped>
.meter {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
}

.meter__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
  color: var(--color-text-muted);
}

.meter__value {
  color: var(--color-text);
}

.meter__track {
  position: relative;
  height: 4px;
  border-radius: var(--radius-xs);
  background: var(--color-bg-muted);
  overflow: hidden;
}

.meter--comfortable .meter__track {
  height: 8px;
  border-radius: var(--radius-sm);
}

/*
  `transform: scaleX()` rather than `width`. This meter ticks continuously in
  the turn HUD and the Run Index while a run is live; animating width lays out
  and paints on every frame, and the composited transform does not.

  `transform-origin: left` keeps it growing from the left edge, and the parent
  clips, so a fill of 0 is genuinely invisible rather than a 1px sliver.
*/
.meter__fill {
  height: 100%;
  width: 100%;
  border-radius: inherit;
  background: var(--color-primary);
  transform-origin: left center;
  transition: transform var(--dur-normal) var(--ease-out);
}

@media (prefers-reduced-motion: reduce) {
  .meter__fill { transition: none; }
}

.meter--warning .meter__fill { background: var(--color-warning); }
.meter--danger .meter__fill { background: var(--color-error); }
</style>
