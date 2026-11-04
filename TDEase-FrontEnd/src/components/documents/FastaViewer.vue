<template>
  <section class="fasta-viewer" data-render-target="fasta-formatted">
    <header class="fasta-viewer__summary">
      <span v-if="searching"><strong>{{ matchedIndexes.length }}</strong> / {{ document.records.length }} {{ t('workbench.fileDocument.fasta.sequences') }}</span>
      <span v-else><strong>{{ document.records.length }}</strong> {{ t('workbench.fileDocument.fasta.sequences') }}</span>
      <span><strong>{{ formattedResidues }}</strong> {{ t('workbench.fileDocument.fasta.residues') }}</span>
      <span v-if="document.invalidLineCount" class="fasta-viewer__warning">
        {{ t('workbench.fileDocument.fasta.invalidLines', { count: document.invalidLineCount }) }}
      </span>
    </header>

    <template v-if="document.records.length">
      <input
        v-model="query"
        class="fasta-viewer__search"
        type="search"
        :placeholder="t('workbench.fileDocument.fasta.searchPlaceholder')"
        :aria-label="t('workbench.fileDocument.fasta.searchPlaceholder')"
      >

      <div v-if="visibleRecords.length" class="fasta-viewer__records">
        <details
          v-for="(view, index) in visibleRecords"
          :key="`${view.record.id}:${index}`"
          class="fasta-viewer__record"
          :open="index === 0"
        >
          <summary>
            <span class="fasta-viewer__index">{{ index + 1 }}</span>
            <span class="fasta-viewer__identity">
              <strong><template v-if="view.record.id"><template v-for="(segment, i) in view.idSegments" :key="i"><mark v-if="segment.hit">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></template><template v-else>{{ t('workbench.fileDocument.fasta.unnamed') }}</template></strong>
              <span v-if="view.record.description"><template v-for="(segment, i) in view.descriptionSegments" :key="i"><mark v-if="segment.hit">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></span>
            </span>
            <span v-if="view.residueRanges.length" class="fasta-viewer__hits">
              {{ t('workbench.fileDocument.fasta.matchPositions', { positions: formatRanges(view.residueRanges) }) }}
            </span>
            <span class="fasta-viewer__length">{{ view.record.sequence.length.toLocaleString() }} aa/nt</span>
          </summary>
          <pre v-if="view.sequenceLines" class="fasta-viewer__sequence"><template v-for="(line, lineIndex) in view.sequenceLines" :key="lineIndex"><template v-for="(segment, segmentIndex) in line" :key="segmentIndex"><mark v-if="segment.hit">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template>{{ '\n' }}</template></pre>
          <pre v-else class="fasta-viewer__sequence">{{ wrapSequence(view.record.sequence) }}</pre>
        </details>
        <p v-if="hiddenCount" class="fasta-viewer__limit">
          {{ t('workbench.fileDocument.fasta.hiddenRecords', { count: hiddenCount }) }}
        </p>
      </div>

      <p v-else class="fasta-viewer__empty">{{ t('workbench.fileDocument.fasta.noMatches', { query: query.trim() }) }}</p>
    </template>

    <p v-else class="fasta-viewer__empty">{{ t('workbench.fileDocument.fasta.empty') }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  buildSequenceLines,
  fastaEntryMatches,
  fastaNeedles,
  fastaSearchEntry,
  findResidueRanges,
  parseFasta,
  splitTextMatches,
  wrapSequence,
  type FastaRecord,
  type TextSegment,
} from '@/services/fasta'

const props = defineProps<{ source: string }>()
const { t } = useI18n()
const document = computed(() => parseFasta(props.source))

const query = ref('')
const needles = computed(() => fastaNeedles(query.value))
const searching = computed(() => needles.value.header !== '')

// Lowercased fields are memoized per document, so each keystroke only scans
// prepared strings instead of re-lowercasing whole sequences.
const searchIndex = computed(() => document.value.records.map((record) => fastaSearchEntry(record)))
const matchedIndexes = computed(() => {
  if (!searching.value) return searchIndex.value.map((_, index) => index)
  const matched: number[] = []
  searchIndex.value.forEach((entry, index) => {
    if (fastaEntryMatches(entry, needles.value)) matched.push(index)
  })
  return matched
})

