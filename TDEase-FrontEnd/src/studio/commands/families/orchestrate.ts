import type { CommandContext, CommandDefinition } from '../registry'
import { objectSchema, optionalNumber, optionalString, requiredString, stringSchema } from '../args'

// A JS orchestration script whose agent()/parallel()/pipeline()/phase()
// calls fan work out across the existing subagent registry, with completed
// agent() calls journaled by positional index. `resumeFromRunId` replays the
// unchanged prefix and re-runs only the changed tail — so editing one prompt
// in a 20-agent script no longer re-pays for the other 19. Intermediate
// results stay in script variables instead of this transcript. See
// docs/design/ORCHESTRATE-RUNTIME.md.
export function orchestrateCommands(): ReadonlyArray<CommandDefinition> {
  return ([
    {
      id: 'orchestrate.run', title: 'Run Orchestration Script',
      exposure: { mindsets: 'all' },
      summary: 'Execute a JS orchestration script in the background. The script uses agent(prompt, opts?) to spawn a subagent (returns its §6 result), parallel(thunks) for concurrent fan-out, pipeline(items, ...stages) for staged fan-out, and phase(title) to mark progress. Each agent() call is cached by position so resumeFromRunId replays the unchanged prefix. Returns {runId}; call orchestrate.wait to receive the final result.',
      args: objectSchema({
        script: stringSchema(),
        args: { type: 'object' },
        resumeFromRunId: stringSchema(),
        maxAgents: { type: 'number', minimum: 1 },
        concurrency: { type: 'number', minimum: 1, maximum: 16 },
      }, ['script']),
      mutates: true, permission: 'subagent.spawn', stakes: 'inline',
      enabled: (context) => Boolean(context.orchestrate) && Boolean(context.subagents),
      run: async (args, context) => requireOrchestrate(context).run({
        script: requiredString(args, 'script'),
        args: args.args,
        resumeFromRunId: optionalString(args, 'resumeFromRunId'),
        maxAgents: optionalNumber(args, 'maxAgents'),
        concurrency: optionalNumber(args, 'concurrency'),
      }),
    },
    {
      id: 'orchestrate.wait', title: 'Wait For Orchestration',
      exposure: { mindsets: 'all' },
      summary: 'Block until an orchestration run settles, then return its final result. Call once after orchestrate.run; do not poll status.',
      args: objectSchema({ runId: stringSchema() }, ['runId']),
      mutates: false,
      enabled: (context) => Boolean(context.orchestrate),
      run: async (args, context, execution) => requireOrchestrate(context).wait(requiredString(args, 'runId'), execution?.signal),
    },
    {
      id: 'orchestrate.status', title: 'Orchestration Status',
      exposure: { mindsets: 'all' },
      summary: 'Report one orchestration run state — running/done/failed, current phase, and journaled agent() count.',
      args: objectSchema({ runId: stringSchema() }, ['runId']),
      mutates: false,
      agentVisible: false,
      hiddenReason: 'Live progress is UI inspection; Agent orchestration uses orchestrate.wait to join.',
      enabled: (context) => Boolean(context.orchestrate),
      run: async (args, context) => requireOrchestrate(context).status(requiredString(args, 'runId')),
    },
  ] satisfies CommandDefinition[])
}

function requireOrchestrate(context: CommandContext) {
  if (!context.orchestrate) throw new Error('Orchestration runtime is unavailable in this session')
  return context.orchestrate
}
