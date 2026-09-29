<script setup lang="ts">
/**
 * ToolCallRow — the generic expanded-body row for one tool call, and the
 * registry's default renderer. Everything identity-specific (icon, action
 * phrase, status glyph) comes from the render context the owning group
 * provided; a per-tool renderer replaces this row wholesale via the registry
 * (`tool-call/registry.ts`), not by growing branches here.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Close, Minus } from '@element-plus/icons-vue'
import ToolIcon from '../ToolIcon.vue'
import { bareToolName, toolActionKey, toolIconName } from '@/utils/tool-identity'
import { useToolCallRenderContext } from './renderContext'

// The context is a getter object — wrapping in computeds keeps every read
// tracking the live tool object (status flips, the live→settled identity
// swap) instead of snapshotting at inject time.
const ctx = useToolCallRenderContext()
const tool = computed(() => ctx.tool)
const isSingle = computed(() => ctx.isSingle)

const { t } = useI18n()

const label = computed(() => {
  const key = toolActionKey(tool.value.name)
  return key ? t(key) : bareToolName(tool.value.name)
})

/** Summary-glyph class per render status; `unknown` keeps the legacy failure look. */
function statusGlyphClass(status: typeof tool.value.status): string {
  if (status === 'succeeded') return 'done'
  if (status === 'cancelled') return 'cancelled'
  return 'failed'
}

/** Short inline verdict for a settled approval, or '' when none. */
const approvalVerdict = computed(() => {
  if (!tool.value.approval) return ''
  return tool.value.approval.decision === 'approved'
    ? t('agent.approval.approved')
    : t('agent.approval.declined')
})
</script>

<template>
  <div class="tool-entry">
    <div
      class="tool-indicator"
      :class="{ 'tool-indicator--bare': isSingle }"
      :data-tool="tool.name"
      :data-done="String(tool.done)"
    >
      <ToolIcon v-if="!isSingle" :name="toolIconName(tool.name)" />
      <span v-if="!isSingle" class="tool-desc">{{ label }}</span>
      <span class="tool-name mono" :title="tool.name">{{ bareToolName(tool.name) }}</span>
      <span
        v-if="tool.full"
        class="tool-detail tool-detail--full"
        :title="tool.full"
      >{{ tool.full }}</span>
      <span v-if="tool.error" class="tool-detail tool-detail--full tool-error">{{ tool.error }}</span>
      <span
        v-if="approvalVerdict"
        class="tool-approval"
        :class="tool.approval?.decision === 'approved' ? 'is-approved' : 'is-declined'"
        :title="tool.approval?.reason"
      >{{ approvalVerdict }}</span>
      <span
        v-if="!isSingle && tool.status !== 'running'"
        class="tool-status"
        :class="statusGlyphClass(tool.status)"
        :title="tool.status === 'cancelled' ? t('agent.toolGroup.cancelled') : undefined"
        aria-hidden="true"
      ><el-icon :size="14"><Check v-if="tool.status === 'succeeded'" /><Minus v-else-if="tool.status === 'cancelled'" /><Close v-else /></el-icon></span>
      <span v-if="!isSingle && tool.status === 'running'" class="tool-dots" aria-hidden="true"></span>
    </div>
    <!-- Output section: the one dimension the args summary can never
         carry. Empty output is an explicit state, not silence; a cut
         preview states the verbatim total. -->
    <div
      v-if="tool.status === 'succeeded' && tool.resultPreview"
      class="tool-output"
      :class="{ 'tool-output--empty': !tool.resultPreview.text }"
    >
      <span class="tool-output-label">{{ t('agent.toolGroup.output') }}</span>
      <span v-if="tool.resultPreview.text" class="tool-output-text">{{ tool.resultPreview.text }}</span>
      <span v-else class="tool-output-text tool-output-text--empty">{{ t('agent.toolGroup.noOutput') }}</span>
      <span
        v-if="tool.resultPreview.truncated"
        class="tool-output-meta mono"
      >{{ t('agent.toolGroup.outputTruncated', { count: tool.resultPreview.totalChars }) }}</span>
    </div>
  </div>
