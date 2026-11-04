<!--
  MindsetBackdrop — the conversation surface's animated mode identity.

  The mindset switch is a PRODUCT-level choice (top of the Agent page, in the
  SessionBar), and a product-level choice earns a product-level cue: flipping
  Workflow Analysis ↔ Explore crossfades the transcript's backdrop between
  two emblems, each speaking its mode's established visual language —

    workflow analysis: an ORTHOGONAL pipeline schematic — the universal
              flow-editor language (rounded stage nodes joined by
              right-angle, rounded-corner connectors, fanning out and
              merging back). Packages flow along the connectors
              (dash-offset) and the stages breathe in pipeline order.
              Reads instantly as "workflow".
    explore:   a TOPOGRAPHIC CONTOUR FIELD — nested elevation rings
              generated from smooth harmonic functions, the way survey
              maps draw unknown terrain (the same metaphor as the
              contour-field/topolines school of animated backgrounds, and
              the same plan-view language as a feature map). The contours
              drift slowly and breathe in nesting order; a small survey
              station marks where the exploration stands. Reads instantly
              as "surveying the unknown".

  All geometry is GENERATED (harmonic closed contours; axis-aligned
  orthogonal routes with fixed corner radii) — deterministic, smooth, and
  architecturally legible, never hand-sketched. Both emblems share one
  viewBox and are CENTERED in the surface (the empty state's hero emblem is
  the identity mark; this drawing is the ambient backdrop of an ongoing
  conversation), and the ink stays in the composer-safe band, so switching
  modes changes nothing about the layout. Token-pure (currentColor), quiet
  by design (12% alpha), pure decoration (aria-hidden, pointer-events none).
  prefers-reduced-motion freezes all motion into static line art.
-->
<script setup lang="ts">
import type { MindsetId } from '@/agent/prompt'

defineProps<{ mindset: MindsetId }>()

// ── Explore: harmonic contour generation ────────────────────────────────────
// A closed contour is a circle modulated by a few fixed sine harmonics —
// organic like real elevation rings, but smooth and deterministic.
type Harmonic = readonly [k: number, amp: number, phase: number]

function contour(cx: number, cy: number, base: number, harmonics: readonly Harmonic[], phaseShift: number): string {
  const N = 96
  const parts: string[] = []
  for (let i = 0; i < N; i += 1) {
    const t = (i / N) * Math.PI * 2
    let r = base
    for (const [k, amp, phase] of harmonics) r *= 1 + amp * Math.sin(k * t + phase + phaseShift)
    const x = cx + r * Math.cos(t)
    // Slight vertical squash: the plan-view (map) perspective.
    const y = cy + r * Math.sin(t) * 0.82
    parts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
  }
  return `${parts.join(' ')} Z`
}

const P1_HARMONICS: readonly Harmonic[] = [[2, 0.16, 0.7], [3, 0.11, 2.2], [5, 0.05, 4.1]]
const P2_HARMONICS: readonly Harmonic[] = [[2, 0.2, 1.6], [3, 0.1, 3.0], [4, 0.06, 5.2]]

/** The terrain: one major elevation (three nested rings) and one minor
 *  (two rings), plus a single open contour crossing the map. All ink stays
 *  inside the composer-safe band (viewBox y ≤ ~400). */
const RINGS = [
  { d: contour(780, 270, 112, P1_HARMONICS, 0.0), delay: 0 },
  { d: contour(780, 270, 78, P1_HARMONICS, 0.45), delay: 0.6 },
  { d: contour(780, 270, 46, P1_HARMONICS, 0.9), delay: 1.2 },
  { d: contour(300, 340, 58, P2_HARMONICS, 0.2), delay: 0.3 },
  { d: contour(300, 340, 34, P2_HARMONICS, 0.65), delay: 0.9 },
] as const

/** The survey station: a small crosshair parked on the major peak — where
 *  the exploration currently stands. */
const STATION = { x: 826, y: 246 }

// ── Workflow Analysis: orthogonal pipeline ──────────────────────────────────
// Stage nodes as rounded rects; connectors are axis-aligned routes with a
// fixed 8px corner radius — the flow-editor convention. The pipeline fans
// out of INPUT into two parallel stages and merges through JOIN → CHECK →
// RESULT.
const NODE_W = 64
const NODE_H = 26
const NODES = [
  { cx: 110, cy: 300 },
  { cx: 330, cy: 240 },
  { cx: 330, cy: 380 },
  { cx: 560, cy: 310 },
  { cx: 740, cy: 310 },
  { cx: 920, cy: 310 },
] as const

/** Orthogonal routes (M/H/V with quadratic corners) between the node faces.
 *  Fan-out at x=220, merge at x=500. */
