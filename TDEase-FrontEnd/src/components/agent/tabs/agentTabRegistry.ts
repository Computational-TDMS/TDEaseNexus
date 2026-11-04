/**
 * agentTabRegistry — the Agent tab host's dispatch table.
 *
 * The Agent-side twin of `components/documents/registry.ts`, kept SEPARATE so
 * the two registries never share kinds. Maps each `AgentTabKind` to the
 * component the `AgentTabHost` mounts — reusing the Workbench's real viewers
 * (`FileDocument`) and the existing Agent view components
 * (`SubagentList`/`AgentFileList`/`SessionTodoCard`) rather than
 * writing seconds.
 *
 * Lighter than the document registry: no `notBuilt` placeholder, no totality
 * assertion beyond a Map lookup. The kind union is small and every kind ships
 * a real component, so there is no "owed surface" to record.
 */
import { defineAsyncComponent } from 'vue'
import type { Component } from 'vue'
import type { AgentTabKey } from '@/studio/domain/agent-tab'
// The two document reuse tabs are async for the same reason their rows in
// `documents/definitions.ts` are: FileDocument statically pulls the plotly
// spectrum chain and RunDocument the dagre workflow graph, and this registry
// sits on the AgentPage static path into the entry chunk — a static import
// here re-shipmates ~5MB of vendor code with the app shell.
const FileDocument = defineAsyncComponent(() => import('@/components/documents/FileDocument.vue'))
const RunDocument = defineAsyncComponent(() => import('@/components/documents/RunDocument.vue'))
import AgentFileList from '../AgentFileList.vue'
import SessionTodoCard from '../SessionTodoCard.vue'
import SubagentConversation from '../SubagentConversation.vue'
import AgentSettingsTab from './AgentSettingsTab.vue'
import TrajectoryTab from '../TrajectoryTab.vue'
import SideChatTab from './SideChatTab.vue'

export type AgentTabKind = AgentTabKey['kind']

export interface ResolvedAgentTab {
  component: Component
  props: Record<string, unknown>
}

/** Props derived from a key, or absent when the component takes none. */
type PropsFor<K extends AgentTabKind> = (key: Extract<AgentTabKey, { kind: K }>) => Record<string, unknown>

interface AgentTabDefinition {
  component: Component
  props?: (key: AgentTabKey) => Record<string, unknown>
}

/** Type-checks a per-kind props function against its specific key shape. */
function typedProps<K extends AgentTabKind>(fn: PropsFor<K>): (key: AgentTabKey) => Record<string, unknown> {
  return fn as (key: AgentTabKey) => Record<string, unknown>
}

const definitions: Record<AgentTabKind, AgentTabDefinition> = {
  'agent-file': {
    component: FileDocument,
    // `citedByAgent: true` is structural provenance, not extra identity: every
    // agent-file tab is opened from an Agent-cited path (transcript file
    // click), never from the Navigator. FileDocument uses it to give an honest
    // "the Agent cited this path but it is not on disk" error instead of the
    // generic "your workspace file went missing" remedy — distinguishing a
    // hallucinated reference from a real deleted file.
    props: typedProps<'agent-file'>((key) => ({ workspaceId: key.workspaceId, path: key.path, citedByAgent: true })),
  },
  'agent-subagent': {
    // Reads the child session's conversation from disk and renders it with the
    // same Transcript the parent uses. No new IPC — see SubagentConversation.
    component: SubagentConversation,
    props: typedProps<'agent-subagent'>((key) => ({ subagentId: key.subagentId, role: key.role })),
  },
  'agent-run': {
    // The Workbench's real run page (status header, DAG, files) — viewer reuse:
    // a run opened from the Agent is the SAME page the Runs navigator opens,
    // not a second, thinner viewer. RunDocument self-reads useRunsStore.
    component: RunDocument,
    props: typedProps<'agent-run'>((key) => ({ runId: key.runId })),
  },
  'agent-files': {
    // AgentFileList already self-reads useAgentFilesStore.
    component: AgentFileList,
  },
  'agent-plan': {
    // SessionTodoCard reads the plan off the injected chatMessages ref.
    component: SessionTodoCard,
  },
  'agent-settings': {
    // The per-turn runtime config drawer. Reads the settings store directly and
    // injects the live turn readout (AgentPage provides it) for context/vision.
    component: AgentSettingsTab,
  },
  'agent-trajectory': {
    // The trajectory inspector: a pure derived map over the session's canonical
    // atoms (`agent/events/trajectory.ts`) — the same single truth the
    // transcript projected. Snapshot bodies load lazily from beside the log.
    component: TrajectoryTab,
  },
  'agent-side-chat': {
    // The selection-flow child conversation: a compact Transcript + composer
    // bound to the side session (see `createSideSession` for the session-layer
    // contract). Static import — it pulls the transcript, which is already on
    // this registry's static path.
    component: SideChatTab,
    props: typedProps<'agent-side-chat'>((key) => ({ sessionId: key.sessionId, parentSessionId: key.parentSessionId })),
  },
}

export function resolveAgentTab(key: AgentTabKey): ResolvedAgentTab {
  const def = definitions[key.kind]
  if (!def) {
    throw new Error(`Agent tab registry: no dispatch for AgentTabKind = ${JSON.stringify(key.kind)}`)
  }
  const props = def.props ? def.props(key) : {}
  return { component: def.component, props }
}
