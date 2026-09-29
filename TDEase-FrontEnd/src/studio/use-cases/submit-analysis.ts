import type { AnalysisCommit } from '../domain/analysis-plan'
import type { PlanRef } from '../domain/identity'
import type { BackendGateway } from '../ports/backend-gateway'
import type { PermissionGateway } from '../ports/permission-gateway'
import type { PlanRegistry } from '../runtime/plan-registry'

export interface SubmitAnalysisDependencies {
  backend: BackendGateway
  permission?: PermissionGateway
  registry: PlanRegistry
  prepareTransport?: (commit: AnalysisCommit) => Promise<void>
}

export async function submitAnalysis(ref: PlanRef, dependencies: SubmitAnalysisDependencies) {
  if (dependencies.permission) {
    await requirePermission(dependencies.permission, 'workflow.submit', `Submit validated analysis plan ${ref}`)
  }
  const commit = dependencies.registry.beginSubmit(ref)
  try {
    if (dependencies.prepareTransport) await dependencies.prepareTransport(commit)
    const run = await dependencies.backend.submit(commit)
    dependencies.registry.consume(ref)
    return run
  } catch (error) {
    dependencies.registry.submitFailed(ref)
    throw error
  }
}

async function requirePermission(permission: PermissionGateway, action: 'workflow.submit', reason: string) {
  const decision = permission.decide(action)
  if (decision === 'deny') throw new Error(`Permission denied: ${action}`)
  if (decision === 'ask' && !await permission.request(action, reason)) {
    throw new Error(`Permission declined: ${action}`)
  }
}