</template>

<style scoped>
.tool-entry { min-width: 0; }

.tool-indicator {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-label);
  color: var(--color-text-secondary);
  padding: 2px 0;
  line-height: 1.5;
  max-width: 100%;
}

/* A single-tool body row has no phrase of its own (the summary IS the tool);
   it still shows the raw identity (.tool-name) the summary hid. */
.tool-name {
  flex-shrink: 0;
  font-size: var(--domain-text-meta);
  color: var(--color-text-muted);
  opacity: 0.85;
}

.tool-desc {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-detail {
  flex: 1;
  min-width: 0;
  font-size: var(--domain-text-meta);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-detail.tool-error { color: var(--color-error-text); }

/* Expanded body: the FULL (un-truncated) detail, allowed to wrap instead of
   clipping — a long command/path reads in full here, not as an ellipsis. The
   row is flex-start so a multi-line command keeps the label and status glyph
   aligned to its first line. */
.tool-detail--full {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow: visible;
  text-overflow: clip;
}

/* Inline approval verdict: a quiet pill that shows the call was gated on
   consent and what the user decided, without a separate card. Sits between
   the detail and the status glyph so the whole call reads on one line. */
.tool-approval {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: var(--radius-xs);
  font-size: var(--domain-text-meta);
  font-family: var(--font-mono);
  line-height: 1.6;
  border: var(--line-w) solid var(--line-hairline);
  color: var(--color-text-muted);
}
.tool-approval.is-approved { color: var(--color-success-text); border-color: color-mix(in srgb, var(--color-success) 35%, transparent); }
.tool-approval.is-declined { color: var(--color-error-text); border-color: color-mix(in srgb, var(--color-error) 35%, transparent); }

.tool-status { margin-left: auto; font-size: var(--text-sm); }
.tool-status.done { color: var(--color-success-text); }
.tool-status.failed { color: var(--color-error-text); }
/* Interrupted, not failed: the neutral minus keeps cancelled legible as
   "the turn ended around this call" — danger red would teach users that a
   cancelled turn broke something. */
.tool-status.cancelled { color: var(--color-text-muted); }

/* Output preview: a labeled, quieter echo of the result under the call row,
   set off by indent alone (no callout rule). Pre-wrap so line structure in
   the output survives. */
.tool-output {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0 var(--space-1);
}
.tool-output-label {
  font-size: var(--domain-text-meta);
  color: var(--color-text-muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.tool-output-text {
  font-family: var(--font-mono);
  font-size: var(--domain-text-meta);
  color: var(--color-text-secondary);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.tool-output-text--empty { color: var(--color-text-muted); font-style: italic; }
.tool-output-meta {
  font-size: var(--domain-text-meta);
  color: var(--color-text-muted);
}

/*
  CSS shimmer for the "running" cue. `::after` carries three dots revealed one
  at a time by a stepped width animation ("" → "." → ".." → "..." → ""). No JS
  timer, no ref, no re-render — the previous setInterval re-rendered this row
  twice a second for every running tool in a turn.
*/
.tool-dots {
  display: inline-block;
  margin-left: auto;
  font-weight: 700;
  letter-spacing: 0.1em;
  /* The running cue carries the live channel colour (The Living Channel
     Rule) — gray dots read as "static text", celadon dots read as "working". */
  color: var(--color-live);
  min-width: 1.5em;
}
.tool-dots::after {
  content: '...';
  display: inline-block;
  width: 0;
  overflow: hidden;
  animation: tool-dots-reveal 1.5s steps(4, end) infinite;
}
@keyframes tool-dots-reveal {
  0%   { width: 0; }
  100% { width: 1.5em; }
}

@media (prefers-reduced-motion: reduce) {
  .tool-dots::after { animation: none; width: 1.5em; }
}
</style>
