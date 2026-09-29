<template>
  <div class="ws-rail-wrap">
    <button
      ref="triggerRef"
      :class="['activity-btn', { active: hasWorkspace }]"
      :title="hasWorkspace ? activeWorkspaceLabel : t('workbench.workspaceRail.openWorkspace')"
      :aria-label="hasWorkspace ? activeWorkspaceLabel : t('workbench.workspaceRail.openWorkspace')"
      :aria-expanded="open"
      :aria-haspopup="true"
      @click="togglePopover"
    >
      <el-icon :size="20"><FolderOpened /></el-icon>
    </button>

    <Teleport to="body">
      <div v-if="open" class="ws-popover-overlay" @click="close" @contextmenu.prevent="close">
        <div
          ref="popoverRef"
          class="ws-popover"
          role="dialog"
          :aria-label="t('workbench.workspaceRail.workspaces')"
          :style="{ top: `${pos.y}px`, left: `${pos.x}px` }"
          @click.stop
          @keydown="onPopoverKeydown"
        >
          <div class="ws-popover-header">
            <span>{{ t('workbench.workspaceRail.workspaces') }}</span>
            <button
              class="ws-refresh"
              :title="t('workbench.workspaceRail.refreshList')"
              :aria-label="t('workbench.workspaceRail.refreshList')"
              @click="refresh"
            >
              <el-icon :size="12"><Refresh /></el-icon>
            </button>
          </div>

          <div v-if="loading" class="ws-popover-empty">{{ t('workbench.workspaceRail.loading') }}</div>
          <div v-else-if="recent.length === 0" class="ws-popover-empty">
            {{ t('workbench.workspaceRail.noRecent') }}
          </div>
          <ul v-else class="ws-list" role="listbox" :aria-label="t('workbench.workspaceRail.workspaces')">
            <li
              v-for="ws in recent"
              :key="ws.workspace_id"
              :class="['ws-item', { current: ws.workspace_id === workspaceStore.workspaceId }]"
              role="option"
              :aria-selected="ws.workspace_id === workspaceStore.workspaceId"
              :aria-label="displayName(ws)"
              :title="ws.local_path"
              tabindex="0"
              @click="switchTo(ws)"
              @keydown.enter.prevent="switchTo(ws)"
              @keydown.space.prevent="switchTo(ws)"
            >
              <el-icon :size="13" class="ws-item-icon" aria-hidden="true"><FolderOpened /></el-icon>
              <span class="ws-item-name">{{ displayName(ws) }}</span>
              <button
                class="ws-item-forget"
                :title="t('workbench.workspaceRail.removeFromRecent')"
                :aria-label="t('workbench.workspaceRail.removeFromRecent')"
                @click.stop="forget(ws.workspace_id)"
              >
                <el-icon :size="11" aria-hidden="true"><Close /></el-icon>
              </button>
            </li>
          </ul>

          <div class="ws-popover-divider" />
          <AppButton variant="default" size="sm" class="ws-open-btn" :disabled="opening" :loading="opening" @click="openFolder">
            <template #icon><el-icon :size="13" aria-hidden="true"><FolderAdd /></el-icon></template>
            {{ t('workbench.workspaceRail.openFolder') }}
          </AppButton>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FolderOpened, FolderAdd, Refresh, Close } from '@element-plus/icons-vue'
import { useWorkspaceStore } from '@/stores/workspace'
import {
  listOpenedWorkspaces,
  forgetWorkspace,
  workspaceDisplayName,
  type WorkspaceRegistryEntry,
} from '@/services/workspace/workspaceRegistry'
import { useWorkspaceOpener } from '@/composables/useWorkspaceOpener'
import { useWorkspaceRailPanel } from '@/composables/useWorkspaceRailPanel'
import AppButton from '@/components/primitives/AppButton.vue'

const workspaceStore = useWorkspaceStore()
const { pickAndOpen, openPath } = useWorkspaceOpener()
const { t } = useI18n()

// The panel's open state is SHARED (useWorkspaceRailPanel): the rail button
// renders and positions it, but other surfaces — the Welcome surface's
// workspace card — can request it open, and it is the one workspace-choosing
// UI in the app.
const open = useWorkspaceRailPanel().open
const loading = ref(false)
const opening = ref(false)
const recent = ref<WorkspaceRegistryEntry[]>([])
const pos = ref({ x: 0, y: 0 })
const triggerRef = ref<HTMLButtonElement | null>(null)
const popoverRef = ref<HTMLElement | null>(null)

const hasWorkspace = computed(() => workspaceStore.hasWorkspace)

// The rail button's tooltip shows the current Workspace's short label. The
// store holds the path, not a display name, so derive the basename here; the
// registry list below uses `workspaceDisplayName` over each entry instead.
const activeWorkspaceLabel = computed(() => {
  const p = workspaceStore.workspacePath
  const base = p.split(/[\\/]/).filter(Boolean).pop()
  return base || p || t('workbench.workspaceRail.workspaceFallback')
})

// List items use the shared display helper so a stale registry entry whose
// `name` is a full path still renders as its basename.
function displayName(ws: WorkspaceRegistryEntry): string {
  return workspaceDisplayName(ws)
}

async function refresh() {
  loading.value = true
  try {
    recent.value = await listOpenedWorkspaces()
  } catch (err) {
    console.warn('[WorkspaceRailButton] list failed', err)
    recent.value = []
  } finally {
    loading.value = false
  }
}

async function togglePopover(_e: MouseEvent) {
  open.value = !open.value
}

