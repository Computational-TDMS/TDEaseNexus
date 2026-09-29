import { validateRelativePath } from './workspaceModule'

export type EvidenceStatus = 'proposed' | 'challenged' | 'inconclusive' | 'supported' | 'refuted'
export type EvidenceEntityRole = 'input' | 'output' | 'support' | 'contradiction'
export type EvidenceRelationType = 'wasDerivedFrom' | 'wasRevisionOf' | 'wasInvalidatedBy'
export type EvidenceFileVerification = 'unchecked' | 'match' | 'changed' | 'missing'

export interface EvidenceWriteInput {
  scope: { kind: 'workspace' } | { kind: 'run'; runPath: string }
  statement: string
  status: EvidenceStatus
  activity: { type: 'run' | 'analysis' | 'observation'; label: string }
  entities: Array<{ path: string; role: EvidenceEntityRole }>
  relations?: Array<{ claimPath: string; type: EvidenceRelationType }>
  adjudication?: { by: 'user' | 'deterministic-check'; basis: string; activityPath?: string }
  notes?: string
}

/** Trusted operational anchor injected by the Agent runtime, never model-authored. */
export interface EvidenceTurnProvenance {
  sessionId: string
  turnId: string
  callId: string
  promptSnapshotDigest: string
  model: string
}

export interface EvidenceWriteContext {
  agentId?: string
  provenance?: EvidenceTurnProvenance
}

export interface EvidenceClaimProjection {
  ref: string
  statement: string
  status: EvidenceStatus
  notes?: string
}

export interface EvidenceEntityProjection {
  ref: string
  path: string
  role: EvidenceEntityRole
  size: number
  verification: EvidenceFileVerification
}

/** One row of `evidence.list`: just enough to pick a file worth reading. */
export interface EvidenceListItem {
  path: string
  status: EvidenceStatus
  summary: string
}

export interface EvidenceGraphNode {
  ref: string
  path: string
  status: EvidenceStatus
  summary: string
}

export interface EvidenceGraphEdge {
  fromPath: string
  fromRef: string
  toPath: string
  toRef: string
  type: EvidenceRelationType
}

export interface EvidenceGraphIssue {
  kind: 'dangling' | 'cycle' | 'unreadable'
  detail: string
  paths: string[]
}

export interface EvidenceGraphProjection {
  nodes: EvidenceGraphNode[]
  edges: EvidenceGraphEdge[]
  issues: EvidenceGraphIssue[]
}

export interface EvidenceRelationProjection {
  type: EvidenceRelationType
  claimPath: string
  currentClaimRef: string
  relatedClaimRef: string
}

export interface EvidenceActivityProjection {
  ref: string
  type: EvidenceWriteInput['activity']['type']
  label: string
  endedAt: string
}

export interface EvidenceAdjudicationProjection {
  by: 'user' | 'deterministic-check'
  basis: string
  activityPath?: string
}

export interface EvidenceTurnProjection extends EvidenceTurnProvenance {
  ref: string
  sessionLogPath: string
  promptSnapshotPath: string
}

export interface EvidenceVerificationProjection {
  state: 'unchecked' | 'verified' | 'drifted'
  valid?: boolean
}

export interface EvidenceProjection {
  path: string
  claim: EvidenceClaimProjection
  relatedClaims: ReadonlyArray<EvidenceClaimProjection & { path?: string }>
  entities: ReadonlyArray<EvidenceEntityProjection>
  relations: ReadonlyArray<EvidenceRelationProjection>
  activity: EvidenceActivityProjection
  adjudication?: EvidenceAdjudicationProjection
  turn?: EvidenceTurnProjection
  verification: EvidenceVerificationProjection
  mermaid: string
}

export interface EvidenceVerificationFile {
  ref: string
  path: string
  expected: string
  actual: string | null
  valid: boolean
  status: Exclude<EvidenceFileVerification, 'unchecked'>
}

export interface EvidenceVerificationResult {
  path: string
  valid: boolean
  files: ReadonlyArray<EvidenceVerificationFile>
  projection: EvidenceProjection
}

export interface EvidenceFileSystem {
  listFiles(): Promise<string[]>
  readText(path: string): Promise<string>
  /** Must atomically create and reject an existing target. */
  writeTextAtomic(path: string, content: string): Promise<void>
  digest(path: string): Promise<{ sha256: string; size: number } | null>
}

