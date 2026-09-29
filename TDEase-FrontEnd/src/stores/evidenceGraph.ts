/**
 * Evidence graph store — the Workspace-wide PROV claim DAG for humans.
 *
 * Thin lifecycle wrapper over `createWorkspaceEvidence(...).graph()`: it owns
 * the `EvidenceFileSystem` adapter onto `ViewsFS`, a refresh loop, and the
 * file watcher that makes the graph self-updating when the Agent (or anyone
 * else) writes a new `*.prov.json` claim.
 *
 * Read-only on purpose. Writing Evidence stays `tdease.evidence.write`, a
 * command with a permission boundary; this store never calls `write`/`verify`,
 * so its `writeTextAtomic` refuses rather than silently bypassing that gate.
 */

import { ref } from 'vue'
import { defineStore } from 'pinia'
import { getViewsFS } from '@/services/workspace/views-fs'
import { createFileWatcher, type FileWatcher } from '@/services/workspace/fileWatcher'
import {
  createWorkspaceEvidence,
  type EvidenceFileSystem,
  type EvidenceGraphProjection,
} from '@/services/workspace/workspaceEvidence'

export const useEvidenceGraphStore = defineStore('evidenceGraph', () => {
  const graph = ref<EvidenceGraphProjection | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const workspaceRoot = ref('')

  let watcher: FileWatcher | null = null
  let unsubscribe: (() => void) | null = null

  function evidenceFs(): EvidenceFileSystem {
    const fs = getViewsFS()
    const root = workspaceRoot.value
    return {
      listFiles: () => fs.listFiles('**/*.prov.json', ''),
      readText: (path) => fs.readFile(root ? `${root}/${path}` : path),
      writeTextAtomic: () => Promise.reject(new Error('The Evidence graph view is read-only')),
      async digest(path) {
        const text = await fs.readFile(root ? `${root}/${path}` : path)
        const bytes = new TextEncoder().encode(text)
        const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
        const sha256 = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')
        return { sha256, size: bytes.byteLength }
      },
    }
  }

  async function refresh() {
    if (!workspaceRoot.value) return
    loading.value = true
    error.value = null
    try {
      graph.value = await createWorkspaceEvidence(evidenceFs()).graph()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  function initializeFromPath(path: string) {
    if (path === workspaceRoot.value) return
    teardown()
    workspaceRoot.value = path
    if (!path) return
    watcher = createFileWatcher(path, ['evidence/**', 'runs/*/evidence/**'])
    unsubscribe = watcher.on((event) => {
      // Watcher events are Workspace-relative (same contract as views.ts).
      if (!/^(?:evidence|runs\/[^/]+\/evidence)\//.test(event.path)) return
      void refresh()
    })
    void watcher.start()
    void refresh()
  }

  function teardown() {
    unsubscribe?.()
    unsubscribe = null
    void watcher?.stop()
    watcher = null
    workspaceRoot.value = ''
    graph.value = null
    error.value = null
    loading.value = false
  }

  return { graph, loading, error, workspaceRoot, refresh, initializeFromPath, teardown }
})
