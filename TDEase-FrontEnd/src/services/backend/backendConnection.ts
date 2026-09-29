import type { CapabilitiesDocument } from './client-contracts'

export type BackendConnectionPhase =
  | 'disabled'
  | 'connecting'
  | 'online'
  | 'degraded'
  | 'upgrading'
  | 'offline'
  | 'reconnecting'
  | 'incompatible'

export interface BackendConnectionSnapshot {
  phase: BackendConnectionPhase
  baseUrl: string
  instanceId: string | null
  generation: string | null
  error: string | null
  attempt: number
  changedAt: number
}

type Listener = (snapshot: BackendConnectionSnapshot) => void

const SUPPORTED_PROTOCOL_VERSION = 3
// Two probe requests per cycle, so 5s ≈ 1.4k requests/hour at idle — fine for
// a desktop-local backend but pure idle traffic; 15s (~480/hour) still detects
// a dropped backend well inside the reconnect backoff window.
const ONLINE_PROBE_MS = 15_000
const MAX_RECONNECT_MS = 30_000

class BackendConnectionSupervisor {
  private listeners = new Set<Listener>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private probe: Promise<BackendConnectionSnapshot> | null = null
  private accessToken: string | null = null
  private targetEpoch = 0
  private snapshot: BackendConnectionSnapshot = {
    phase: 'offline', baseUrl: '', instanceId: null, generation: null,
    error: null, attempt: 0, changedAt: Date.now(),
  }

