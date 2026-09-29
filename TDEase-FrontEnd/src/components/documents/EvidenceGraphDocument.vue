<!--
  EvidenceGraphDocument — the Workspace-wide PROV claim DAG, for humans.

  `FileDocument` shows ONE `evidence/*.prov.json` bundle; this document shows
  the cross-file projection `evidence.graph` (wasDerivedFrom / wasRevisionOf /
  wasInvalidatedBy edges, dangling/cycle/unreadable integrity issues) that the
  Agent reaches through the `tdease.evidence.graph` command. Both read the same
  `createWorkspaceEvidence` service, so the human and the Agent can never see
  two different graphs.

  Layout: claims are claims, so `EvidenceGraphViewer` is fed one `kind: 'claim'`
  node per file plus an explicit `column` — the topological depth of the claim
  in the derivation DAG (oldest leftmost), which the kind-based fallback could
  not express.

  Export renders the same projection through mermaid (already a dependency,
  reused lazily like `utils/mermaid-renderer.ts`) so the DAG can leave the app
  as SVG/PNG for papers, tickets, or review.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import EvidenceGraphViewer from '@/components/visualization/EvidenceGraphViewer.vue'
import Empty from '@/components/primitives/Empty.vue'
import ErrorCard from '@/components/primitives/ErrorCard.vue'
import Skeleton from '@/components/primitives/Skeleton.vue'
import AppButton from '@/components/primitives/AppButton.vue'
import { useEvidenceGraphStore } from '@/stores/evidenceGraph'
import { useWorkspaceStore } from '@/stores/workspace'
import { projectWorkspaceEvidenceGraph } from '@/services/workspace/evidence-graph'
import type { EvidenceGraphProjection } from '@/services/workspace/workspaceEvidence'
import type { StructuredError } from '@/studio/domain/errors'

const { t } = useI18n()
const evidenceGraphStore = useEvidenceGraphStore()
const workspaceStore = useWorkspaceStore()

/** Same self-driving lifecycle as ViewsDocument: reachable from a restored
 *  tab without the Navigator having visited anything first. Idempotent. */
function syncWorkspace(path: string) {
  if (path === evidenceGraphStore.workspaceRoot) return
  evidenceGraphStore.teardown()
  if (path) evidenceGraphStore.initializeFromPath(path)
}

onMounted(() => syncWorkspace(workspaceStore.workspacePath))
watch(() => workspaceStore.workspacePath, syncWorkspace)
onBeforeUnmount(() => evidenceGraphStore.teardown())

const graph = computed<EvidenceGraphProjection | null>(() => evidenceGraphStore.graph)
const isLoading = computed(() => evidenceGraphStore.loading && !graph.value)
const failure = computed<StructuredError | null>(() => evidenceGraphStore.error
  ? {
      code: 'EVIDENCE_GRAPH_SCAN_FAILED',
      domain: 'workspace',
      message: t('workbench.evidenceGraph.errorMessage'),
      remedy: t('workbench.evidenceGraph.errorRemedy'),
      details: { reason: evidenceGraphStore.error },
      retryable: true,
    }
  : null)

const hasWorkspace = computed(() => workspaceStore.hasWorkspace)

/**
 * The claim verdict in the paradigm's own five-state vocabulary
 * (`evidence.write` statuses). Unknown values render verbatim — a status this
 * surface does not know is still shown, never swallowed.
 */
const STATUS_KEYS = ['proposed', 'challenged', 'inconclusive', 'supported', 'refuted'] as const
function statusLabel(status: string): string {
  return STATUS_KEYS.includes(status as typeof STATUS_KEYS[number])
    ? t(`workbench.evidenceGraph.statusValue.${status}`)
    : status
}

/** Datasets/table rows come from the shared projection service — the same
 *  layering and shapes any other surface gets, not a view-local fork. */
const view = computed(() => graph.value ? projectWorkspaceEvidenceGraph(graph.value) : null)
const datasets = computed(() => view.value?.datasets ?? [])

// ── Mermaid export ───────────────────────────────────────────────────────────

