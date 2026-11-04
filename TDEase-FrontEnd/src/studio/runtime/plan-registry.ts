import type { AnalysisCommit, PreparedPlanView } from '../domain/analysis-plan'
import { asRelativePath, type PlanRef, type RelativePath, type Sha256, type WorkspaceId } from '../domain/identity'

interface PlanRecord {
  commit: AnalysisCommit
  view: PreparedPlanView
  validatedDigest?: Sha256
  includesPath: (path: RelativePath) => boolean
}

export class PlanRegistry {
  private readonly records = new Map<PlanRef, PlanRecord>()

  add(
    commit: AnalysisCommit,
    view: PreparedPlanView,
    includesPath: (path: RelativePath) => boolean,
  ): PreparedPlanView {
    if (this.records.has(view.ref)) throw new Error(`Duplicate PlanRef: ${view.ref}`)
    this.records.set(view.ref, { commit, view, includesPath })
    return view
  }

  get(ref: PlanRef): PreparedPlanView { return this.record(ref).view }
  resolveCommit(ref: PlanRef): AnalysisCommit { return this.record(ref).commit }

  beginValidation(ref: PlanRef): PreparedPlanView {
    return this.transition(ref, ['prepared', 'invalid'], 'validating')
  }

  completeValidation(ref: PlanRef, dryRun: PreparedPlanView['dryRun']): PreparedPlanView {
    const record = this.record(ref)
    if (record.view.state !== 'validating') throw invalidTransition(record.view.state, 'validation result')
    const valid = dryRun?.valid === true
    record.validatedDigest = valid ? record.view.digest : undefined
    record.view = { ...record.view, state: valid ? 'valid' : 'invalid', dryRun }
    return record.view
  }

  beginSubmit(ref: PlanRef): AnalysisCommit {
    const record = this.record(ref)
    if (record.view.state !== 'valid' || record.validatedDigest !== record.view.digest) {
      throw new Error('Plan must have a successful dry-run for the unchanged digest before submission')
    }
    record.view = { ...record.view, state: 'submitting' }
    return record.commit
  }

  submitFailed(ref: PlanRef): PreparedPlanView {
    return this.transition(ref, ['submitting'], 'valid')
  }

  consume(ref: PlanRef): PreparedPlanView {
    return this.transition(ref, ['submitting'], 'consumed')
  }

  expireWorkspace(workspaceId: WorkspaceId, changedPath: RelativePath): ReadonlyArray<PlanRef> {
    const expired: PlanRef[] = []
    for (const [ref, record] of this.records) {
      if (record.commit.workspaceId !== workspaceId || !isMutable(record.view.state)) continue
      const prefix = `${record.commit.runPath}/`
      if (!changedPath.startsWith(prefix)) continue
      const runRelativePath = asRelativePath(changedPath.slice(prefix.length))
      const wasFrozen = record.commit.files.some((file) => file.path === runRelativePath)
      if (!wasFrozen && !record.includesPath(runRelativePath)) continue
      record.validatedDigest = undefined
      record.view = { ...record.view, state: 'expired' }
      expired.push(ref)
    }
    return expired
  }

  discard(ref: PlanRef): void { this.records.delete(ref) }
  clear(): void { this.records.clear() }

  private transition(ref: PlanRef, from: PreparedPlanView['state'][], to: PreparedPlanView['state']): PreparedPlanView {
    const record = this.record(ref)
    if (!from.includes(record.view.state)) throw invalidTransition(record.view.state, to)
    record.view = { ...record.view, state: to }
    return record.view
  }

  private record(ref: PlanRef): PlanRecord {
    const record = this.records.get(ref)
    if (!record) throw new Error(`Unknown or expired PlanRef: ${ref}`)
    return record
  }
}

function isMutable(state: PreparedPlanView['state']): boolean {
  return state === 'prepared' || state === 'validating' || state === 'invalid' || state === 'valid'
}

function invalidTransition(from: string, to: string): Error {
  return new Error(`Invalid plan transition: ${from} -> ${to}`)
}
