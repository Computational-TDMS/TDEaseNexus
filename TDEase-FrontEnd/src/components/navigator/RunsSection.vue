<!--
  RunsSection — the Navigator's first tab, focused on run folders.

  The Workspace's top-level `runs/` directory holds one folder per run — each
  named by the user (e.g. `histone48-mouse`, `chlamy-pnnl-batch`) and carrying
  that run's own data, Snakefile and analysis (FILE-LAYOUT.md §4:
  "user-authored run drafts, flat layout"). This section lists those run
  folders directly, so a user lands on their runs — the actual work units —
  rather than on the full file tree's noise (raw data dumps, config, logs).

  Where the ActivityDock shows a Backend run's live STATE (running / queued /
  failed, streamed from the server), this section shows the Workspace's
  user-authored run FOLDERS — the local files. The two are deliberately
  separate surfaces: state vs. files.

  Each run is a collapsible layer; opening it lazy-loads that run's contents
  (files and sub-directories alike — a run's analysis/ and data
  files are all things the user manages) the same way the Files tree does
  (loadDirLazy), and an item opens through the same `openWorkspaceFile`
  entrance every other section uses — no second document kind, no second
  selection model.
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDown, ArrowRight, Folder } from '@element-plus/icons-vue'
import Empty from '@/components/primitives/Empty.vue'
import type { FileTreeNode } from '@/types/workspace-data'
import { useDocumentsStore } from '@/stores/documents'
import { useWorkspaceStore } from '@/stores/workspace'

const { t } = useI18n()
const workspaceStore = useWorkspaceStore()
const documentsStore = useDocumentsStore()

/**
 * The Workspace's top-level runs directory — one folder per user-authored run
 * (FILE-LAYOUT.md §4). Not the Backend's `results/` task output, and not the
 * `run-files/` document-id prefix (documents.ts, the id↔key boundary) which
 * is a virtual namespace that never exists on disk.
 */
const RUNS_DIR = 'runs'

const hasWorkspace = computed(() => workspaceStore.hasWorkspace)

/** The `runs/` directory node in the loaded tree, if the Workspace has one. */
const runsDirNode = computed<FileTreeNode | null>(() =>
  workspaceStore.fileTree.find((node) => node.path === RUNS_DIR && node.type === 'directory') ?? null)

/**
 * Run folders directly under `runs/`. Each child directory IS a run (named by
 * the user, e.g. `histone48-mouse`). Read from whichever projection has it:
 * the seed `children` from loadFileTree, or `directoryCache` filled by an expand.
 */
const runDirs = computed<ReadonlyArray<FileTreeNode>>(() => {
  const byPath = new Map<string, FileTreeNode>()
  const consider = (node: FileTreeNode) => {
    if (node.type !== 'directory') return
    byPath.set(node.path, node)
  }
  for (const child of runsDirNode.value?.children ?? []) consider(child)
  for (const child of workspaceStore.directoryCache.get(RUNS_DIR) ?? []) consider(child)
  // Newest-first is not knowable from the tree alone (no mtime here), so fall
  // back to name sort — stable and predictable.
  return Array.from(byPath.values())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
})

/** Expanded run layers — which run folders the user has opened. */
const expandedRuns = ref<Set<string>>(new Set())

function toggleRun(path: string) {
  if (expandedRuns.value.has(path)) {
    expandedRuns.value.delete(path)
  } else {
    expandedRuns.value.add(path)
    // Lazy-load the run's contents on first expand, same pattern as the Files
    // tree.
    if (!workspaceStore.directoryCache.has(path)) void workspaceStore.loadDirLazy(path)
  }
}

/**
 * Contents inside a run folder, from the lazy cache (loaded on expand). Files
 * AND sub-directories are shown — a run's analysis/ and data files
 * are all things the user manages, so none are hidden here. The noise cut is
 * structural (this section only shows runs/, not the whole tree), not a filter
 * inside each run.
 */
function runContents(runPath: string): ReadonlyArray<FileTreeNode> {
  return (workspaceStore.directoryCache.get(runPath) ?? [])
    .sort((a, b) => {
      // Directories first, then files; name sort within each group — same order
      // the Files tree uses, so a run folder reads the same way here as there.
      const ad = a.type === 'directory' ? 0 : 1
      const bd = b.type === 'directory' ? 0 : 1
      if (ad !== bd) return ad - bd
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
    })
}

