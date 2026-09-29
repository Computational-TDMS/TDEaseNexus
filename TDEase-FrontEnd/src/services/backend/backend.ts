/**
 * TDEase backend client — HTTP + SSE.
 *
 * FRONTEND-ZERO: thin client that talks to the TDEase server.
 * Desktop mode hits localhost; Server/Cloud mode hits a remote URL.
 *
 * Contract alignment: status values from src/contracts/enums.py.
 * All live updates via SSE + Last-Event-ID.
 */

// --- Types ---

import type { CapabilitiesDocument, CommitPlan, RunDefinitionRaw, RunDefinitionRevision, RunEvent, RunFileEntry, RunInfo, RunRevision, RunStatus, TrashedRunInfo, TreeEntry, WorkflowGraph } from './client-contracts'
import type { NodeProjection } from '../catalog/nodeCatalog'
import { throwBackendFailure } from './backendFailure'
import { backendConnectionSupervisor, monitoredBackendFetch } from './backendConnection'
import { runStatusForEvent } from '../../studio/domain/run'
import type { TDEaseDesktop } from '@/services/desktop/desktopBridge'
export type { RunInfo, RunStatus } from './client-contracts'

export interface RunListResponse {
  runs: RunInfo[]
  total: number
  offset: number
  limit: number
  has_more: boolean
}

export interface DryRunProjection {
  nodes: Array<{
    id: number
    rule: string
    label: string
    initial_status?: 'waiting' | 'up_to_date'
    /**
     * The engine resolved this job's threads against the Run's core budget
     * (peak appetite clamped, e.g. topfd 28→8 on an 8-core budget); resources
     * carries declared hard floors like mem_mb. Both make the degradation
     * observable instead of silent (spec/WORKFLOW-RUN.md §1).
     */
    threads?: number
    resources?: Record<string, number | string>
  }>
  edges: Array<{ source: number; target: number }>
}

export interface RunListOptions {
  workspaceId?: string
  offset?: number
  limit?: number
  status?: RunStatus[]
  query?: string
}

export type RunEventHandler = (run: RunInfo) => void
export type RunEventStreamHandler = (event: RunEvent) => void

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED'])

/**
 * Published Result addressing (wire shape) -- docs/design/CORE-ARCHITECTURE.md 3.2,
 * mirrored server-side by `src/contracts/run.py::ResultRef`.
 *
 * `digest` absent = a reference to the *current* value of this Result (unpinned;
 * follows a Recompute automatically). `digest` present = a reference to *exactly*
 * this value (pinned; used for Evidence/provenance). Both readings are valid on
 * the wire, so `digest` is optional here rather than defaulted.
 */
export interface ResultRef {
  workspace_id: string
  run_id: string
  result_id: string
  digest?: string | null
}

/**
 * One entry of the Published Result projection returned by
 * `GET /api/v2/runs/{run_id}/results` -- the join of a declared `result_specs`
 * entry against the Run's file manifest (`app/api/runs_v2.py::list_run_results`).
 * `status: 'declared'` means the spec exists but its output has not materialized
 * yet; it is reported, not omitted. `status: 'ready'` carries the current digest
 * and size.
 */
export interface RunResultEntry {
  result_id: string
  name: string
  kind: string
  dimensions: Record<string, string>
  output: string
  status: 'declared' | 'ready'
  digest?: string | null
  size?: number | null
  ref: ResultRef
}

export interface RunResultsResponse {
  run_id: string
  results: RunResultEntry[]
}


export class TDEaseClient {
  private baseUrl: string
  private accessToken: string | null
  private eventSources = new Set<AbortController>()

  constructor(baseUrl = defaultBaseUrl(), accessToken: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.accessToken = accessToken
  }

  /**
   * Submit a run commit.
   *
   * Contract: src/contracts/run.py RunCommit —
   *   snakefile  = full Snakefile CONTENT (frozen at submit time), not a path
   *   workspace_files / workspace_tree_hash = client-frozen tree manifest
   *   local_root_id/local_run_path = Backend-issued local capability, Desktop only
   */
  async dryRun(plan: CommitPlan, actor: 'user' | 'ai' = 'user'): Promise<{ valid: boolean; exit_code: number; engine: string; output: string; projection?: DryRunProjection | null }> {
    return this.post('/api/v2/runs/dry-run', { commit: this.toCommit(plan) }, actor, 310_000) as Promise<{ valid: boolean; exit_code: number; engine: string; output: string; projection?: DryRunProjection | null }>
  }

