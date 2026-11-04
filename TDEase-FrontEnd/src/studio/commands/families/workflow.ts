import { asPlanRef } from '../../domain/identity'
import type { CommandDefinition, JsonSchema } from '../registry'
import {
  objectSchema, optionalRecord, optionalString, optionalStringArray, requiredString, stringSchema,
} from '../args'

const PLAN_REF_ARGS: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['planRef'],
  properties: { planRef: { type: 'string', minLength: 1 } },
}

const WORKFLOW_RUN_ARGS: JsonSchema = objectSchema({
  runPath: { ...stringSchema(), pattern: '^runs/[^/]+$' },
  managedNodes: {
    type: 'array', items: objectSchema({
      id: stringSchema(), rules: { type: 'array', items: stringSchema() },
    }, ['id', 'rules']),
  },
  config: { type: 'object' },
  targets: { type: 'array', items: stringSchema() },
}, ['runPath'])

/** Snakemake Run lifecycle: inspect/validate/run plus the planRef compatibility pair (`studio.analysis`). */
export function workflowCommands(): ReadonlyArray<CommandDefinition> {
  return ([
    {
      id: 'workflow.inspect', title: 'Inspect Workflow',
      exposure: { mindsets: 'workflow', setting: 'workflow' },
      summary: 'Inspect one editable runs/<run> directory and return only the missing information and safe next actions.',
      args: objectSchema({ runPath: { ...stringSchema(), pattern: '^runs/[^/]+$' } }, ['runPath']),
      mutates: false,
      run: (args, context) => context.studio.analysis.inspect({ runPath: requiredString(args, 'runPath') }),
    },
    {
      id: 'workflow.validate', title: 'Validate Workflow',
      exposure: { mindsets: 'workflow', setting: 'workflow' },
      summary: 'Freeze the current Run, infer config.yaml and Backend Nodes, perform a real dry-run, then discard the temporary plan.',
      args: WORKFLOW_RUN_ARGS, mutates: true, permission: 'workflow.dry_run',
      run: (args, context) => context.studio.analysis.validate(workflowInput(args)),
    },
    {
      id: 'workflow.run', title: 'Run Workflow',
      exposure: { mindsets: 'workflow', setting: 'workflow' },
      summary: 'Atomically freeze, dry-run, and submit one Run. Invalid definitions are returned for editing and are never queued.',
      args: WORKFLOW_RUN_ARGS, mutates: true, permission: 'workflow.submit', stakes: 'document',
      run: (args, context) => context.studio.analysis.run(workflowInput(args)),
    },
    {
      id: 'workflow.prepare', title: 'Prepare Workflow',
      summary: 'Freeze one runs/<run> directory using its single fixed Snakefile and return an opaque planRef.',
      args: objectSchema({
        runPath: { ...stringSchema(), pattern: '^runs/[^/]+$' },
        managedNodes: {
          type: 'array', items: objectSchema({
            id: stringSchema(), rules: { type: 'array', items: stringSchema() },
          }, ['id', 'rules']),
        },
        config: { type: 'object' },
        targets: { type: 'array', items: stringSchema() },
      }, ['runPath']),
      mutates: true, permission: 'workflow.preflight', agentVisible: false,
      hiddenReason: 'Compatibility command for the analysis review UI; agents use workflow.validate or workflow.run.',
      run: (args, context) => context.studio.analysis.prepare({
        runPath: optionalString(args, 'runPath'),
        managedNodes: optionalManagedNodes(args.managedNodes),
        config: optionalRecord(args, 'config'),
        targets: optionalStringArray(args, 'targets'),
      }),
    },
    {
      id: 'workflow.dryRun', title: 'Validate Workflow Plan',
      summary: 'Validate the exact immutable plan referenced by planRef with the real Snakemake engine.',
      args: PLAN_REF_ARGS, mutates: true, permission: 'workflow.dry_run', agentVisible: false,
      hiddenReason: 'Compatibility command for existing PlanRef review documents.',
      run: (args, context) => context.studio.analysis.dryRun(asPlanRef(requiredString(args, 'planRef'))),
    },
    {
      id: 'workflow.submit', title: 'Submit Workflow Plan',
      summary: 'Submit the unchanged validated plan and hand long-running progress tracking to the application.',
      // Commits hours of compute against gigabytes of input from a `planRef`
      // that says nothing about either. The plan has to be visible to be
      // approved.
      args: PLAN_REF_ARGS, mutates: true, permission: 'workflow.submit', stakes: 'document', agentVisible: false,
      hiddenReason: 'Compatibility command for existing PlanRef review documents.',
      run: (args, context) => context.studio.analysis.submit(asPlanRef(requiredString(args, 'planRef'))),
    },
  ] satisfies CommandDefinition[])
}

function workflowInput(args: Record<string, unknown>) {
  return {
    runPath: requiredString(args, 'runPath'),
    managedNodes: optionalManagedNodes(args.managedNodes),
    config: optionalRecord(args, 'config'),
    targets: optionalStringArray(args, 'targets'),
  }
}

function optionalManagedNodes(value: unknown): Array<{ id: string; rules: string[] }> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('managedNodes must be an array')
  return value.map((node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('managedNodes must contain objects')
    const entry = node as Record<string, unknown>
    const id = requiredString(entry, 'id')
    const rules = optionalStringArray(entry, 'rules')
    if (!rules) throw new Error('managedNodes.rules must be an array of strings')
    return { id, rules }
  })
}
