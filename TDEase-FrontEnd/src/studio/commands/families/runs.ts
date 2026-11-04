import { asRelativePath, asRunId } from '../../domain/identity'
import type { RunStatus } from '../../domain/run'
import type { CommandDefinition, JsonSchema } from '../registry'
import { objectSchema, optionalInteger, optionalString, requiredString, stringSchema } from '../args'

const RUN_ID_ARGS: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['runId'],
  properties: { runId: { type: 'string', minLength: 1 } },
}

const RUN_STATUS: ReadonlyArray<RunStatus> = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']

/** Run observation and control: list/read/wait/diagnose plus resume/trash lifecycle (`studio.runs`). */
export function runsCommands(): ReadonlyArray<CommandDefinition> {
  return ([
    {
      id: 'runs.list', title: 'List Runs',
      exposure: { mindsets: 'all', setting: 'runObservation' },
      summary: 'Find registered Runs and their execution state. For a known Run, use runs.listFiles to discover published result files.',
      args: objectSchema({
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        status: { type: 'array', items: { type: 'string', enum: RUN_STATUS } },
        query: stringSchema(),
      }),
      mutates: false,
      run: async (args, context) => {
        const snapshot = await context.studio.runs.load({
          workspaceId: context.workspaceId,
          offset: optionalInteger(args, 'offset'),
          limit: optionalInteger(args, 'limit'),
          status: optionalRunStatuses(args.status),
          query: optionalString(args, 'query'),
        })
        return {
          items: [...snapshot.runs.values()], total: snapshot.total, offset: snapshot.offset,
          limit: snapshot.limit, hasMore: snapshot.hasMore,
        }
      },
    },
    {
      id: 'runs.status', title: 'Read Run Status',
      exposure: { mindsets: 'all', setting: 'runObservation' },
      summary: 'Read the current projection for one Run.',
      args: RUN_ID_ARGS, mutates: false,
      run: (args, context) => context.studio.runs.refresh(asRunId(requiredString(args, 'runId'))),
    },
    {
      id: 'runs.wait', title: 'Wait for Run Status',
      exposure: { mindsets: 'all', setting: 'runObservation' },
      summary: 'Wait up to a bounded deadline (max 300s) for one Run; re-call to keep waiting — settled runs are also announced automatically between steps.',
      args: objectSchema({
        runId: stringSchema(),
        deadlineMs: { type: 'integer', minimum: 1, maximum: 300_000 },
      }, ['runId']),
      mutates: false,
      run: (args, context, execution) => context.studio.runs.wait(
        asRunId(requiredString(args, 'runId')),
        optionalInteger(args, 'deadlineMs'),
        execution?.signal,
      ),
    },
    {
      id: 'runs.tailLog', title: 'Read Run Log Tail',
      exposure: { mindsets: 'all', setting: 'runObservation' },
      summary: 'Read a bounded tail of one Run engine log for diagnosis (at most 200 lines; the failure region sits at the end).',
      args: objectSchema({
        runId: stringSchema(), lines: { type: 'integer', minimum: 1, maximum: 200 },
      }, ['runId']),
      mutates: false,
      run: (args, context) => context.studio.runs.tailLog(
        asRunId(requiredString(args, 'runId')), optionalInteger(args, 'lines'),
      ),
    },
    {
      id: 'runs.listDefinitions', title: 'List Run Definitions',
      exposure: { mindsets: 'all', setting: 'runObservation' },
      summary: "List one Run's immutable definition history: each submitted revision with its outcome and the results revision it produced. Answers what changed between attempts and which execution made the current results.",
      args: RUN_ID_ARGS, mutates: false,
      run: (args, context) => context.studio.runs.listDefinitions(asRunId(requiredString(args, 'runId'))),
    },
    {
      id: 'runs.readDefinition', title: 'Read Run Definition',
      exposure: { mindsets: 'all', setting: 'runObservation' },
      summary: "Read one frozen definition's full content (exact Snakefile text, config, node digests, input manifest) — diff what an earlier revision actually executed before editing again.",
      args: objectSchema({ runId: stringSchema(), definitionRevisionId: stringSchema() }, ['runId', 'definitionRevisionId']),
      mutates: false,
      run: (args, context) => context.studio.runs.readDefinition(
        asRunId(requiredString(args, 'runId')), requiredString(args, 'definitionRevisionId'),
      ),
    },
    {
      id: 'runs.diagnose', title: 'Diagnose Run',
      exposure: { mindsets: 'all', setting: 'runObservation' },
      summary: 'Aggregate public status, DAG, log, and produced files into a failure class and guided next action.',
      args: RUN_ID_ARGS, mutates: false,
      run: (args, context) => context.studio.runs.diagnose(asRunId(requiredString(args, 'runId'))),
    },
    {
      id: 'runs.listFiles', title: 'List Run Files',
      exposure: { mindsets: 'all', setting: 'runObservation' },
      summary: 'List one Run\'s result files with size and digest, optionally filtered by a glob pattern; pass a revision to list that exact result version.',
      args: objectSchema({ runId: stringSchema(), pattern: stringSchema(), revision: stringSchema() }, ['runId']),
      mutates: false,
      run: (args, context) => context.studio.runs.listFiles(
        asRunId(requiredString(args, 'runId')), optionalString(args, 'pattern'), optionalString(args, 'revision'),
      ),
    },
    {
      id: 'runs.fetchFile', title: 'Fetch Run File',
      // No exposure: fetchFile returned only Blob metadata to the model —
      // materialization is pullFile's job, and an advertised tool that cannot
      // deliver readable bytes is the phantom-tool defect. The studio surface
      // stays for UI/compatibility callers.
      summary: 'Fetch one exact Run file addressed by a Run-relative path.',
      args: objectSchema({ runId: stringSchema(), path: stringSchema() }, ['runId', 'path']),
      mutates: false,
      run: (args, context) => context.studio.runs.fetchFile(
        asRunId(requiredString(args, 'runId')), asRelativePath(requiredString(args, 'path')),
      ),
      renderForAgent: (result) => {
        if (result instanceof Blob) return JSON.stringify({ size: result.size, type: result.type || 'application/octet-stream' })
        return JSON.stringify(result)
      },
    },
    {
      id: 'runs.pullFile', title: 'Pull Run File to Workspace',
      exposure: { mindsets: 'all', setting: 'runObservation' },
      summary: 'Materialize a Run file and return its local path and source record. Pass revision to select a result version. Matching local content is reused; differing content returns conflict without replacing it. With analysisSlug, record sources.json and place conflicting content under that analysis. Use written only on a successful result.',
      args: objectSchema({ runId: stringSchema(), path: stringSchema(), revision: stringSchema(), analysisSlug: stringSchema() }, ['runId', 'path']),
      mutates: true, permission: 'run.pull_file',
      run: (args, context) => context.studio.runs.pullFile(
        asRunId(requiredString(args, 'runId')), asRelativePath(requiredString(args, 'path')), {
          revision: optionalString(args, 'revision'),
          analysisSlug: optionalString(args, 'analysisSlug'),
        },
      ),
      renderForAgent: (result) => JSON.stringify(result),
    },
    {
      id: 'runs.resume', title: 'Resume Run',
      exposure: { mindsets: 'workflow', setting: 'runControl' },
      summary: 'Resume one terminal Run in place using incremental execution.',
      args: RUN_ID_ARGS, mutates: true, permission: 'run.resume',
      run: (args, context) => context.studio.runs.rerun(asRunId(requiredString(args, 'runId')), 'resume'),
    },
    {
      id: 'runs.overwrite', title: 'Overwrite Run Outputs',
      exposure: { mindsets: 'workflow', setting: 'runControl' },
      summary: 'Re-run one terminal Run and force reachable jobs to overwrite declared outputs.',
      // Discards every result the Run produced, irreversibly, and propagates
      // new digests to everything referencing them. The Agent-side twin of the
      // `Recompute all results` button, which confirms for the same reason.
      args: RUN_ID_ARGS, mutates: true, permission: 'run.overwrite', stakes: 'document',
      run: (args, context) => context.studio.runs.rerun(asRunId(requiredString(args, 'runId')), 'overwrite'),
    },
    {
      id: 'runs.cancel', title: 'Cancel Run',
      exposure: { mindsets: 'workflow', setting: 'runControl' },
      summary: 'Request cancellation of one queued or running Run.',
      args: RUN_ID_ARGS, mutates: true, permission: 'run.cancel',
      run: async (args, context) => {
        await context.studio.runs.cancel(asRunId(requiredString(args, 'runId')))
        return { cancelled: true }
      },
    },
    {
      id: 'runs.trash', title: 'Move Run to Trash',
      exposure: { mindsets: 'workflow', setting: 'runControl' },
      summary: 'Move one terminal Run to recoverable trash. Permanent deletion is unavailable.',
      args: RUN_ID_ARGS, mutates: true, permission: 'run.trash',
      run: async (args, context) => {
        await context.studio.runs.trash(asRunId(requiredString(args, 'runId')))
        return { trashed: true }
      },
    },
    {
      id: 'runs.restore', title: 'Restore Run',
      exposure: { mindsets: 'workflow', setting: 'runControl' },
      summary: 'Restore one Run from recoverable trash.',
      args: RUN_ID_ARGS, mutates: true, permission: 'run.restore',
      run: (args, context) => context.studio.runs.restore(asRunId(requiredString(args, 'runId'))),
    },
  ] satisfies CommandDefinition[])
}

function optionalRunStatuses(value: unknown): RunStatus[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => !RUN_STATUS.includes(item as RunStatus))) {
    throw new Error('status must be an array of Run statuses')
  }
  return [...value] as RunStatus[]
}
