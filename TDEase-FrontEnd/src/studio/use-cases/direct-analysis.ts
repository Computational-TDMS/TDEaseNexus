import type { PreparedPlanView } from '../domain/analysis-plan'
import type { RunSummary } from '../domain/run'
import type { BackendGateway } from '../ports/backend-gateway'
import type { SnapshotSelection, WorkspaceRepository } from '../ports/workspace-repository'
import type { PlanRegistry } from '../runtime/plan-registry'
import { dryRunAnalysis } from './dry-run-analysis'
import {
  discoverManagedNodes,
  prepareAnalysis,
  requiredRunPath,
  type PrepareAnalysisInput,
} from './prepare-analysis'
import { submitAnalysis, type SubmitAnalysisDependencies } from './submit-analysis'

export interface DirectAnalysisDependencies {
  backend: BackendGateway
  workspace: WorkspaceRepository
  registry: PlanRegistry
  snapshotSelection: SnapshotSelection
  prepareTransport?: SubmitAnalysisDependencies['prepareTransport']
  randomId?: () => string
}

export interface WorkflowInspection {
  status: 'ready' | 'needs_edit'
  stage: 'inspect'
  runPath: string
  files: ReadonlyArray<{ path: string; kind: 'file' | 'directory'; size?: number }>
  referencedNodes: ReadonlyArray<string>
  unavailableNodes: ReadonlyArray<string>
  missingInformation: ReadonlyArray<string>
  allowedActions: ReadonlyArray<string>
  recommendedAction: string
}

export interface WorkflowValidation {
  status: 'valid' | 'needs_edit' | 'blocked'
  stage: 'dry-run'
  errorClass?: string
  summary: string
  missingInformation: ReadonlyArray<string>
  allowedActions: ReadonlyArray<string>
  recommendedAction: string
  plan: Omit<PreparedPlanView, 'ref'>
}

export type WorkflowRunResult =
  | { status: 'submitted'; stage: 'submitted'; run: RunSummary; validation: WorkflowValidation; recommendedAction: 'runs.status' }
  | { status: 'needs_edit' | 'blocked'; stage: 'dry-run'; validation: WorkflowValidation; recommendedAction: string }

export async function inspectAnalysis(
  input: Pick<PrepareAnalysisInput, 'runPath'>,
  dependencies: Pick<DirectAnalysisDependencies, 'backend' | 'workspace'>,
): Promise<WorkflowInspection> {
  const runPath = requiredRunPath(input.runPath)
  const entries = await dependencies.workspace.list(runPath)
  const snakefile = entries.find((entry) => entry.kind === 'file' && entry.path === `${runPath}/Snakefile`)
  if (!snakefile) {
    return {
      status: 'needs_edit', stage: 'inspect', runPath, files: entries,
      referencedNodes: [], unavailableNodes: [], missingInformation: ['Snakefile'],
      allowedActions: ['workspace.write', 'templates.list', 'templates.get'],
      recommendedAction: 'workspace.write',
    }
  }
  const text = await dependencies.workspace.readText(snakefile.path)
  const referencedNodes = discoverManagedNodes(text).map((node) => node.id)
  const availability = await Promise.all(referencedNodes.map(async (id) => {
    try { await dependencies.backend.getNode(id); return undefined } catch { return id }
  }))
  const unavailableNodes = availability.filter((id): id is string => id !== undefined)
  return {
    status: unavailableNodes.length ? 'needs_edit' : 'ready', stage: 'inspect', runPath, files: entries,
    referencedNodes, unavailableNodes,
    missingInformation: unavailableNodes.map((id) => `Backend Node ${id}`),
    allowedActions: unavailableNodes.length ? ['nodes.list', 'nodes.get', 'workspace.edit'] : ['workflow.validate', 'workflow.run'],
    recommendedAction: unavailableNodes.length ? 'nodes.list' : 'workflow.run',
  }
}

export async function validateAnalysis(
  input: PrepareAnalysisInput,
  dependencies: DirectAnalysisDependencies,
): Promise<WorkflowValidation> {
  const prepared = await prepareAnalysis(input, dependencies)
  try {
    const validated = await dryRunAnalysis(prepared.ref, dependencies.backend, dependencies.registry)
    return validationResult(validated)
  } finally {
    dependencies.registry.discard(prepared.ref)
  }
}

export async function runAnalysis(
  input: PrepareAnalysisInput,
  dependencies: DirectAnalysisDependencies,
): Promise<WorkflowRunResult> {
  const prepared = await prepareAnalysis(input, dependencies)
  let validated: PreparedPlanView
  try {
    validated = await dryRunAnalysis(prepared.ref, dependencies.backend, dependencies.registry)
  } catch (error) {
    dependencies.registry.discard(prepared.ref)
    throw error
  }
  const validation = validationResult(validated)
  if (validation.status !== 'valid') {
    dependencies.registry.discard(prepared.ref)
    return { status: validation.status, stage: 'dry-run', validation, recommendedAction: validation.recommendedAction }
  }
  try {
    const run = await submitAnalysis(prepared.ref, {
      backend: dependencies.backend,
      registry: dependencies.registry,
      prepareTransport: dependencies.prepareTransport,
    })
    return { status: 'submitted', stage: 'submitted', run, validation, recommendedAction: 'runs.status' }
  } catch (error) {
    dependencies.registry.discard(prepared.ref)
    throw error
  }
}

function validationResult(view: PreparedPlanView): WorkflowValidation {
  const { ref: _ref, ...plan } = view
  const output = view.dryRun?.output ?? ''
  if (view.dryRun?.valid) {
    return {
      status: 'valid', stage: 'dry-run', summary: 'The frozen Run passed the real Backend dry-run.',
      missingInformation: [], allowedActions: ['workflow.run'], recommendedAction: 'workflow.run', plan,
    }
  }
  const errorClass = classifyDryRun(output)
  const blocked = errorClass === 'PERMISSION_PROTOCOL' || errorClass === 'BACKEND_ENVIRONMENT'
  return {
    status: blocked ? 'blocked' : 'needs_edit', stage: 'dry-run', errorClass,
    summary: output.trim().split(/\r?\n/).slice(-8).join('\n') || 'The Backend dry-run failed.',
    missingInformation: missingInformation(errorClass),
    allowedActions: blocked ? ['workflow.inspect', 'runs.diagnose'] : ['workspace.edit', 'nodes.get', 'workflow.validate'],
    recommendedAction: blocked ? 'runs.diagnose' : 'workspace.edit', plan,
  }
}

function classifyDryRun(output: string): string {
  if (/WORKSPACE_PATH_ESCAPE|FORBIDDEN|permission|containment/i.test(output)) return 'PERMISSION_PROTOCOL'
  if (/NODE_|executable|not found|environment/i.test(output)) return 'BACKEND_ENVIRONMENT'
  if (/MissingInputException|missing input|does not exist/i.test(output)) return 'INPUT_DATA'
  if (/SyntaxError|Snakefile|rule |WildcardError|Config file/i.test(output)) return 'WORKFLOW_DEFINITION'
  return 'WORKFLOW_DEFINITION'
}

function missingInformation(errorClass: string): ReadonlyArray<string> {
  if (errorClass === 'INPUT_DATA') return ['Required Run input file or declared input path']
  if (errorClass === 'PERMISSION_PROTOCOL') return ['Approved Workspace capability or public protocol access']
  if (errorClass === 'BACKEND_ENVIRONMENT') return ['Backend Node deployment or executable availability']
  return ['Valid Snakefile/configuration definition']
}
