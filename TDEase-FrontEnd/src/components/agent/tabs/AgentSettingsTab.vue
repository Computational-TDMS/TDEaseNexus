<!--
  AgentSettingsTab — the per-turn runtime config drawer (a right-sidebar tab).

  Holds the three low-frequency controls that used to crowd the Composer's
  toolbar: model selection, reasoning effort, and the context-window readout.
  The high-frequency switches (mindset, permission) stay in the Composer; this
  drawer is for configuration a user sets once and rarely touches mid-session.

  Model and thinking effort bind straight to the settings store (persisted,
  applied on the next turn's bind). The context readout and the model's image
  capability come from the live turn via `inject(AGENT_TURN_READOUT)` —
  AgentPage provides it, because those values (contextTokensUsed, contextWindow,
  modelSupportsImages) live in `useAgentTurn` and refresh only when Node binds
  the session. So the readout is honest about what has actually taken effect,
  not what was just selected: switching model updates the SessionBar label at
  once, but the context-window number waits for the next turn (the banner says
  so, rather than pretending).
-->
<template>
  <div class="agent-settings">
    <!-- Model -->
    <section class="agent-settings__section">
      <h3 class="agent-settings__heading">{{ t('agent.settingsTab.model') }}</h3>
      <div class="agent-settings__row">
        <label class="agent-settings__field">
          <span class="agent-settings__field-label">{{ t('agent.settingsTab.provider') }}</span>
          <select
            class="agent-settings__select"
            :value="settingsStore.provider"
            @change="onProviderChange"
          >
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.displayName }}</option>
          </select>
        </label>
        <label class="agent-settings__field">
          <span class="agent-settings__field-label">{{ t('agent.settingsTab.modelName') }}</span>
          <select
            class="agent-settings__select"
            :value="settingsStore.model"
            :disabled="models.length === 0"
            @change="onModelChange"
          >
            <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
          </select>
        </label>
      </div>
      <p v-if="!hasCredential" class="agent-settings__warn">
        {{ t('agent.settingsTab.noCredential', { provider: activeProviderName }) }}
      </p>
      <p class="agent-settings__note">{{ t('agent.settingsTab.modelNote') }}</p>
    </section>

    <!-- Reasoning effort -->
    <section class="agent-settings__section">
      <h3 class="agent-settings__heading">{{ t('agent.settingsTab.reasoning') }}</h3>
      <div class="agent-settings__segmented" role="radiogroup" :aria-label="t('agent.thinking.effortTitle')">
        <button
          v-for="lvl in thinkingLevels"
          :key="lvl.value"
          type="button"
          role="radio"
          class="agent-settings__seg-btn"
          :class="{ active: agentStore.thinkingLevel === lvl.value }"
          :aria-checked="agentStore.thinkingLevel === lvl.value"
          :title="t(lvl.titleKey)"
          @click="agentStore.thinkingLevel = lvl.value"
        >
          {{ t(lvl.labelKey) }}
        </button>
      </div>
      <p class="agent-settings__seg-hint">{{ activeThinkingHint }}</p>
    </section>

    <!-- Context window readout -->
    <section class="agent-settings__section">
      <h3 class="agent-settings__heading">{{ t('agent.settingsTab.context') }}</h3>
      <div class="agent-settings__ctx" :class="`agent-settings__ctx--${ctxTone}`">
        <svg class="agent-settings__ctx-ring" width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
          <circle class="agent-settings__ctx-track" cx="24" cy="24" r="20" fill="none" stroke-width="4" />
          <circle
            class="agent-settings__ctx-fill"
            cx="24" cy="24" r="20" fill="none" stroke-width="4"
            stroke-linecap="round"
            :stroke-dasharray="ctxRingDash"
            :stroke-dashoffset="ctxRingOffset"
            transform="rotate(-90 24 24)"
          />
        </svg>
        <div class="agent-settings__ctx-text">
          <span class="agent-settings__ctx-pct">{{ ctxTotal && ctxUsed != null ? `${ctxPct}%` : '—' }}</span>
          <span class="agent-settings__ctx-detail">{{ ctxUsedLabel }} / {{ ctxTotalLabel }}</span>
          <span v-if="ctxCacheLabel" class="agent-settings__ctx-cache">
            {{ t('agent.settingsTab.contextCache', { pct: ctxCacheLabel }) }}
          </span>
        </div>
      </div>
      <p class="agent-settings__note">{{ t('agent.settingsTab.contextNote') }}</p>
    </section>
    <!-- Capabilities (opt-in tool surfaces; applied on the next bind) -->
    <section class="agent-settings__section">
      <h3 class="agent-settings__heading">{{ t('agent.settingsTab.capabilities') }}</h3>
      <label class="agent-settings__toggle">
        <input
          type="checkbox"
          class="agent-settings__toggle-input"
          :checked="settingsStore.ptcEnabled"
          @change="onPtcToggle"
        />
        <span class="agent-settings__toggle-text">
          <span class="agent-settings__toggle-label">{{ t('agent.settingsTab.ptc') }}</span>
          <span class="agent-settings__toggle-hint">{{ t('agent.settingsTab.ptcHint') }}</span>
        </span>
      </label>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/settings'
