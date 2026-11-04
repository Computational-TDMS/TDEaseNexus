/**
 * agentView — the renderer half of `view.*` (contracts/view-runtime.ts).
 *
 * Receives the Agent's viewer commands and turns them into the same Workbench
 * actions a user performs: open a Workspace file, move a viewer, select an
 * ion. Three pieces of view state live here, and nothing else:
 *
 *   - `openedBy`: which open documents the Agent opened (the tab badge);
 *   - `unseen`: Agent opens the user has not looked at yet (Follow off);
 *   - `directives`: the latest focus/select per Workspace path, with a
 *     sequence number, which viewers consume the way they consume a click.
 *
 * Follow agent (settings) decides focus: on → the tab takes focus (in the
 * preview slot, so Agent browsing never litters tabs); off → background tab,
 * marked unseen until selected.
 */
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { ViewCommandEnvelope, ViewFocus, ViewSelect } from '@/contracts/view-runtime'
import { desktopAgentViewBridge } from '@/services/desktop/desktopBridge'
import { useDocumentsStore } from './documents'
import { useSettingsStore } from './settings'

export interface ViewDirective {
  seq: number
  focus?: ViewFocus
  select?: ViewSelect
  /** The Agent's viewer hint (e.g. `ms2_discrimination`), when given. */
  viewer?: string
}

export const useAgentViewStore = defineStore('agentView', () => {
  const documents = useDocumentsStore()
  const settings = useSettingsStore()

  const openedBy = ref<Record<string, { sessionId: string; at: number }>>({})
  const unseen = ref<ReadonlySet<string>>(new Set())
  const directives = ref<Record<string, ViewDirective>>({})
  let seq = 0
  let unsubscribe: (() => void) | null = null

  function directiveFor(path: string): ViewDirective | undefined {
    return directives.value[path.replace(/\\/g, '/')]
  }

  function apply(envelope: ViewCommandEnvelope): void {
    const { command } = envelope
    const follow = settings.followAgent
    const id = documents.openWorkspaceFile(command.path, { preview: true, background: !follow })
    openedBy.value = { ...openedBy.value, [id]: { sessionId: envelope.sessionId, at: envelope.issuedAt } }
    if (!follow && documents.activeDocumentId !== id) unseen.value = new Set([...unseen.value, id])

    const focus = command.op === 'select' ? undefined : command.focus
    const select = command.op === 'focus' ? undefined : command.select
    const viewer = command.op === 'open' ? command.viewer : undefined
    if (focus || select || viewer) {
      const previous = directives.value[command.path]
      directives.value = {
        ...directives.value,
        // A focus keeps the standing selection and vice versa — the Agent
        // zooming does not clear what it selected a moment ago.
        [command.path]: {
          seq: ++seq,
          focus: focus ?? previous?.focus,
          select: select ?? previous?.select,
          viewer: viewer ?? previous?.viewer,
        },
      }
    }
  }

  /** Subscribe once per window (AppShell setup). Safe outside Electron. */
  function start(): void {
    if (unsubscribe) return
    const bridge = desktopAgentViewBridge()
    if (!bridge) return
    unsubscribe = bridge.onCommand(apply)
  }

  // Looking at an Agent-opened tab clears its unseen marker.
  watch(() => documents.activeDocumentId, (id) => {
    if (id && unseen.value.has(id)) {
      const next = new Set(unseen.value)
      next.delete(id)
      unseen.value = next
    }
  })

  return { openedBy, unseen, directives, directiveFor, apply, start }
})