  async submitPlan(plan: CommitPlan, actor: 'user' | 'ai' = 'user'): Promise<RunInfo> {
    return this.post('/api/v2/runs', { commit: this.toCommit(plan) }, actor) as Promise<RunInfo>
  }

  async getRunGraph(runId: string): Promise<WorkflowGraph> {
    return this.get(`/api/v2/runs/${encodeURIComponent(runId)}/graph`, undefined, 15_000) as Promise<WorkflowGraph>
  }

  async registerWorkspaceRoot(path: string): Promise<{ root_id: string; path: string }> {
    return this.post('/api/workspace-roots', { path }) as Promise<{ root_id: string; path: string }>
  }

  async revokeWorkspaceRoot(rootId: string): Promise<void> {
    const response = await this.authFetch(
      `${this.baseUrl}/api/workspace-roots/${encodeURIComponent(rootId)}`,
      () => ({ method: 'DELETE', headers: this.headers() }),
    )
    if (!response.ok) await throwBackendFailure(response, `DELETE /api/workspace-roots/${rootId}`)
  }

  async missingBlobs(entries: TreeEntry[]): Promise<string[]> {
    const result = await this.post('/api/v2/uploads/manifest', { entries }) as { missing: string[] }
    return result.missing ?? []
  }

  /**
   * The Backend capability document.
   *
   * Unauthenticated by design, so this deliberately bypasses `get()` and its
   * bearer header: the document is what tells a caller how to authenticate, and
   * requiring authentication to read it would be a bootstrap deadlock
   * (docs/spec/CAPABILITIES.md 3).
   */
  async getCapabilities(): Promise<CapabilitiesDocument> {
    const response = await monitoredBackendFetch(`${this.baseUrl}/api/capabilities`)
    if (!response.ok) await throwBackendFailure(response, 'GET /api/capabilities')
    return response.json() as Promise<CapabilitiesDocument>
  }

  async uploadBlob(digest: string, content: Blob): Promise<void> {
    const response = await this.authFetch(
      `${this.baseUrl}/api/v2/uploads/${digest}`,
      () => {
        const form = new FormData()
        form.append('file', content, digest)
        return { method: 'PUT', headers: this.headers(), body: form }
      },
    )
    if (!response.ok) await throwBackendFailure(response, `PUT /api/v2/uploads/${digest}`)
  }

  async prepareRemote(plan: CommitPlan, readBlob: (path: string) => Promise<Blob>): Promise<void> {
    if (plan.materializationStrategy !== 'blob_store') return
    const missing = new Set(await this.missingBlobs(plan.workspaceFiles))
    for (const entry of plan.workspaceFiles) {
      if (missing.has(entry.blob_hash)) await this.uploadBlob(entry.blob_hash, await readBlob(entry.path))
    }
  }

  async wait(runId: string, lastEventId = 0): Promise<RunInfo> {
    const initial = await this.status(runId)
    if (TERMINAL_STATUSES.has(initial.status)) return initial
    return new Promise<RunInfo>((resolve, reject) => {
      let latest = initial
      const stop = this.subscribeEvents(runId, (event) => {
        const status = runStatusForEvent(event.type)
        if (status) latest = { ...latest, status, event_seq_last: event.seq }
        if (status && TERMINAL_STATUSES.has(status)) finish(latest)
      }, Math.max(lastEventId, initial.event_seq_last))
      // Fallback status GET for a stream that ends without a terminal event.
      // The timer must be cleared on every resolution path — left scheduled it
      // fires a stray status request 30s after the caller already got its result.
      const poll = setTimeout(async () => {
        try {
          const current = await this.status(runId)
          if (TERMINAL_STATUSES.has(current.status)) finish(current)
        } catch (error) { stop(); reject(error) }
      }, 30_000)
      const finish = (run: RunInfo) => { clearTimeout(poll); stop(); resolve(run) }
    })
  }

  async status(runId: string): Promise<RunInfo> {
    return this.get(`/api/v2/runs/${runId}`) as Promise<RunInfo>
  }

  async listNodes(): Promise<NodeProjection[]> {
    const result = await this.get('/api/nodes') as { nodes: Array<Omit<NodeProjection, 'rulesText'> & { rules_text: string }> }
    // Map the wire key to the projection key without carrying both — the
    // duplicate shipped ~14k extra chars per node to every consumer.
    return (result.nodes ?? []).map(({ rules_text, ...node }) => ({ ...node, rulesText: rules_text }))
  }

  async getNode(id: string): Promise<NodeProjection> {
    const { rules_text, ...node } = await this.get(`/api/nodes/${encodeURIComponent(id)}`) as Omit<NodeProjection, 'rulesText'> & { rules_text: string }
    return { ...node, rulesText: rules_text }
  }

