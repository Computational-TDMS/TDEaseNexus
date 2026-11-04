/**
 * useSessionMetadataPersistence — delta-persist session records (title,
 * timestamps, archived flag, mindset) to the workspace's session.json files,
 * extracted from AgentPage (architecture audit candidate 6).
 *
 * Delta persistence: the computed rebuilds every record whenever one session's
 * durable fields change, so the watcher compares against the last write and
 * touches only the session.json whose fields actually moved — one title edit
 * must not rewrite every session on disk. The watch stays shallow on purpose:
 * each recompute emits fresh record objects, so a reference change already
 * tracks the durable fields, and deep only adds full-traversal cost per tick.
 */
import { computed, watch, type Ref } from 'vue'
import { useAgentStore } from '@/stores/agent'
import {
  desktopWorkspaceTextBridge,
  writeWorkspaceSessionMetadata,
  type WorkspaceSessionMetadata,
  type WorkspaceTextBridge,
} from '@/services/agent/agentSessionStorage'

export function useSessionMetadataPersistence(
  workspacePath: Ref<string | undefined>,
  /** Lazy by contract: the desktop bridge THROWS outside Electron, so it must
   *  resolve at write time (inside the watcher), never at setup time. */
  resolveWorkspace: () => WorkspaceTextBridge = desktopWorkspaceTextBridge,
): void {
  const agentStore = useAgentStore()

  // Side sessions persist with the same delta discipline as the main lists —
  // they are excluded from `sessions`/`archivedSessions` by design, so they
  // must be unioned in here explicitly or a side chat's metadata would never
  // reach disk (and hydrate could never restore it).
  const durableSessions = computed(() => [...agentStore.sessions, ...agentStore.archivedSessions, ...agentStore.sideSessions].map((session): WorkspaceSessionMetadata => ({
    version: 1,
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    archived: session.archived === true,
    mindset: session.mindset,
    ...(session.sideOf ? { sideOf: session.sideOf } : {}),
  })))

  const lastWrittenSessions = new Map<string, WorkspaceSessionMetadata>()

  function sameSessionMetadata(left: WorkspaceSessionMetadata, right: WorkspaceSessionMetadata): boolean {
    return left.title === right.title
      && left.createdAt === right.createdAt
      && left.updatedAt === right.updatedAt
      && left.archived === right.archived
      && left.mindset === right.mindset
      && left.sideOf === right.sideOf
  }

  watch(durableSessions, (records) => {
    if (!workspacePath.value) return
    for (const record of records) {
      const written = lastWrittenSessions.get(record.id)
      if (written && sameSessionMetadata(written, record)) continue
      // Records are fresh-per-recompute projections, never mutated in place, so
      // holding the reference is a faithful "last written" snapshot.
      lastWrittenSessions.set(record.id, record)
      void writeWorkspaceSessionMetadata(resolveWorkspace(), workspacePath.value, record)
    }
  })
}