function ensureListed() {
  if (!runsDirNode.value) return
  if ((runsDirNode.value.children?.length ?? 0) > 0) return
  if (workspaceStore.directoryCache.has(RUNS_DIR)) return
  void workspaceStore.loadDirLazy(RUNS_DIR)
}

onMounted(ensureListed)
watch(() => workspaceStore.fileTree, ensureListed)

function openFile(node: FileTreeNode) {
  documentsStore.openWorkspaceFile(node.path)
}

function isOpen(node: FileTreeNode): boolean {
  const key = documentsStore.activeKey
  return key?.kind === 'file' && key.path === node.path
}
</script>

<template>
  <div class="runs-section">
    <Empty
      v-if="!hasWorkspace"
      data-state="no-workspace"
      :title="t('workbench.filesSection.noWorkspaceTitle')"
      :description="t('workbench.filesSection.noWorkspaceDescription')"
    />
    <Empty
      v-else-if="!runsDirNode || runDirs.length === 0"
      data-state="no-runs"
      :title="t('workbench.navigator.runs.emptyTitle')"
      :description="t('workbench.navigator.runs.emptyDescription')"
    />
    <ul
      v-else
      class="runs-section__list"
      :aria-label="t('workbench.navigator.runs.emptyTitle')"
    >
      <li v-for="run in runDirs" :key="run.path" class="runs-section__run">
        <button
          type="button"
          class="runs-section__run-header"
          :aria-expanded="expandedRuns.has(run.path)"
          :title="run.name"
          @click="toggleRun(run.path)"
        >
          <el-icon :size="12" class="runs-section__chev" aria-hidden="true">
            <ArrowDown v-if="expandedRuns.has(run.path)" />
            <ArrowRight v-else />
          </el-icon>
          <span class="runs-section__run-name">{{ run.name }}</span>
        </button>
        <ul
          v-if="expandedRuns.has(run.path)"
          class="runs-section__items"
        >
          <li
            v-for="item in runContents(run.path)"
            :key="item.path"
          >
            <button
              type="button"
              class="runs-section__item"
              :class="{ 'is-dir': item.type === 'directory', 'is-active': isOpen(item) }"
              :title="item.name"
              @click="openFile(item)"
            >
              <el-icon v-if="item.type === 'directory'" :size="13" class="runs-section__item-icon" aria-hidden="true"><Folder /></el-icon>
              <span class="runs-section__item-name">{{ item.name }}</span>
            </button>
          </li>
          <li v-if="runContents(run.path).length === 0" class="runs-section__item-empty">
            {{ t('workbench.fileTree.emptyFolder') }}
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.runs-section {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: var(--space-1) 0;
  overflow: auto;
}

.runs-section__list,
.runs-section__items {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* A run layer header — collapsible, carries the run name. Same register as
   the Files tree's directory rows: full-width, transparent, hover lifts. */
.runs-section__run-header {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  width: 100%;
  height: var(--row-h);
  min-height: var(--row-h);
  padding: 0 var(--space-2) 0 var(--space-1);
  border: none;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-sm);
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: background-color var(--dur-instant) var(--ease-out);
}

.runs-section__run-header:hover {
  background: var(--color-hover);
}

.runs-section__run-header:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: -2px;
}

.runs-section__chev {
  flex: none;
  color: var(--color-text-disabled);
}

.runs-section__run-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Items inside a run — indented one level, quieter than the run header.
   Files are leaves; directories carry a folder glyph so the two read as
   distinct kinds at a glance (same convention as the Files tree). */
.runs-section__item {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  width: 100%;
  height: var(--row-h-sm);
  min-height: var(--row-h-sm);
  padding: 0 var(--space-3) 0 calc(var(--space-2) + var(--space-3) + var(--space-1-5));
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
  text-align: left;
  transition: background-color var(--dur-instant) var(--ease-out), color var(--dur-instant) var(--ease-out);
}

.runs-section__item:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.runs-section__item.is-dir {
  color: var(--color-text);
  font-weight: 500;
}

.runs-section__item.is-active {
  color: var(--color-primary);
  background: var(--color-primary-soft);
}

.runs-section__item:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: -2px;
}

.runs-section__item-icon {
  flex: none;
  color: var(--color-text-disabled);
}

.runs-section__item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.runs-section__item-empty {
  padding: var(--space-1) var(--space-3) var(--space-1) calc(var(--space-2) + var(--space-3) + var(--space-1-5));
  color: var(--color-text-disabled);
  font-size: var(--text-label);
}
</style>
