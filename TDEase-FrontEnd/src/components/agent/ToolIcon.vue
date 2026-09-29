<script setup lang="ts">
/**
 * ToolIcon — the process rows' identity glyph. Rendering is delegated to the
 * Lucide icon library (@lucide/vue, consistent 24×24 stroke set, tree-shaken
 * per import); this component is only the NAME→GLYPH seam, so the rest of the
 * app keeps speaking tool-identity's vocabulary and a glyph swap never touches
 * a call site. Icons inherit currentColor — the row's quiet voice; the status
 * glyph alone carries semantic color.
 */
import { Activity, Brain, Circle, FileDown, FileText, FolderOpen, ListTodo, PencilLine, Play, ScrollText, Sparkles, SquareTerminal, TextSearch, Workflow } from '@lucide/vue'
import { computed, type Component } from 'vue'
import type { ToolIconName } from '@/utils/tool-identity'

const ICONS: Record<ToolIconName, Component> = {
  terminal: SquareTerminal,
  file: FileText,
  pencil: PencilLine,
  folder: FolderOpen,
  search: TextSearch,
  list: ListTodo,
  spark: Sparkles,
  thought: Brain,
  circle: Circle,
  workflow: Workflow,
  run: Play,
  monitor: Activity,
  log: ScrollText,
  fileDown: FileDown,
}

const props = defineProps<{ name: ToolIconName }>()
const glyph = computed(() => ICONS[props.name] ?? Circle)
</script>

<template>
  <component :is="glyph" class="tool-icon" :size="14" :stroke-width="1.75" aria-hidden="true" />
</template>

<style scoped>
.tool-icon {
  flex-shrink: 0;
  display: inline-block;
  vertical-align: -2px;
}
</style>
