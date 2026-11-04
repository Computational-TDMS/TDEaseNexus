<script setup lang="ts">
/**
 * BashCallRow — bash's expanded body. A plain shell call renders exactly the
 * generic row; a `tdeasenexus-toolbox` call (the mass-spec kernel) adds a
 * typed result card under it — command, request, verdict and the top
 * candidates — read from the kernel's JSON envelope (utils/toolbox-result).
 */
import { computed } from 'vue'
import ToolCallRow from './ToolCallRow.vue'
import { useToolCallRenderContext } from './renderContext'
import { toolboxSummary } from '@/utils/toolbox-result'

const ctx = useToolCallRenderContext()
const summary = computed(() => toolboxSummary(ctx.tool))
</script>

<template>
  <div class="bash-call">
    <ToolCallRow />
    <div v-if="summary" class="toolbox-card" :class="summary.verdict ? `is-${summary.verdict.tone}` : 'is-partial'">
      <div class="toolbox-card__head">
        <span class="toolbox-card__cmd mono">{{ summary.command }}</span>
        <span v-for="p in summary.params" :key="p" class="toolbox-card__param mono">{{ p }}</span>
        <span v-if="summary.verdict" class="toolbox-card__verdict">{{ summary.verdict.text }}</span>
        <span v-if="summary.elapsedMs !== undefined" class="toolbox-card__elapsed mono num">{{ summary.elapsedMs }} ms</span>
      </div>
      <ol v-if="summary.rows.length" class="toolbox-card__rows">
        <li v-for="(row, i) in summary.rows" :key="i" class="toolbox-card__row">
          <span class="toolbox-card__label">{{ row.label }}</span>
          <span v-if="row.detail" class="toolbox-card__detail">{{ row.detail }}</span>
          <span class="toolbox-card__value mono num">{{ row.value }}</span>
        </li>
      </ol>
      <div v-if="summary.warnings" class="toolbox-card__warn">⚠ {{ summary.warnings }}</div>
    </div>
  </div>
</template>

<style scoped>
.toolbox-card {
  margin: 4px 0 6px 22px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-card);
  font-size: var(--text-label);
  box-shadow: inset 2px 0 0 var(--color-border);
}
.toolbox-card.is-positive { box-shadow: inset 2px 0 0 var(--color-success); }
.toolbox-card.is-negative { box-shadow: inset 2px 0 0 var(--color-error); }
.toolbox-card__head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.toolbox-card__cmd { color: var(--color-primary); font-weight: 600; }
.toolbox-card__param { color: var(--color-text-secondary); }
.toolbox-card__verdict { font-weight: 600; color: var(--color-text); }
.is-negative .toolbox-card__verdict { color: var(--color-error-text); }
.is-positive .toolbox-card__verdict { color: var(--color-success-text); }
.toolbox-card__elapsed { margin-left: auto; color: var(--color-text-muted); }
.toolbox-card__rows { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 2px; }
.toolbox-card__row { display: flex; align-items: baseline; gap: 8px; }
.toolbox-card__label { color: var(--color-text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toolbox-card__detail { color: var(--color-text-muted); }
.toolbox-card__value { margin-left: auto; color: var(--color-text-secondary); }
.toolbox-card__warn { margin-top: 4px; color: var(--color-warning-text); }
</style>
