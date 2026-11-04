<!--
  Ms2DiscriminationViewer — one MS2 scan judged under competing proteoform
  models (chart-forge candidate-discrimination payload, parsed by
  services/visualization/ms2Discrimination.ts).

  What it answers: which fragments tell the models apart. For the active
  model, matched peaks are coloured by ion series; ions matched under ONLY
  one model are labelled; ions the active model predicts but the scan does
  not contain are drawn as dashed "not observed" ghosts (when the sibling
  fragment-compare output is present). The sequence row above is linked both
  ways — an ion lights the residues it spans, a residue lights the ions that
  cover it.

  Motion is functional only: a range change (drag-zoom, reset, or the
  Agent's `view.focus`) animates the axis so the eye keeps its bearings;
  peaks never animate for decoration. `prefers-reduced-motion` jumps.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ionKey,
  ionResidues,
  parseIonLabel,
  type DiscriminationMatch,
  type DiscriminationModel,
} from '@/services/visualization/ms2Discrimination'
import type { ViewDirective } from '@/stores/agentView'

const props = defineProps<{
  model: DiscriminationModel
  /** The Agent's latest focus/select for this file (stores/agentView). */
  directive?: ViewDirective
}>()

const { t } = useI18n()

// ── Layout ────────────────────────────────────────────────────────────────
const H = 340
const PAD = { l: 14, r: 14, t: 46, b: 26 }
const host = ref<HTMLElement | null>(null)
const width = ref(800)
let resize: ResizeObserver | null = null
onMounted(() => {
  if (!host.value) return
  resize = new ResizeObserver(([entry]) => { width.value = Math.max(360, Math.floor(entry!.contentRect.width)) })
  resize.observe(host.value)
})
onBeforeUnmount(() => { resize?.disconnect(); cancelAnimationFrame(raf) })

// ── Model state ───────────────────────────────────────────────────────────
const activeId = ref(props.model.candidates[0]?.id ?? '')
const active = computed(() => props.model.candidates.find((c) => c.id === activeId.value) ?? props.model.candidates[0]!)
const selectedIon = ref<string | null>(null)
const selectedResidue = ref<number | null>(null)
/** The Agent's `view.focus` residue window — a span lit on the sequence row,
 *  independent of the click selection (a focus moves the view, a select picks). */
const focusedSpan = ref<[number, number] | null>(null)

const fullDomain = computed<[number, number]>(() => {
  const mzs = props.model.peaks.map((p) => p.mz)
  const lo = Math.min(...mzs), hi = Math.max(...mzs)
  const pad = (hi - lo) * 0.02 || 10
  return [Math.max(0, lo - pad), hi + pad]
})