export interface EvidenceRuntime {
  now(): Date
  randomId(): string
}

interface ResolvedEntity {
  path: string
  role: EvidenceEntityRole
  sha256: string
  size: number
}

interface ResolvedRelation {
  path: string
  type: EvidenceRelationType
  document: Record<string, unknown>
  claimRef: string
}

const STATUSES = new Set<EvidenceStatus>(['proposed', 'challenged', 'inconclusive', 'supported', 'refuted'])
const ENTITY_ROLES = new Set<EvidenceEntityRole>(['input', 'output', 'support', 'contradiction'])
const RELATION_TYPES = new Set<EvidenceRelationType>(['wasDerivedFrom', 'wasRevisionOf', 'wasInvalidatedBy'])
const ACTIVITY_TYPES = new Set<EvidenceWriteInput['activity']['type']>(['run', 'analysis', 'observation'])
const SHA256 = /^[a-f0-9]{64}$/i

export function createWorkspaceEvidence(
  fs: EvidenceFileSystem,
  runtime: Partial<EvidenceRuntime> = {},
) {
  const now = runtime.now ?? (() => new Date())
  const randomId = runtime.randomId ?? (() => globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2))
  const evidencePaths = async () => (await fs.listFiles())
    .filter((item) => isEvidencePath(item))
    .map(evidencePath)
    .sort()

  const assertAcyclicRelationChain = async (starts: ReadonlyArray<string>) => {
    const visited = new Set<string>()
    const walk = async (path: string, stack: string[]): Promise<void> => {
      if (stack.includes(path)) throw new Error(`Evidence relation chain contains a cycle: ${[...stack, path].join(' -> ')}`)
      if (visited.has(path)) return
      visited.add(path)
      let document: Record<string, unknown>
      try {
        document = validateProvBundle(JSON.parse(await fs.readText(path)))
      } catch {
        return // unreadable or dangling targets are graph issues, not write blockers
      }
      const claimRef = currentClaimRef(document)
      for (const relation of relationProjections(document, claimRef)) {
        await walk(relation.claimPath, [...stack, path])
      }
    }
    for (const start of starts) await walk(start, [])
  }

  return {
    async list(): Promise<EvidenceListItem[]> {
      const items: EvidenceListItem[] = []
      for (const path of await evidencePaths()) {
        try {
          const claim = claimOf(validateProvBundle(JSON.parse(await fs.readText(path))))
          items.push({ path, status: claim.status, summary: summarize(claim.statement) })
        } catch {
          // An unreadable bundle must not blank the folder; evidence.graph
          // is the integrity surface that reports it as an `unreadable` issue.
        }
      }
      return items
    },

    async read(path: string): Promise<EvidenceProjection> {
      const resolvedPath = evidencePath(path)
      const document = validateProvBundle(JSON.parse(await fs.readText(resolvedPath)))
      return projectEvidence(document, resolvedPath)
    },

    async graph(): Promise<EvidenceGraphProjection> {
      const documents = await Promise.all((await evidencePaths()).map(async (path) => {
        try {
          return { path, document: JSON.parse(await fs.readText(path)) as unknown }
        } catch {
          return { path, document: null }
        }
      }))
      return buildEvidenceGraph(documents)
    },

    async verify(path: string): Promise<EvidenceVerificationResult> {
      const resolvedPath = evidencePath(path)
      const document = validateProvBundle(JSON.parse(await fs.readText(resolvedPath)))
      // Verification re-hashes against the bundle itself, never against a
      // projection -- projections are views and may legitimately omit digests.
      const files = await Promise.all(fileEntities(document).map(async (entity): Promise<EvidenceVerificationFile> => {
        const actual = await fs.digest(entity.path)
        const valid = actual?.sha256 === entity.sha256
        return {
          ref: entity.ref,
          path: entity.path,
          expected: entity.sha256,
          actual: actual?.sha256 ?? null,
          valid,
          status: !actual ? 'missing' : valid ? 'match' : 'changed',
        }
      }))
      const valid = files.every((item) => item.valid)
      return {
        path: resolvedPath,
        valid,
        files,
        projection: projectEvidence(document, resolvedPath, new Map(files.map((item) => [item.ref, item.status])), valid),
      }
    },

    async write(input: EvidenceWriteInput, context: string | EvidenceWriteContext = {}) {
      validateInput(input)
      const normalizedContext = typeof context === 'string' ? { agentId: context } : context
      const agentId = normalizedContext.agentId?.trim() || 'tdease-agent'
      const provenance = normalizedContext.provenance
      if (provenance) validateTurnProvenance(provenance)
      const directory = scopeDirectory(input.scope)
      const existing = new Set(await evidencePaths())
      const relations: ResolvedRelation[] = []

      for (const relation of input.relations ?? []) {
        const claimPath = evidencePath(relation.claimPath)
        if (parent(claimPath) !== directory) {
          throw new Error('Related claims must be in the same Evidence directory')
        }
        if (!existing.has(claimPath)) throw new Error(`Related claim not found: ${claimPath}`)
        const document = validateProvBundle(JSON.parse(await fs.readText(claimPath)))
        relations.push({
          path: claimPath,
          type: relation.type,
          document,
          claimRef: currentClaimRef(document),
        })
      }

      // A new claim points backwards, so it can only close a cycle if the
      // chain it joins already contains one. Walk the target chain and refuse
      // to extend a broken graph.
      await assertAcyclicRelationChain(relations.map((relation) => relation.path))

      const resolved: ResolvedEntity[] = await Promise.all(input.entities.map(async (entity) => {
        const path = validateRelativePath(entity.path)
        const digest = await fs.digest(path)
        if (!digest) throw new Error(`Evidence entity not found: ${path}`)
        if (!SHA256.test(digest.sha256) || !Number.isInteger(digest.size) || digest.size < 0) {
          throw new Error(`Evidence entity digest is invalid: ${path}`)
        }
        return { ...entity, path, ...digest }
      }))

      const stamp = now().toISOString()
      const token = normalizeToken(randomId())
      const refs = {
        claim: `tdease:claim-${token}`,
        activity: `tdease:activity-${token}`,
        plan: provenance ? `tdease:prompt-${provenance.promptSnapshotDigest}` : `tdease:plan-${token}`,
        agent: `tdease:agent-${normalizeToken(agentId)}`,
        ...(provenance ? { turn: turnRef(provenance) } : {}),
      }
      const path = `${directory}/${stamp.replace(/[-:.TZ]/g, '')}-${token}.prov.json`
      if (existing.has(path)) throw new Error(`Evidence already exists: ${path}`)

      const bundle = buildBundle({ input, resolved, relations, stamp, refs, agentId, provenance })
      await fs.writeTextAtomic(path, `${JSON.stringify(bundle, null, 2)}\n`)
      return { path, claimRef: refs.claim, projection: projectEvidence(bundle, path) }
    },
  }
}

