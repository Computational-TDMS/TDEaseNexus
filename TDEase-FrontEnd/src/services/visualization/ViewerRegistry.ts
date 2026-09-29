import type { Component } from 'vue'

import type { ViewerContract, ViewerPortContract } from './viewerContract'
import { assertViewerContract } from './viewerContract'
import { canonicalizeViewerType } from './viewerTypeAliases'

export type {
  ViewerContract,
  ViewerPortContract,
} from './viewerContract'

/** A viewer registration bound to the host framework (Vue). */
export type ViewerRegistration = ViewerContract<Component>

export class ViewerRegistry {
  private readonly viewers = new Map<string, ViewerRegistration>()
  private initialized = false

  list(): readonly ViewerRegistration[] {
    this.ensureInitialized()
    return Array.from(this.viewers.values())
  }

  get(viewerId: string): ViewerRegistration | undefined {
    this.ensureInitialized()
    return this.viewers.get(canonicalizeViewerType(viewerId) ?? viewerId)
  }

  require(viewerId: string): ViewerRegistration {
    const registration = this.get(viewerId)
    if (!registration) throw new Error(`Unknown viewer: ${viewerId}`)
    return registration
  }

  getCanvasPorts(viewerId: string): ViewerPortContract | undefined {
    return this.get(viewerId)?.ports
  }

  compatiblePorts(viewerId: string, kind: string): ReadonlyArray<ViewerPortContract['data'][number]> {
    return this.require(viewerId).ports.data.filter(port => port.accepts.includes(kind))
  }

  viewersAccepting(kind: string): readonly ViewerRegistration[] {
    return this.list().filter(registration =>
      registration.ports.data.some(port => port.accepts.includes(kind)),
    )
  }

  private ensureInitialized(): void {
    if (this.initialized) return
    this.initialized = true

    for (const path of Object.keys(discoveryModules).sort()) {
      const registration = (discoveryModules[path] as { default?: ViewerRegistration }).default
      if (!registration) continue
      assertViewerContract(registration)
      if (this.viewers.has(registration.id)) {
        throw new Error(`Duplicate viewer registration: ${registration.id}`)
      }
      this.viewers.set(registration.id, Object.freeze(registration))
    }
  }
}

const discoveryModules = import.meta.glob(
  '@/services/visualization/registrations/*.ts',
  { eager: true },
)

export const viewerRegistry = new ViewerRegistry()
