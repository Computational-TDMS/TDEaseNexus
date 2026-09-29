<script setup lang="ts">
/**
 * Collapse — height 0 ↔ auto animation primitive.
 *
 * Keeps OpenHanako's Collapse contract: closed content is unmounted (after
 * the leave transition), and opening creates a fresh overflow-hidden body.
 * The animation itself is the `grid-template-rows: 0fr ↔ 1fr` trick driven
 * by a pure-CSS `<Transition>` — no JS height measurement at all:
 *
 *   1. ProcessFold's Collapse wraps ToolGroupBlock, whose own Collapse holds
 *      the tool rows. Both enter at once.
 *   2. The old onEnter hook measured scrollHeight while the inner Collapse
 *      was still at height:0, so the outer captured a too-small target.
 *   3. The browser-nested transitions interrupted each other, leaving the
 *      outer stuck mid-animation; vue-virtual-scroller's ResizeObserver then
 *      re-measured and the outer collapsed again. Net effect: a flash.
 *
 * Animating the grid track instead of a measured pixel height removes the
 * stale-target race entirely — nested Collapses each transition their own
 * track and the browser resolves the rest. Unmounting on close still avoids
 * stale hidden nodes when nested inside a virtualized transcript.
 */
const props = withDefaults(defineProps<{
  open: boolean
  /** ms; matches openhanako's --duration-fast ≈ 120ms */
  duration?: number
}>(), {
  duration: 140,
})

</script>

<template>
  <Transition name="collapse">
    <div
      v-if="open"
      class="collapse"
      :class="{ 'collapse--open': open }"
      :style="{ '--collapse-duration': `${props.duration}ms` }"
    >
      <div class="collapse__inner">
        <slot />
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* height 0 ↔ auto without measuring: the grid row transitions 0fr → 1fr
   while the inner body clips the overflow. */
.collapse {
  display: grid;
  grid-template-rows: 1fr;
}
.collapse__inner {
  overflow: hidden;
  min-height: 0;
}
.collapse-enter-active,
.collapse-leave-active {
  transition: grid-template-rows var(--collapse-duration, 140ms) var(--ease-out, ease-out);
}
.collapse-enter-from,
.collapse-leave-to {
  grid-template-rows: 0fr;
}

@media (prefers-reduced-motion: reduce) {
  .collapse-enter-active,
  .collapse-leave-active {
    transition: none;
  }
}
</style>
