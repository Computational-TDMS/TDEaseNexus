/**
 * The capability document, end to end.
 *
 * This mechanism was inert in three independent ways at once: nothing called
 * `capabilities()`, the implementation returned a hardcoded all-`false`
 * constant instead of asking, and that constant carried a `discovery` field the
 * Backend has no concept of. Capability flags are now an explicit Backend
 * registry, so the Client must consume that registry instead of inventing its
 * own feature defaults.
 *
 * These tests pin the shape against `app/api/capabilities.py`. If the Backend
 * document changes, the fixture below is what should fail first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TDEaseBackendGateway } from './studioBackendGateway'
import { TDEaseClient } from './backend'
import type { CapabilitiesDocument } from './client-contracts'

/** Field for field what `build_capabilities()` returns today. */
const document: CapabilitiesDocument = {
  protocol_version: 3,
  auth: { scheme: 'bearer', bootstrap: 'desktop' },
  materialization: { strategies: ['local_workspace_hardlink'] },
  limits: {
    max_cores: 256,
    max_memory_mb: 24576,
    total_logical_cpus: 256,
    reserved_service_cpus: 4,
    total_memory_mb: 32768,
    reserved_service_memory_mb: 8192,
    max_concurrent_runs: 1,
    dry_run_timeout_seconds: 300,
    log_tail_default_lines: 200,
    log_tail_max_lines: 10000,
  },
  engine: { name: 'snakemake', version: '8.0.0', execution_profile: 'desktop-local' },
  features: {
    run_definition: false,
    published_results: true,
    native_dry_run_projection: true,
    mutable_run_title: false,
    cursor_logs: false,
  },
  multi_user: false,
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(document), {
    status: 200, headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function gateway() {
  return new TDEaseBackendGateway(new TDEaseClient('http://backend'))
}

describe('the Backend capability document', () => {
  it('is actually fetched, not assumed', async () => {
    await gateway().capabilities()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/capabilities')
  })

  it('is requested without a bearer header, because it is what tells you how to authenticate', async () => {
    await new TDEaseBackendGateway(new TDEaseClient('http://backend', 'secret-token')).capabilities()
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined
    const headers = new Headers(init?.headers ?? {})
    expect(headers.has('Authorization')).toBe(false)
  })

  it('reports what the Backend actually says about Published Results', async () => {
    const capabilities = await gateway().capabilities()
    // The Backend registry advertises only implemented public behaviour; the
    // Client used to hardcode false and hide a panel the Backend can fill.
    expect(capabilities.features.publishedResults).toBe(true)
    expect(capabilities.features.runDefinition).toBe(false)
    expect(capabilities.features.nativeDryRunProjection).toBe(true)
  })

  it('carries the rest of the document, not just the feature flags', async () => {
    const capabilities = await gateway().capabilities()
    expect(capabilities.protocolVersion).toBe(3)
    expect(capabilities.auth).toEqual({ scheme: 'bearer', bootstrap: 'desktop' })
    expect(capabilities.materializationStrategies).toEqual(['local_workspace_hardlink'])
    expect(capabilities.limits.maxCores).toBe(256)
    expect(capabilities.limits.maxMemoryMb).toBe(24576)
    expect(capabilities.limits.maxConcurrentRuns).toBe(1)
    expect(capabilities.limits.logTailMaxLines).toBe(10000)
    expect(capabilities.engine.executionProfile).toBe('desktop-local')
    expect(capabilities.multiUser).toBe(false)
  })

  it('asks once per gateway', async () => {
    const subject = gateway()
    await Promise.all([subject.capabilities(), subject.capabilities()])
    await subject.capabilities()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('has no field the Backend does not send', async () => {
    const capabilities = await gateway().capabilities()
    // `discovery` was invented client-side and never existed on the Backend.
    expect(capabilities).not.toHaveProperty('discovery')
    expect(Object.keys(capabilities).sort()).toEqual([
      'auth', 'engine', 'features', 'limits', 'materializationStrategies', 'multiUser', 'protocolVersion',
    ])
  })
})