interface FastaRecordView {
  record: FastaRecord
  idSegments: TextSegment[]
  descriptionSegments: TextSegment[]
  residueRanges: Array<[number, number]>
  sequenceLines: TextSegment[][] | null
}

const visibleRecords = computed<FastaRecordView[]>(() => {
  const { header, sequence } = needles.value
  return matchedIndexes.value.slice(0, 500).map((recordIndex) => {
    const record = document.value.records[recordIndex]
    const residueRanges = searching.value && sequence ? findResidueRanges(record.sequence, sequence) : []
    return {
      record,
      idSegments: splitTextMatches(record.id, header),
      descriptionSegments: splitTextMatches(record.description, header),
      residueRanges,
      sequenceLines: residueRanges.length ? buildSequenceLines(record.sequence, residueRanges) : null,
    }
  })
})
const hiddenCount = computed(() => Math.max(0, matchedIndexes.value.length - visibleRecords.value.length))
const formattedResidues = computed(() => document.value.totalResidues.toLocaleString())

const HIT_BADGE_LIMIT = 3

function formatRanges(ranges: Array<[number, number]>): string {
  const shown = ranges.slice(0, HIT_BADGE_LIMIT).map(([start, end]) => (start === end ? `${start}` : `${start}–${end}`))
  return shown.join(', ') + (ranges.length > HIT_BADGE_LIMIT ? ', …' : '')
}
</script>

<style scoped>
.fasta-viewer {
  width: 100%;
  min-width: 0;
  color: var(--color-text);
}

.fasta-viewer__summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--line-w) solid var(--line-hairline);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.fasta-viewer__summary strong { color: var(--color-text); }
.fasta-viewer__warning { color: var(--color-warning-text); }

.fasta-viewer__search {
  display: block;
  width: calc(100% - var(--space-3) * 2);
  margin: var(--space-2) var(--space-3);
  padding: var(--space-1) var(--space-2);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-xs);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.fasta-viewer__search::placeholder { color: var(--color-text-muted); }

.fasta-viewer mark {
  border-radius: 2px;
  background: var(--color-warning-soft);
  color: inherit;
}

.fasta-viewer__record {
  border-bottom: var(--line-w) solid var(--line-hairline);
}

.fasta-viewer__record summary {
  display: grid;
  grid-template-columns: 4ch minmax(0, 1fr) auto auto;
  gap: var(--space-2);
  align-items: center;
  min-height: 38px;
  padding: var(--space-1) var(--space-3);
  cursor: pointer;
}

.fasta-viewer__record summary:hover { background: var(--color-hover); }
.fasta-viewer__record summary:focus-visible { outline: 2px solid var(--color-ring); outline-offset: -2px; }
.fasta-viewer__index, .fasta-viewer__length { color: var(--color-text-muted); font-size: var(--text-label); }
.fasta-viewer__index { font-variant-numeric: tabular-nums; }
.fasta-viewer__length { white-space: nowrap; }

.fasta-viewer__hits {
  color: var(--color-warning-text);
  font-family: var(--font-mono);
  font-size: var(--text-label);
  white-space: nowrap;
}

.fasta-viewer__identity {
  display: flex;
  min-width: 0;
  gap: var(--space-2);
  align-items: baseline;
}

.fasta-viewer__identity strong {
  flex: none;
  color: var(--color-primary);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.fasta-viewer__identity span {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fasta-viewer__sequence {
  margin: 0;
  padding: var(--space-3) calc(var(--space-3) + 6ch);
  overflow-x: auto;
  color: var(--color-text);
  background: var(--color-bg-secondary);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.7;
  letter-spacing: 0;
}

.fasta-viewer__limit, .fasta-viewer__empty {
  margin: 0;
  padding: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

@media (max-width: 640px) {
  .fasta-viewer__record summary { grid-template-columns: 3ch minmax(0, 1fr); }
  .fasta-viewer__hits, .fasta-viewer__length { grid-column: 2; }
  .fasta-viewer__identity { display: block; }
  .fasta-viewer__identity span { display: block; margin-top: 2px; }
  .fasta-viewer__sequence { padding-left: var(--space-3); }
}
</style>
