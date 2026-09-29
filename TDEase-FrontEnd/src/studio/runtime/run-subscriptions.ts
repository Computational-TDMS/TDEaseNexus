import type { RunId } from '../domain/identity'
import type { RunEvent } from '../domain/run'
import type { BackendGateway, Unsubscribe } from '../ports/backend-gateway'

interface Subscription {
  listeners: Set<(event: RunEvent) => void>
  doneListeners: Set<() => void>
  stop: Unsubscribe
}

export class RunSubscriptions {
  private readonly subscriptions = new Map<RunId, Subscription>()

  constructor(private readonly backend: BackendGateway) {}

  subscribe(
    runId: RunId,
    afterSeq: number,
    listener: (event: RunEvent) => void,
    onDone?: () => void,
  ): Unsubscribe {
    let subscription = this.subscriptions.get(runId)
    if (!subscription) {
      subscription = {
        listeners: new Set([listener]),
        doneListeners: new Set(onDone ? [onDone] : []),
        stop: () => {},
      }
      this.subscriptions.set(runId, subscription)
      const created = subscription
      created.stop = this.backend.subscribeRun(
        runId,
        afterSeq,
        (event) => {
          for (const current of created.listeners) current(event)
        },
        () => this.finish(runId, created),
      )
    } else {
      subscription.listeners.add(listener)
      if (onDone) subscription.doneListeners.add(onDone)
    }
    const subscribed = subscription
    return () => {
      const current = this.subscriptions.get(runId)
      if (current !== subscribed) return
      current.listeners.delete(listener)
      if (onDone) current.doneListeners.delete(onDone)
      if (current.listeners.size === 0) {
        current.stop()
        this.subscriptions.delete(runId)
      }
    }
  }

  has(runId: RunId): boolean { return this.subscriptions.has(runId) }

  private finish(runId: RunId, subscription: Subscription): void {
    if (this.subscriptions.get(runId) !== subscription) return
    this.subscriptions.delete(runId)
    const doneListeners = [...subscription.doneListeners]
    subscription.listeners.clear()
    subscription.doneListeners.clear()
    for (const listener of doneListeners) listener()
  }

  dispose(): void {
    for (const subscription of this.subscriptions.values()) subscription.stop()
    this.subscriptions.clear()
  }
}