function buildBundle(value: {
  input: EvidenceWriteInput
  resolved: ReadonlyArray<ResolvedEntity>
  relations: ReadonlyArray<ResolvedRelation>
  stamp: string
  refs: { claim: string; activity: string; plan: string; agent: string; turn?: string }
  agentId: string
  provenance?: EvidenceTurnProvenance
}): Record<string, unknown> {
  const { input, resolved, relations, stamp, refs, agentId, provenance } = value
  const entity: Record<string, unknown> = {
    [refs.claim]: {
      'prov:type': 'tdease:Claim',
      'prov:value': input.statement.trim(),
      'tdease:status': input.status,
      ...(input.notes?.trim() ? { 'prov:note': input.notes.trim() } : {}),
    },
    [refs.plan]: {
      'prov:type': 'prov:Plan',
      ...(provenance
        ? {
            'prov:location': promptSnapshotPath(provenance),
            'tdease:sha256': provenance.promptSnapshotDigest,
          }
        : { 'prov:label': 'AI-authored scientific Evidence semantics' }),
    },
  }
  const used: Record<string, unknown> = {}

  resolved.forEach((item, index) => {
    const ref = `tdease:file-${index}-${refs.claim.slice('tdease:claim-'.length)}`
    entity[ref] = {
      'prov:type': 'tdease:File',
      'prov:location': item.path,
      'tdease:sha256': item.sha256,
      'tdease:size': item.size,
      'tdease:role': item.role,
    }
    used[`tdease:usage-${index}`] = {
      'prov:activity': refs.activity,
      'prov:entity': ref,
      'tdease:role': item.role,
    }
  })

  const bundle: Record<string, unknown> = {
    prefix: {
      prov: 'http://www.w3.org/ns/prov#',
      xsd: 'http://www.w3.org/2001/XMLSchema#',
      tdease: 'https://tdease.dev/ns/evidence#',
    },
    entity,
    activity: {
      [refs.activity]: {
        'prov:type': `tdease:${input.activity.type}`,
        'prov:label': input.activity.label.trim(),
        'prov:endedAtTime': stamp,
      },
      ...(provenance && refs.turn ? {
        [refs.turn]: {
          'prov:type': 'tdease:AgentTurn',
          'tdease:sessionId': provenance.sessionId,
          'tdease:turnId': provenance.turnId,
          'tdease:sourceCallId': provenance.callId,
          'tdease:model': provenance.model,
          'tdease:sessionLogPath': sessionLogPath(provenance),
        },
      } : {}),
    },
    agent: {
      [refs.agent]: {
        'prov:type': 'prov:SoftwareAgent',
        'prov:label': agentId,
      },
    },
    wasAssociatedWith: {
      'tdease:association': {
        'prov:activity': refs.activity,
        'prov:agent': refs.agent,
        'prov:plan': refs.plan,
      },
      ...(provenance && refs.turn ? {
        'tdease:turn-association': {
          'prov:activity': refs.turn,
          'prov:agent': refs.agent,
          'prov:plan': refs.plan,
        },
      } : {}),
    },
    used,
    wasGeneratedBy: {
      'tdease:generation': {
        'prov:entity': refs.claim,
        'prov:activity': refs.activity,
      },
    },
  }

  if (provenance && refs.turn) {
    bundle.wasInformedBy = {
      'tdease:turn-context': {
        'prov:informed': refs.activity,
        'prov:informant': refs.turn,
      },
    }
  }

  for (const [index, relation] of relations.entries()) {
    entity[relation.claimRef] = asRecord(asRecord(relation.document.entity)[relation.claimRef])
    const section = asRecord(bundle[relation.type])
    section[`tdease:relation-${index}`] = relation.type === 'wasInvalidatedBy'
      ? {
          'prov:entity': relation.claimRef,
          'prov:activity': refs.activity,
          'tdease:invalidatingClaim': refs.claim,
          'tdease:claimPath': relation.path,
        }
      : {
          'prov:generatedEntity': refs.claim,
          'prov:usedEntity': relation.claimRef,
          'tdease:claimPath': relation.path,
        }
    bundle[relation.type] = section
  }

  if (input.adjudication) {
    const adjudicationRef = `tdease:adjudication-${refs.claim.slice('tdease:claim-'.length)}`
    bundle.activity = {
      ...asRecord(bundle.activity),
      [adjudicationRef]: {
        'prov:type': 'tdease:Adjudication',
        'prov:label': input.adjudication.basis.trim(),
        'tdease:by': input.adjudication.by,
        ...(input.adjudication.activityPath
          ? { 'tdease:activityPath': validateRelativePath(input.adjudication.activityPath) }
          : {}),
      },
    }
    bundle.wasGeneratedBy = {
      ...asRecord(bundle.wasGeneratedBy),
      'tdease:adjudicates': {
        'prov:entity': refs.claim,
        'prov:activity': adjudicationRef,
      },
    }
  }

  return validateProvBundle(bundle)
}