const ROUTES = [
  'M142 300 H212 Q220 300 220 292 V248 Q220 240 228 240 H298',
  'M142 300 H212 Q220 300 220 308 V372 Q220 380 228 380 H298',
  'M362 240 H492 Q500 240 500 248 V302 Q500 310 508 310 H528',
  'M362 380 H492 Q500 380 500 372 V318 Q500 310 508 310 H528',
  'M592 310 H708',
  'M772 310 H888',
] as const
</script>

<template>
  <div class="mindset-backdrop" aria-hidden="true">
    <!-- Workflow Analysis: the orthogonal pipeline. Each route is a faint
         rail plus a flowing dash riding it (packages through the pipeline);
         stages breathe in pipeline order, so direction reads left → result. -->
    <svg
      class="mindset-backdrop__layer"
      :class="{ 'mindset-backdrop__layer--active': mindset === 'workflow' }"
      viewBox="0 0 1200 560"
      preserveAspectRatio="xMidYMid meet"
    >
      <path v-for="(d, i) in ROUTES" :key="`rail-${i}`" class="pipe-rail" :d="d" />
      <path v-for="(d, i) in ROUTES" :key="`flow-${i}`" class="pipe-flow" :d="d" :style="{ 'animation-delay': `${i * -1.1}s` }" />
      <rect
        v-for="(n, i) in NODES"
        :key="`node-${i}`"
        class="pipe-node"
        :x="n.cx - NODE_W / 2"
        :y="n.cy - NODE_H / 2"
        :width="NODE_W"
        :height="NODE_H"
        :rx="8"
        :style="{ 'animation-delay': `${i * 0.7}s` }"
      />
    </svg>

    <!-- Explore: the contour field. Rings drift (dash-offset) and breathe in
         nesting order; the open contour and the survey station complete the
         map. -->
    <svg
      class="mindset-backdrop__layer"
      :class="{ 'mindset-backdrop__layer--active': mindset === 'analysis' }"
      viewBox="0 0 1200 560"
      preserveAspectRatio="xMidYMid meet"
    >
      <path class="trail" d="M-20 200 C 200 160, 420 250, 640 210 S 1000 150, 1220 190" />
      <path
        v-for="(ring, i) in RINGS"
        :key="`ring-${i}`"
        class="contour"
        :d="ring.d"
        :style="{ 'animation-delay': `${ring.delay}s` }"
      />
      <g class="station">
        <line :x1="STATION.x - 7" :y1="STATION.y" :x2="STATION.x + 7" :y2="STATION.y" />
        <line :x1="STATION.x" :y1="STATION.y - 7" :x2="STATION.x" :y2="STATION.y + 7" />
        <circle :cx="STATION.x" :cy="STATION.y" r="3.5" />
      </g>
    </svg>
  </div>
</template>

<style scoped>
.mindset-backdrop {
  position: absolute;
  inset: 0;
  pointer-events: none;
  color: var(--color-text-muted);
}
.mindset-backdrop__layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  fill: none;
  stroke: currentColor;
  opacity: 0;
  transition: opacity 360ms var(--ease-out);
}
/* Present but quiet: the emblem must read as a backdrop across the surface
   (12% of the muted tone — visible at a glance, harmless under text); the
   inactive layer is fully transparent, so the crossfade reads as one emblem
   replacing the other. */
.mindset-backdrop__layer--active { opacity: 0.12; }

/* ── Workflow pipeline ───────────────────────────────────────────────────── */
.pipe-rail {
  stroke-width: 1;
}
.pipe-flow {
  stroke-width: 2;
  stroke-linecap: round;
  stroke-dasharray: 3 13;
  animation: backdrop-flow 6s linear infinite;
}
.pipe-node {
  stroke-width: 1.2;
  animation: backdrop-breathe 4.2s var(--ease-out) infinite;
}

/* ── Explore contour field ──────────────────────────────────────────────────
   Rings drift slowly (a crawling topo map, not a conveyor); the open trail
   flows a touch faster; the station holds still — the one fixed point of a
   moving survey. */
.contour {
  stroke-width: 1;
  stroke-dasharray: 4 10;
  animation: backdrop-flow 16s linear infinite, backdrop-breathe 4.2s var(--ease-out) infinite;
}
.trail {
  stroke-width: 1;
  stroke-dasharray: 5 11;
  animation: backdrop-flow 11s linear infinite;
}
.station {
  stroke-width: 1.2;
}

@keyframes backdrop-flow {
  to { stroke-dashoffset: -160; }
}
@keyframes backdrop-breathe {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}

/* Reduced motion freezes the emblems into static line art: no drift, no
   breathing — the identity stays, the motion goes (VISUAL-SYSTEM §6.10). */
@media (prefers-reduced-motion: reduce) {
  .mindset-backdrop__layer { transition: none; }
  .pipe-flow,
  .trail { display: none; }
  .contour { stroke-dasharray: none; animation: none; }
  .pipe-node { animation: none; opacity: 0.9; }
}
</style>
