<script setup lang="ts">
/**
 * ToolCallRenderer — resolves a tool call's row renderer from the registry
 * and hands it the render context (ZCode's ToolCallBlocks outer node).
 *
 * The context is a getter object, not a snapshot: when the group swaps the
 * tool object (a status flip, or the live→settled identity change) consumers
 * that read `context.tool` inside computed/templates re-track automatically.
 */
import { computed, provide, withDefaults } from 'vue'
import type { ToolCall } from '@/stores/chat-types'
import { TOOL_CALL_CONTEXT_KEY } from './renderContext'
import { resolveToolCallRenderer } from './registry'

const props = withDefaults(defineProps<{
  tool: ToolCall & { full?: string }
  /** Single-tool group: the summary already carries the identity. */
  isSingle?: boolean
}>(), {
  isSingle: false,
})

const resolved = computed(() => resolveToolCallRenderer(props.tool.name))

provide(TOOL_CALL_CONTEXT_KEY, {
  get tool() { return props.tool },
  get isSingle() { return props.isSingle },
})
</script>

<template>
  <component :is="resolved" />
</template>