// Opening — from the trigger OR from a remote request (Welcome card) — funnels
// through here: position beside the trigger, refresh the registry, and move
// focus into the panel so keyboard users land on the actionable content.
watch(open, async (isOpen) => {
  if (!isOpen) return
  const rect = triggerRef.value?.getBoundingClientRect()
  if (rect) pos.value = { x: rect.right + 4, y: rect.top }
  await refresh()
  await nextTick()
  popoverRef.value?.querySelector<HTMLElement>('.ws-item, .ws-open-btn')?.focus()
})

function close(): void {
  open.value = false
}

/**
 * Esc closes the popover and returns focus to the trigger button (keyboard
 * parity with the click-outside dismissal). ArrowUp/Down move between the
 * workspace list items.
 */
function onPopoverKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopImmediatePropagation()
    close()
    triggerRef.value?.focus()
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const items = Array.from(popoverRef.value?.querySelectorAll<HTMLElement>('.ws-item') ?? [])
    if (items.length === 0) return
    const current = document.activeElement as HTMLElement | null
    const idx = items.indexOf(current ?? document.body)
    e.preventDefault()
    const next = e.key === 'ArrowDown'
      ? items[(idx + 1 + items.length) % items.length]
      : items[(idx - 1 + items.length) % items.length]
    next?.focus()
  }
}

async function switchTo(ws: WorkspaceRegistryEntry) {
  const normalize = (path: string) => path.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()
  // Short-circuit when the clicked entry is already the active Workspace AND
  // its tree is actually populated. The tree-empty guard is the fix for the
  // ghost "selected but blank" startup state: if a restore failed to load the
  // tree, `workspaceId`/`workspacePath` still match this entry (they come from
  // localStorage), so without this guard the click would be swallowed and the
  // user would be forced to switch away and back to recover. Treat a blank
  // tree as "not really attached" and re-run the open path.
  const alreadyAttached = ws.workspace_id === workspaceStore.workspaceId
    && normalize(ws.local_path) === normalize(workspaceStore.workspacePath)
    && workspaceStore.fileTree.length > 0
  if (alreadyAttached) { close(); return }
  // Forward the registry's stable `workspace_id` so reopening a folder reuses
  // its identity instead of minting a new one (which the registry dedupes
  // away, losing this entry — see useWorkspaceOpener.openPath).
  await openPath(ws.local_path, { id: ws.workspace_id, name: ws.name })
  close()
}

async function openFolder() {
  if (opening.value) return
  opening.value = true
  try {
    const ok = await pickAndOpen()
    if (ok) await refresh()
  } finally {
    opening.value = false
    close()
  }
}

async function forget(id: string) {
  try { await forgetWorkspace(id) }
  catch (err) { console.warn('[WorkspaceRailButton] forget failed', err) }
  await refresh()
}

onMounted(async () => {
  await refresh()
  // Workspace restoration on launch is handled in `useWorkspaceStore`'s
  // constructor, which replays the full attach path (register + loadFileTree)
  // so the tree is populated by the time any consumer mounts. This selector
  // only lists recent workspaces and switches between them on user action.
})
</script>

<style scoped>
.ws-rail-wrap { position: relative; }

/* Reuse the activity-btn look from App.vue so the rail stays consistent. */
.activity-btn {
  width: var(--space-6);
  height: var(--space-6);
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
  position: relative;
}
.activity-btn:hover {
  color: var(--color-text);
  background: var(--color-hover);
}
.activity-btn.active { color: var(--color-interact-text); }
.activity-btn.active::before {
  content: '';
  position: absolute;
  left: calc(var(--space-2) * -1);
  top: var(--space-2);
  bottom: var(--space-2);
  width: 3px;
  background: var(--color-primary);
  border-radius: 0 2px 2px 0;
}

.ws-popover-overlay {
  position: fixed;
  inset: 0;
  /* The z-index ladder (unified-design-tokens.css): a modal-class scrim sits
     at the overlay rung — above in-page panels, below true modals. */
  z-index: var(--z-overlay);
}

.ws-popover {
  position: fixed;
  min-width: 240px;
  max-width: 320px;
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-overlay);
  padding: var(--space-1-5);
  font-size: var(--text-sm);
  color: var(--color-text);
}

.ws-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-label);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-text-muted);
}
.ws-refresh {
  border: none;
  background: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: var(--space-1-5);
  border-radius: var(--radius-xs);
  display: flex;
}
.ws-refresh:hover { color: var(--color-text); background: var(--color-hover); }

.ws-popover-empty {
  padding: var(--space-2-5) var(--space-2);
  color: var(--color-text-muted);
  text-align: center;
  font-size: var(--text-label);
}

.ws-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 280px;
  overflow-y: auto;
}

.ws-item {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-xs);
  cursor: default;
  user-select: none;
}
.ws-item:hover { background: var(--color-hover); }
.ws-item.current { color: var(--color-interact-text); }
.ws-item-icon { color: inherit; flex-shrink: 0; }
.ws-item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-item-forget {
  border: none;
  background: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: var(--space-1-5);
  border-radius: var(--radius-xs);
  display: flex;
  opacity: 0;
  transition: opacity var(--transition-fast);
}
.ws-item:hover .ws-item-forget,
.ws-item:focus-within .ws-item-forget { opacity: 0.6; }
.ws-item-forget:hover,
.ws-item-forget:focus-visible {
  opacity: 1 !important;
  color: var(--color-error-text);
  background: var(--color-error-soft);
  outline: none;
}

.ws-popover-divider {
  height: 1px;
  margin: var(--space-1) var(--space-1);
  background: var(--color-border);
}

/* AppButton owns the shape + states; scope it to fill the popover width and
   left-align so it reads as a menu action, not a centred CTA. */
.ws-open-btn { width: 100%; justify-content: flex-start; }
</style>
