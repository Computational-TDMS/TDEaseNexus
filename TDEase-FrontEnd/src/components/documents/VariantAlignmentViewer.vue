<!--
  Read-only render of a VariantAlignmentModel: the identified protein
  variants of one sample, reference-aligned against the longest identified
  sequence and drawn in the Figure-5C idiom — consensus on top, deviations
  in red, gaps as dashes, identified rows tinted, theoretical mass per row
  and a conservation strip per block.

  The component is pure presentation: it receives a finished model and never
  reads files. Column identity renders as plain text — only mismatches and
  gaps become spans — so even proteome-scale models stay a few thousand DOM
  nodes.
-->
<template>
  <section class="variant-alignment" data-render-target="toppic-variants">
    <header v-if="model.rows.length" class="variant-alignment__summary">
      <span>
        <strong>{{ identifiedCount }}</strong>
        {{ t('workbench.fileDocument.variants.identified') }}
      </span>
      <span v-if="model.familyCount > 0">
        <strong>{{ model.familyCount }}</strong>
        {{ t('workbench.fileDocument.variants.family') }}
      </span>
      <span v-if="model.skipped.length" class="variant-alignment__warning">
        {{ t('workbench.fileDocument.variants.skipped', { count: model.skipped.length }) }}
      </span>
      <span v-if="fastaName" class="variant-alignment__fasta">{{ fastaName }}</span>
    </header>

    <p v-if="!model.rows.length" class="variant-alignment__empty">
      {{ t('workbench.fileDocument.variants.empty') }}
    </p>

    <div v-else class="variant-alignment__scroll">
      <div v-for="block in blocks" :key="block.start" class="variant-alignment__block">
        <div class="variant-alignment__row" aria-hidden="true">
          <span class="variant-alignment__label" />
          <span class="variant-alignment__cells is-ruler">{{ block.ruler }}</span>
        </div>

        <div class="variant-alignment__row is-consensus">
          <span class="variant-alignment__label" :title="model.referenceAccession">
            {{ t('workbench.fileDocument.variants.consensus') }}
          </span>
          <span class="variant-alignment__cells">
            <span v-for="(segment, index) in block.consensus" :key="index" :class="segment.type">{{ segment.text }}</span>
          </span>
        </div>

        <div
          v-for="row in model.rows"
          :key="row.accession"
          class="variant-alignment__row"
          :class="{ 'is-identified': row.identified, 'is-span-only': row.state === 'span-only' }"
        >
          <span class="variant-alignment__label" :title="rowLabelTitle(row)">
            <strong>{{ row.accession }}</strong>
            <small v-if="row.theoreticalMass !== null">
              {{ row.theoreticalMass.toFixed(2) }} {{ t('workbench.fileDocument.variants.massUnit') }}
            </small>
          </span>
          <span class="variant-alignment__cells">
            <span
              v-for="(segment, index) in block.rows.get(row.accession) ?? []"
              :key="index"
              :class="segment.type"
            >{{ segment.text }}</span>
          </span>
        </div>

        <div class="variant-alignment__row is-conservation" aria-hidden="true">
          <span class="variant-alignment__label" />
          <span class="variant-alignment__cells is-bars">
            <span
              v-for="(value, index) in block.conservation"
              :key="index"
              class="variant-alignment__bar"
              :style="{ height: barHeight(value) }"
            />
          </span>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AlignedVariantRow, AlignmentSegment, VariantAlignmentModel } from '@/services/sequence/variantAlignment'
import { alignmentSegments } from '@/services/sequence/variantAlignment'

const props = defineProps<{ model: VariantAlignmentModel; fastaName?: string }>()
const { t } = useI18n()

const BLOCK_COLUMNS = 60

const identifiedCount = computed(() => props.model.rows.filter((row) => row.identified).length)

interface BlockView {
  start: number
  ruler: string
  consensus: AlignmentSegment[]
  rows: Map<string, AlignmentSegment[]>
  conservation: number[]
}