  async listPage(options: RunListOptions = {}): Promise<RunListResponse> {
    const params: Record<string, unknown> = {
      ...(options.workspaceId ? { workspace_id: options.workspaceId } : {}),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.query ? { query: options.query } : {}),
    }
    if (options.status?.length) params.status = options.status
    return this.get('/api/v2/runs', params) as Promise<RunListResponse>
  }

  async list(workspaceId?: string): Promise<RunInfo[]> {
    const r = await this.listPage({ workspaceId })
    return r.runs ?? []
  }

  async cancel(runId: string, actor: 'user' | 'ai' = 'user'): Promise<boolean> {
    try { await this.post(`/api/v2/runs/${runId}/cancel`, undefined, actor); return true }
    catch { return false }
  }

  async rerun(runId: string, mode: 'resume' | 'overwrite', actor: 'user' | 'ai' = 'user'): Promise<RunInfo> {
    await this.post(`/api/v2/runs/${runId}/rerun`, { mode }, actor)
    return this.status(runId)
  }

  async trashRun(runId: string, actor: 'user' | 'ai' = 'user'): Promise<void> {
    await this.post(`/api/v2/runs/${runId}/trash`, undefined, actor)
  }

  async listTrash(): Promise<TrashedRunInfo[]> {
    const result = await this.get('/api/v2/runs/trash') as { runs: TrashedRunInfo[] }
    return result.runs ?? []
  }

  async restoreRun(runId: string, actor: 'user' | 'ai' = 'user'): Promise<RunInfo> {
    return this.post(`/api/v2/runs/trash/${runId}/restore`, undefined, actor) as Promise<RunInfo>
  }

  async tailLog(runId: string, lines = 50): Promise<string> {
    const response = await this.authFetch(
      `${this.baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/log?tail=${lines}`,
      () => ({ headers: this.headers() }),
    )
    if (!response.ok) await throwBackendFailure(response, `GET /api/v2/runs/${runId}/log`)
    return response.text()
  }

  async pullFiles(runId: string, patterns?: string[]): Promise<string[]> {
    const r = await this.get(`/api/v2/runs/${runId}/files`, { patterns }) as { files: string[] }
    return r.files ?? []
  }

  async listRunFiles(
    runId: string,
    pattern = 'results/**',
    revision?: string,
    includeWorkflow = false,
  ): Promise<RunFileEntry[]> {
    const result = await this.get(`/api/v2/runs/${runId}/files`, {
      pattern,
      ...(revision ? { revision } : {}),
      ...(includeWorkflow ? { include_workflow: true } : {}),
    }) as { files: RunFileEntry[] }
    return result.files ?? []
  }

  async listRunRevisions(runId: string): Promise<RunRevision[]> {
    const result = await this.get(`/api/v2/runs/${runId}/revisions`) as { revisions: RunRevision[] }
    return result.revisions ?? []
  }

  async getRunDefinition(runId: string, definitionRevisionId: string): Promise<RunDefinitionRaw> {
    return this.get(`/api/v2/runs/${encodeURIComponent(runId)}/definitions/${encodeURIComponent(definitionRevisionId)}`) as Promise<RunDefinitionRaw>
  }

  async listRunDefinitions(runId: string): Promise<RunDefinitionRevision[]> {
    const result = await this.get(`/api/v2/runs/${encodeURIComponent(runId)}/definitions`) as { definitions: RunDefinitionRevision[] }
    return result.definitions ?? []
  }

  async listResults(runId: string): Promise<RunResultEntry[]> {
    const result = await this.get(`/api/v2/runs/${runId}/results`) as RunResultsResponse
    return result.results ?? []
  }

  async fetchFile(runId: string, fp: string, revision?: string): Promise<Blob> {
    const query = revision ? `?revision=${encodeURIComponent(revision)}` : ''
    const url = `${this.baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(fp)}${query}`
    const r = await this.authFetch(url, () => ({ headers: this.headers() }))
    if (!r.ok) await throwBackendFailure(r, `GET /api/v2/runs/${runId}/files/${fp}`)
    return r.blob()
  }

  /**
   * SSE subscription to a single run's event stream.
   * Events are raw JSONL lines: { run_id, seq, timestamp, type, data }
   * The server closes the stream on terminal status with event: done.
   */
  subscribeEvents(
    runId: string,
    handler: RunEventStreamHandler,
    lastEventId = 0,
    onDone?: () => void,
  ): () => void {
    let cursor = lastEventId
    const controller = new AbortController()
    this.eventSources.add(controller)
    void (async () => {
      let terminal = false
      while (!controller.signal.aborted && !terminal) {
        try {
          const response = await fetch(`${this.baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/events`, {
            headers: this.headers({
              Accept: 'text/event-stream',
              ...(cursor > 0 ? { 'Last-Event-ID': String(cursor) } : {}),
            }),
            cache: 'no-store',
            signal: controller.signal,
          })
          backendConnectionSupervisor.observeResponse(response, `${this.baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/events`)
          if (!response.ok) await throwBackendFailure(response, `GET /api/v2/runs/${runId}/events`)
          await consumeSse(response, (eventName, data) => {
            if (eventName === 'done') {
              try {
                const checkpoint = JSON.parse(data) as { last_event_id?: unknown }
                terminal = typeof checkpoint.last_event_id === 'number'
                  && checkpoint.last_event_id <= cursor
              } catch {
                terminal = false
              }
              return
            }
            try {
              const event = JSON.parse(data) as RunEvent
              if (event.seq > cursor) {
                cursor = event.seq
                handler(event)
              }
            } catch { /* malformed events are ignored; status GET is recovery */ }
          })
          if (!terminal) terminal = await this.isTerminalThrough(runId, cursor)
        } catch (error) {
          if (controller.signal.aborted) break
          backendConnectionSupervisor.observeTransportFailure(
            error,
            `${this.baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/events`,
          )
          terminal = await this.isTerminalThrough(runId, cursor)
        }
        if (!terminal && !controller.signal.aborted) await sleep(1000)
      }
      if (terminal && !controller.signal.aborted) onDone?.()
      this.eventSources.delete(controller)
    })()
    return () => {
      controller.abort()
      this.eventSources.delete(controller)
    }
  }

  subscribe(runId: string, handler: RunEventHandler): () => void {
    return this.subscribeEvents(runId, (evt) => {
      const status = runStatusForEvent(evt.type)
      if (!status) return
      handler({
        run_id: evt.run_id ?? runId,
        name: evt.run_id ?? runId,
        workspace_id: '',
        status,
        cores: 0,
        rerun_mode: 'resume',
        labels: {},
        result_file_count: 0,
        event_seq_last: evt.seq ?? 0,
        created_at: evt.timestamp ?? '',
      })
    })
  }

  /** Poll-based fallback. Returns unsubscribe function. */
  poll(runId: string, handler: RunEventHandler, intervalMs = 2000): () => void {
    let active = true
    const loop = async () => {
      while (active) {
        try {
          const run = await this.status(runId)
          if (!active) return
          if (run) handler(run)
          if (TERMINAL_STATUSES.has(run.status)) { active = false; return }
        } catch { /* continue */ }
        await sleep(intervalMs)
      }
    }
    loop()
    return () => { active = false }
  }

  disconnect() {
    for (const controller of this.eventSources) controller.abort()
    this.eventSources.clear()
  }

  private async isTerminalThrough(runId: string, cursor: number): Promise<boolean> {
    try {
      const current = await this.status(runId)
      return TERMINAL_STATUSES.has(current.status) && current.event_seq_last <= cursor
    } catch {
      return false
    }
  }

  private async get(path: string, params?: Record<string, unknown>, timeoutMs?: number) {
    const qs = params ? '?' + new URLSearchParams(
      Object.entries(params).flatMap(([key, value]) =>
        Array.isArray(value) ? value.map(item => [key, String(item)]) : [[key, String(value)]],
      )
    ).toString() : ''
    const r = await this.authFetch(
      `${this.baseUrl}${path}${qs}`,
      () => ({ headers: this.headers() }),
      timeoutMs ?? 15_000,
    )
    if (!r.ok) await throwBackendFailure(r, `GET ${path}`)
    return r.json()
  }

  private async post(
    path: string,
    body?: unknown,
    actor: 'user' | 'ai' = 'user',
    timeoutMs = 30_000,
  ) {
    const r = await this.authFetch(`${this.baseUrl}${path}`, () => ({
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json', 'X-TDEase-Actor': actor }),
      body: body ? JSON.stringify(body) : undefined,
    }), timeoutMs)
    if (!r.ok) await throwBackendFailure(r, `POST ${path}`)
    return r.json()
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
      ...extra,
    }
  }

  /**
   * Re-fetch the launch connection and adopt its token, returning whether the
   * token actually changed. Tokens are per-launch: a Backend restart (splash
   * retry, in-process restart) mints a fresh pair, and a client holding the
   * dead token sees 401 on every authenticated call while health probes
   * (public paths) still read "online". The desktop bridge's connection()
   * awaits the current start chain, so after any restart it hands back the
   * new tokens.
   */
  private async refreshLaunchToken(): Promise<boolean> {
    const bridge = (globalThis as { tdeaseDesktop?: TDEaseDesktop }).tdeaseDesktop?.backend
    if (!bridge) return false
    const connection = await bridge.connection()
    if (!connection?.baseUrl) return false
    const baseUrl = connection.baseUrl.replace(/\/$/, '')
    if (connection.accessToken === this.accessToken && baseUrl === this.baseUrl) return false
    this.baseUrl = baseUrl
    this.accessToken = connection.accessToken ?? null
    return true
  }

  /**
   * monitoredBackendFetch with one-shot launch-token recovery: on a 401 whose
   * re-handshake yields a DIFFERENT token, rebuild the request once with the
   * fresh credentials. A 401 with an unchanged token is a real rejection and
   * surfaces untouched — this never loops or hammers the bridge.
   */
  private async authFetch(url: string, build: () => RequestInit, timeoutMs = 15_000): Promise<Response> {
    let response = await monitoredBackendFetch(url, build(), timeoutMs)
    if (response.status === 401 && await this.refreshLaunchToken()) {
      response = await monitoredBackendFetch(url, build(), timeoutMs)
    }
    return response
  }

  private toCommit(plan: CommitPlan) {
    return {
      run_id: plan.runId, idempotency_key: plan.idempotencyKey, workspace_id: plan.workspaceId,
      workspace_tree_hash: plan.workspaceTreeHash, workspace_files: plan.workspaceFiles,
      local_root_id: plan.localRootId ?? null, local_run_path: plan.localRunPath ?? null,
      workspace_run_path: plan.workspaceRunPath ?? null,
      snakefile: plan.snakefile,
      config: plan.config,
      // `cores`/`memory_mb` are deliberately absent: the compute envelope is
      // Backend-owned -- runs_v2 rejects a caller-declared value outright
      // (RUN_MODE_MISMATCH) and injects its own startup budget at commit.
      // `mode` is deliberately absent -- see the note in `submit`.
      targets: plan.targets, user_id: 'desktop', nodes: plan.nodes,
      labels: { name: plan.workspaceRunPath?.split('/').at(-1) ?? plan.runId },
      // Optional semantic metadata. Without it, the Backend derives neutral
      // Published Results from Snakemake default targets.
      ...(plan.resultSpecs?.length ? { result_specs: plan.resultSpecs } : {}),
    }
  }
}


