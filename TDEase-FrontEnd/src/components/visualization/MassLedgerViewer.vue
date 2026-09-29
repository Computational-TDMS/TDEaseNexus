<!--
  MassLedgerViewer — the resolve-shift result's mass accounting, rendered as
  the ledger it is: one signed row per chemistry term, the kernel's own model
  sum, and the closure verdict against the observed shift. Read model:
  `services/visualization/massLedger.ts`; every number shown is the kernel's
  own — this surface never re-derives chemistry.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { MassLedgerModel } from '@/services/visualization/massLedger'

defineProps<{ model: MassLedgerModel }>()
const { t } = useI18n()

/** Four decimals, the ledger's working precision — Da deltas at ppm stakes. */
function signed(value: number): string {
  const abs = Math.abs(value).toFixed(4)
  return value < 0 ? `−${abs}` : `+${abs}`
}
function plain(value: number): string {
  return Math.abs(value).toFixed(4)
}
</script>

<template>
  <div class="mass-ledger">
    <header class="mass-ledger__head">
      <span v-if="model.combination" class="mass-ledger__combination">{{ model.combination }}</span>
      <span class="mass-ledger__sequence mono">{{ model.sequence }}</span>
    </header>

    <dl class="mass-ledger__rows mono">
      <div v-for="(term, index) in model.terms" :key="index" class="mass-ledger__row">
        <dt>
          <span>{{ term.name ?? t('workbench.massLedger.shift') }}</span>
          <span v-if="term.site !== null" class="mass-ledger__site">{{ t('workbench.massLedger.site', { site: term.site }) }}</span>
        </dt>
        <dd>{{ signed(term.delta) }}</dd>
      </div>
      <div v-if="model.freeMass" class="mass-ledger__row">
        <dt><span>{{ t('workbench.massLedger.residual') }}</span></dt>
        <dd>{{ signed(model.freeMass) }}</dd>
      </div>
      <div class="mass-ledger__row mass-ledger__row--sum">
        <dt><span>{{ t('workbench.massLedger.modelShift') }}</span></dt>
        <dd>{{ signed(model.modelShift) }}</dd>
      </div>
    </dl>

    <div class="mass-ledger__verdict mono">
      <div class="mass-ledger__box">
        <span>{{ t('workbench.massLedger.observed') }}</span>
        <b class="num">{{ plain(model.observedShift) }}</b>
      </div>
      <div class="mass-ledger__box">
        <span>{{ t('workbench.massLedger.model') }}</span>
        <b class="num">{{ plain(model.modelShift) }}</b>
      </div>
      <div class="mass-ledger__box">
        <span>{{ t('workbench.massLedger.error') }}</span>
        <b class="num">{{ plain(model.closureErrorDa) }} Da</b>
        <small v-if="model.closureErrorPpm !== null" class="num">{{ model.closureErrorPpm.toFixed(2) }} ppm</small>
      </div>
    </div>

    <p v-if="model.proforma" class="mass-ledger__proforma mono">{{ model.proforma }}</p>
  </div>
</template>

<style scoped>
.mass-ledger {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 560px;
  padding: var(--space-3);
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-md);
  background: var(--color-bg-card);
}

.mass-ledger__head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}
.mass-ledger__combination {
  overflow: hidden;
  color: var(--color-text);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mass-ledger__sequence {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mass-ledger__rows {
  margin: 0;
  display: flex;
  flex-direction: column;
}
.mass-ledger__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-1) 0;
}
.mass-ledger__row dt {
  display: flex;
  align-items: baseline;
  gap: var(--space-1-5);
  min-width: 0;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mass-ledger__site {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.mass-ledger__row dd {
  flex: none;
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.mass-ledger__row--sum {
  margin-top: var(--space-1);
  padding-top: var(--space-2);
  border-top: var(--line-w) solid var(--line-seam-strong);
  font-weight: 600;
}

.mass-ledger__verdict {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.mass-ledger__box {
  display: flex;
  flex-direction: column;
  gap: var(--space-0-5);
  flex: 1 1 auto;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
}
.mass-ledger__box span {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.mass-ledger__box b {
  font-weight: 600;
}
.mass-ledger__box small {
  color: var(--color-text-muted);
}

.mass-ledger__proforma {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
</style>