function escapeMermaid(value: string): string {
  return value.replace(/["\r\n]/g, (character) => character === '"' ? "'" : ' ')
}

const mermaidSource = computed(() => {
  const projection = graph.value
  if (!projection) return ''
  const ids = new Map(projection.nodes.map((node, index) => [node.path, `C${index}`]))
  const lines = ['graph LR']
  for (const node of projection.nodes) {
    lines.push(`  ${ids.get(node.path)}["${escapeMermaid(node.summary)}\\n${node.status}"]`)
  }
  for (const edge of projection.edges) {
    const from = ids.get(edge.fromPath)
    const to = ids.get(edge.toPath)
    if (from && to) lines.push(`  ${from} -->|${edge.type}| ${to}`)
  }
  return lines.join('\n')
})

const exporting = ref(false)
const exportError = ref<string | null>(null)

async function renderMermaidSvg(): Promise<string> {
  const mod = await import('mermaid')
  const mermaid = mod.default
  const theme = typeof document !== 'undefined'
    && ['frappe', 'macchiato', 'mocha'].includes(document.documentElement.dataset.theme ?? '')
    ? 'dark'
    : 'default'
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme })
  const { svg } = await mermaid.render(`evidence-graph-export-${Date.now()}`, mermaidSource.value)
  return svg
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function exportSvg() {
  exporting.value = true
  exportError.value = null
  try {
    const svg = await renderMermaidSvg()
    download(new Blob([svg], { type: 'image/svg+xml' }), 'evidence-graph.svg')
  } catch (cause) {
    exportError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    exporting.value = false
  }
}

async function exportPng() {
  exporting.value = true
  exportError.value = null
  try {
    const svg = await renderMermaidSvg()
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error('SVG rasterization failed'))
        img.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth || 1200
      canvas.height = image.naturalHeight || 800
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas 2D is unavailable')
      // PNG export background follows the active theme's chart surface, not a
      // hardcoded white, so the exported image matches what's on screen.
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--chart-bg').trim()
      context.fillStyle = bg || '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0)
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG encoding failed')), 'image/png'))
      download(blob, 'evidence-graph.png')
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch (cause) {
    exportError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="evidence-graph-document">
    <Skeleton v-if="isLoading" variant="row" :lines="4" />

    <ErrorCard
      v-else-if="failure"
      :error="failure"
      @retry="evidenceGraphStore.refresh()"
    />

    <Empty
      v-else-if="!hasWorkspace"
      :title="t('workbench.evidenceGraph.noWorkspaceTitle')"
      :description="t('workbench.evidenceGraph.noWorkspaceDescription')"
    />

    <Empty
      v-else-if="!graph || graph.nodes.length === 0"
      :title="t('workbench.evidenceGraph.emptyTitle')"
      :description="t('workbench.evidenceGraph.emptyDescription')"
    />

    <template v-else>
      <header class="evidence-graph-document__toolbar">
        <span class="evidence-graph-document__stats">
          {{ t('workbench.evidenceGraph.stats', { nodes: graph.nodes.length, edges: graph.edges.length }) }}
        </span>
        <AppButton variant="subtle" size="sm" @click="evidenceGraphStore.refresh()">
          {{ t('workbench.evidenceGraph.refresh') }}
        </AppButton>
        <AppButton variant="subtle" size="sm" :disabled="exporting" @click="exportSvg">
          {{ t('workbench.evidenceGraph.exportSvg') }}
        </AppButton>
        <AppButton variant="subtle" size="sm" :disabled="exporting" @click="exportPng">
          {{ t('workbench.evidenceGraph.exportPng') }}
        </AppButton>
      </header>

      <p v-if="exportError" class="evidence-graph-document__export-error" role="alert">
        {{ t('workbench.evidenceGraph.exportFailed', { error: exportError }) }}
      </p>

      <section
        v-if="graph.issues.length"
        class="evidence-graph-document__issues"
        data-testid="evidence-graph-issues"
      >
        <h3 class="evidence-graph-document__heading">{{ t('workbench.evidenceGraph.issuesTitle') }}</h3>
        <ul>
          <li v-for="(issue, index) in graph.issues" :key="index" :data-kind="issue.kind">
            <strong>{{ issue.kind }}</strong> — {{ issue.detail }}
          </li>
        </ul>
      </section>

      <EvidenceGraphViewer
        class="evidence-graph-document__viewer"
        :datasets="datasets"
        unframed
      />

      <section class="evidence-graph-document__tables">
        <div>
          <h3 class="evidence-graph-document__heading">{{ t('workbench.evidenceGraph.nodesTitle') }}</h3>
          <table class="evidence-graph-document__table" data-testid="evidence-node-table">
            <thead>
              <tr>
                <th>{{ t('workbench.evidenceGraph.claimRef') }}</th>
                <th>{{ t('workbench.evidenceGraph.status') }}</th>
                <th>{{ t('workbench.evidenceGraph.summary') }}</th>
                <th>{{ t('workbench.evidenceGraph.path') }}</th>
                <th>{{ t('workbench.evidenceGraph.relations') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in view?.rows ?? []" :key="row.path" :data-status="row.status">
                <td class="evidence-graph-document__mono">{{ row.ref }}</td>
                <td>{{ statusLabel(row.status) }}</td>
                <td>{{ row.summary }}</td>
                <td class="evidence-graph-document__mono">{{ row.path }}</td>
                <td>{{ row.relations }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div>
          <h3 class="evidence-graph-document__heading">{{ t('workbench.evidenceGraph.edgesTitle') }}</h3>
          <table class="evidence-graph-document__table" data-testid="evidence-edge-table">
            <thead>
              <tr>
                <th>{{ t('workbench.evidenceGraph.relation') }}</th>
                <th>{{ t('workbench.evidenceGraph.from') }}</th>
                <th>{{ t('workbench.evidenceGraph.to') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(edge, index) in graph.edges" :key="index">
                <td>{{ edge.type }}</td>
                <td class="evidence-graph-document__mono">{{ edge.fromRef }}</td>
                <td class="evidence-graph-document__mono">{{ edge.toRef }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.evidence-graph-document {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: var(--space-3);
}

.evidence-graph-document__toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.evidence-graph-document__stats {
  flex: 1 1 auto;
  color: var(--color-text-muted);
  font-size: var(--text-label);
}

.evidence-graph-document__export-error {
  flex: none;
  margin: 0;
  color: var(--color-error-text);
  font-size: var(--text-label);
}

.evidence-graph-document__heading {
  margin: 0 0 var(--space-1);
  color: var(--color-text);
  font-size: var(--text-sm);
}

.evidence-graph-document__issues {
  flex: none;
  padding: var(--space-2);
  border: 1px solid var(--color-warning);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--text-label);
}

.evidence-graph-document__issues ul { margin: 0; padding-left: var(--space-4); }

.evidence-graph-document__viewer {
  flex: none;
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
}

.evidence-graph-document__tables {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.evidence-graph-document__table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-label);
  color: var(--color-text);
}

.evidence-graph-document__table th,
.evidence-graph-document__table td {
  padding: var(--space-1) var(--space-2);
  border: var(--line-w) solid var(--line-hairline);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}

.evidence-graph-document__table th {
  background: var(--color-bg-muted);
  color: var(--color-text-muted);
  text-transform: uppercase;
  font-size: var(--text-label, 11px);
}

.evidence-graph-document__mono {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: var(--text-label);
}
</style>
