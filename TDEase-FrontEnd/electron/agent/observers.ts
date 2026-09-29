/**
 * Node-side Observers: usage accounting + tool-call audit.
 *
 * Both are *observability, not prerequisites* (AGENT-LOOP.md). A usage write or
 * an audit record failing must never break the model call, so every public
 * method wraps its work in try/catch that swallows (console.warn) — a missing
 * ledger entry is a degraded-metrics problem, not a turn failure.
 *
 * The usage ledger itself (createUsageLedger in src/ai/core/usage-ledger.ts) is
 * reused unchanged: it already normalises Pi/Anthropic/OpenAI usage payloads,
 * computes cost from costRates, and persists atomically. This class is just the
 * adapter that maps the contracts.ts Observers surface onto it, plus the
 * session-scoped tool audit. The ledger is injected (not created here) so the
 * composition root owns its storage path and lifecycle.
 */

import type { ModelSelector } from '../../src/contracts/agent-runtime'
import type { UsageLedger, CostRates, UsageModel } from '../../src/ai/core/usage-ledger'
import type { Observers, ResolvedProvider } from './contracts'

export interface NodeObserversOptions {
  readonly ledger: UsageLedger
  /**
   * Optional compact eval sink for tool-call audits. Called once per completed
   * tool call with a small, JSON-safe record intended for easy eval scanning —
   * the full conversation truth stays in the session's `events.jsonl`; this is
   * the trimmed index (tool, ok, when, key args) an eval loop reads without
   * parsing the whole transcript. Defaults to the in-memory ring buffer only.
   */
  readonly toolAuditSink?: (entry: CompactToolAudit) => void
}

/**
 * A trimmed, eval-friendly tool-call record. Fields are deliberately flat and
 * tool-typed: `command` for bash (includes tdeasenexus-toolbox / uv run --script calls),
 * `id`/`resource` for tdease.skill.read, `path` for read/grep/ls. Extra args
 * are kept under `detail` so the full input remains reachable without bloating
 * the common row.
 */
export interface CompactToolAudit {
  readonly at: string
  readonly sessionId: string
  readonly callId: string
  readonly tool: string
  readonly ok: boolean
  /** The binding's authority — every permission row is meaningless without it. */
  readonly authority?: 'ask' | 'auto'
  /** Present on delegated (subagent) sessions: the parent sessionId whose
   *  frozen ceiling this call ran under (AGENT-LIFECYCLE.md §Delegation). */
  readonly delegatedFrom?: string
  /** The narrowed tool surface the delegation granted (the spawn's persisted
   *  scope) — the audit's answer to "what was this child allowed to use". */
  readonly delegationScope?: ReadonlyArray<string>
  readonly command?: string
  readonly id?: string
  readonly resource?: string
  readonly path?: string
  readonly query?: string
  readonly detail?: Record<string, unknown>
}

/**
 * In-memory ring buffer for tool-call audit. Bounded so a long session cannot
 * grow it without limit; the oldest entry is dropped first. Kept here rather
 * than written to a per-session file so the observer stays decoupled from the
 * session directory layout — a future owner can swap in a jsonl writer behind
 * the same Observers interface without touching the model loop.
 */
const AUDIT_BUFFER_LIMIT = 1000

interface AuditEntry {
  readonly sessionId: string
  readonly callId: string
  readonly name: string
  readonly ok: boolean
  readonly at: string
  readonly args?: unknown
  readonly result?: unknown
}

export class NodeObservers implements Observers {
  private readonly ledger: UsageLedger
  private readonly audit: AuditEntry[] = []
  private readonly toolAuditSink?: (entry: CompactToolAudit) => void

  constructor(options: NodeObserversOptions) {
    this.ledger = options.ledger
    this.toolAuditSink = options.toolAuditSink
  }

  startUsage(meta: { model: ModelSelector; provider: ResolvedProvider; cost?: CostRates }): string {
    try {
      const { requestId } = this.ledger.start({
        model: toUsageModel(meta),
        // Bind-time rates first (pi catalog / settings meta merged by the
        // SessionHost); settings-only fallback for callers that predate it.
        costRates: meta.cost ?? toCostRates(meta.provider),
      })
      return requestId
    } catch (error) {
      // A usage start failure is not recoverable mid-call (no handle to finish),
      // but it must not propagate — return an empty handle so finishUsage/error
      // become harmless no-ops against an unknown requestId.
      console.warn('[observers] startUsage swallowed', error)
      return ''
    }
  }

  finishUsage(handle: string, usage: {
    input_tokens: number
    output_tokens: number
    cache_read_tokens?: number
    cache_write_tokens?: number
  }): void {
    if (!handle) return
    try {
      this.ledger.finish(handle, { usage: toLedgerUsage(usage) })
    } catch (error) {
      console.warn('[observers] finishUsage swallowed', error)
    }
  }

