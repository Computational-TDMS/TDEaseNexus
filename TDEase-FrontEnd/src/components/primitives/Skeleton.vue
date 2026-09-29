<!--
  Skeleton — shape-matched loading placeholder (VISUAL-SYSTEM.md §7.6).

  "Skeletons where the shape is known... their proportions must match the
  real content, or the transition becomes a jolt." A skeleton is not
  content, so it carries `aria-hidden="true"` unconditionally. The shimmer
  is decorative, not informational, so under reduced motion the global rule
  in unified-design-tokens.css freezing every animation-duration already
  gives the required static block — no local override needed here.
-->
<template>
  <div class="skeleton" :class="`skeleton--${variant}`" aria-hidden="true">
    <template v-if="variant === 'text'">
      <div
        v-for="line in lineCount"
        :key="line"
        class="skeleton__bar skeleton__bar--text"
        :style="line === lineCount && lineCount > 1 ? { width: '60%' } : undefined"
      />
    </template>
    <div v-else-if="variant === 'row'" class="skeleton__bar skeleton__bar--row" />
    <div v-else class="skeleton__bar skeleton__bar--block" :style="{ height: blockHeight }" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  variant: 'text' | 'row' | 'block'
  lines?: number
  height?: number | string
}>(), {
  lines: 1,
})

const lineCount = computed(() => Math.max(1, props.lines))

const blockHeight = computed(() => {
  if (props.height === undefined) return '80px'
  return typeof props.height === 'number' ? `${props.height}px` : props.height
})
</script>

<style scoped>
.skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
}

.skeleton__bar {
  border-radius: var(--radius-xs);
  background: linear-gradient(
    90deg,
    var(--color-bg-muted) 25%,
    var(--color-bg-hover) 50%,
    var(--color-bg-muted) 75%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.6s ease-in-out infinite;
}

.skeleton__bar--text {
  height: 10px;
  width: 100%;
}

.skeleton__bar--row {
  height: var(--row-h);
  width: 100%;
}

.skeleton__bar--block {
  width: 100%;
}

@keyframes skeleton-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
