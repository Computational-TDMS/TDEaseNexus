<!--
  WelcomeSpectrum — the boot splash's living spectrum, re-homed.

  Ported from electron/splash.html so the welcome surface picks up exactly
  where the splash handed off: the charge-state envelope of an intact protein
  (≈16 kDa, z 12–28 centered on 19+, isotope fine structure) over an m/z
  500–1500 baseline, plus the signature wandering dot — the "signal being
  seen" — that lifts nearby peaks into a breath as it passes. The geometry
  math is identical to the splash's; colors resolve through semantic tokens
  so all five themes hold. This is the one page-level exception to the
  stillness of static content (The Living Channel Rule): it is the tail of
  the boot moment, not a sticker on a panel. The loop parks itself when the
  element is off-screen or the document is hidden, and prefers-reduced-motion
  gets the static spectrum with the dot resting on the apex.
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/* Macro geometry — same constants as electron/splash.html (viewBox 880×248,
   baseline y=196, tallest peak 118, envelope/axis math identical) so both
   spectra read as one object. Detail sizes (stick width, label font, dot,
   halo) are ~1.4× the splash's: the welcome column renders this viewBox at
   ~560px where the splash renders it at ~1180px, and unscaled details would
   shrink below legibility. */
const BASE = 196
const MAXH = 118
const M = 15800 // intact protein ≈ 16 kDa
const xOf = (mz: number) => 70 + (mz - 500) * (740 / 1000)
const gauss = (z: number) => Math.exp(-((z - 19.5) ** 2) / (2 * 4.2 ** 2))
const ISO = [0.3, 0.62, 1.0, 0.58, 0.26]

interface Stick {
  /** stick left edge (isotope offset applied) */
  x: number
  /** stick top y */
  y: number
  /** stick height */
  h: number
  /** monoisotopic peak of the charge state */
  main: boolean
  /** charge-state cluster center — the dot's lift is measured from here */
  xc: number
}

const sticks: Stick[] = []
for (let z = 12; z <= 28; z++) {
  const xc = xOf(M / z)
  const env = gauss(z)
  ISO.forEach((ratio, i) => {
    const h = Math.max(3, MAXH * env * ratio)
    sticks.push({ x: xc + (i - 2) * 5.8 - 2, y: BASE - h, h, main: i === 2, xc })
  })
}
const chargeLabels = [14, 17, 20, 23, 26].map((z) => ({
  z,
  x: xOf(M / z),
  y: BASE - MAXH * gauss(z) - 12,
}))
const ticks = [600, 800, 1000, 1200, 1400].map((mz) => ({ mz, x: xOf(mz) }))

/* Reduced-motion pose: the dot rests on the apex above 19+. */
const apexX = xOf(M / 19)
const apexH = MAXH * gauss(19)
const apexTop = BASE - apexH

const rootEl = ref<SVGSVGElement>()
const dotEl = ref<SVGCircleElement>()
const haloEl = ref<SVGEllipseElement>()
const mainEls: SVGRectElement[] = []
const reflEls: SVGRectElement[] = []
function setMain(el: unknown, i: number): void {
  if (el instanceof SVGElement) mainEls[i] = el as SVGRectElement
}
function setRefl(el: unknown, i: number): void {
  if (el instanceof SVGElement) reflEls[i] = el as SVGRectElement
}

/* Wandering-dot law, verbatim from the splash (only SIGMA widens with the
   coarser isotope spacing): the dot sweeps the cluster (7.5s round trip,
   cosine ease at the ends); sticks near it are lifted (Gaussian falloff),
   all sticks keep a quiet 3.6s base breath. */
const DOT_AMP = 270
const DOT_T = 7.5
const SIGMA = 30
const BOOST = 0.55
const envAtX = (x: number) => gauss(M / (500 + (x - 70) / 0.74))

let rafId = 0
let active = false
let inView = true

function frame(now: number): void {
  const t = now / 1000
  const dotX = 440 + DOT_AMP * Math.cos((2 * Math.PI * t) / DOT_T)
  for (let i = 0; i < sticks.length; i++) {
    const lift = BOOST * Math.exp(-((sticks[i].xc - dotX) ** 2) / (2 * SIGMA * SIGMA))
    const sc = 0.94 + 0.06 * Math.sin((2 * Math.PI * t) / 3.6) + lift
    const tr = `scaleY(${sc.toFixed(4)})`
    mainEls[i] && (mainEls[i].style.transform = tr)
    reflEls[i] && (reflEls[i].style.transform = tr)
  }
  const topH = MAXH * envAtX(dotX) * (1 + BOOST)
  dotEl.value?.setAttribute('cx', dotX.toFixed(2))
  dotEl.value?.setAttribute('cy', (BASE - topH - 15).toFixed(2))
  haloEl.value?.setAttribute('cx', dotX.toFixed(2))
  haloEl.value?.setAttribute('cy', (BASE - topH * 0.55).toFixed(2))
  if (active) rafId = requestAnimationFrame(frame)
}
function start(): void {
  if (active) return
  active = true
  rafId = requestAnimationFrame(frame)
}
function stop(): void {
  active = false
  cancelAnimationFrame(rafId)
}
function maybeStart(): void {
  if (inView && document.visibilityState === 'visible') start()
}

