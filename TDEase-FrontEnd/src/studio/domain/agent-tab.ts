/**
 * AgentTab — the identity model for a tab in the Agent page's right sidebar.
 *
 * This is the Agent-side twin of `DocumentKey`/`OpenDocument`, kept SEPARATE
 * on purpose: `documents.ts` is a singleton store with one `activeDocumentId`
 * shared by the Workbench's `DocumentHost`. Routing Agent assets through it
 * would make the two pages fight over the single active document. Instead the
 * Agent page owns its own tab host with its own (simpler) identity and store.
 *
 * Simpler than `OpenDocument`: no `dirty` (the right sidebar is a viewer, not
 * an editor), no `pinned`/`preview` tiers (it is a short-lived lookup surface),
 * no persistence (tabs are session-scoped — close the session, the tabs go).
 *
 * Kinds:
 *   `agent-file`      — a workspace file, rendered by the same `FileDocument`
 *                       the Workbench uses (viewer reuse, not a second viewer).
 *   `agent-subagent`  — one subagent's full conversation, read from its session
 *                       log on disk (`<workspace>/.tdease/sessions/<subagentId>`
 *                       via the same `projectSessionEvents` path the parent
 *                       session's history uses). Keyed on subagentId, so two
 *                       different subagents are two tabs; the same one refocuses.
 *   `agent-files` — the files gallery (one per session, singleton tab).
 *   `agent-plan`      — the session todo plan (one per session, singleton tab).
 *   `agent-evidence`  — the evidence panel (one per session, singleton tab).
 *   `agent-settings`  — the per-turn runtime config drawer (model, thinking
 *                       effort, context-window readout). Singleton.
 *   `agent-trajectory` — the trajectory inspector: the session's canonical
 *                       atoms re-folded as one row per turn (prompt, requests
 *                       with their digest chain, tool calls, settlement).
 *                       Singleton.
 *
 * The four singleton `agent-*` view kinds have no per-instance identity, so
 * opening one twice just refocuses it. `agent-file`, `agent-subagent` and
 * `agent-run` carry identity (path / subagentId / runId), so distinct instances
 * are distinct tabs.
 */
import type { RelativePath, WorkspaceId } from './identity'

export type AgentTabKey =
  | { kind: 'agent-file'; workspaceId: WorkspaceId; path: RelativePath }
  | { kind: 'agent-subagent'; subagentId: string; role: string }
  | { kind: 'agent-run'; runId: string }
  | { kind: 'agent-files' }
  | { kind: 'agent-plan' }
  | { kind: 'agent-evidence' }
  | { kind: 'agent-settings' }
  | { kind: 'agent-trajectory' }
  /** Side chat: a child conversation of the active session (see
   *  `createSideSession`). Keyed by the child session id; the parent id rides
   *  along for the panel's provenance display. */
  | { kind: 'agent-side-chat'; sessionId: string; parentSessionId: string }

export type AgentTabKind = AgentTabKey['kind']

export interface AgentTab {
  key: AgentTabKey
  /** Canonical id (see `agentTabId`); stable for the tab's lifetime. */
  id: string
  title: string
  /** Open order, for stable tab-strip sorting. */
  openedAt: number
  /** Last-focused time, for MRU close fallback. */
  lastActiveAt: number
}

/**
 * Canonical id for an AgentTabKey — stable, collision-free. Singleton kinds
 * collapse to a fixed id (one Files tab per session, etc.); `agent-file`
 * is keyed on the path and `agent-subagent` on its subagentId, so two different
 * files / subagents are two tabs while re-opening the same one refocuses.
 */
export function agentTabId(key: AgentTabKey): string {
  switch (key.kind) {
    case 'agent-file': return `agent-file:${key.workspaceId}:${key.path}`
    case 'agent-subagent': return `agent-subagent:${key.subagentId}`
    case 'agent-run': return `agent-run:${key.runId}`
    case 'agent-files': return 'agent-files'
    case 'agent-plan': return 'agent-plan'
    case 'agent-evidence': return 'agent-evidence'
    case 'agent-settings': return 'agent-settings'
    case 'agent-trajectory': return 'agent-trajectory'
    case 'agent-side-chat': return `agent-side-chat:${key.sessionId}`
  }
}
