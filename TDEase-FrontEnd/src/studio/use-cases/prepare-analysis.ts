import type { AnalysisCommit, PreparedPlanView } from '../domain/analysis-plan'
import { asPlanRef, asRelativePath, asRunId, asSha256, type RelativePath } from '../domain/identity'
import type { BackendGateway } from '../ports/backend-gateway'
import type { SnapshotSelection, WorkspaceRepository } from '../ports/workspace-repository'
import type { PlanRegistry } from '../runtime/plan-registry'
import { isSubmissionPathIncluded } from '../domain/workspace-snapshot-policy'
import { bufferToHex } from '@/utils/hex'
import { parse as parseYaml } from 'yaml'

export interface ManagedNodeSelection {
  id: string
  rules: ReadonlyArray<string>
}

export interface PrepareAnalysisInput {
  runPath?: string
  managedNodes?: ReadonlyArray<ManagedNodeSelection>
  config?: Readonly<Record<string, unknown>>
  targets?: ReadonlyArray<string>
}

export interface PrepareAnalysisDependencies {
  backend: BackendGateway
  workspace: WorkspaceRepository
  registry: PlanRegistry
  snapshotSelection: SnapshotSelection
  randomId?: () => string
}

export async function prepareAnalysis(
  input: PrepareAnalysisInput,
  dependencies: PrepareAnalysisDependencies,
): Promise<PreparedPlanView> {
  const runPath = requiredRunPath(input.runPath)
  const runPrefix = `${runPath}/`
  const workspaceSnakefilePath = asRelativePath(`${runPath}/Snakefile`)
  const includeRunPath = (path: RelativePath) => {
    if (!path.startsWith(runPrefix)) return false
    return dependencies.snapshotSelection.include(asRelativePath(path.slice(runPrefix.length)))
  }
  const [workspace, workspaceRevision, snakefile] = await Promise.all([
    dependencies.workspace.inspect(),
    dependencies.workspace.snapshot({ include: includeRunPath }),
    dependencies.workspace.readText(workspaceSnakefilePath),
  ])
  const snakefileEntry = workspaceRevision.files.find((file) => file.path === workspaceSnakefilePath)
  if (!snakefileEntry) {
    throw new Error(`Snakefile is not included in the trusted Run snapshot: ${workspaceSnakefilePath}`)
  }
  if (await digestText(snakefile) !== snakefileEntry.digest) {
    throw new Error(`Snakefile changed while the Run snapshot was being prepared: ${workspaceSnakefilePath}`)
  }
  const files = workspaceRevision.files.map((file) => ({
    ...file,
    path: asRelativePath(file.path.slice(runPrefix.length)),
  }))
  const workspaceTreeHash = await digestTree(files)

  const selections = input.managedNodes ?? discoverManagedNodes(snakefile)
  if (new Set(selections.map((selection) => selection.id)).size !== selections.length) {
    throw new Error('managedNodes must not contain duplicate Node ids')
  }
  const details = await Promise.all(selections.map((selection) => dependencies.backend.getNode(selection.id)))
  const nodes = details.map((node, index) => {
    const rules = [...new Set(selections[index]?.rules ?? [])]
    if (rules.length !== (selections[index]?.rules.length ?? 0)) {
      throw new Error(`Managed Node ${node.id} contains duplicate rule names`)
    }
    const available = new Set(node.capabilities.map((capability) => capability.name))
    const unknown = rules.filter((rule) => !available.has(rule))
    if (unknown.length) throw new Error(`Managed Node ${node.id} does not expose rules: ${unknown.join(', ')}`)
    return { id: node.id, version: node.version, digest: node.digest, rules }
  })
  const id = dependencies.randomId ?? randomId
  const config = input.config ?? await readRunConfig(
    dependencies.workspace, workspaceRevision.files, runPath, runPrefix,
  )
  const commit: AnalysisCommit = {
    runId: await stableRunId(workspace.id, runPath), idempotencyKey: `ik_${id()}`,
    workspaceId: workspace.id, runPath, workspaceTreeHash,
    files: files.map(({ path, digest, size }) => ({ path, digest, size })),
    snakefile,
    targets: [...(input.targets ?? [])],
    // No compute envelope fields here by design: Backend scheduling owns the
    // envelope and injects its startup budget at commit; the Agent never
    // chooses a concurrency limit (spec/WORKFLOW-RUN.md §1).
    config: { ...config }, nodes,
  }
  const digest = await digestCommit(commit)
  const ref = asPlanRef(`plan_${id()}`)
  const view: PreparedPlanView = {
    ref, digest, workspaceTreeHash, state: 'prepared', snakefilePath: workspaceSnakefilePath,
    nodes, scripts: files.filter((file) => file.role === 'script').map((file) => file.path),
    inputSummary: files.filter((file) => file.role === 'input').map(({ path, size }) => ({ path, size })),
    config: commit.config, targets: commit.targets, warnings: [],
  }
  return dependencies.registry.add(commit, view, dependencies.snapshotSelection.include)
}

/** One editable Workspace Run maps to one durable Backend Run. Attempts remain
 * random/idempotent; identity is a stable hash of the Workspace identity and
 * its Run-relative directory. */
async function stableRunId(workspaceId: string, runPath: RelativePath) {
  const digest = await digestText(`${workspaceId}\n${runPath}`)
  return asRunId(`run_${digest.slice(0, 24)}`)
}

export function requiredRunPath(value: string | undefined): RelativePath {
  if (!value) throw new Error('workflow.prepare requires runPath')
  const path = asRelativePath(value)
  if (!/^runs\/[^/]+$/.test(path)) throw new Error('runPath must match runs/<run>')
  return path
}

export function discoverManagedNodes(snakefile: string): ReadonlyArray<ManagedNodeSelection> {
  const ids = new Set<string>()
  const pattern = /^\s*include\s*:\s*["']nodes\/([^/"']+)\/rules\.smk["']/gm
  for (const match of snakefile.matchAll(pattern)) {
    if (match[1]) ids.add(match[1])
  }
  return [...ids].sort().map((id) => ({ id, rules: [] }))
}

async function readRunConfig(
  workspace: WorkspaceRepository,
  files: ReadonlyArray<{ path: RelativePath; digest: string }>,
  runPath: RelativePath,
  runPrefix: string,
): Promise<Readonly<Record<string, unknown>>> {
  const workspacePath = asRelativePath(`${runPath}/config.yaml`)
  const entry = files.find((file) => file.path === workspacePath)
  if (!entry) return {}
  const text = await workspace.readText(workspacePath)
  if (await digestText(text) !== entry.digest) {
    throw new Error(`config.yaml changed while the Run snapshot was being prepared: ${workspacePath}`)
  }
  const parsed = parseYaml(text)
  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${runPrefix}config.yaml must contain a mapping at its root`)
  }
  return parsed as Record<string, unknown>
}

async function digestTree(files: ReadonlyArray<{ path: RelativePath; digest: string; size: number }>) {
  const canonical = files
    .map((file) => `${file.path}:${file.digest}:${file.size}`)
    .sort()
    .join('\n')
  return digestText(canonical)
}

async function digestCommit(commit: AnalysisCommit) {
  const canonical = JSON.stringify(canonicalize(commit))
  return digestText(canonical)
}

async function digestText(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return asSha256(bufferToHex(digest))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]))
  }
  return value
}

function randomId(): string {
  return bufferToHex(crypto.getRandomValues(new Uint8Array(12)))
}

export const DEFAULT_SNAPSHOT_SELECTION: SnapshotSelection = {
  include: isSubmissionPathIncluded,
}