export function projectEvidence(
  document: Record<string, unknown>,
  path: string,
  fileStates: ReadonlyMap<string, Exclude<EvidenceFileVerification, 'unchecked'>> = new Map(),
  verified?: boolean,
): EvidenceProjection {
  const resolvedPath = evidencePath(path)
  const bundle = validateProvBundle(document)
  const entity = asRecord(bundle.entity)
  const claimRef = currentClaimRef(bundle)
  const claim = claimProjection(claimRef, entity[claimRef])
  const relations = relationProjections(bundle, claimRef)
  const relatedPaths = new Map(relations.map((relation) => [relation.relatedClaimRef, relation.claimPath]))
  const relatedClaims = Object.entries(entity)
    .filter(([ref, raw]) => ref !== claimRef && asRecord(raw)['prov:type'] === 'tdease:Claim')
    .map(([ref, raw]) => ({ ...claimProjection(ref, raw), path: relatedPaths.get(ref) }))
  const entities = fileEntities(bundle)
    .map(({ ref, path, role, size }): EvidenceEntityProjection => ({
      ref,
      path,
      role,
      size,
      verification: fileStates.get(ref) ?? 'unchecked',
    }))
  const generation = generationFor(bundle, claimRef)
  const activityRaw = asRecord(asRecord(bundle.activity)[generation.activityRef])
  const activityType = String(activityRaw['prov:type']).replace(/^tdease:/, '')
  if (!ACTIVITY_TYPES.has(activityType as EvidenceWriteInput['activity']['type'])) {
    throw new Error(`Evidence activity has unsupported type: ${activityType}`)
  }
  const adjudication = adjudicationProjection(bundle)
  const turn = turnProjection(bundle, generation.activityRef)
  const verdict = claim.status === 'supported' || claim.status === 'refuted'
  if (verdict !== Boolean(adjudication)) {
    throw new Error(verdict
      ? 'Supported/refuted Evidence is missing adjudication'
      : 'Descriptive Evidence must not contain adjudication')
  }

  return {
    path: resolvedPath,
    claim,
    relatedClaims,
    entities,
    relations,
    activity: {
      ref: generation.activityRef,
      type: activityType as EvidenceWriteInput['activity']['type'],
      label: requiredString(activityRaw['prov:label'], 'activity label'),
      endedAt: requiredString(activityRaw['prov:endedAtTime'], 'activity endedAtTime'),
    },
    ...(adjudication ? { adjudication } : {}),
    ...(turn ? { turn } : {}),
    verification: verified === undefined
      ? { state: 'unchecked' }
      : { state: verified ? 'verified' : 'drifted', valid: verified },
    mermaid: evidenceMermaid(claim, relatedClaims, relations),
  }
}