const blocks = computed<BlockView[]>(() => {
  const model = props.model
  const views: BlockView[] = []
  for (let start = 0; start < Math.max(model.columnCount, 1); start += BLOCK_COLUMNS) {
    const end = Math.min(start + BLOCK_COLUMNS, model.columnCount)
    const rows = new Map<string, AlignmentSegment[]>()
    for (const row of model.rows) rows.set(row.accession, alignmentSegments(row.alignedSequence, model.consensus, start, end))
    views.push({
      start,
      ruler: rulerFor(start, end - start),
      consensus: alignmentSegments(model.consensus, model.consensus, start, end),
      rows,
      conservation: model.conservation.slice(start, end),
    })
  }
  return views
})

function rulerFor(start: number, width: number): string {
  const chars = new Array<string>(width).fill(' ')
  for (let index = start; index < start + width; index++) {
    if ((index + 1) % 10 !== 0) continue
    const label = String(index + 1)
    for (let digit = 0; digit < label.length; digit++) {
      const position = index - start - label.length + 1 + digit
      if (position >= 0 && position < width) chars[position] = label[digit]!
    }
  }
  return chars.join('')
}

function barHeight(value: number): string {
  return `${Math.round(2 + value * 12)}px`
}

function rowLabelTitle(row: AlignedVariantRow): string {
  return row.facts ? `${row.description}\n${row.facts.matchCount} × PrSM` : row.description
}
</script>

<style scoped>
.variant-alignment {
  width: 100%;
  min-width: 0;
  color: var(--color-text);
}

.variant-alignment__summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--line-w) solid var(--line-hairline);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.variant-alignment__summary strong { color: var(--color-text); }
.variant-alignment__warning { color: var(--color-warning-text); }
.variant-alignment__fasta {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--text-label);
}

.variant-alignment__empty {
  margin: 0;
  padding: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.variant-alignment__scroll {
  overflow-x: auto;
}

.variant-alignment__block {
  display: inline-block;
  vertical-align: top;
  padding: var(--space-2) var(--space-3);
}

.variant-alignment__row {
  display: flex;
  align-items: stretch;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.variant-alignment__row.is-ruler,
.variant-alignment__row.is-conservation {
  min-height: 18px;
  color: var(--color-text-muted);
  font-size: var(--text-label);
}

.variant-alignment__label {
  position: sticky;
  left: 0;
  z-index: var(--z-raised);
  flex: 0 0 24ch;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 var(--space-2);
  overflow: hidden;
  background: var(--color-bg);
  font-family: var(--font-sans);
}

.variant-alignment__label strong {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--text-label);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.variant-alignment__label small {
  color: var(--color-text-muted);
  font-size: var(--text-label);
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

.variant-alignment__row.is-consensus .variant-alignment__label {
  color: var(--color-text);
  font-weight: 600;
  font-size: var(--text-label);
}

.variant-alignment__row.is-identified { background: var(--color-warning-soft); }
.variant-alignment__row.is-identified .variant-alignment__label { background: color-mix(in srgb, var(--color-warning) 15%, var(--color-bg)); }
.variant-alignment__row.is-identified .variant-alignment__label strong { color: var(--color-text); }
.variant-alignment__row.is-span-only .variant-alignment__label strong { color: var(--color-warning-text); }

.variant-alignment__cells {
  flex: 1 1 auto;
  padding: 0 var(--space-2);
  white-space: pre;
}

.variant-alignment__cells.is-ruler {
  color: var(--color-text-muted);
  font-size: var(--text-label);
  line-height: inherit;
}

.variant-alignment__cells .match { color: var(--color-text); }
.variant-alignment__row.is-consensus .variant-alignment__cells { font-weight: 600; }
.variant-alignment__row.is-consensus .variant-alignment__cells .match { color: var(--color-text); }
.variant-alignment__cells .mismatch { color: var(--color-error-text); }
.variant-alignment__cells .gap { color: var(--color-text-muted); }

.variant-alignment__cells.is-bars {
  display: flex;
  align-items: flex-end;
  gap: 0;
  padding-bottom: 2px;
  font-size: var(--text-sm);
}

.variant-alignment__bar {
  flex: 0 0 1ch;
  background: color-mix(in srgb, var(--color-primary) 55%, var(--color-bg));
}
</style>
