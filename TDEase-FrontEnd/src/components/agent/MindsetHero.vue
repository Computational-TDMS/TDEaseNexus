<!--
  MindsetHero — the empty conversation's centerpiece. The mode emblem is the
  IDENTITY of the resting surface (not a background): drawn small, centered,
  in the accent voice, above the goal hints.

    workflow analysis: the TRIDENT — one source stage fanning into three
              parallel tines, drawn in flow-editor language (rounded nodes,
              orthogonal rounded-corner routes). Packages flow along the
              tines; the stages breathe in order.
    explore:  the SCANNING GLASS — a magnifying glass swaying side to side
              around its lens, glint inside, reading the terrain.

  The two emblems crossfade on a mode flip. Pure decoration: aria-hidden,
  pointer-events none. prefers-reduced-motion freezes the motion into the
  static mark.
-->
<script setup lang="ts">
import type { MindsetId } from '@/agent/prompt'

defineProps<{ mindset: MindsetId }>()

// ── Trident: one source, three tines ────────────────────────────────────────
// Orthogonal routes from the source's right face (x=44, y=80) to the three
// tine nodes (x=148), fanning to y=32/80/128 with 6px rounded corners.
const ROUTES = [
  'M44 80 H70 Q76 80 76 74 V38 Q76 32 82 32 H148',
  'M44 80 H148',
  'M44 80 H70 Q76 80 76 86 V122 Q76 128 82 128 H148',
] as const
const TINE_YS = [32, 80, 128] as const
</script>

<template>
  <div class="mindset-hero" aria-hidden="true">
    <!-- Workflow Analysis: the trident pipeline. -->
    <svg
      class="mindset-hero__art"
      :class="{ 'mindset-hero__art--active': mindset === 'workflow' }"
      viewBox="0 0 200 160"
    >
      <path v-for="(d, i) in ROUTES" :key="`rail-${i}`" class="hero-rail" :d="d" />
      <path v-for="(d, i) in ROUTES" :key="`flow-${i}`" class="hero-flow" :d="d" :style="{ 'animation-delay': `${i * -0.9}s` }" />
      <rect class="hero-node" x="8" y="69" width="36" height="22" rx="7" />
      <rect
        v-for="(cy, i) in TINE_YS"
        :key="`tine-${i}`"
        class="hero-node"
        x="148"
        :y="cy - 11"
        width="36"
        height="22"
        rx="7"
        :style="{ 'animation-delay': `${0.4 + i * 0.5}s` }"
      />
    </svg>

    <!-- Explore: the scanning glass. -->
    <svg
      class="mindset-hero__art"
      :class="{ 'mindset-hero__art--active': mindset === 'analysis' }"
      viewBox="0 0 200 160"
    >
      <g class="hero-glass">
        <circle class="hero-lens" cx="98" cy="64" r="32" />
        <circle class="hero-glint" cx="87" cy="53" r="8" />
        <line class="hero-handle" x1="121" y1="87" x2="158" y2="124" />
      </g>
    </svg>
  </div>
</template>

<style scoped>
.mindset-hero {
  position: relative;
  width: 200px;
  height: 160px;
  margin: 0 auto;
  pointer-events: none;
  color: var(--color-primary);
}
/* The two emblems stack and crossfade on a mode flip — the same transition
   voice as the transcript backdrop, now at identity strength. */
.mindset-hero__art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  fill: none;
  stroke: currentColor;
  opacity: 0;
  transition: opacity 360ms var(--ease-out);
}
.mindset-hero__art--active { opacity: 1; }

/* ── Trident ─────────────────────────────────────────────────────────────── */
.hero-rail {
  stroke-width: 1.2;
  opacity: 0.4;
}
.hero-flow {
  stroke-width: 2;
  stroke-linecap: round;
  stroke-dasharray: 3 9;
  animation: hero-flow 3.6s linear infinite;
}
.hero-node {
  stroke-width: 1.6;
  animation: hero-breathe 3.8s var(--ease-out) infinite;
}

/* ── Scanning glass ────────────────────────────────────────────────────────
   The whole glass sways around the lens center — a slow, deliberate scan,
   not a wobble. The glint rides along (it is part of the group). */
.hero-glass {
  transform-box: view-box;
  transform-origin: 98px 64px;
  animation: hero-swing 3.2s ease-in-out infinite;
}
.hero-lens {
  stroke-width: 2.5;
}
.hero-glint {
  stroke-width: 2;
  opacity: 0.6;
}
.hero-handle {
  stroke-width: 3.5;
  stroke-linecap: round;
}

@keyframes hero-flow {
  to { stroke-dashoffset: -120; }
}
@keyframes hero-breathe {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
@keyframes hero-swing {
  0%, 100% { transform: rotate(-7deg); }
  50% { transform: rotate(7deg); }
}

@media (prefers-reduced-motion: reduce) {
  .mindset-hero__art { transition: none; }
  .hero-flow { display: none; }
  .hero-glass { animation: none; transform: rotate(-4deg); }
  .hero-node { animation: none; opacity: 0.9; }
}
</style>
