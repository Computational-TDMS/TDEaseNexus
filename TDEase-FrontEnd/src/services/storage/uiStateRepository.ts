// localStorage adapter for the UiStateRepository port
// (`@/studio/ports/ui-state-repository`, STUDIO-FRONTEND-BUSINESS-LOGIC.md
// §9.2). The port states the three discardability rules and the guarantees
// below; this file is only the mechanism that keeps them.
//
// Keys are namespaced `tdease.ui.<workspaceId>.<key>`. Every read is
// defensive: a missing or corrupt value returns the fallback and never
// throws. Writes are debounced (~200ms) and coalesced per key.

import type { UiStateRepository } from '@/studio/ports/ui-state-repository'
import { createLogger } from '@/utils/logger'

const log = createLogger('ui-state-repository')

const NAMESPACE_PREFIX = 'tdease.ui.'
const DEBOUNCE_MS = 200

function storageKey(workspaceId: string, key: string): string {
  return `${NAMESPACE_PREFIX}${workspaceId}.${key}`
}

function workspacePrefix(workspaceId: string): string {
  return `${NAMESPACE_PREFIX}${workspaceId}.`
}

export function createLocalUiStateRepository(storage?: Storage): UiStateRepository {
  const backing = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)

  // One pending timer per fully-qualified storage key: a burst of writes to
  // the same key coalesces into the last value; writes to different keys
  // debounce independently.
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function read<T>(workspaceId: string, key: string, fallback: T): T {
    if (!backing) return fallback
    try {
      const raw = backing.getItem(storageKey(workspaceId, key))
      if (raw == null) return fallback
      return JSON.parse(raw) as T
    } catch (error) {
      log.warn(`Failed to read UI state "${key}" for workspace "${workspaceId}"; using fallback.`, error)
      return fallback
    }
  }

  function write<T>(workspaceId: string, key: string, value: T): void {
    if (!backing) return
    const fullKey = storageKey(workspaceId, key)

    const existingTimer = pendingTimers.get(fullKey)
    if (existingTimer != null) {
      clearTimeout(existingTimer)
    }

    const timer = setTimeout(() => {
      pendingTimers.delete(fullKey)
      try {
        backing.setItem(fullKey, JSON.stringify(value))
      } catch (error) {
        log.warn(`Failed to persist UI state "${key}" for workspace "${workspaceId}".`, error)
      }
    }, DEBOUNCE_MS)

    pendingTimers.set(fullKey, timer)
  }

  function clear(workspaceId: string): void {
    if (!backing) return
    const prefix = workspacePrefix(workspaceId)
    try {
      const toRemove: string[] = []
      for (let i = 0; i < backing.length; i++) {
        const k = backing.key(i)
        if (k != null && k.startsWith(prefix)) {
          toRemove.push(k)
        }
      }
      toRemove.forEach((k) => {
        const timer = pendingTimers.get(k)
        if (timer != null) {
          clearTimeout(timer)
          pendingTimers.delete(k)
        }
        backing.removeItem(k)
      })
    } catch (error) {
      log.warn(`Failed to clear UI state for workspace "${workspaceId}".`, error)
    }
  }

  return { read, write, clear }
}
