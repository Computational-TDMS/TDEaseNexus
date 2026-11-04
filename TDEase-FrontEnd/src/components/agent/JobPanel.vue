<!--
  JobPanel — the floating background-jobs panel, a right-rail state sibling of
  SubagentPanel. Lists `tdease.job.start` records (running / succeeded / failed
  / cancelled) with cancel and stdout/stderr peek. Completion is already pushed
  to the model by the context hook; this panel is the human's view of the same
  records the registry tracks.

  Speaks the shared design-token vocabulary (surface steps, status text tones,
  hairline seams) — an earlier draft reached for Element Plus's internal
  `--el-*` variables, which bypass the theme system entirely and rendered this
  panel off-voice in every non-default theme.
-->
<script setup lang="ts">
import { computed } from 'vue'
import { Close } from '@element-plus/icons-vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@/components/primitives/AppButton.vue'
import IconButton from '@/components/primitives/IconButton.vue'
import { useJobsStore } from '@/stores/jobs'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const { t } = useI18n()
const jobsStore = useJobsStore()
const jobs = computed(() => jobsStore.active)

function close(): void { emit('update:open', false) }
async function cancel(jobId: string): Promise<void> { await jobsStore.cancel(jobId) }
async function peek(jobId: string): Promise<void> { await jobsStore.peek(jobId, 40) }
</script>

<template>
  <section class="job-panel">
    <header class="job-panel__header">
      <span class="job-panel__title">{{ t('agent.jobs.title') }}</span>
      <IconButton size="xs" :aria-label="t('agent.jobs.close')" :title="t('agent.jobs.close')" @click="close">
        <el-icon :size="12" aria-hidden="true"><Close /></el-icon>
      </IconButton>
    </header>
    <div v-if="jobs.length === 0" class="job-panel__empty">{{ t('agent.jobs.empty') }}</div>
    <ul v-else class="job-panel__list">
      <li v-for="job in jobs" :key="job.jobId" class="job-panel__item">
        <div class="job-panel__item-head">
          <span class="job-panel__state" :data-state="job.state">{{ t(`agent.jobs.state.${job.state}`) }}</span>
          <code class="job-panel__command" :title="job.command">{{ job.command }}</code>
          <span v-if="job.elapsedS !== undefined" class="job-panel__elapsed mono">{{ job.elapsedS }}s</span>
        </div>
        <div v-if="job.exitCode !== undefined" class="job-panel__exit mono">{{ t('agent.jobs.exit', { code: job.exitCode }) }}</div>
        <div v-if="job.error" class="job-panel__error mono">{{ job.error.code }}: {{ job.error.message }}</div>
        <div v-if="jobsStore.peeks[job.jobId]" class="job-panel__peek">
          <pre v-if="jobsStore.peeks[job.jobId].stdoutTail" class="job-panel__stdout">{{ jobsStore.peeks[job.jobId].stdoutTail }}</pre>
          <pre v-if="jobsStore.peeks[job.jobId].stderrTail" class="job-panel__stderr">{{ jobsStore.peeks[job.jobId].stderrTail }}</pre>
        </div>
        <div class="job-panel__actions">
          <AppButton v-if="job.state === 'running'" variant="subtle" size="sm" @click="cancel(job.jobId)">
            {{ t('agent.jobs.cancel') }}
          </AppButton>
          <AppButton variant="subtle" size="sm" @click="peek(job.jobId)">
            {{ t('agent.jobs.peek') }}
          </AppButton>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.job-panel { display: flex; flex-direction: column; height: 100%; }
.job-panel__header {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--line-w) solid var(--line-seam);
}
.job-panel__title { font-weight: 600; font-size: var(--text-base); color: var(--color-text); }
.job-panel__empty { padding: var(--space-4); color: var(--color-text-muted); font-size: var(--text-sm); }
.job-panel__list { list-style: none; margin: 0; padding: 0; overflow: auto; flex: 1; }
.job-panel__item {
  padding: var(--space-2-5) var(--space-3);
  border-bottom: var(--line-w) solid var(--line-hairline);
}
.job-panel__item:last-child { border-bottom: none; }
.job-panel__item-head { display: flex; align-items: center; gap: var(--space-2); }
.job-panel__state {
  flex-shrink: 0;
  font-size: var(--text-label);
  padding: 1px var(--space-1-5);
  border-radius: var(--radius-xs);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.job-panel__state[data-state="running"]   { color: var(--color-primary-active); background: var(--color-primary-soft); text-transform: none; letter-spacing: 0; }
.job-panel__state[data-state="succeeded"] { color: var(--color-success-text); }
.job-panel__state[data-state="failed"]    { color: var(--color-error-text); }
.job-panel__state[data-state="cancelled"] { color: var(--color-text-muted); }
.job-panel__command {
  flex: 1; min-width: 0;
  font-family: var(--font-mono); font-size: var(--text-label);
  color: var(--color-text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.job-panel__elapsed { flex-shrink: 0; font-size: var(--text-label); color: var(--color-text-muted); }
.job-panel__exit { font-size: var(--text-label); color: var(--color-text-muted); margin-top: var(--space-1); }
.job-panel__error { font-size: var(--text-label); color: var(--color-error-text); margin-top: var(--space-1); }
.job-panel__peek { margin-top: var(--space-1-5); }
.job-panel__peek pre {
  margin: 0; padding: var(--space-1-5);
  background: var(--color-bg-tertiary);
  font-size: var(--text-label);
  color: var(--color-text-secondary);
  max-height: 180px; overflow: auto; white-space: pre-wrap; word-break: break-all;
  border-radius: var(--radius-xs);
}
.job-panel__stderr { color: var(--color-error-text); }
.job-panel__actions { margin-top: var(--space-1-5); display: flex; gap: var(--space-2); }
</style>
