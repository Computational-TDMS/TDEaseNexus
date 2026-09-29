import type { MindsetId } from './prompt'
import { normalizeAgentToolSettings } from '@/contracts/agent-runtime'
import type {
  AgentBuiltinToolName,
  AgentPermissionAction,
  AgentToolPreferences,
  AgentToolSettings,
} from '@/contracts/agent-runtime'
import { studioCommandDefinitions } from '@/studio/commands/definitions'
import type { CommandDefinition } from '@/studio/commands/registry'

export {
  AGENT_TOOL_SETTING_KEYS,
  DEFAULT_AGENT_TOOL_SETTINGS,
  normalizeAgentToolSettings,
} from '@/contracts/agent-runtime'
export type { AgentToolSettingKey, AgentToolSettings } from '@/contracts/agent-runtime'

export interface AgentToolProfile {
  key: string
  runtime: AgentToolPreferences
  includeTodo: boolean
  allowsStudioCommand(id: string): boolean
  /** Canonical tool name → permission action: builtins by name, studio
   *  commands by their declared `permission`. One table for the whole tool
   *  surface — the gate, PTC, and the approval flow all resolve through it. */
  actionForTool(toolName: string): AgentPermissionAction | undefined
}

/** The builtin side of the tool surface: which action each builtin satisfies.
 *  The builtin LIST per mindset lives in `createAgentToolProfile` below; this
 *  table is the name→action half that used to live in agent-runtime's
 *  buildToolActions, next to a second copy of the same facts. `mcp` is the
 *  MCP bridge pseudo-tool — not an AgentBuiltinToolName, but it carries the
 *  same shell.exec action when the bridge is enabled. */
const BUILTIN_ACTIONS: Readonly<Record<AgentBuiltinToolName | 'mcp', AgentPermissionAction>> = {
  read: 'workspace.read',
  grep: 'workspace.read',
  find: 'workspace.read',
  ls: 'workspace.read',
  write: 'workspace.write',
  edit: 'workspace.write',
  bash: 'shell.exec',
  mcp: 'shell.exec',
}

/**
 * The bare-name → action lookup for consumers that classify one tool name
 * without a full profile (the approval card's whitelist derivation). The
 * SAME table the runtime gates through — a mapping change here can never
 * desync a downstream classifier.
 */
export function builtinActionFor(toolName: string): AgentPermissionAction | undefined {
  return (BUILTIN_ACTIONS as Readonly<Record<string, AgentPermissionAction>>)[toolName]
}

/**
 * The tool-gating module: everything the runtime needs to answer "can the
 * model see tool X right now" is derived here, from one source — the command
 * registry's own metadata (`exposure` for visibility, `permission` for the
 * action) plus the builtin table above. Before this derivation existed, the
 * same facts lived in three parallel id lists (tool-profile's Sets,
 * agent-runtime's buildToolActions, subagent-registry's narrowing Sets), and a
 * new command had to be added to each by hand — the phantom-tool defect class
 * (job.* was its last live round).
 */
export function createAgentToolProfile(
  mindset: MindsetId,
  rawSettings: AgentToolSettings,
  definitions: ReadonlyArray<Pick<CommandDefinition, 'id' | 'exposure' | 'permission'>> = studioCommandDefinitions(),
): AgentToolProfile {
  const settings = normalizeAgentToolSettings(rawSettings)
  const executor = mindset === 'executor'
  const scientific = mindset === 'explorer' || executor
  const builtins: AgentBuiltinToolName[] = ['read', 'grep', 'find', 'ls']
  if (executor && settings.workspaceWrite) builtins.push('write', 'edit')
  if (settings.shell) builtins.push('bash')

  const byId = new Map(definitions.map((definition) => [definition.id, definition]))

  const allowsStudioCommand = (id: string): boolean => {
    // Absent exposure = never agent-visible: UI-only and compatibility
    // commands declare none, and an unclassified new command fails closed
    // instead of leaking into every mindset.
    const exposure = byId.get(id)?.exposure
    if (!exposure) return false
    if (exposure.mindsets === 'executor' && !executor) return false
    if (exposure.mindsets === 'scientific' && !scientific) return false
    if (exposure.setting && !settings[exposure.setting]) return false
    return true
  }

  const actionForTool = (toolName: string): AgentPermissionAction | undefined => {
    if (toolName in BUILTIN_ACTIONS) return BUILTIN_ACTIONS[toolName as keyof typeof BUILTIN_ACTIONS]
    if (toolName.startsWith('tdease.')) return byId.get(toolName.slice('tdease.'.length))?.permission
    return undefined
  }

  const runtime = Object.freeze({
    builtins: Object.freeze(builtins),
    mcp: settings.mcp,
  })
  return Object.freeze({
    key: JSON.stringify({ mindset, settings }),
    runtime,
    includeTodo: executor,
    allowsStudioCommand,
    actionForTool,
  })
}
