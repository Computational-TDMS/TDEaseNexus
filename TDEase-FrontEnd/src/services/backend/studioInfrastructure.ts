/**
 * The composition root for everything derived from a `TDEaseClient`.
 *
 * Before this module existed, `new TDEaseBackendGateway(...)` appeared in five
 * places (`stores/runs.ts`, `stores/documents.ts`, `services/permissionMode.ts`,
 * `services/studioRunInfrastructure.ts`, `services/studioBackendGateway.ts`)
 * and each one re-decided three things on its own: which client to bind to,
 * which actor to attribute Backend calls to, and whether the resulting gateway
 * was allowed to submit. Those decisions are not local -- getting any of them
 * wrong is silent -- so they live here instead.
 *
 * ## Why the memo is keyed by the client instance
 *
 * `getTDEaseClient()` returns a *swappable* singleton: `initializeTDEaseClient()`
 * replaces it once Electron resolves the real base URL and access token, and
 * `setTDEaseBaseUrl()` replaces it again on demand. Anything cached against the
 * pre-swap client would keep talking to `http://127.0.0.1:8000` with no token.
 *
 * Keying the memo on the client instance makes that invalidation automatic: a
 * swapped client is a different key, so it gets fresh infrastructure and the old
 * graph becomes garbage. This generalizes the `WeakMap`-per-client trick that
 * `sharedRunSubscriptions` already used for exactly this reason.
 *
 * Note that today the swap also happens to be ordered safely -- `src/main.ts`
 * awaits `useSettingsStore().connectBackend()` (the IPC → `setTDEaseBaseUrl` →
 * supervisor.connect chain) before `app.mount()`, so no component observes the
 * pre-swap default `http://127.0.0.1:8000` client. That ordering is
 * load-bearing and lives in a single line far from every consumer; the keying
 * here is what keeps this module correct if it ever moves.
 *
 * ## Why there are two gateways, not one
 *
 * `TDEaseBackendGateway` takes an `actor` and an optional Workspace root, and the
 * pair is not free: local materialization requires that trusted root. A
 * default-constructed gateway can therefore read the
 * Backend but *cannot* submit -- a partially-functional object whose missing
 * half only shows up at run time.
 *
 * So this module offers the split explicitly:
 *
 * - `gateway` -- attributed to `'user'`, for reading (Runs, files, results).
 * - `agentGateway(workspaceRoot)` -- attributed to `'ai'` and bound to a trusted
 *   Workspace root, which is the only shape that can commit an analysis.
 *
 * Asking for a submitting gateway now requires producing the root, at the call
 * site, in the type system.
 */

import { getTDEaseClient, type TDEaseClient } from './backend'
import { TDEaseBackendGateway } from './studioBackendGateway'
import { createPublishedResultCache, type ResultCacheStorage } from '../storage/studioResultCache'
import { RunSubscriptions } from '@/studio/runtime/run-subscriptions'
import { RunRepository } from '@/studio/runtime/run-repository'
import type { BackendGateway } from '@/studio/ports/backend-gateway'
import type { ResultCache } from '@/studio/ports/result-cache'
import type { TDEaseDesktop } from '@/services/desktop/desktopBridge'

export interface StudioInfrastructure {
  /** The client every member below is bound to. */
  readonly client: TDEaseClient

  /**
   * The reading gateway, attributed to `'user'`. Shared, because it is
   * stateless and callers should not each hold their own.
   */
  readonly gateway: BackendGateway

  /**
   * One event-subscription multiplexer per client, so N Run views share one
   * upstream stream per Run.
   */
  readonly runSubscriptions: RunSubscriptions

  /**
   * The single Run projection for this Backend connection. Agent submission,
   * Navigator, documents and the Activity dock must observe the same object;
   * otherwise a submitted Run can execute successfully while every visible
   * surface remains unaware of it.
   */
  readonly runRepository: RunRepository

  /**
   * A gateway that can commit an analysis: attributed to `'ai'` and bound to a
   * trusted local Workspace root. Memoized per root.
   */
  agentGateway(workspaceRoot: string): BackendGateway
  workspaceGateway(workspaceRoot: string): BackendGateway