// Animated x-domain: `domain` is what renders, `target` what it moves to.
const domain = ref<[number, number]>([...fullDomain.value])
let raf = 0
const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
function animateTo(next: [number, number]) {
  cancelAnimationFrame(raf)
  if (reducedMotion) { domain.value = next; return }
  const from: [number, number] = [...domain.value]
  const start = performance.now(), dur = 420
  const ease = (x: number) => 1 - Math.pow(1 - x, 3)
  const step = (now: number) => {
    const u = ease(Math.min(1, (now - start) / dur))
    domain.value = [from[0] + (next[0] - from[0]) * u, from[1] + (next[1] - from[1]) * u]
    if (u < 1) raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
}
watch(fullDomain, (d) => { domain.value = [...d] })

const plotW = computed(() => width.value - PAD.l - PAD.r)
const plotH = H - PAD.t - PAD.b
const x = (mz: number) => PAD.l + ((mz - domain.value[0]) / (domain.value[1] - domain.value[0])) * plotW.value

const visiblePeaks = computed(() => props.model.peaks.filter((p) => p.mz >= domain.value[0] && p.mz <= domain.value[1]))
// The y-scale follows what is visible, so a zoom into the low-mass region
// makes small fragments legible instead of flat against the axis.
const yMax = computed(() => Math.max(1, ...visiblePeaks.value.map((p) => p.i)))
const y = (i: number) => PAD.t + plotH - (i / yMax.value) * plotH

const matchByMz = computed(() => {
  const map = new Map<number, DiscriminationMatch>()
  for (const m of active.value.matches) map.set(Math.round(m.mz * 1e4), m)
  return map
})
const matchOf = (mz: number) => matchByMz.value.get(Math.round(mz * 1e4))

const residueHighlight = computed<[number, number] | null>(() => {
  if (!selectedIon.value) return null
  const [ion, n] = selectedIon.value.split(':')
  return ionResidues(ion!, Number(n), props.model.sequence.length)
})
/** Ions (active model) that cover the selected residue. */
const residueIons = computed(() => {
  const r = selectedResidue.value
  if (!r) return new Set<string>()
  const len = props.model.sequence.length
  return new Set(active.value.matches
    .filter((m) => { const [a, b] = ionResidues(m.ion, m.n, len); return r >= a && r <= b })
    .map((m) => ionKey(m.ion, m.n, m.q)))
})

function peakClass(mz: number): string {
  const m = matchOf(mz)
  if (!m) return 'pk'
  const key = ionKey(m.ion, m.n, m.q)
  const lit = selectedIon.value === key || residueIons.value.has(key)
  return `pk pk--${m.ion === 'b' || m.ion === 'a' || m.ion === 'c' ? 'n' : 'c'}${lit ? ' pk--lit' : ''}${props.model.discriminating.get(key) === active.value.id ? ' pk--disc' : ''}`
}

const labels = computed(() => active.value.matches
  .filter((m) => m.mz >= domain.value[0] && m.mz <= domain.value[1])
  .filter((m) => {
    const key = ionKey(m.ion, m.n, m.q)
    return props.model.discriminating.get(key) === active.value.id || selectedIon.value === key
  })
  .map((m) => ({ key: ionKey(m.ion, m.n, m.q), m, x: x(m.mz), y: y(m.i) })))

const ghosts = computed(() => props.model.ghosts
  .filter((g) => g.candidateId === active.value.id && g.mz >= domain.value[0] && g.mz <= domain.value[1])
  .map((g) => ({ ...g, x: x(g.mz) })))

const ticks = computed(() => {
  const span = domain.value[1] - domain.value[0]
  const raw = span / Math.max(3, Math.floor(plotW.value / 110))
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(domain.value[0] / step) * step; v <= domain.value[1]; v += step) out.push(v)
  return out
})

// ── Interaction ───────────────────────────────────────────────────────────
const brush = ref<{ a: number; b: number } | null>(null)
function mzAt(event: PointerEvent): number {
  const rect = (event.currentTarget as SVGElement).getBoundingClientRect()
  const px = event.clientX - rect.left
  return domain.value[0] + ((px - PAD.l) / plotW.value) * (domain.value[1] - domain.value[0])
}
function onDown(event: PointerEvent) {
  const mz = mzAt(event)
  brush.value = { a: mz, b: mz }
  ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
}
function onMove(event: PointerEvent) { if (brush.value) brush.value = { ...brush.value, b: mzAt(event) } }
function onUp() {
  const b = brush.value
  brush.value = null
  if (!b) return
  const lo = Math.min(b.a, b.b), hi = Math.max(b.a, b.b)
  if (hi - lo > (domain.value[1] - domain.value[0]) * 0.01) animateTo([lo, hi])
}
function resetZoom() { focusedSpan.value = null; animateTo([...fullDomain.value]) }
function zoomToDiscriminating() {
  const mzs = [
    ...active.value.matches.filter((m) => props.model.discriminating.has(ionKey(m.ion, m.n, m.q))).map((m) => m.mz),
    ...props.model.ghosts.filter((g) => g.candidateId === active.value.id).map((g) => g.mz),
  ]
  if (!mzs.length) return
  const lo = Math.min(...mzs), hi = Math.max(...mzs)
  const pad = Math.max(20, (hi - lo) * 0.25)
  animateTo([lo - pad, hi + pad])
}
function selectPeak(mz: number) {
  const m = matchOf(mz)
  selectedResidue.value = null
  selectedIon.value = m ? ionKey(m.ion, m.n, m.q) : null
}
function selectResidue(pos: number) {
  selectedIon.value = null
  selectedResidue.value = selectedResidue.value === pos ? null : pos
}

