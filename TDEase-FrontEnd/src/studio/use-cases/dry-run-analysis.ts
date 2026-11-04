import type { PlanRef } from '../domain/identity'
import type { BackendGateway } from '../ports/backend-gateway'
import type { PlanRegistry } from '../runtime/plan-registry'

export async function dryRunAnalysis(ref: PlanRef, backend: BackendGateway, registry: PlanRegistry) {
  registry.beginValidation(ref)
  const commit = registry.resolveCommit(ref)
  let result
  try {
    result = await backend.dryRun(commit)
  } catch (error) {
    if (registry.get(ref).state === 'validating') {
      registry.completeValidation(ref, {
        valid: false, exitCode: -1, engine: 'transport-error',
        output: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  }
  return registry.completeValidation(ref, result)
}