  current(): BackendConnectionSnapshot {
    return { ...this.snapshot }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.current())
    return () => this.listeners.delete(listener)
  }

  disable(): void {
    this.targetEpoch += 1
    this.stopTimer()
    this.accessToken = null
    this.transition({
      phase: 'disabled', baseUrl: '', instanceId: null, generation: null,
      error: null, attempt: 0,
    })
  }

  async connect(baseUrl: string, accessToken: string | null): Promise<BackendConnectionSnapshot> {
    const targetChanged = this.snapshot.baseUrl !== baseUrl
    this.targetEpoch += 1
    this.probe = null
    this.stopTimer()
    this.accessToken = accessToken
    this.transition({
      phase: this.snapshot.baseUrl === baseUrl && this.snapshot.attempt > 0 ? 'reconnecting' : 'connecting',
      baseUrl,
      ...(targetChanged ? { instanceId: null, generation: null } : {}),
      error: null,
    })
    return this.checkNow()
  }

  observeResponse(response: Response, input?: string | URL): void {
    if (!this.observesCurrentTarget(input) || this.snapshot.phase === 'incompatible') return
    if (response.status === 503) {
      this.transition({ phase: 'upgrading', error: `Backend is not ready (HTTP ${response.status})` })
      this.scheduleReconnect()
      return
    }
    this.transition({ phase: 'online', error: null, attempt: 0 })
    this.schedule(ONLINE_PROBE_MS)
  }

  observeTransportFailure(error: unknown, input?: string | URL): void {
    if (!this.observesCurrentTarget(input) || this.snapshot.phase === 'incompatible') return
    this.transition({
      phase: this.snapshot.phase === 'online' ? 'degraded' : 'offline',
      error: error instanceof Error ? error.message : String(error),
      attempt: this.snapshot.attempt + 1,
    })
    this.scheduleReconnect()
  }

  checkNow(): Promise<BackendConnectionSnapshot> {
    if (this.probe) return this.probe
    const epoch = this.targetEpoch
    const tracked = this.runProbe(epoch).finally(() => {
      if (this.probe === tracked) this.probe = null
    })
    this.probe = tracked
    return tracked
  }

  private async runProbe(epoch: number): Promise<BackendConnectionSnapshot> {
    const baseUrl = this.snapshot.baseUrl
    if (!baseUrl) return this.current()
    try {
      // Both endpoints in one round trip. /ready still owns the failure
      // transition (checked first below, exactly as when the requests were
      // sequential), so a failing request produces the same state transitions.
      const [readyResult, capabilitiesResult] = await Promise.allSettled([
        probeFetch(`${baseUrl}/ready`, this.headers()),
        probeFetch(`${baseUrl}/api/capabilities`, this.headers()),
      ])
      if (epoch !== this.targetEpoch) return this.current()
      if (readyResult.status === 'rejected') throw readyResult.reason
      const ready = readyResult.value
      if (!ready.ok) {
        this.transition({
          phase: ready.status === 503 ? 'upgrading' : 'offline',
          error: `Backend readiness check failed (HTTP ${ready.status})`,
          attempt: this.snapshot.attempt + 1,
        })
        this.scheduleReconnect()
        return this.current()
      }
      const readiness = await readObject(ready)
      if (capabilitiesResult.status === 'rejected') throw capabilitiesResult.reason
      const capabilitiesResponse = capabilitiesResult.value
      if (!capabilitiesResponse.ok) throw new Error(`Backend capabilities check failed (HTTP ${capabilitiesResponse.status})`)
      const capabilities = await capabilitiesResponse.json() as CapabilitiesDocument
      if (capabilities.protocol_version !== SUPPORTED_PROTOCOL_VERSION) {
        this.stopTimer()
        this.transition({
          phase: 'incompatible',
          error: `Backend protocol ${capabilities.protocol_version} is unsupported by this Client`,
        })
        return this.current()
      }
      this.transition({
        phase: 'online',
        instanceId: stringField(readiness, 'instance_id'),
        generation: stringField(readiness, 'generation'),
        error: null,
        attempt: 0,
      })
      this.schedule(ONLINE_PROBE_MS)
    } catch (error) {
      if (epoch !== this.targetEpoch) return this.current()
      this.transition({
        phase: this.snapshot.phase === 'online' ? 'degraded' : 'offline',
        error: error instanceof Error ? error.message : String(error),
        attempt: this.snapshot.attempt + 1,
      })
      this.scheduleReconnect()
    }
    return this.current()
  }

  private headers(): HeadersInit {
    return this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}
  }

  private observesCurrentTarget(input?: string | URL): boolean {
    if (!this.snapshot.baseUrl) return false
    if (input === undefined) return true
    try {
      const target = new URL(this.snapshot.baseUrl)
      const request = new URL(input.toString(), target)
      const targetPath = target.pathname.replace(/\/$/, '')
      return request.origin === target.origin
        && (request.pathname === targetPath || request.pathname.startsWith(`${targetPath}/`))
    } catch {
      return false
    }
  }

  private scheduleReconnect(): void {
    const exponent = Math.min(this.snapshot.attempt, 6)
    const base = Math.min(MAX_RECONNECT_MS, 500 * (2 ** exponent))
    const jitter = Math.floor(Math.random() * Math.max(1, base * 0.2))
    this.schedule(base + jitter)
  }

  private schedule(delay: number): void {
    this.stopTimer()
    if (!this.snapshot.baseUrl || this.snapshot.phase === 'disabled' || this.snapshot.phase === 'incompatible') return
    this.timer = globalThis.setTimeout(() => {
      this.timer = null
      if (this.snapshot.phase !== 'online') this.transition({ phase: 'reconnecting' })
      void this.checkNow()
    }, delay)
  }

  private stopTimer(): void {
    if (this.timer !== null) globalThis.clearTimeout(this.timer)
    this.timer = null
  }

  private transition(patch: Partial<BackendConnectionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, changedAt: Date.now() }
    for (const listener of this.listeners) listener(this.current())
  }
}

export const backendConnectionSupervisor = new BackendConnectionSupervisor()

export async function monitoredBackendFetch(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const externalSignal = init.signal
  const abortFromExternal = () => controller.abort(externalSignal?.reason)
  if (externalSignal?.aborted) abortFromExternal()
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
  const timeout = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('Backend request timed out', 'TimeoutError'))
  }, timeoutMs)
  try {
    const response = await fetch(input, { ...init, signal: controller.signal })
    backendConnectionSupervisor.observeResponse(response, input)
    return response
  } catch (error) {
    if (!externalSignal?.aborted) {
      backendConnectionSupervisor.observeTransportFailure(
        timedOut ? new Error(`Backend request timed out after ${timeoutMs}ms`) : error,
        input,
      )
    }
    throw error
  } finally {
    globalThis.clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abortFromExternal)
  }
}

async function probeFetch(url: string, headers: HeadersInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), 2_500)
  try {
    return await fetch(url, { headers, cache: 'no-store', signal: controller.signal })
  } finally {
    globalThis.clearTimeout(timeout)
  }
}

async function readObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json()
    return value && typeof value === 'object' ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === 'string' && value[key] ? value[key] : null
}