// ── Agent directives (view.focus / view.select) ───────────────────────────
/** The Agent's residue window, swapped into order and clamped to the sequence. */
function clampSpan(start: number | undefined, end: number | undefined, length: number): [number, number] | null {
  const a = start ?? end
  const b = end ?? start
  if (a === undefined || b === undefined) return null
  const lo = Math.max(1, Math.min(a, b))
  const hi = Math.min(length, Math.max(a, b))
  return hi >= lo ? [lo, hi] : null
}

function applyDirective(d: ViewDirective | undefined) {
  if (!d) return
  const s = d.select
  if (s?.model && props.model.candidates.some((c) => c.id === s.model)) activeId.value = s.model
  if (s?.ion) {
    const parsed = parseIonLabel(s.ion)
    if (parsed) {
      const hit = active.value.matches.find((m) => m.ion === parsed.ion && m.n === parsed.n && (parsed.q === undefined || m.q === parsed.q))
        ?? props.model.candidates.flatMap((c) => c.matches).find((m) => m.ion === parsed.ion && m.n === parsed.n)
      selectedResidue.value = null
      selectedIon.value = hit ? ionKey(hit.ion, hit.n, hit.q) : null
    }
  }
  if (s?.residue) { selectedIon.value = null; selectedResidue.value = s.residue }
  const f = d.focus
  if (f) {
    // A fresh focus replaces the whole window: residue fields present → that
    // span, absent → no span (the Agent moved elsewhere in the same file).
    focusedSpan.value = clampSpan(f.residueStart, f.residueEnd, props.model.sequence.length)
    if (f.mzMin !== undefined || f.mzMax !== undefined) {
      // Clamped to the scan: a window the payload does not cover would
      // otherwise render an empty plot.
      const lo = Math.max(fullDomain.value[0], f.mzMin ?? fullDomain.value[0])
      const hi = Math.min(fullDomain.value[1], f.mzMax ?? fullDomain.value[1])
      if (hi > lo) animateTo([lo, hi])
    }
  }
}
watch(() => props.directive?.seq, () => applyDirective(props.directive), { immediate: true })

// ── Sequence row ──────────────────────────────────────────────────────────
const residues = computed(() => {
  const len = props.model.sequence.length
  const bCleav = new Set(active.value.matches.filter((m) => m.ion === 'b' || m.ion === 'c').map((m) => m.cleav))
  const yCleav = new Set(active.value.matches.filter((m) => m.ion === 'y' || m.ion === 'z').map((m) => len - m.n))
  const mods = new Map(active.value.mods.map((m) => [m.pos, m.tag]))
  const hl = residueHighlight.value
  const span = focusedSpan.value
  return props.model.sequence.split('').map((aa, i) => {
    const pos = i + 1
    return {
      aa, pos,
      b: bCleav.has(pos), y: yCleav.has(pos),
      mod: mods.get(pos),
      lit: (hl && pos >= hl[0] && pos <= hl[1]) || selectedResidue.value === pos
        || Boolean(span && pos >= span[0] && pos <= span[1]),
    }
  })
})

const selectedMatch = computed(() => {
  if (!selectedIon.value) return null
  return active.value.matches.find((m) => ionKey(m.ion, m.n, m.q) === selectedIon.value) ?? null
})
const discCount = (id: string) => [...props.model.discriminating.values()].filter((owner) => owner === id).length
</script>

