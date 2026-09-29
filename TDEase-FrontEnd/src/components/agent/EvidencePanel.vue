<!--
  EvidencePanel — the inspector's Evidence tab content.

  Reuses `useEvidenceGraphStore` (the Workspace-wide PROV DAG projection) and
  the existing `openEvidenceGraph()` document route. The inspector does not
  invent a second evidence model: it surfaces the same files the Navigator's
  Evidence section lists, plus a one-click entry into the graph document.

  Session-scoped evidence (only the claims produced in *this* session) is a
  future refinement — the PROV claim graph does not currently tag claims with
  a parent sessionId, so a Workspace-wide view is the honest scope today.
-->
<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Connection } from '@element-plus/icons-vue'
import AppButton from '@/components/primitives/AppButton.vue'
import Empty from '@/components/primitives/Empty.vue'
import { useEvidenceGraphStore } from '@/stores/evidenceGraph'
import { useDocumentsStore } from '@/stores/documents'
import { useWorkspaceStore } from '@/stores/workspace'

const { t } = useI18n()
const evidenceGraph = useEvidenceGraphStore()
const documentsStore = useDocumentsStore()
const workspaceStore = useWorkspaceStore()

const hasEvidence = computed(() => (evidenceGraph.graph?.nodes?.length ?? 0) > 0)
const nodeCount = computed(() => evidenceGraph.graph?.nodes?.length ?? 0)
/**
 * While the evidence files are still being scanned we must NOT show the "no
 * evidence" Empty — that reads as a finding ("there is none") when the truth
 * is "still looking". Gate on `loading` first.
 */
const isLoading = computed(() => evidenceGraph.loading)

function syncEvidence() {
  const root = workspaceStore.workspacePath
  if (root) evidenceGraph.initializeFromPath(root)
  else evidenceGraph.teardown()
}

onMounted(syncEvidence)
watch(() => workspaceStore.workspacePath, syncEvidence)

function openGraph() {
  documentsStore.openEvidenceGraph(t('agent.evidence.graphTitle'))
}
</script>

<template>
  <div class="evidence-panel">
    <!-- Loading gate comes first: "no evidence" is a finding, not the state
         while we are still scanning the evidence files. -->
    <p v-if="isLoading" class="evidence-panel__loading">{{ t('agent.evidence.loading') }}</p>
    <Empty v-else-if="!hasEvidence" :icon="Connection" :title="t('agent.inspector.empty.evidence')" />

    <template v-else>
      <div class="evidence-panel__head">
        <p class="evidence-panel__summary">
          {{ t('agent.evidence.nodeCount', { count: nodeCount }) }}
        </p>
        <AppButton variant="primary" size="sm" @click="openGraph">
          {{ t('agent.evidence.openGraph') }}
        </AppButton>
      </div>
      <p class="evidence-panel__hint">{{ t('agent.evidence.workspaceScoped') }}</p>
    </template>
  </div>
</template>

<style scoped>
.evidence-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
}

.evidence-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.evidence-panel__summary {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

.evidence-panel__loading {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  font-style: italic;
}

.evidence-panel__hint {
  margin: 0;
  font-size: var(--text-label);
  color: var(--color-text-muted);
  line-height: 1.4;
}
</style>