export function validateProvBundle(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Evidence must be a PROV-JSON object')
  const bundle = value
  for (const key of ['prefix', 'entity', 'activity', 'agent']) {
    if (!Object.keys(asRecord(bundle[key])).length) throw new Error(`PROV bundle is missing ${key}`)
  }
  const prefix = asRecord(bundle.prefix)
  if (prefix.prov !== 'http://www.w3.org/ns/prov#') throw new Error('PROV bundle must declare the prov prefix')
  // The authoring agent is one of the three semantic anchors (claim, activity,
  // agent); a bundle without an identified SoftwareAgent is not Evidence.
  const hasSoftwareAgent = Object.values(asRecord(bundle.agent))
    .some((raw) => asRecord(raw)['prov:type'] === 'prov:SoftwareAgent')
  if (!hasSoftwareAgent) throw new Error('PROV bundle must identify a prov:SoftwareAgent')
  currentClaimRef(bundle)
  return bundle
}

/**
 * Project many Evidence documents into one cross-file claim DAG. One broken
 * bundle never blanks the graph: it becomes an `unreadable` issue, edges whose
 * target is outside the input set become `dangling` issues, and revision or
 * derivation loops are reported as `cycle` issues.
 */
export function buildEvidenceGraph(
  documents: ReadonlyArray<{ path: string; document: unknown }>,
): EvidenceGraphProjection {
  const nodes: EvidenceGraphNode[] = []
  const edges: EvidenceGraphEdge[] = []
  const issues: EvidenceGraphIssue[] = []
  const known = new Set(documents.map((item) => item.path))

  for (const item of documents) {
    try {
      const bundle = validateProvBundle(item.document)
      const claim = claimOf(bundle)
      nodes.push({ ref: claim.ref, path: item.path, status: claim.status, summary: summarize(claim.statement) })
      for (const relation of relationProjections(bundle, claim.ref)) {
        edges.push({
          fromPath: item.path,
          fromRef: relation.currentClaimRef,
          toPath: relation.claimPath,
          toRef: relation.relatedClaimRef,
          type: relation.type,
        })
      }
    } catch (cause) {
      issues.push({
        kind: 'unreadable',
        detail: cause instanceof Error ? cause.message : String(cause),
        paths: [item.path],
      })
    }
  }

  for (const edge of edges) {
    if (!known.has(edge.toPath)) {
      issues.push({
        kind: 'dangling',
        detail: `${edge.fromPath} ${edge.type} ${edge.toPath}, which is not in the graph`,
        paths: [edge.fromPath, edge.toPath],
      })
    }
  }

  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.type === 'wasInvalidatedBy' || !known.has(edge.toPath)) continue
    outgoing.set(edge.fromPath, [...(outgoing.get(edge.fromPath) ?? []), edge.toPath])
  }
  const done = new Set<string>()
  const walk = (path: string, stack: string[]) => {
    if (stack.includes(path)) {
      const cycle = [...stack.slice(stack.indexOf(path)), path]
      issues.push({ kind: 'cycle', detail: `Evidence relation cycle: ${cycle.join(' -> ')}`, paths: cycle })
      return
    }
    if (done.has(path)) return
    done.add(path)
    for (const next of outgoing.get(path) ?? []) walk(next, [...stack, path])
  }
  for (const node of nodes) walk(node.path, [])

  return { nodes, edges, issues }
}

