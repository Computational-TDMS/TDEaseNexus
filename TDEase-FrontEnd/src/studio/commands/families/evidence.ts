import type { EvidenceWriteInput } from '@/services/workspace/workspaceEvidence'
import type { CommandDefinition } from '../registry'
import { EMPTY_ARGS, objectSchema, requiredString, stringSchema } from '../args'

const ENTITY_ROLES = ['input', 'output', 'support', 'contradiction'] as const

/** W3C PROV evidence claims: the citable scientific record (`context.evidence`). */
export function evidenceCommands(): ReadonlyArray<CommandDefinition> {
  return ([
    {
      id: 'evidence.list', title: 'List Evidence',
      summary: 'List native W3C PROV Evidence files in the Workspace and Runs, each with its claim status and statement summary.',
      args: EMPTY_ARGS, mutates: false,
      run: (_args, context) => context.evidence.list(),
    },
    {
      id: 'evidence.graph', title: 'Evidence Graph',
      summary: 'Project every W3C PROV Evidence claim into one cross-file DAG: nodes, wasDerivedFrom/wasRevisionOf/wasInvalidatedBy edges, and dangling/cycle/unreadable integrity issues.',
      args: EMPTY_ARGS, mutates: false,
      enabled: (context) => Boolean(context.evidence),
      run: (_args, context) => context.evidence.graph(),
    },
    {
      id: 'evidence.read', title: 'Read Evidence',
      summary: 'Read the compressed projection of one W3C PROV Evidence claim.',
      args: objectSchema({ path: { ...stringSchema(), pattern: '^(evidence|runs/[^/]+/evidence)/.+\\.prov\\.json$' } }, ['path']),
      mutates: false,
      run: (args, context) => context.evidence.read(requiredString(args, 'path')),
    },
    {
      id: 'evidence.write', title: 'Write Evidence',
      exposure: { mindsets: 'scientific' },
      summary: 'Record a scientific statement as a generated native W3C PROV claim.',
      // A scientific record that other claims will cite. Named alongside
      // workflow.submit as the second thing that must
      // never be approved from a chat bubble.
      args: objectSchema({
        scope: objectSchema({ kind: { type: 'string', enum: ['workspace', 'run'] }, runPath: stringSchema() }, ['kind']),
        statement: stringSchema(),
        status: { type: 'string', enum: ['proposed', 'challenged', 'inconclusive', 'supported', 'refuted'] },
        activity: objectSchema({ type: { type: 'string', enum: ['run', 'analysis', 'observation'] }, label: stringSchema() }, ['type', 'label']),
        entities: { type: 'array', minItems: 1, items: objectSchema({ path: stringSchema(), role: { type: 'string', enum: [...ENTITY_ROLES] } }, ['path', 'role']) },
        relations: { type: 'array', items: objectSchema({ claimPath: stringSchema(), type: { type: 'string', enum: ['wasDerivedFrom', 'wasRevisionOf', 'wasInvalidatedBy'] } }, ['claimPath', 'type']) },
        adjudication: objectSchema({ by: { type: 'string', enum: ['user', 'deterministic-check'] }, basis: stringSchema(), activityPath: stringSchema() }, ['by', 'basis']),
        notes: stringSchema(),
      }, ['scope', 'statement', 'status', 'activity', 'entities']),
      mutates: true, permission: 'workspace.write', stakes: 'document',
      run: (args, context) => context.provenance
        ? context.evidence.write(
            args as unknown as EvidenceWriteInput,
            context.provenance,
          )
        : context.evidence.write(args as unknown as EvidenceWriteInput),
    },
    {
      id: 'evidence.verify', title: 'Verify Evidence',
      summary: 'Recompute the digests of files cited by one W3C PROV Evidence claim.',
      args: objectSchema({ path: { ...stringSchema(), pattern: '^(evidence|runs/[^/]+/evidence)/.+\\.prov\\.json$' } }, ['path']),
      mutates: false,
      run: (args, context) => context.evidence.verify(requiredString(args, 'path')),
    },
  ] satisfies CommandDefinition[])
}
