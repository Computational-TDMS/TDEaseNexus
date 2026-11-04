<template>
  <Teleport to="body">
    <div v-if="state" class="ctx-overlay" @click="close" @contextmenu.prevent="close">
      <ul
        ref="menuRef"
        class="ctx-menu"
        :class="{ visible: placed }"
        :style="{ left: `${position.x}px`, top: `${position.y}px` }"
        role="menu"
        @click.stop
        @contextmenu.prevent.stop
        @keydown.escape.prevent="close"
      >
        <template v-for="(item, idx) in state.items" :key="idx">
          <li v-if="item.divider" class="ctx-divider" role="separator" />
          <li
            v-else
            class="ctx-item"
            :class="{ danger: item.danger, disabled: item.disabled, checked: item.checked }"
            role="menuitem"
            :aria-disabled="item.disabled || false"
            @click="onItemClick(item)"
          >
            <span v-if="item.checked" class="ctx-check"><el-icon :size="12" aria-hidden="true"><Check /></el-icon></span>
            <span class="ctx-label">{{ item.label }}</span>
          </li>
        </template>
      </ul>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { Check } from '@element-plus/icons-vue'

export interface MenuItem {
  label?: string
  action?: () => void | Promise<void>
  divider?: boolean
  danger?: boolean
  disabled?: boolean
  checked?: boolean
}

export interface CtxMenuState {
  position: { x: number; y: number }
  items: MenuItem[]
}

const props = defineProps<{ state: CtxMenuState | null }>()
const emit = defineEmits<{ close: [] }>()

const menuRef = ref<HTMLUListElement>()
const placed = ref(false)
const position = ref({ x: 0, y: 0 })

// Clamp the menu inside the viewport after it mounts.
watch(() => props.state, async (s) => {
  if (!s) { placed.value = false; return }
  position.value = { ...s.position }
  placed.value = false
  await nextTick()
  const el = menuRef.value
  if (!el) { placed.value = true; return }
  const rect = el.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  let { x, y } = position.value
  if (x + rect.width > vw - 4) x = Math.max(4, vw - rect.width - 4)
  if (y + rect.height > vh - 4) y = Math.max(4, vh - rect.height - 4)
  position.value = { x, y }
  placed.value = true
  // Focus for Esc handling
  el.focus()
})

function onItemClick(item: MenuItem) {
  if (item.divider || item.disabled) return
  emit('close')
  if (item.action) item.action()
}

function close() {
  emit('close')
}
</script>

<style scoped>
.ctx-overlay {
  position: fixed;
  inset: 0;
  /* The z-index ladder (unified-design-tokens.css): a context menu is a
     scrim + floating surface, so it sits at the overlay rung. */
  z-index: var(--z-overlay);
}

.ctx-menu {
  position: fixed;
  min-width: 160px;
  max-width: 260px;
  margin: 0;
  padding: var(--space-1) 0;
  list-style: none;
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-overlay);
  font-size: var(--text-sm);
  font-family: var(--font-body);
  color: var(--color-text);
  outline: none;
  opacity: 0;
  transition: opacity var(--dur-instant) var(--ease-out);
}
.ctx-menu.visible { opacity: 1; }

.ctx-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  cursor: default;
  user-select: none;
  border-radius: var(--radius-xs);
  margin: 0 var(--space-1);
}
.ctx-item:hover:not(.disabled) {
  background: var(--color-bg-hover);
}
.ctx-item.disabled {
  opacity: 0.4;
  cursor: default;
}
.ctx-item.danger {
  color: var(--color-error-text);
}
.ctx-item.danger:hover:not(.disabled) {
  background: var(--color-error-soft);
}
.ctx-check {
  width: var(--space-3);
  color: var(--color-interact-text);
}
.ctx-label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ctx-divider {
  height: 1px;
  margin: var(--space-1) var(--space-2);
  background: var(--color-border);
}
</style>
