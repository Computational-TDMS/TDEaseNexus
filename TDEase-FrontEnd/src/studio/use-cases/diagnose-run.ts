import type { RunId } from '../domain/identity'
import type { BackendGateway, RunFileEntry, WorkflowGraph } from '../ports/backend-gateway'

export interface RunDiagnosis {
  runId: RunId
  status: string
  errorClass: string
  summary: string
  failedJobs: ReadonlyArray<{ id: number; rule: string; wildcards: Readonly<Record<string, string>> }>
  runningJobs: ReadonlyArray<{ id: number; rule: string; wildcards: Readonly<Record<string, string>> }>
  producedFiles: number
  logTail: string
  knownFacts: ReadonlyArray<string>
  missingInformation: ReadonlyArray<string>
  allowedActions: ReadonlyArray<string>
  recommendedAction: string
}

export async function diagnoseRun(runId: RunId, backend: BackendGateway): Promise<RunDiagnosis> {
  const run = await backend.getRun(runId)
  const [graphResult, logResult, filesResult] = await Promise.allSettled([
    backend.getRunGraph(runId), backend.readLog(runId, 200), backend.listRunFiles(runId),
  ])
  const graph: WorkflowGraph | undefined = graphResult.status === 'fulfilled' ? graphResult.value : undefined
  const logTail = logResult.status === 'fulfilled' ? logResult.value.text : ''
  const files: ReadonlyArray<RunFileEntry> = filesResult.status === 'fulfilled' ? filesResult.value : []
  const failedJobs = (graph?.nodes ?? []).filter((node) => node.status === 'failed')
    .map(({ id, rule, wildcards }) => ({ id, rule, wildcards }))
  const runningJobs = (graph?.nodes ?? []).filter((node) => node.status === 'running')
    .map(({ id, rule, wildcards }) => ({ id, rule, wildcards }))
  const combined = `${run.error ?? ''}\n${logTail}`
  const errorClass = classifyRunFailure(run.status, combined)
  const action = recommendedAction(run.status, errorClass)
  const knownFacts = [
    `Run status: ${run.status}`,
    `Observed event sequence: ${run.lastEventSeq}`,
    `Failed jobs: ${failedJobs.length}`,
    `Running jobs: ${runningJobs.length}`,
    `Visible produced files: ${files.length}`,
  ]
  if (run.error) knownFacts.push(`Run error: ${run.error}`)
  return {
    runId, status: run.status, errorClass,
    summary: tailSummary(run.error || logTail || `Run is ${run.status}.`),
    failedJobs, runningJobs, producedFiles: files.length, logTail,
    knownFacts,
    missingInformation: missingInformation(errorClass, graphResult, logResult),
    allowedActions: allowedActions(run.status, errorClass),
    recommendedAction: action,
  }
}

function classifyRunFailure(status: string, text: string): string {
  if (status === 'SUCCEEDED') return 'NONE'
  if (status === 'QUEUED' || status === 'RUNNING') return 'IN_PROGRESS'
  if (status === 'CANCELLED') return 'CANCELLED'
  if (/orphaned|worker process not found|backend restarted/i.test(text)) return 'BACKEND_ORPHANED'
  if (/WORKSPACE_PATH_ESCAPE|FORBIDDEN|permission|containment/i.test(text)) return 'PERMISSION_PROTOCOL'
  if (/out of memory|cannot allocate|no space|disk|resource/i.test(text)) return 'RESOURCE_EXHAUSTION'
  if (/in use|locked|another process|concurrent/i.test(text)) return 'CONCURRENCY'
  if (/MissingInputException|missing input|FASTA|mzML|feature file|corrupt/i.test(text)) return 'INPUT_DATA'
  if (/executable|DLL|not found|unsupported platform/i.test(text)) return 'NODE_RUNTIME'
  if (/SyntaxError|WildcardError|RuleException|config/i.test(text)) return 'WORKFLOW_DEFINITION'
  return status === 'FAILED' ? 'EXECUTION_UNKNOWN' : 'NONE'
}

function recommendedAction(status: string, errorClass: string): string {
  if (status === 'SUCCEEDED') return 'runs.listFiles'
  if (status === 'QUEUED' || status === 'RUNNING') return 'runs.wait'
  if (errorClass === 'BACKEND_ORPHANED') return 'runs.resume'
  if (['WORKFLOW_DEFINITION', 'INPUT_DATA'].includes(errorClass)) return 'workspace.edit'
  if (['NODE_RUNTIME', 'EXECUTION_UNKNOWN'].includes(errorClass)) return 'nodes.get'
  if (['RESOURCE_EXHAUSTION', 'CONCURRENCY'].includes(errorClass)) return 'workflow.inspect'
  return 'runs.status'
}

function allowedActions(status: string, errorClass: string): ReadonlyArray<string> {
  if (status === 'SUCCEEDED') return ['runs.listFiles', 'runs.fetchFile']
  if (status === 'QUEUED' || status === 'RUNNING') return ['runs.wait', 'runs.tailLog', 'runs.cancel']
  if (errorClass === 'BACKEND_ORPHANED') return ['runs.resume', 'runs.trash']
  if (['WORKFLOW_DEFINITION', 'INPUT_DATA'].includes(errorClass)) {
    return ['workspace.edit', 'workflow.validate', 'workflow.run', 'runs.trash']
  }
  return ['nodes.get', 'workflow.inspect', 'runs.resume', 'runs.trash']
}

function missingInformation(
  errorClass: string,
  graph: PromiseSettledResult<WorkflowGraph>,
  log: PromiseSettledResult<{ text: string }>,
): ReadonlyArray<string> {
  const missing: string[] = []
  if (graph.status === 'rejected') missing.push('Workflow graph projection')
  if (log.status === 'rejected') missing.push('Backend engine log')
  if (errorClass === 'EXECUTION_UNKNOWN') missing.push('A classified failure signature or a bounded Node probe')
  if (errorClass === 'INPUT_DATA') missing.push('Validation of the smallest affected input')
  return missing
}

function tailSummary(value: string): string {
  return value.trim().split(/\r?\n/).slice(-8).join('\n')
}