import { useAgentStore } from '@/stores/agent'
import { AGENT_TURN_READOUT, formatTokensK, type AgentTurnReadout } from '../turnReadout'
import type { ThinkingLevel } from '@/contracts/agent-runtime'

const { t } = useI18n()
const settingsStore = useSettingsStore()
const agentStore = useAgentStore()
// The context-window / vision readout comes from the live turn (see the
// component header). `inject` returns the fallback `null` readout outside the
// Agent page, but this tab only ever mounts inside AgentPage's provide scope.
const readout = inject(AGENT_TURN_READOUT, null as AgentTurnReadout | null)

const providers = computed(() => settingsStore.availableProviders())
const models = computed(() => settingsStore.availableModels())
const activeProviderName = computed(() =>
  providers.value.find((p) => p.id === settingsStore.provider)?.displayName ?? settingsStore.provider,
)
const hasCredential = computed(() => settingsStore.hasProviderCredential())

function onProviderChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  settingsStore.setProvider(value)
}
function onModelChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  settingsStore.setModel(value)
}
function onPtcToggle(event: Event) {
  settingsStore.ptcEnabled = (event.target as HTMLInputElement).checked
}

// Reasoning effort — reuses the canonical ThinkingLevel union so this stays in
// sync with what useAgentTurn ships to Node. The hint under the segmented
// control mirrors the level's titleKey so a hovered level and the selected one
// read the same explanation.
const thinkingLevels: Array<{ value: ThinkingLevel; labelKey: string; titleKey: string }> = [
  { value: 'off', labelKey: 'agent.thinking.level.off', titleKey: 'agent.thinking.level.offHint' },
  { value: 'low', labelKey: 'agent.thinking.level.low', titleKey: 'agent.thinking.level.lowHint' },
  { value: 'medium', labelKey: 'agent.thinking.level.medium', titleKey: 'agent.thinking.level.mediumHint' },
  { value: 'high', labelKey: 'agent.thinking.level.high', titleKey: 'agent.thinking.level.highHint' },
  { value: 'xhigh', labelKey: 'agent.thinking.level.xhigh', titleKey: 'agent.thinking.level.xhighHint' },
  { value: 'max', labelKey: 'agent.thinking.level.max', titleKey: 'agent.thinking.level.maxHint' },
]
const activeThinkingHint = computed(() => {
  const lvl = thinkingLevels.find((l) => l.value === agentStore.thinkingLevel)
  return lvl ? t(lvl.titleKey) : ''
})

// ── Context-window readout ──
// A larger SVG ring than the Composer's pill, with the percentage as the
// headline and "used / total" as the detail, plus the last request's cache hit
// rate underneath. The values are the LIVE occupancy Node pushed over the
// `context:changed` channel over the bound model's context window. `null`
// occupancy (post-compaction / never bound) reads "—" — never a fabricated
// denominator or a stale settlement sum. The window comes from the model's
// contextWindow via the injected readout; until a model is bound it is unknown
// and the total shows "—".
const ctxUsed = computed<number | null>(() => readout?.contextTokensUsed.value ?? null)
const ctxCacheHitRate = computed<number | null>(() => readout?.contextCacheHitRate.value ?? null)
const ctxTotal = computed(() => {
  const w = readout?.contextWindow.value
  return w && w > 0 ? w : null
})
const ctxPct = computed(() => ctxTotal.value && ctxUsed.value != null ? Math.min(100, Math.round((ctxUsed.value / ctxTotal.value) * 100)) : 0)
const ctxTone = computed<'neutral' | 'warning' | 'danger'>(() => {
  if (ctxPct.value > 85) return 'danger'
  if (ctxPct.value > 60) return 'warning'
  return 'neutral'
})
const ctxUsedLabel = computed(() => ctxUsed.value == null ? '—' : formatTokensK(ctxUsed.value))
const ctxTotalLabel = computed(() => ctxTotal.value ? formatTokensK(ctxTotal.value) : '—')
const ctxCacheLabel = computed(() => {
  const hit = ctxCacheHitRate.value
  return hit == null ? null : `${Math.round(hit * 100)}%`
})
// Ring geometry: r=20 → circumference ≈ 125.66. Fill arc = pct × C.
const CTX_CIRC = 2 * Math.PI * 20
const ctxRingDash = computed(() => `${(ctxPct.value / 100) * CTX_CIRC} ${CTX_CIRC}`)
const ctxRingOffset = computed(() => 0)
</script>