<template>
  <div ref="host" class="ms2d" data-viewer="ms2_discrimination">
    <header class="ms2d__head">
      <div class="ms2d__title">
        <strong>{{ model.title }}</strong>
        <span class="ms2d__meta">
          <template v-if="model.activation">{{ model.activation }}</template>
          <template v-if="model.precursorCharge"> · z={{ model.precursorCharge }}</template>
          <template v-if="model.thresholds"> · {{ model.thresholds }}</template>
        </span>
      </div>
      <div class="ms2d__models" role="radiogroup" :aria-label="t('visualization.ms2Discrimination.models')">
        <button
          v-for="c in model.candidates"
          :key="c.id"
          type="button"
          role="radio"
          class="ms2d__model"
          :class="{ 'is-active': c.id === activeId }"
          :aria-checked="c.id === activeId"
          :style="{ '--model': c.color ?? 'var(--color-primary)' }"
          @click="activeId = c.id"
        >
          <span class="ms2d__model-id">{{ c.id }}</span>
          <span class="ms2d__model-label">{{ c.label }}</span>
          <span class="ms2d__model-stats num">
            {{ t('visualization.ms2Discrimination.stats', { b: c.counts.b ?? 0, y: c.counts.y ?? 0, cov: Math.round(c.coverage * 100), disc: discCount(c.id) }) }}
          </span>
        </button>
      </div>
    </header>

    <div class="ms2d__seq mono" :aria-label="t('visualization.ms2Discrimination.sequence')">
      <button
        v-for="r in residues"
        :key="r.pos"
        type="button"
        class="ms2d__aa"
        :class="{ 'is-b': r.b, 'is-y': r.y, 'is-lit': r.lit, 'has-mod': r.mod }"
        :title="r.mod ? `${r.aa}${r.pos} · ${r.mod}` : `${r.aa}${r.pos}`"
        @click="selectResidue(r.pos)"
      >{{ r.aa }}</button>
    </div>

    <div class="ms2d__toolbar">
      <button type="button" class="ms2d__tool" @click="zoomToDiscriminating">{{ t('visualization.ms2Discrimination.zoomDiscriminating') }}</button>
      <button type="button" class="ms2d__tool" @click="resetZoom">{{ t('visualization.ms2Discrimination.resetZoom') }}</button>
      <span class="ms2d__hint">{{ t('visualization.ms2Discrimination.hint') }}</span>
      <span v-if="selectedMatch" class="ms2d__readout mono num">
        {{ selectedMatch.ion }}{{ selectedMatch.n }}<sup>{{ selectedMatch.q }}+</sup>
        · m/z {{ selectedMatch.mz.toFixed(4) }} · {{ selectedMatch.ppm.toFixed(2) }} ppm
      </span>
    </div>

    <svg
      class="ms2d__plot"
      :width="width"
      :height="H"
      role="img"
      :aria-label="t('visualization.ms2Discrimination.plot')"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @dblclick="resetZoom"
    >
      <line :x1="PAD.l" :x2="width - PAD.r" :y1="PAD.t + plotH" :y2="PAD.t + plotH" class="ms2d__axis" />
      <g v-for="v in ticks" :key="v">
        <line :x1="x(v)" :x2="x(v)" :y1="PAD.t + plotH" :y2="PAD.t + plotH + 4" class="ms2d__axis" />
        <text :x="x(v)" :y="PAD.t + plotH + 18" class="ms2d__tick">{{ Math.round(v * 100) / 100 }}</text>
      </g>
      <line
        v-for="p in visiblePeaks"
        :key="p.mz"
        :x1="x(p.mz)" :x2="x(p.mz)" :y1="PAD.t + plotH" :y2="y(p.i)"
        :class="peakClass(p.mz)"
        @pointerdown.stop
        @click="selectPeak(p.mz)"
      />
      <g v-for="g in ghosts" :key="`${g.ion}${g.n}:${g.q}`" class="ms2d__ghost">
        <line :x1="g.x" :x2="g.x" :y1="PAD.t + plotH" :y2="PAD.t + 18" />
        <text :x="g.x" :y="PAD.t + 4">{{ g.ion }}{{ g.n }}<tspan baseline-shift="super" font-size="9">{{ g.q }}+</tspan> {{ g.mz.toFixed(2) }}</text>
        <text :x="g.x" :y="PAD.t + 15" class="ms2d__ghost-note">{{ t('visualization.ms2Discrimination.notObserved') }}</text>
      </g>
      <g v-for="l in labels" :key="l.key" class="ms2d__label">
        <text :x="l.x" :y="Math.max(PAD.t + 10, l.y - 20)" class="ms2d__label-ion">{{ l.m.ion }}{{ l.m.n }}<tspan baseline-shift="super" font-size="9">{{ l.m.q }}+</tspan></text>
        <text :x="l.x" :y="Math.max(PAD.t + 22, l.y - 7)" class="ms2d__label-sub">{{ l.m.mz.toFixed(3) }} · {{ l.m.ppm.toFixed(2) }} ppm</text>
      </g>
      <rect
        v-if="brush"
        :x="Math.min(x(brush.a), x(brush.b))" :y="PAD.t"
        :width="Math.abs(x(brush.b) - x(brush.a))" :height="plotH"
        class="ms2d__brush"
      />
    </svg>
  </div>
</template>