function validateInput(input: EvidenceWriteInput): void {
  if (!input || typeof input !== 'object') throw new Error('Evidence input is required')
  if (!input.statement?.trim() || !input.activity?.label?.trim()) {
    throw new Error('Evidence statement and activity label are required')
  }
  if (!STATUSES.has(input.status)) throw new Error(`Unsupported Evidence status: ${String(input.status)}`)
  if (!ACTIVITY_TYPES.has(input.activity.type)) throw new Error(`Unsupported Evidence activity: ${String(input.activity.type)}`)
  const verdict = input.status === 'supported' || input.status === 'refuted'
  if (verdict !== Boolean(input.adjudication)) {
    throw new Error(verdict ? 'supported/refuted requires adjudication' : 'Only supported/refuted may include adjudication')
  }
  if (input.adjudication) {
    if (!['user', 'deterministic-check'].includes(input.adjudication.by) || !input.adjudication.basis?.trim()) {
      throw new Error('Evidence adjudication requires a valid by and basis')
    }
    if (input.adjudication.activityPath) validateRelativePath(input.adjudication.activityPath)
  }
  if (!Array.isArray(input.entities) || !input.entities.length) throw new Error('Evidence requires at least one entity')
  for (const entity of input.entities) {
    validateRelativePath(entity.path)
    if (!ENTITY_ROLES.has(entity.role)) throw new Error(`Unsupported Evidence entity role: ${String(entity.role)}`)
  }
  for (const relation of input.relations ?? []) {
    evidencePath(relation.claimPath)
    if (!RELATION_TYPES.has(relation.type)) throw new Error(`Unsupported Evidence relation: ${String(relation.type)}`)
  }
}

function validateTurnProvenance(value: EvidenceTurnProvenance): void {
  for (const [name, item] of Object.entries({ sessionId: value.sessionId, turnId: value.turnId })) {
    if (typeof item !== 'string' || !/^[A-Za-z0-9_-]+$/.test(item)) {
      throw new Error(`Evidence turn provenance ${name} is invalid`)
    }
  }
  if (typeof value.callId !== 'string' || !/^[A-Za-z0-9_.:-]+$/.test(value.callId)) {
    throw new Error('Evidence turn provenance callId is invalid')
  }
  if (!SHA256.test(value.promptSnapshotDigest)) throw new Error('Evidence turn provenance prompt digest is invalid')
  if (typeof value.model !== 'string' || !value.model.trim()) throw new Error('Evidence turn provenance model is required')
}

function sessionLogPath(value: EvidenceTurnProvenance): string {
  return `.tdease/sessions/${value.sessionId}/events.jsonl`
}

function promptSnapshotPath(value: EvidenceTurnProvenance): string {
  return `.tdease/sessions/${value.sessionId}/snapshots/${value.promptSnapshotDigest}.md`
}

function turnRef(value: EvidenceTurnProvenance): string {
  return `tdease:turn-${value.sessionId}-${value.turnId}`
}

function scopeDirectory(scope: EvidenceWriteInput['scope']): string {
  if (scope.kind === 'workspace') return 'evidence'
  const runPath = validateRelativePath(scope.runPath).replace(/\/$/, '')
  if (!/^runs\/[^/]+$/.test(runPath)) throw new Error('runPath must identify one runs/<run> directory')
  return `${runPath}/evidence`
}

function evidencePath(value: string): string {
  const path = validateRelativePath(value)
  if (!isEvidencePath(path)) throw new Error('Evidence must be a .prov.json claim in evidence/ or runs/<run>/evidence/')
  return path
}

export function isEvidencePath(value: string): boolean {
  return /^(?:evidence|runs\/[^/]+\/evidence)\/[^/]+\.prov\.json$/.test(value)
}

