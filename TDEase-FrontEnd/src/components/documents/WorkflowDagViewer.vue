<!--
  WorkflowDagViewer — renders a Snakemake workflow's dry-run DAG.

  The DAG arrives as a `DryRunProjection` (`{ nodes, edges }`) from
  `documentsStore.projectWorkspaceWorkflow`, which runs Snakemake's native
  dry-run against the Workspace file and returns the resolved rule graph —
  not a heuristic inferred from the source. This component only projects
  that structure into a picture; it invents no topology of its own.

  Rendering goes through the same mermaid pipeline MarkdownContent uses
  (`src/utils/mermaid-renderer.ts`): the projection is serialized to a
  mermaid `graph TD` source, wrapped in the standard `.mermaid-diagram`
  shell, and `renderMermaidDiagrams` turns it into an inlined SVG. That keeps
  the DAG's theme (light/dark) consistent with every other diagram in the
  app, and means the source-toggle toolbar and render error handling come
  for free rather than being re-implemented here.
-->
<template>
  <div ref="root" class="workflow-dag" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderMermaidDiagrams } from '@/utils/mermaid-renderer'
import type { DryRunProjection } from '@/studio/ports/backend-gateway'

const props = defineProps<{
  projection: DryRunProjection
}>()

const root = ref<HTMLElement | null>(null)

/**
 * Serialize the projection into a mermaid `graph TD` source. Each node is
 * `n<id>["rule"]` (the rule name is the stable identifier Snakemake reports;
 * `label` is often a file path, which we drop into a tooltip via the title
 * rather than crowding the node shape). Quoting the node text and escaping
 * the few characters mermaid treats as syntax inside a quoted string keeps
 * rules like `complex_modification_site_N` and labels containing `"` or `\`
 * from breaking the diagram.
 *
 * Self-edges and duplicate edges are skipped: mermaid renders a self-loop as
 * a confusing curl and dedups visually anyway, but emitting them pollutes
 * the source and can trip the parser.
 */
function mermaidSourceFor(projection: DryRunProjection): string {
  const lines: string[] = ['graph TD']
  for (const node of projection.nodes) {
    const rule = escapeMermaidText(node.rule)
    const tooltip = node.label && node.label !== node.rule
      ? `:"${escapeMermaidText(node.label)}"`
      : ''
    lines.push(`  n${node.id}["${rule}"${tooltip}]`)
  }
  const seen = new Set<string>()
  for (const edge of projection.edges) {
    if (edge.source === edge.target) continue
    const key = `${edge.source}->${edge.target}`
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(`  n${edge.source} --> n${edge.target}`)
  }
  return lines.join('\n')
}

function escapeMermaidText(text: string): string {
  // Inside a mermaid quoted node label, `"` and `\` are the only escapes
  // the parser cares about; newlines would break the single-line node def.
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
}

/**
 * Rebuild the mermaid shell and re-render. The shell matches the structure
 * `mermaidFences` (src/utils/markdown.ts) produces for fenced diagrams, so
 * `renderMermaidDiagrams` handles it the same way: it reads `.mermaid-source
 * code`, initializes mermaid with the live `data-theme`, and writes the SVG
 * into `.mermaid-rendered`, attaching the source-toggle toolbar on success.
 */
function render() {
  const el = root.value
  if (!el) return
  const source = mermaidSourceFor(props.projection)
  el.innerHTML = [
    '<div class="mermaid-diagram">',
    `<pre class="mermaid-source"><code>${escapeHtml(source)}</code></pre>`,
    '<div class="mermaid-rendered"></div>',
    '</div>',
  ].join('')
  void renderMermaidDiagrams(el)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

onMounted(render)
watch(() => props.projection, render)
onBeforeUnmount(() => { if (root.value) root.value.innerHTML = '' })
</script>

<style scoped>
.workflow-dag {
  width: 100%;
  min-height: 0;
  padding: var(--space-3);
  overflow: auto;
}

/* Inherit the markdown diagram surface styles so a DAG reads like the
   diagrams in the transcript, not a third kind of figure. The selectors
   target the rendered shell this component owns. */
.workflow-dag :deep(.mermaid-rendered) {
  display: flex;
  justify-content: center;
}

.workflow-dag :deep(.mermaid-rendered svg) {
  max-width: 100%;
  height: auto;
}
</style>