let defaultClient: TDEaseClient | null = null

export function getTDEaseClient(): TDEaseClient {
  if (!defaultClient) defaultClient = new TDEaseClient()
  return defaultClient
}

export function setTDEaseBaseUrl(url: string, accessToken: string | null = null) {
  defaultClient = new TDEaseClient(url, accessToken)
}

export async function initializeTDEaseClient(): Promise<void> {
  const bridge = (globalThis as { tdeaseDesktop?: TDEaseDesktop }).tdeaseDesktop?.backend
  if (!bridge) return
  const connection = await bridge.connection()
  if (!connection?.baseUrl) throw new Error('Desktop backend connection is unavailable')
  defaultClient = new TDEaseClient(connection.baseUrl, connection.accessToken)
}


function defaultBaseUrl(): string {
  // Precedence: the desktop bridge and stored settings replace the whole
  // client (initializeTDEaseClient()/setTDEaseBaseUrl()) and always win; next
  // is the runtime config injected by public/env-config.js — rewritten per
  // deployment by docker-entrypoint.sh — so Docker can repoint the API; the
  // desktop-local default is last. The value is untyped runtime input from a
  // shell-written file, hence the shape check before trusting it. Inlined
  // type (not the global.d.ts declaration): this module also typechecks
  // under tsconfig.electron.json, whose include graph never sees src/*.d.ts.
  const configured = typeof window === 'undefined'
    ? undefined
    : (window as { __RUNTIME_CONFIG__?: { VITE_API_BASE_URL?: string } }).__RUNTIME_CONFIG__?.VITE_API_BASE_URL
  if (typeof configured === 'string' && /^https?:\/\//i.test(configured)) return configured
  // Keeping the shared client free of import.meta lets the same module bundle
  // into Electron main CJS.
  return 'http://127.0.0.1:8000'
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function consumeSse(response: Response, onEvent: (eventName: string, data: string) => void): Promise<void> {
  if (!response.body) throw new Error('SSE response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      let eventName = 'message'
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      }
      if (data.length) onEvent(eventName, data.join('\n'))
      boundary = buffer.indexOf('\n\n')
    }
    if (done) break
  }
}