function parent(value: string): string {
  return value.slice(0, value.lastIndexOf('/'))
}

function normalizeToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9-]/g, '').replace(/^-+|-+$/g, '')
  if (!token) throw new Error('Evidence id generator returned an empty identifier')
  return token
}

function claimOf(document: Record<string, unknown>): EvidenceClaimProjection {
  const ref = currentClaimRef(document)
  return claimProjection(ref, asRecord(document.entity)[ref])
}

function summarize(statement: string): string {
  const flat = statement.replace(/\s+/g, ' ').trim()
  return flat.length <= 120 ? flat : `${flat.slice(0, 117)}...`
}

/** File entities with their recorded digests. Internal: projections omit sha256. */
function fileEntities(bundle: Record<string, unknown>) {
  return Object.entries(asRecord(bundle.entity))
    .filter(([, raw]) => asRecord(raw)['prov:type'] === 'tdease:File')
    .map(([ref, raw]) => {
      const item = asRecord(raw)
      return {
        ref,
        path: requiredString(item['prov:location'], `entity ${ref} location`),
        role: requiredEntityRole(item['tdease:role'], `entity ${ref} role`),
        sha256: requiredSha256(item['tdease:sha256'], `entity ${ref} sha256`),
        size: requiredNonNegativeInteger(item['tdease:size'], `entity ${ref} size`),
      }
    })
}

function currentClaimRef(document: Record<string, unknown>): string {
  const entity = asRecord(document.entity)
  const generated = Object.values(asRecord(document.wasGeneratedBy))
    .map(asRecord)
    .map((relation) => relation['prov:entity'])
    .filter((ref): ref is string => typeof ref === 'string')
  const claims = [...new Set(generated.filter((ref) => asRecord(entity[ref])['prov:type'] === 'tdease:Claim'))]
  if (claims.length !== 1) throw new Error('PROV bundle must generate exactly one current claim')
  claimProjection(claims[0], entity[claims[0]])
  return claims[0]
}

function claimProjection(ref: string, raw: unknown): EvidenceClaimProjection {
  const claim = asRecord(raw)
  if (claim['prov:type'] !== 'tdease:Claim') throw new Error(`Entity is not an Evidence claim: ${ref}`)
  const status = claim['tdease:status']
  if (!STATUSES.has(status as EvidenceStatus)) throw new Error(`Claim ${ref} has unsupported status: ${String(status)}`)
  const notes = claim['prov:note']
  return {
    ref,
    statement: requiredString(claim['prov:value'], `claim ${ref} statement`),
    status: status as EvidenceStatus,
    ...(typeof notes === 'string' && notes ? { notes } : {}),
  }
}

function generationFor(document: Record<string, unknown>, claimRef: string): { activityRef: string } {
  for (const raw of Object.values(asRecord(document.wasGeneratedBy))) {
    const relation = asRecord(raw)
    if (relation['prov:entity'] === claimRef && typeof relation['prov:activity'] === 'string') {
      const activity = asRecord(asRecord(document.activity)[relation['prov:activity']])
      if (activity['prov:type'] !== 'tdease:Adjudication') return { activityRef: relation['prov:activity'] }
    }
  }
  throw new Error(`Current claim has no generating scientific activity: ${claimRef}`)
}

function relationProjections(document: Record<string, unknown>, claimRef: string): EvidenceRelationProjection[] {
  const projected: EvidenceRelationProjection[] = []
  for (const type of RELATION_TYPES) {
    for (const raw of Object.values(asRecord(document[type]))) {
      const relation = asRecord(raw)
      const claimPath = requiredString(relation['tdease:claimPath'], `${type} claim path`)
      evidencePath(claimPath)
      if (type === 'wasInvalidatedBy') {
        if (relation['tdease:invalidatingClaim'] !== claimRef) continue
        projected.push({
          type,
          claimPath,
          currentClaimRef: claimRef,
          relatedClaimRef: requiredString(relation['prov:entity'], `${type} related claim`),
        })
      } else if (relation['prov:generatedEntity'] === claimRef) {
        projected.push({
          type,
          claimPath,
          currentClaimRef: claimRef,
          relatedClaimRef: requiredString(relation['prov:usedEntity'], `${type} related claim`),
        })
      }
    }
  }
  return projected
}