  /**
   * A Published Result cache over the two storage backends. The storages are
   * platform-specific (an Electron filesystem store, a browser origin-private
   * store) and are supplied by whoever knows the platform -- this module only
   * knows how to wire them to a gateway.
   */
  resultCache(
    cache: ResultCacheStorage,
    workspace: ResultCacheStorage,
    actor?: 'user' | 'ai',
  ): ResultCache
}

export interface StudioInfrastructureOptions {
  readWorkspaceBlob?: (workspaceRoot: string, relative: string) => Promise<Blob>
}

/**
 * Assemble infrastructure for an explicit client.
 *
 * This is the test seam: pass a fake `TDEaseClient` and the whole graph below
 * it is fake, with no module-level state to reset between tests.
 */
export function createStudioInfrastructure(
  client: TDEaseClient,
  options: StudioInfrastructureOptions = {},
): StudioInfrastructure {
  let gateway: BackendGateway | undefined
  let runSubscriptions: RunSubscriptions | undefined
  let runRepository: RunRepository | undefined
  const agentGateways = new Map<string, BackendGateway>()
  const workspaceGateways = new Map<string, BackendGateway>()

  const infrastructure: StudioInfrastructure = {
    client,

    get gateway(): BackendGateway {
      // Lazy: a session that never touches the Backend never constructs one.
      gateway ??= new TDEaseBackendGateway(client)
      return gateway
    },

    get runSubscriptions(): RunSubscriptions {
      runSubscriptions ??= new RunSubscriptions(infrastructure.gateway)
      return runSubscriptions
    },

    get runRepository(): RunRepository {
      runRepository ??= new RunRepository(infrastructure.gateway, infrastructure.runSubscriptions)
      return runRepository
    },

    agentGateway(workspaceRoot: string): BackendGateway {
      if (!workspaceRoot) {
        // Failing here beats failing during materialization at submit time,
        // after the user has already built a plan.
        throw new Error('An agent gateway requires a trusted Workspace root')
      }
      const existing = agentGateways.get(workspaceRoot)
      if (existing) return existing
      const created = new TDEaseBackendGateway(
        client,
        'ai',
        workspaceRoot,
        options.readWorkspaceBlob
          ? (relative) => options.readWorkspaceBlob!(workspaceRoot, relative)
          : undefined,
      )
      agentGateways.set(workspaceRoot, created)
      return created
    },

    workspaceGateway(workspaceRoot: string): BackendGateway {
      if (!workspaceRoot) throw new Error('A Workspace gateway requires a trusted Workspace root')
      const existing = workspaceGateways.get(workspaceRoot)
      if (existing) return existing
      const created = new TDEaseBackendGateway(
        client,
        'user',
        workspaceRoot,
        options.readWorkspaceBlob
          ? (relative) => options.readWorkspaceBlob!(workspaceRoot, relative)
          : undefined,
      )
      workspaceGateways.set(workspaceRoot, created)
      return created
    },

    resultCache(cache, workspace, actor = 'user'): ResultCache {
      // 'user' reuses the shared reading gateway; 'ai' gets its own attribution
      // but needs no Workspace root, because resolving and fetching a Published
      // Result never submits.
      const backend = actor === 'user'
        ? infrastructure.gateway
        : new TDEaseBackendGateway(client, 'ai')
      return createPublishedResultCache(backend, cache, workspace)
    },
  }

  return infrastructure
}

const byClient = new WeakMap<TDEaseClient, StudioInfrastructure>()

/** Infrastructure for a specific client, shared across all callers holding it. */
export function studioInfrastructureFor(client: TDEaseClient): StudioInfrastructure {
  const existing = byClient.get(client)
  if (existing) return existing
  const created = createStudioInfrastructure(client, {
    readWorkspaceBlob: async (workspaceRoot, relative) => {
      const bridge = (globalThis as { tdeaseDesktop?: TDEaseDesktop }).tdeaseDesktop?.workspace
      if (!bridge) throw new Error('Remote submission requires the Client Workspace byte reader')
      return new Blob([new Uint8Array(await bridge.readBytes(workspaceRoot, relative))])
    },
  })
  byClient.set(client, created)
  return created
}

/**
 * Infrastructure for the client the app is currently bound to.
 *
 * Call this per use rather than caching the result: it is cheap (a `WeakMap`
 * hit), and calling it fresh is what makes a client swap take effect.
 */
export function studioInfrastructure(): StudioInfrastructure {
  return studioInfrastructureFor(getTDEaseClient())
}
