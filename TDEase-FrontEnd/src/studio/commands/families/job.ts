import type { CommandContext, CommandDefinition } from '../registry'
import { objectSchema, optionalStringArray, requiredString, stringSchema } from '../args'

// The shell-command analogue of a subagent: `start` returns jobId
// immediately, the command runs fire-and-forget, and completion is injected
// into the next provider request via the context hook (tdease-extension.ts)
// — the model never `bash sleep + status` polls. Use for genuinely long
// commands (mass-spec processing, census, large-file parsing); short
// commands stay on synchronous `bash`. The port is injected by
// electron/agent/job-registry.ts; `enabled` keeps the commands unadvertised
// when the port is absent.
export function jobCommands(): ReadonlyArray<CommandDefinition> {
  return ([
    {
      id: 'job.start', title: 'Start Background Job',
      exposure: { mindsets: 'all' },
      summary: 'Run a long shell command in the background and return {jobId, waitable, suggestedWaitS} immediately. The command keeps running after this call returns; its completion (exit code + output tail) is also announced to you automatically in a later turn. Follow with job.wait({jobIds:[id]}) to block for it — never poll with sleep or job.status. Use job.peek for live progress, job.cancel to stop. Prefer this over bash only when the command is genuinely long (tens of seconds or more); short commands stay on synchronous bash.',
      args: objectSchema({
        command: stringSchema(),
        cwd: stringSchema(),
        timeoutS: { type: 'number', minimum: 1 },
      }, ['command']),
      mutates: true, permission: 'shell.exec', stakes: 'inline',
      enabled: (context) => Boolean(context.jobs),
      run: async (args, context) =>
        requireJobs(context).start({
          command: requiredString(args, 'command'),
          ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}),
          ...(typeof args.timeoutS === 'number' ? { timeoutS: args.timeoutS } : {}),
        }),
    },
    {
      id: 'job.wait', title: 'Wait For Jobs',
      exposure: { mindsets: 'all' },
      summary: 'Block until background jobs settle, then return their terminal statuses (state, exit code, output tail). Omit jobIds to wait for EVERY job in this session (the collect-everything form — waits for all); pass jobIds:[id] to wait on specific jobs, where the default returns on the FIRST completion so you can loop, or all:true to wait for every one. This is the only way to wait for a job: never poll job.status or sleep.',
      args: objectSchema({
        jobIds: { type: 'array', minItems: 1, items: stringSchema() },
        all: { type: 'boolean' },
      }, []),
      mutates: false,
      enabled: (context) => Boolean(context.jobs),
      run: async (args, context, execution) =>
        requireJobs(context).wait({
          jobIds: optionalStringArray(args, 'jobIds'),
          all: args.all === true,
        }, execution?.signal),
    },
    {
      id: 'job.status', title: 'Job Status',
      exposure: { mindsets: 'all' },
      summary: 'Report one background job state (running/succeeded/failed/cancelled), exit code, and elapsed time. Completion is pushed to you automatically — use this only when you need the state right now.',
      args: objectSchema({ jobId: stringSchema() }, ['jobId']),
      mutates: false,
      agentVisible: false,
      hiddenReason: 'Status polling is UI/diagnostics only; the Agent waits with job.wait and is told about completions automatically.',
      enabled: (context) => Boolean(context.jobs),
      run: async (args, context) =>
        requireJobs(context).status(requiredString(args, 'jobId')),
    },
    {
      id: 'job.peek', title: 'Peek Job Output',
      exposure: { mindsets: 'all' },
      summary: 'Tail a background job stdout/stderr — see live progress, or what a finished job printed. Lighter than re-reading the full log.',
      args: objectSchema({ jobId: stringSchema(), lines: { type: 'number', minimum: 1, maximum: 500 } }, ['jobId']),
      mutates: false,
      enabled: (context) => Boolean(context.jobs),
      run: async (args, context) =>
        requireJobs(context).peek(requiredString(args, 'jobId'), typeof args.lines === 'number' ? args.lines : undefined),
    },
    {
      id: 'job.cancel', title: 'Cancel Job',
      exposure: { mindsets: 'all' },
      summary: 'Stop a running background job. A cancelled job settles as cancelled — never silently as success.',
      args: objectSchema({ jobId: stringSchema() }, ['jobId']),
      mutates: true, permission: 'shell.exec', stakes: 'inline',
      enabled: (context) => Boolean(context.jobs),
      run: async (args, context) =>
        requireJobs(context).cancel(requiredString(args, 'jobId')),
    },
    {
      id: 'job.list', title: 'List Jobs',
      exposure: { mindsets: 'all' },
      summary: 'List all background jobs for this session with their current state. Use to see what is still running or review settled jobs.',
      args: objectSchema({}, []),
      mutates: false,
      enabled: (context) => Boolean(context.jobs),
      run: async (_args, context) =>
        requireJobs(context).list(),
    },
  ] satisfies CommandDefinition[])
}

function requireJobs(context: CommandContext) {
  if (!context.jobs) throw new Error('Background jobs are unavailable in this session')
  return context.jobs
}
