/**
 * The document registration table.
 *
 * One row per `DocumentKey` variant, and the compiler is what keeps it total:
 * `DocumentDefinitionTable` is a mapped type over the union, so omitting a
 * variant fails `vue-tsc` with "Property 'x' is missing", and naming a variant
 * that does not exist fails as an unknown property. Neither is a runtime
 * surprise, and neither has a fallback branch to hide behind.
 *
 * One variant has no surface yet -- `analysis-review`, whose plan-review use
 * case is absent (docs/STATUS.md). It is registered explicitly
 * against `NotBuiltDocument` with its own copy, so the gap is one visible row
 * here rather than a `v-else` a typo could also reach.
 *
 * The former `canvas` row (BlockCanvas + canvas-registry) was removed with the
 * Canvas feature on 2026-09-17; knowledge pages under `wiki/` are the one
 * remaining authored-surface document kind.
 */

import { defineAsyncComponent } from 'vue'
import EvidenceGraphDocument from './EvidenceGraphDocument.vue'
import NotBuiltDocument from './NotBuiltDocument.vue'
import {
  createDocumentRegistry,
  type DocumentDefinition,
  type DocumentDefinitionTable,
  type DocumentKind,
  type DocumentRegistry,
} from './registry'

/**
 * A variant that is registered, honest and unbuilt. The same copy feeds both
 * the component's props and the machine-readable `notBuilt` marker, so the
 * two can never drift apart.
 */
function notBuiltDocument<K extends DocumentKind>(
  kind: K,
  titleKey: string,
  descriptionKey: string,
): DocumentDefinition<K> {
  const copy = { titleKey, descriptionKey }
  return { kind, component: NotBuiltDocument, props: () => ({ ...copy }), notBuilt: copy }
}

export const documentDefinitions: DocumentDefinitionTable = {
  'run-index': {
    kind: 'run-index',
    // Async on purpose: `RunIndexDocument` statically pulls `ag-grid-vue3` +
    // its CSS, and the router -> AppShell -> DocumentHost chain to this table
    // is fully static, so a static import here puts ~1MB of ag-grid in the
    // entry chunk. Module registration still happens inside the component's
    // own module scope before its first render.
    component: defineAsyncComponent(() => import('./RunIndexDocument.vue')),
  },
  run: {
    kind: 'run',
    // Async: dagre layout + the run file tree ride the static route chain
    // into the entry chunk otherwise (same reasoning as run-index above).
    component: defineAsyncComponent(() => import('./RunDocument.vue')),
    props: (key) => ({ runId: key.runId }),
  },
  result: {
    kind: 'result',
    // Async: d3 CSV ingress (fileIngress) is shared with the file/run rows
    // and must not ride the entry chunk (same reasoning as run-index above).
    component: defineAsyncComponent(() => import('./ResultDocument.vue')),
    // The whole `ResultRef` reaches the component: `resultId` alone is not an
    // identity (CORE-ARCHITECTURE.md §3.2 -- the digest is what decides
    // whether this reads as "exactly this value" or is superseded), and the
    // Result cache keys on all four fields.
    props: (key) => ({ resultRef: key.ref }),
  },
  'evidence-graph': {
    kind: 'evidence-graph',
    component: EvidenceGraphDocument,
  },
  file: {
    kind: 'file',
    // Async: `FileDocument` statically pulls `MsAlignDocument` ->
    // `SpectrumViewer` -> plotly.js — the one chain that put 4.7MB of plotly
    // in the entry chunk (2026-09-04 perf audit). Same reasoning as
    // run-index above.
    component: defineAsyncComponent(() => import('./FileDocument.vue')),
    props: (key) => ({ workspaceId: key.workspaceId, path: key.path }),
  },
  wiki: {
    kind: 'wiki',
    // Async: CodeMirror (~the editor bundle) must not enter the entry chunk —
    // the same reasoning as run-index's ag-grid deferral above.
    component: defineAsyncComponent(() => import('./WikiDocument.vue')),
    props: (key) => ({ scope: key.scope, page: key.page }),
  },
  'wiki-index': {
    kind: 'wiki-index',
    component: defineAsyncComponent(() => import('./WikiIndexDocument.vue')),
  },
  'analysis-review': notBuiltDocument(
    'analysis-review',
    'workbench.documentHost.analysisReviewNotBuiltTitle',
    'workbench.documentHost.analysisReviewNotBuiltDescription',
  ),
  settings: {
    kind: 'settings',
    // Async: the settings surface is a hub of panels with no first-screen
    // role (opened from the command palette); same reasoning as run-index.
    component: defineAsyncComponent(() => import('./SettingsDocument.vue')),
  },
}

/**
 * Constructed at module scope, so an invalid table is a **startup** assertion
 * failure (§5.1) rather than a first-render one -- importing `DocumentHost`
 * is enough to trip it.
 */
export const documentRegistry: DocumentRegistry = createDocumentRegistry(documentDefinitions)
