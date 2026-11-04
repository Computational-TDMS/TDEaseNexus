<!--
  Disclosure — the two-layer disclosure rule's atom (VISUAL-SYSTEM.md §11,
  CORE-ARCHITECTURE.md §9.4). Every place the scientific layer summarizes
  something, a Disclosure holds the exact thing it summarized: the raw tool
  call under the verb phrase, the log tail under the error, the digest
  under the version, the physical path under the `ResultRef`.

  Built on <details>/<summary> for free keyboard and screen-reader
  semantics — no custom `tabindex`/`aria-expanded` bookkeeping needed — and
  styled to match, with the chevron rotating over `--dur-fast`.
-->
<template>
  <details
    class="disclosure"
    :class="[`disclosure--${density}`, { 'is-open': isOpen }]"
    :open="isOpen"
    @toggle="handleToggle"
  >
    <summary class="disclosure__summary">
      <el-icon class="disclosure__chevron" :size="12"><CaretRight /></el-icon>
      <span class="disclosure__summary-text">
        <slot name="summary">{{ summary }}</slot>
      </span>
    </summary>
    <div class="disclosure__content">
      <slot />
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { CaretRight } from '@element-plus/icons-vue'

const props = withDefaults(defineProps<{
  summary?: string
  defaultOpen?: boolean
  density?: 'comfortable' | 'compact'
  open?: boolean
}>(), {
  defaultOpen: false,
  density: 'comfortable',
  open: undefined,
})

const emit = defineEmits<{
  'update:open': [boolean]
}>()

const uncontrolledOpen = ref(props.defaultOpen)

// `open` is typed `boolean` for a clean public API, but Vue's compiler
// still casts an *absent* Boolean-typed prop to `false` unless an
// explicit `default` key exists in the options object — so `open:
// undefined` above is load-bearing, not decorative: without it, an
// uncontrolled Disclosure could never open past its `defaultOpen`.
const isOpen = computed(() => props.open ?? uncontrolledOpen.value)

function handleToggle(event: Event) {
  const next = (event.target as HTMLDetailsElement).open
  uncontrolledOpen.value = next
  emit('update:open', next)
}
</script>

<style scoped>
.disclosure {
  border-radius: var(--radius-sm);
}

.disclosure__summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  list-style: none;
  cursor: pointer;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-xs);
  font-size: var(--text-base);
  line-height: var(--text-base-lh);
  color: var(--color-text);
}

.disclosure--compact .disclosure__summary {
  padding: 0 var(--space-1);
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
}

.disclosure__summary::-webkit-details-marker {
  display: none;
}

.disclosure__summary:hover {
  background: var(--color-hover);
}

.disclosure__summary:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}

.disclosure__chevron {
  flex: none;
  color: var(--color-text-muted);
  transition: transform var(--dur-fast) var(--ease-out);
}

.disclosure.is-open .disclosure__chevron {
  transform: rotate(90deg);
}

.disclosure__content {
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-5);
  color: var(--color-text-muted);
}

.disclosure--compact .disclosure__content {
  padding: var(--space-1) var(--space-1) var(--space-1) var(--space-4);
}
</style>