<style scoped>
.agent-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  height: 100%;
  overflow: auto;
}

.agent-settings__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.agent-settings__heading {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-text, var(--color-text));
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.agent-settings__row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.agent-settings__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.agent-settings__field-label {
  font-size: var(--text-label);
  color: var(--color-text-muted, var(--color-text-muted));
}

.agent-settings__select {
  height: var(--row-h-sm);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-sm);
  padding: 0 var(--space-2);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out);
}
.agent-settings__select:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--color-primary) 40%, var(--color-border));
}
.agent-settings__select:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 1px;
}
.agent-settings__select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.agent-settings__warn {
  margin: 0;
  font-size: var(--text-label);
  color: var(--color-warning, var(--color-warning));
}

.agent-settings__note {
  margin: 0;
  font-size: var(--text-label);
  line-height: var(--text-label-lh);
  color: var(--color-text-muted, var(--color-text-muted));
}

/* Capability toggles */
.agent-settings__toggle {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-1) 0;
  cursor: pointer;
}
.agent-settings__toggle-input {
  margin: 2px 0 0;
  accent-color: var(--color-primary);
  cursor: pointer;
}
.agent-settings__toggle-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.agent-settings__toggle-label {
  font-size: var(--text-sm);
  color: var(--color-text);
}
.agent-settings__toggle-hint {
  font-size: var(--text-label);
  line-height: var(--text-label-lh);
  color: var(--color-text-muted, var(--color-text-muted));
}

/* Reasoning effort segmented control */
.agent-settings__segmented {
  display: inline-flex;
  flex-wrap: wrap;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.agent-settings__seg-btn {
  border: none;
  border-right: 1px solid var(--color-border-panel);
  background: var(--color-bg);
  color: var(--color-text-secondary);
  font-size: var(--text-label);
  padding: var(--space-1) var(--space-2);
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.agent-settings__seg-btn:last-child { border-right: none; }
.agent-settings__seg-btn:hover { background: var(--color-hover); color: var(--color-text); }
.agent-settings__seg-btn.active {
  background: var(--color-primary);
  color: var(--color-on-primary);
}
.agent-settings__seg-hint {
  margin: 0;
  font-size: var(--text-label);
  color: var(--color-text-muted, var(--color-text-muted));
}

/* Context-window readout */
.agent-settings__ctx {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2);
  border-radius: var(--radius-md);
  background: var(--color-bg);
}
.agent-settings__ctx-ring { flex-shrink: 0; }
.agent-settings__ctx-track {
  stroke: color-mix(in srgb, var(--color-text-muted) 30%, transparent);
}
.agent-settings__ctx-fill {
  stroke: var(--color-primary);
  transition: stroke-dasharray var(--dur-fast) var(--ease-out);
}
.agent-settings__ctx--warning .agent-settings__ctx-fill { stroke: var(--color-warning, var(--color-warning)); }
.agent-settings__ctx--danger  .agent-settings__ctx-fill { stroke: var(--color-error, var(--color-error)); }
.agent-settings__ctx-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.agent-settings__ctx-pct {
  font-size: var(--text-lg);
  font-weight: 600;
  font-family: var(--font-mono);
  color: var(--color-text, var(--color-text));
}
.agent-settings__ctx--warning .agent-settings__ctx-pct { color: var(--color-warning, var(--color-warning)); }
.agent-settings__ctx--danger  .agent-settings__ctx-pct { color: var(--color-error, var(--color-error)); }
.agent-settings__ctx-detail {
  font-size: var(--text-label);
  color: var(--color-text-muted, var(--color-text-muted));
  font-family: var(--font-mono);
}
.agent-settings__ctx-cache {
  font-size: var(--text-label);
  color: var(--color-text-muted, var(--color-text-muted));
  font-family: var(--font-mono);
}
.agent-settings__ctx--warning .agent-settings__ctx-cache { color: var(--color-warning, var(--color-warning)); }
.agent-settings__ctx--danger  .agent-settings__ctx-cache { color: var(--color-error, var(--color-error)); }

@media (prefers-reduced-motion: reduce) {
  .agent-settings__select,
  .agent-settings__seg-btn,
  .agent-settings__ctx-fill { transition: none; }
}
</style>
