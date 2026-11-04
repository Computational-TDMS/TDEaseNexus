import { beforeEach, describe, expect, it, vi } from 'vitest'

const currentClient = vi.hoisted(() => ({ value: {} as object }))

vi.mock('./backend', () => ({
  getTDEaseClient: () => currentClient.value,
}))

import {
  createStudioInfrastructure,
  studioInfrastructure,
  studioInfrastructureFor,
} from './studioInfrastructure'
import type { TDEaseClient } from './backend'

const asClient = (value: object) => value as unknown as TDEaseClient

describe('studioInfrastructure', () => {
  beforeEach(() => {
    currentClient.value = {}
  })

  it('shares one reading gateway rather than handing each caller its own', () => {
    const infrastructure = createStudioInfrastructure(asClient({}))
    expect(infrastructure.gateway).toBe(infrastructure.gateway)
  })

  it('shares one subscription multiplexer per client', () => {
    const infrastructure = createStudioInfrastructure(asClient({}))
    expect(infrastructure.runSubscriptions).toBe(infrastructure.runSubscriptions)
  })

  it('shares one Run projection between Agent submission and visible surfaces', () => {
    const infrastructure = createStudioInfrastructure(asClient({}))
    expect(infrastructure.runRepository).toBe(infrastructure.runRepository)
  })

  it('memoizes an agent gateway per Workspace root, and keeps roots apart', () => {
    const infrastructure = createStudioInfrastructure(asClient({}))
    const first = infrastructure.agentGateway('C:/work/alpha')
    expect(infrastructure.agentGateway('C:/work/alpha')).toBe(first)
    expect(infrastructure.agentGateway('C:/work/beta')).not.toBe(first)
  })

  it('refuses an agent gateway with no trusted Workspace root', () => {
    const infrastructure = createStudioInfrastructure(asClient({}))
    // Failing at assembly beats failing during materialization at submit time,
    // after the user has already built a plan.
    expect(() => infrastructure.agentGateway('')).toThrow(/trusted Workspace root/)
  })

  it('does not attribute agent work to the user, or vice versa', () => {
    const infrastructure = createStudioInfrastructure(asClient({}))
    // Distinct objects is the observable consequence of distinct actor
    // attribution; the actor itself is private to the gateway.
    expect(infrastructure.agentGateway('C:/work/alpha')).not.toBe(infrastructure.gateway)
  })

  it('builds a Published Result cache over the supplied storages', () => {
    const infrastructure = createStudioInfrastructure(asClient({}))
    const storage = {
      digest: async () => undefined,
      read: async () => new Blob(),
      writeAtomic: async () => {},
      remove: async () => {},
    }
    const cache = infrastructure.resultCache(storage, storage)
    expect(typeof cache.open).toBe('function')
    expect(typeof cache.availability).toBe('function')
    expect(typeof cache.materialize).toBe('function')
    expect(typeof cache.evict).toBe('function')
  })

  it('reuses infrastructure for the same client instance', () => {
    const client = asClient({})
    expect(studioInfrastructureFor(client)).toBe(studioInfrastructureFor(client))
  })

  /**
   * The invariant this module exists for. `initializeTDEaseClient()` replaces
   * the client singleton once Electron resolves the real base URL and access
   * token; anything memoized against the previous instance would keep talking
   * to the default URL with no token. Keying on the instance makes that
   * invalidation automatic instead of a thing five call sites must remember.
   */
  it('hands out fresh infrastructure when the client is swapped', () => {
    const before = studioInfrastructure()
    expect(studioInfrastructure()).toBe(before)

    currentClient.value = {}

    const after = studioInfrastructure()
    expect(after).not.toBe(before)
    expect(after.client).not.toBe(before.client)
    expect(after.gateway).not.toBe(before.gateway)
    expect(after.runSubscriptions).not.toBe(before.runSubscriptions)
    expect(after.runRepository).not.toBe(before.runRepository)
  })
})