<style scoped>
.ms2d { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.ms2d__head { display: flex; flex-direction: column; gap: var(--space-2); }
.ms2d__title { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2); }
.ms2d__title strong { font-size: var(--text-md); color: var(--color-text); font-weight: 600; }
.ms2d__meta { font-size: var(--text-label); color: var(--color-text-muted); }
.ms2d__models { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.ms2d__model {
  display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px;
  border: 0; border-radius: var(--radius-md); background: var(--color-bg); cursor: pointer;
  font: inherit; font-size: var(--text-sm); color: var(--color-text-muted);
  box-shadow: inset 0 0 0 1px transparent;
  transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.ms2d__model:hover { background: var(--color-hover); }
.ms2d__model.is-active { color: var(--color-text); box-shadow: inset 0 0 0 1.5px var(--model); }
.ms2d__model-id {
  display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 6px;
  background: var(--model); color: var(--color-on-primary); font-weight: 600; font-size: 12px;
}
.ms2d__model-stats { color: var(--color-text-muted); font-size: var(--text-label); }

.ms2d__seq { display: flex; flex-wrap: wrap; gap: 1px; font-size: 13px; }
.ms2d__aa {
  width: 17px; height: 22px; padding: 0; border: 0; border-radius: 4px; background: none; cursor: pointer;
  font: inherit; color: var(--color-text-secondary); position: relative;
  transition: background var(--dur-fast) var(--ease-out);
}
.ms2d__aa:hover { background: var(--color-hover); }
.ms2d__aa.is-b { box-shadow: inset -2px -2px 0 var(--color-live); }
.ms2d__aa.is-y { box-shadow: inset 2px 2px 0 var(--ctp-pink); }
.ms2d__aa.is-b.is-y { box-shadow: inset -2px -2px 0 var(--color-live), inset 2px 2px 0 var(--ctp-pink); }
.ms2d__aa.has-mod::after {
  content: ''; position: absolute; left: 50%; top: -3px; width: 5px; height: 5px; margin-left: -2.5px;
  border-radius: 50%; background: var(--color-warning);
}
.ms2d__aa.is-lit { background: color-mix(in srgb, var(--color-live) 30%, transparent); color: var(--color-text); }

.ms2d__toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); font-size: var(--text-label); }
.ms2d__tool {
  border: 0; border-radius: var(--radius-sm); background: var(--color-bg); padding: 4px 10px; cursor: pointer;
  font: inherit; color: var(--color-text-secondary);
}
.ms2d__tool:hover { background: var(--color-hover); }
.ms2d__hint { color: var(--color-text-muted); }
.ms2d__readout { margin-left: auto; color: var(--color-primary); }

.ms2d__plot { display: block; user-select: none; touch-action: none; cursor: crosshair; overflow: visible; }
.ms2d__axis { stroke: var(--color-border-panel-strong); stroke-width: 1; }
.ms2d__tick { font-size: 11px; fill: var(--color-text-muted); text-anchor: middle; font-family: var(--font-mono); }
.pk { stroke: var(--color-border-panel-strong); stroke-width: 1.4; cursor: pointer; }
.pk--n { stroke: var(--color-primary); stroke-width: 2.2; }
.pk--c { stroke: var(--ctp-pink); stroke-width: 2.2; }
.pk--disc { stroke-width: 3.6; }
.pk--lit { stroke: var(--color-live); stroke-width: 4.2; filter: drop-shadow(0 0 3px color-mix(in srgb, var(--color-live) 60%, transparent)); }
.ms2d__label text { text-anchor: middle; font-family: var(--font-mono); pointer-events: none; }
.ms2d__label-ion { font-size: 13px; font-weight: 600; fill: var(--color-primary); }
.ms2d__label-sub { font-size: 10.5px; fill: var(--color-text-muted); }
.ms2d__ghost line { stroke: var(--status-failed); stroke-width: 1.4; stroke-dasharray: 5 5; }
.ms2d__ghost text { font-size: 11.5px; fill: var(--status-failed); text-anchor: middle; font-family: var(--font-mono); }
.ms2d__ghost .ms2d__ghost-note { font-family: inherit; font-size: 10.5px; }
.ms2d__brush { fill: color-mix(in srgb, var(--color-live) 14%, transparent); stroke: var(--color-live); stroke-width: 1; }
</style>