function adjudicationProjection(document: Record<string, unknown>): EvidenceAdjudicationProjection | undefined {
  for (const raw of Object.values(asRecord(document.activity))) {
    const activity = asRecord(raw)
    if (activity['prov:type'] !== 'tdease:Adjudication') continue
    const by = activity['tdease:by']
    if (by !== 'user' && by !== 'deterministic-check') throw new Error('Evidence adjudication has unsupported author')
    const activityPath = activity['tdease:activityPath']
    return {
      by,
      basis: requiredString(activity['prov:label'], 'adjudication basis'),
      ...(typeof activityPath === 'string' ? { activityPath: validateRelativePath(activityPath) } : {}),
    }
  }
  return undefined
}

function turnProjection(document: Record<string, unknown>, scientificActivityRef: string): EvidenceTurnProjection | undefined {
  for (const raw of Object.values(asRecord(document.wasInformedBy))) {
    const relation = asRecord(raw)
    if (relation['prov:informed'] !== scientificActivityRef) continue
    const ref = relation['prov:informant']
    if (typeof ref !== 'string') continue
    const activity = asRecord(asRecord(document.activity)[ref])
    if (activity['prov:type'] !== 'tdease:AgentTurn') continue
    const provenance: EvidenceTurnProvenance = {
      sessionId: requiredString(activity['tdease:sessionId'], 'AgentTurn sessionId'),
      turnId: requiredString(activity['tdease:turnId'], 'AgentTurn turnId'),
      callId: requiredString(activity['tdease:sourceCallId'], 'AgentTurn sourceCallId'),
      promptSnapshotDigest: promptDigestForTurn(document, ref),
      model: requiredString(activity['tdease:model'], 'AgentTurn model'),
    }
    validateTurnProvenance(provenance)
    const recordedLog = requiredString(activity['tdease:sessionLogPath'], 'AgentTurn sessionLogPath')
    if (recordedLog !== sessionLogPath(provenance)) throw new Error('AgentTurn session log path does not match its identity')
    return {
      ref,
      ...provenance,
      sessionLogPath: recordedLog,
      promptSnapshotPath: promptSnapshotPath(provenance),
    }
  }
  return undefined
}

function promptDigestForTurn(document: Record<string, unknown>, turnRefValue: string): string {
  for (const raw of Object.values(asRecord(document.wasAssociatedWith))) {
    const association = asRecord(raw)
    if (association['prov:activity'] !== turnRefValue) continue
    const planRef = association['prov:plan']
    if (typeof planRef !== 'string') continue
    const plan = asRecord(asRecord(document.entity)[planRef])
    const digest = requiredSha256(plan['tdease:sha256'], 'AgentTurn Plan digest')
    const location = requiredString(plan['prov:location'], 'AgentTurn Plan location')
    if (!location.endsWith(`/snapshots/${digest}.md`)) throw new Error('AgentTurn Plan location does not match its digest')
    return digest
  }
  throw new Error('AgentTurn has no content-addressed Plan association')
}

function evidenceMermaid(
  claim: EvidenceClaimProjection,
  related: ReadonlyArray<EvidenceClaimProjection>,
  relations: ReadonlyArray<EvidenceRelationProjection>,
): string {
  const nodes = [claim, ...related]
  const ids = new Map(nodes.map((item, index) => [item.ref, `C${index}`]))
  const lines = ['graph LR']
  for (const item of nodes) {
    lines.push(`  ${ids.get(item.ref)}["${escapeMermaid(item.statement)}\\n${item.status}"]`)
  }
  for (const relation of relations) {
    const from = ids.get(relation.currentClaimRef)
    const to = ids.get(relation.relatedClaimRef)
    if (from && to) lines.push(`  ${from} -->|${relation.type}| ${to}`)
  }
  return lines.join('\n')
}

function escapeMermaid(value: string): string {
  return value.replace(/["\r\n]/g, (character) => character === '"' ? "'" : ' ')
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Evidence ${field} is required`)
  return value
}

function requiredSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`Evidence ${field} is invalid`)
  return value
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`Evidence ${field} is invalid`)
  return value as number
}

function requiredEntityRole(value: unknown, field: string): EvidenceEntityRole {
  if (!ENTITY_ROLES.has(value as EvidenceEntityRole)) throw new Error(`Evidence ${field} is invalid`)
  return value as EvidenceEntityRole
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