let io: IntersectionObserver | undefined

onMounted(() => {
  // matchMedia/IntersectionObserver can be absent (jsdom, exotic webviews);
  // the animation is decoration, so degrade to the static pose, never throw.
  if (typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    dotEl.value?.setAttribute('opacity', '0.9')
    haloEl.value?.setAttribute('opacity', '0.5')
    return
  }
  if (typeof IntersectionObserver !== 'function') return
  io = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting
    inView ? maybeStart() : stop()
  })
  io.observe(rootEl.value!)
  document.addEventListener('visibilitychange', onVisibility)
  maybeStart()
})

function onVisibility(): void {
  document.visibilityState === 'visible' ? maybeStart() : stop()
}

onBeforeUnmount(() => {
  stop()
  io?.disconnect()
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <svg ref="rootEl" class="spectrum" viewBox="0 0 880 248" aria-hidden="true">
    <defs>
      <radialGradient id="welcome-spectrum-halo">
        <stop offset="0%" class="halo-stop" />
        <stop offset="100%" class="halo-stop halo-stop--edge" />
      </radialGradient>
    </defs>
    <ellipse
      ref="haloEl"
      class="halo"
      :cx="apexX"
      :cy="BASE - apexH * 0.55"
      rx="150"
      ry="78"
      fill="url(#welcome-spectrum-halo)"
    />
    <g class="refl">
      <rect
        v-for="(s, i) in sticks"
        :key="`r${i}`"
        :ref="(el) => setRefl(el, i)"
        class="stick stick--refl"
        :class="{ 'stick--main': s.main }"
        :x="s.x"
        :y="BASE + 4"
        width="4"
        :height="s.h * 0.32"
        rx="2"
      />
    </g>
    <rect
      v-for="(s, i) in sticks"
      :key="i"
      :ref="(el) => setMain(el, i)"
      class="stick"
      :class="{ 'stick--main': s.main }"
      :x="s.x"
      :y="s.y"
      width="4"
      :height="s.h"
      rx="2"
    />
    <text
      v-for="l in chargeLabels"
      :key="l.z"
      class="charge"
      :x="l.x"
      :y="l.y"
      text-anchor="middle"
    >{{ l.z }}+</text>
    <circle ref="dotEl" class="dot" :cx="apexX" :cy="apexTop - 18" r="3.8" />
    <rect class="axis-line" x="58" :y="BASE" width="764" height="1.5" />
    <rect
      v-for="t in ticks"
      :key="t.mz"
      class="axis-line"
      :x="t.x - 0.75"
      :y="BASE"
      width="1.5"
      height="7"
    />
    <text
      v-for="t in ticks"
      :key="t.mz"
      class="tick-label"
      :x="t.x"
      :y="BASE + 25"
      text-anchor="middle"
    >{{ t.mz }}</text>
    <text class="tick-label axis" x="834" :y="BASE + 25" text-anchor="end">m/z</text>
  </svg>
</template>

<style scoped>
.spectrum {
  display: block;
  width: 100%;
  /* Explicit ratio, not height:auto: the first frame must reserve the full
     viewBox height (880×248) or everything below the spectrum — the whole
     welcome card — shifts ~175px when the ratio resolves, the largest
     remaining first-visit CLS event (2026-09-05 perf re-measure). */
  aspect-ratio: 880 / 248;
  height: auto;
  overflow: visible;
}

.stick {
  fill: color-mix(in srgb, var(--color-primary) 55%, transparent);
  transform-box: fill-box;
  transform-origin: 50% 100%;
}
.stick--main {
  fill: var(--color-primary);
}
.stick--refl {
  transform-origin: 50% 0%;
}
.refl {
  opacity: 0.1;
}

.halo {
  opacity: 0.85;
}
.halo-stop {
  stop-color: var(--color-primary-glow);
}
.halo-stop--edge {
  stop-opacity: 0;
}
.dot {
  fill: var(--color-interact);
}

.axis-line {
  fill: var(--color-border-panel);
}
.charge,
.tick-label {
  font-family: var(--font-mono);
  font-size: 15px;
  fill: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}
.charge {
  letter-spacing: 0.05em;
}
.axis {
  letter-spacing: 0.08em;
}
</style>
