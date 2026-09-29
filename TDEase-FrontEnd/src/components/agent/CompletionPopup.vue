<!--
  CompletionPopup — the one autocomplete dropdown for the Agent composer.

  Replaces the copy-pasted `.slash-popup` / `.skill-dropdown` pair: SlashInput
  used to render its `/`-command list and its `@`-mention picker as two
  near-identical hand-rolled popups. Both now render through this component.

  Rows are flat; an optional `group` field inserts a small header row whenever
  the group changes. The component owns scroll-into-view on `activeIndex`
  changes, so callers only manage the index — this also removes the old
  children[idx + 1] offset bug where the mention popup's hint banner was
  child[0] and skewed every scroll target.
-->
<template>
  <Transition name="popup">
    <div
      v-if="items.length"
      ref="rootRef"
      class="completion-popup"
      :class="`completion-popup--${direction}`"
      role="listbox"
    >
      <template v-for="(item, idx) in items" :key="item.key">
        <div
          v-if="item.group && (idx === 0 || items[idx - 1].group !== item.group)"
          class="completion-popup__group"
        >
          {{ item.group }}
        </div>
        <button
          type="button"
          class="completion-popup__item"
          :class="{ active: idx === activeIndex }"
          role="option"
          :aria-selected="idx === activeIndex"
          :data-idx="idx"
          @click="emit('select', item)"
          @mouseenter="emit('update:activeIndex', idx)"
        >
          <span class="completion-popup__badge" :class="`completion-popup__badge--${item.kind}`">{{ item.badge ?? `${badgePrefix}${item.kind}` }}</span>
          <span class="completion-popup__label">{{ item.label }}</span>
          <span v-if="item.detail" class="completion-popup__detail">{{ item.detail }}</span>
        </button>
      </template>
      <div v-if="hint" class="completion-popup__hint">{{ hint }}</div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

/** One row in the popup. `group` is rendered as a header when it changes. */
export interface CompletionItem {
  readonly key: string
  /** Badge text after the prefix (`command`, `skill`, `run`, `file`, …). */
  readonly kind: string
  /** Badge text override; defaults to `${badgePrefix}${kind}`. */
  readonly badge?: string
  readonly label: string
  readonly detail?: string
  readonly group?: string
}

const props = withDefaults(defineProps<{
  items: ReadonlyArray<CompletionItem>
  activeIndex: number
  /** Bottom hint bar text; the bar renders only when non-empty. */
  hint?: string
  /** Badge prefix: `/` for slash commands, `@` for mentions. */
  badgePrefix?: string
  /** `up` floats above the anchor (bottom: 100%), `down` drops below it. */
  direction?: 'up' | 'down'
}>(), {
  hint: '',
  badgePrefix: '/',
  direction: 'up',
})

const emit = defineEmits<{
  select: [item: CompletionItem]
  'update:activeIndex': [index: number]
}>()

const rootRef = ref<HTMLDivElement | null>(null)

// Follow keyboard navigation: scroll the active row into view. The rows carry
// their flat index as data-idx, so group headers and the hint bar never skew
// the lookup the way child-index arithmetic did before.
watch(() => [props.activeIndex, props.items.length], () => {
  nextTick(() => {
    rootRef.value
      ?.querySelector(`[data-idx="${props.activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  })
})
</script>

<style scoped>
.completion-popup {
  position: absolute;
  left: 0;
  right: 0;
  max-height: 240px;
  overflow-y: auto;
  background: var(--elev-2-bg, var(--color-bg));
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-md);
  box-shadow: var(--elev-2);
  z-index: var(--z-floating);
}

.completion-popup--up {
  bottom: 100%;
  margin-bottom: var(--space-1);
}

.completion-popup--down {
  top: 100%;
  margin-top: var(--space-1);
}

.completion-popup__group {
  font-size: var(--text-label);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-text-muted, var(--color-text-muted));
  padding: var(--space-1) var(--space-3) 2px;
}

.completion-popup__item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px var(--space-3);
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  font-size: var(--text-sm);
  transition: background var(--dur-instant);
}

.completion-popup__item.active {
  background: color-mix(in srgb, var(--color-primary) 10%, var(--color-bg));
}
.completion-popup__item:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: -2px;
}

.completion-popup__badge {
  font-family: var(--font-mono);
  font-weight: 600;
  flex-shrink: 0;
  min-width: 52px;
  text-transform: lowercase;
}

/* Per-kind tones, all derived from existing theme variables via color-mix so
   every palette keeps its contrast. */
.completion-popup__badge--command {
  color: var(--color-primary);
}
.completion-popup__badge--skill {
  color: color-mix(in srgb, var(--color-success, var(--color-primary)) 85%, var(--color-text));
}
.completion-popup__badge--mcp {
  color: color-mix(in srgb, var(--color-warning, var(--color-warning, var(--color-primary))) 85%, var(--color-text));
}
.completion-popup__badge--run {
  color: color-mix(in srgb, var(--color-primary) 70%, var(--color-text));
}
.completion-popup__badge--file {
  color: var(--color-text-muted);
}

.completion-popup__label {
  font-family: var(--font-mono);
  font-weight: 500;
  flex-shrink: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}

.completion-popup__detail {
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  text-align: right;
}

.completion-popup__hint {
  padding: var(--space-1) var(--space-3);
  border-top: var(--line-w) solid var(--line-seam);
  font-size: var(--text-label);
  color: var(--color-text-muted, var(--color-text-muted));
}

/* ── Transition (carried over from the old .slash-popup) ── */
.popup-enter-active {
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.popup-leave-active {
  transition: opacity var(--dur-instant) var(--ease-in), transform var(--dur-instant) var(--ease-in);
}
.popup-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.popup-leave-to {
  opacity: 0;
  transform: translateY(2px);
}
</style>
