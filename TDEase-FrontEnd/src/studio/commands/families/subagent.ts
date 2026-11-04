import type { CommandContext, CommandDefinition } from '../registry'
import { objectSchema, optionalStringArray, requiredString, stringSchema } from '../args'

// Explicit execution primitives, no result-injection side channel: a subagent is a completely ordinary
// bound session on an independent sessionId with a narrowed tool surface.
// The port is injected by electron/agent/subagent-registry.ts; `enabled`
// keeps the commands unadvertised when the port is absent.
export function subagentCommands(): ReadonlyArray<CommandDefinition> {
  return ([
    {
      id: 'subagent.spawn', title: 'Spawn Subagent',
      exposure: { mindsets: 'all' },
      summary: 'Spawn a focused child session to work one bounded task in the background. Returns subagentId immediately; the child streams nothing into this transcript, only its structured result when done. role resolves tdease-ai-capability/system/subagents/<role>/SKILL.md, or "generic" for a one-off plain child.',
      args: objectSchema({
        role: stringSchema(),
        task: stringSchema(),
        input: { type: 'object' },
        toolAllowlist: { type: 'array', items: stringSchema() },
        context: { type: 'string', enum: ['fresh', 'fork'] },
      }, ['role', 'task']),
      mutates: true, permission: 'subagent.spawn', stakes: 'inline',
      enabled: (context) => Boolean(context.subagents),
      run: async (args, context) =>
        requireSubagents(context).spawn({
          role: requiredString(args, 'role'),
          task: requiredString(args, 'task'),
          input: args.input as Record<string, unknown> | undefined,
          toolAllowlist: optionalStringArray(args, 'toolAllowlist'),
          context: (args.context as 'fresh' | 'fork' | undefined) ?? 'fresh',
        }),
    },
    {
      id: 'subagent.status', title: 'Subagent Status',
      exposure: { mindsets: 'all' },
      summary: 'Report one subagent run state for the UI inspector.',
      args: objectSchema({ subagentId: stringSchema() }, ['subagentId']),
      mutates: false,
      agentVisible: false,
      hiddenReason: 'UI inspection only; Agent orchestration uses subagent.wait.',
      enabled: (context) => Boolean(context.subagents),
      run: async (args, context) =>
        requireSubagents(context).status(requiredString(args, 'subagentId')),
    },
    {
      id: 'subagent.cancel', title: 'Cancel Subagent',
      exposure: { mindsets: 'all' },
      summary: 'Abort a running subagent. A cancelled run keeps partial findings and settles as cancelled — never silently as success.',
      args: objectSchema({ subagentId: stringSchema() }, ['subagentId']),
      mutates: true, permission: 'subagent.cancel', stakes: 'inline',
      enabled: (context) => Boolean(context.subagents),
      run: async (args, context) =>
        requireSubagents(context).cancel(requiredString(args, 'subagentId')),
    },
    {
      id: 'subagent.wait', title: 'Wait For Subagents',
      exposure: { mindsets: 'all' },
      summary: 'Wait for subagent results. The selector is optional: omit both groupId and subagentIds to collect EVERY child in this session — it waits for all still-running children, then returns every terminal record (use this to recover results when you did not keep the ids). Otherwise pass exactly one of groupId (after spawnGroup) or subagentIds:[id] (after followup). Default returns after one selected child settles so you can loop; all:true — and the unscoped form — waits for every child. Returned terminal statuses carry structured results; findings are capped at 24 and long strings truncated (flagged truncated:true), so use followup or the child conversation for full detail. Never poll status or transcripts.',
      args: objectSchema({
        groupId: stringSchema(),
        subagentIds: { type: 'array', minItems: 1, items: stringSchema() },
        all: { type: 'boolean' },
      }, []),
      mutates: false,
      enabled: (context) => Boolean(context.subagents),
      run: async (args, context, execution) =>
        requireSubagents(context).wait({
          groupId: typeof args.groupId === 'string' ? args.groupId : undefined,
          subagentIds: optionalStringArray(args, 'subagentIds'),
          all: args.all === true,
        }, execution?.signal),
    },
    {
      id: 'subagent.followup', title: 'Follow Up With Subagent',
      exposure: { mindsets: 'all' },
      summary: 'Continue a settled subagent in its existing session and context. Then call subagent.wait with only subagentIds:[that id]; never include groupId in the same wait call.',
      args: objectSchema({ subagentId: stringSchema(), message: stringSchema() }, ['subagentId', 'message']),
      mutates: true, permission: 'subagent.spawn', stakes: 'inline',
      enabled: (context) => Boolean(context.subagents),
      run: async (args, context) => requireSubagents(context).followup({
        subagentId: requiredString(args, 'subagentId'),
        message: requiredString(args, 'message'),
      }),
    },
    {
      id: 'subagent.spawnGroup', title: 'Spawn Subagent Group',
      exposure: { mindsets: 'all' },
      summary: 'Fan out N independent subagent tasks under one shared groupId. Each task is a normal spawn (role/task/input); the group is an aggregation label so the panel can show them together. Use for independent parallel work (e.g. validate several candidates at once). Returns {groupId, subagentIds}.',
      args: objectSchema({
        tasks: {
          type: 'array', minItems: 1,
          items: objectSchema({
            role: stringSchema(),
            task: stringSchema(),
            input: { type: 'object' },
            toolAllowlist: { type: 'array', items: stringSchema() },
            context: { type: 'string', enum: ['fresh', 'fork'] },
            timeoutS: { type: 'number', minimum: 1 },
          }, ['role', 'task']),
        },
        concurrency: { type: 'number', minimum: 1 },
        groupId: stringSchema(),
      }, ['tasks']),
      mutates: true, permission: 'subagent.spawn', stakes: 'inline',
      enabled: (context) => Boolean(context.subagents),
      run: async (args, context) =>
        requireSubagents(context).spawnGroup({
          tasks: (args.tasks as ReadonlyArray<Record<string, unknown>>).map((task) => ({
            role: requiredString(task, 'role'),
            task: requiredString(task, 'task'),
            input: task.input as Record<string, unknown> | undefined,
            toolAllowlist: optionalStringArray(task, 'toolAllowlist'),
            context: (task.context as 'fresh' | 'fork' | undefined) ?? 'fresh',
            timeoutS: typeof task.timeoutS === 'number' ? task.timeoutS : undefined,
          })),
          concurrency: typeof args.concurrency === 'number' ? args.concurrency : undefined,
          groupId: typeof args.groupId === 'string' ? args.groupId : undefined,
        }),
    },
    {
      id: 'subagent.list', title: 'List Subagent Roles',
      exposure: { mindsets: 'all' },
      summary: 'Discover the available subagent roles from tdease-ai-capability/system/subagents/<role>/SKILL.md. Call this before spawning an unfamiliar role to see the roster and each role description; do not guess role names.',
      args: objectSchema({}, []),
      mutates: false,
      enabled: (context) => Boolean(context.subagents),
      run: async (_args, context) =>
        requireSubagents(context).listAgents(),
    },
    {
      id: 'subagent.peek', title: 'Peek Subagent Activity',
      exposure: { mindsets: 'all' },
      summary: 'Tail a running or settled subagent recent activity — last tool calls and assistant snippet — to see what it is doing or concluded. Lighter than reading the full transcript.',
      args: objectSchema({ subagentId: stringSchema(), lines: { type: 'number', minimum: 1, maximum: 500 } }, ['subagentId']),
      mutates: false,
      agentVisible: false,
      hiddenReason: 'Transcript peeking is UI inspection; Agent orchestration uses subagent.wait.',
      enabled: (context) => Boolean(context.subagents),
      run: async (args, context) =>
        requireSubagents(context).peek(requiredString(args, 'subagentId'), typeof args.lines === 'number' ? args.lines : undefined),
    },
  ] satisfies CommandDefinition[])
}

function requireSubagents(context: CommandContext) {
  if (!context.subagents) throw new Error('Subagents are unavailable in this session')
  return context.subagents
}