  errorUsage(handle: string, error: unknown, status: 'error' | 'aborted', usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_tokens?: number
    cache_write_tokens?: number
  }): void {
    if (!handle) return
    try {
      this.ledger.recordError(handle, error, status, usage ? { usage: toLedgerUsage(usage) } : undefined)
    } catch (ledgerError) {
      // The model call already failed; a usage-accounting failure on top of it
      // must stay silent so the original error is what surfaces to the user.
      console.warn('[observers] errorUsage swallowed', ledgerError)
    }
  }

  auditTool(
    sessionId: string,
    callId: string,
    name: string,
    args: unknown,
    result: unknown,
    ok: boolean,
    identity?: { authority?: 'ask' | 'auto'; delegatedFrom?: string; delegationScope?: ReadonlyArray<string> },
  ): void {
    try {
      // Keep the buffer FIFO-bounded; push() then trim from the front so the
      // most recent AUDIT_BUFFER_LIMIT entries survive. Args/result are
      // JSON-cloned defensively so a later mutation of the caller's object
      // cannot rewrite history already in the buffer.
      this.audit.push({
        sessionId,
        callId,
        name,
        ok,
        at: new Date().toISOString(),
        args: cloneJson(args),
        result: cloneJson(result),
      })
      while (this.audit.length > AUDIT_BUFFER_LIMIT) this.audit.shift()
      // Optional eval sink: a trimmed record for compact, scan-friendly tool
      // auditing. Same best-effort contract as the rest of the observer — a
      // failing sink is a degraded-metrics problem, never a turn failure.
      if (this.toolAuditSink) {
        this.toolAuditSink(compactToolAudit(sessionId, callId, name, args, ok, identity))
      }
      // console.debug keeps the audit visible during development without
      // polluting production logs at the default level.
      console.debug('[observers] tool audit', { sessionId, callId, name, ok })
    } catch (error) {
      console.warn('[observers] auditTool swallowed', error)
    }
  }

  /** Test/diagnostics only: a snapshot of the current audit ring buffer. */
  auditEntries(): ReadonlyArray<AuditEntry> {
    return this.audit.slice()
  }
}

// ── Shape adapters (pure) ────────────────────────────────────────────────────

/**
 * The ledger's normalizeUsage accepts Pi ({input,output}), Anthropic
 * ({input_tokens,...}) and OpenAI ({prompt_tokens,...}); we hand it the
 * canonical token shape so the same path works regardless of provider. Cache
 * counters ride the Pi-normalized names — without them the ledger can never
 * compute hit ratio and the panel shows no cache rows.
 */
function toLedgerUsage(usage: {
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
}): { input_tokens: number; output_tokens: number; cacheRead?: number; cacheWrite?: number } {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cacheRead: usage.cache_read_tokens,
    cacheWrite: usage.cache_write_tokens,
  }
}

function toUsageModel(meta: { model: ModelSelector; provider: ResolvedProvider }): UsageModel {
  return {
    provider: meta.provider.providerId,
    modelId: meta.model.modelId,
    api: meta.provider.api,
  }
}

function toCostRates(provider: ResolvedProvider): CostRates | null {
  const cost = provider.modelMeta?.cost
  if (!cost) return null
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
  }
}

function cloneJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }
}

/**
 * Build the compact eval record from a tool call's (redacted) args. The goal
 * is a flat, tool-typed row an eval loop can scan cheaply: the single most
 * useful field per tool (the full bash command for bash — which carries
 * tdeasenexus-toolbox / uv run --script invocations; the skill id for skill.read; the
 * path for file tools; the query for unimod/proforma lookups) plus the
 * remaining args under `detail`. Never throws; malformed args yield a record
 * with only the stable fields.
 */
function compactToolAudit(
  sessionId: string,
  callId: string,
  name: string,
  args: unknown,
  ok: boolean,
  identity?: { authority?: 'ask' | 'auto'; delegatedFrom?: string; delegationScope?: ReadonlyArray<string> },
): CompactToolAudit {
  const at = new Date().toISOString()
  const identityFields = {
    ...(identity?.authority ? { authority: identity.authority } : {}),
    ...(identity?.delegatedFrom ? { delegatedFrom: identity.delegatedFrom } : {}),
    ...(identity?.delegationScope ? { delegationScope: identity.delegationScope } : {}),
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { at, sessionId, callId, tool: name, ok, ...identityFields }
  }
  const source = args as Record<string, unknown>
  // Collect optional fields into a mutable local, then spread once into the
  // readonly CompactToolAudit at return. Pick<CompactToolAudit, ...> would
  // inherit the readonly modifiers, so this is a plain optional-key object.
  const picked: { command?: string; id?: string; resource?: string; path?: string; query?: string; detail?: Record<string, unknown> } = {}
  const command = source.command
  if (typeof command === 'string' && command.trim()) picked.command = command.trim()
  const id = source.id
  if (typeof id === 'string' && id) picked.id = id
  const resource = source.resource
  if (typeof resource === 'string' && resource) picked.resource = resource
  const path = source.path
  if (typeof path === 'string' && path) picked.path = path
  const query = source.query
  if (typeof query === 'string' && query) picked.query = query
  const detail: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === 'command' || key === 'id' || key === 'resource' || key === 'path' || key === 'query') continue
    if (value === undefined || value === null) continue
    detail[key] = value
  }
  if (Object.keys(detail).length > 0) picked.detail = detail
  return { at, sessionId, callId, tool: name, ok, ...identityFields, ...picked }
}
