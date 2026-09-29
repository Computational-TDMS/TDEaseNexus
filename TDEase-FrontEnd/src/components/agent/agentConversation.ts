// agentConversation — the ONE conversation controller for the Agent surface.
//
// The full AgentPage and the Workbench's right sidebar (AgentSidebar) are two
// views of the same conversation: one turn runtime, one draft, one slash
// registry. This module holds that controller as a lazy singleton so both
// hosts destructure the same refs — typing in either composer writes the same
// draft, and either send routes through the same `turn`. There is still
// exactly one runtime and one approval surface (PermissionCardDock stays on
// the full page); the sidebar is an input, not a second host.
//
// The turn state itself already lives on the agent store per session (see
// useAgentTurn §64-73); subscriptions are keyed by session id and idempotent,
// so a single shared instance is the shape the design already anticipates.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'

import { useWorkspaceStore } from '@/stores/workspace'
import { useSettingsStore } from '@/stores/settings'
import { useAgentStore } from '@/stores/agent'
import { useAgentTabsStore } from '@/stores/agentTabs'
import {
  desktopConversationBridge,
  desktopWorkspaceBridge,
  listEnabledLocalMcpServers,
} from '@/services/desktop/desktopBridge'
import { desktopWorkspaceTextBridge } from '@/services/agent/agentSessionStorage'
import { asRelativePath, asWorkspaceId } from '@/studio/domain/identity'
import { buildSlashRegistry, findSlashCommand, type SlashCommandDef } from '@/agent/slash/slash-registry'
import { conversationExportHtml, exportConversationFileName } from './conversation-export'
import { useAgentTurn } from './useAgentTurn'
import { useSessionDrafts } from './useSessionDrafts'
import { i18n } from '@/locales'

export interface AgentConversation {
  turn: ReturnType<typeof useAgentTurn>
  composerInput: Ref<string>
  drafts: ReturnType<typeof useSessionDrafts>
  localMcpServers: Ref<string[]>
  refreshLocalMcpServers: () => Promise<void>
  sessionModelLabel: ComputedRef<string>
  slashRegistry: ComputedRef<SlashCommandDef[]>
  dispatchSlash: (name: string, args: string) => void
  sendFromComposer: (message: string) => Promise<void>
  stopTurn: () => void
  dequeuePrompt: (index: number) => void
  requestComposerTextInsert: (text: string, mode?: ComposerInsertMode) => void
}

/** "prepend-if-missing" makes re-triggering idempotent: citing the same
 *  selection twice never stacks a duplicate context block. */
type ComposerInsertMode = 'append' | 'prepend-if-missing'

let singleton: AgentConversation | null = null

export function useAgentConversation(): AgentConversation {
  if (singleton) return singleton

  const t = i18n.global.t
  const agentStore = useAgentStore()
  const settingsStore = useSettingsStore()
  const agentTabsStore = useAgentTabsStore()
  const workspaceStore = useWorkspaceStore()
  const { workspacePath, workspaceId } = storeToRefs(workspaceStore)

  const turn = useAgentTurn({ workspacePath, workspaceId })
  const composerInput = ref('')
  const drafts = useSessionDrafts({
    composerInput,
    activeId: () => agentStore.activeId,
    workspaceId: () => workspaceStore.workspaceId,
  })
  const localMcpServers = ref<string[]>([])

  async function refreshLocalMcpServers(): Promise<void> {
    localMcpServers.value = await listEnabledLocalMcpServers(workspacePath.value)
  }

  // The session bar speaks display names: the provider's catalog label, not
  // its raw id ("DeepSeek / deepseek-v4-flash", never "deepseek/deepseek-v4-flash").
  const sessionModelLabel = computed(() => {
    const displayName = settingsStore.availableProviders().find((p) => p.id === settingsStore.provider)?.displayName
    return `${displayName ?? settingsStore.provider} / ${settingsStore.model}`
  })

  /** The composer's send path: clear the draft, then turn the text. */
  async function sendFromComposer(message: string): Promise<void> {
    const text = message.trim()
    if (!text) return
    // Clear the draft for the session being sent from *immediately* — the
    // debounced persist would otherwise race the empty-string write against a
    // scheduled non-empty one.
    drafts.clearActive()
    composerInput.value = ''
    await turn.send(text, workspaceStore.workspaceId)
  }

  /** /export [pdf|html] — write the active conversation into the Workspace. */
  async function onExportConversation(args = '') {
    const wsId = workspaceStore.workspaceId
    const root = workspacePath.value
    const session = agentStore.active
    if (!wsId || !root || !session) return
    if (session.messages.length === 0) {
      ElMessage.warning(t('agent.export.empty'))
      return
    }
    const pdfMode = args.trim().toLowerCase() === 'pdf'
    const filename = exportConversationFileName(session.title, Date.now())
    const relative = pdfMode ? `exports/${filename.replace(/\.html$/, '.pdf')}` : `exports/${filename}`
    try {
      const html = await conversationExportHtml({
        title: session.title || t('agent.export.untitled'),
        modelLabel: sessionModelLabel.value,
        workspaceName: root.split(/[\\/]/).filter(Boolean).pop(),
        exportedAt: Date.now(),
        messages: session.messages,
      })
      if (pdfMode) {
        const print = desktopConversationBridge()
        const workspace = desktopWorkspaceBridge()
        if (!print || !workspace) throw new Error('PDF export requires the Electron desktop runtime')
        const bytes = await print.printPdf(html)
        await workspace.writeBytesAtomic(root, relative, bytes)
        // The OS default viewer is the right reader for a PDF; failure to open
        // must not fail the export — the file is already on disk.
        void workspace.openExternal(`${root}/${relative}`).catch(() => undefined)
      } else {
        await desktopWorkspaceTextBridge().writeTextAtomic(root, relative, html)
        agentTabsStore.open(
          { kind: 'agent-file', workspaceId: asWorkspaceId(wsId), path: asRelativePath(relative) },
          { title: filename },
        )
      }
    } catch (error) {
      ElMessage.error(t('agent.export.failed', { message: error instanceof Error ? error.message : String(error) }))
    }
  }

  // The one canonical slash-command list, shared by the Composer's picker and
  // the menu button; dispatch below is a table lookup against the same list, so
  // a command cannot be advertised without being runnable.
  const slashRegistry = computed(() => buildSlashRegistry(t, {
    newSession: () => agentStore.createSession(),
    fork: () => turn.fork().then(() => undefined),
    stop: () => turn.stop(),
    // compact() surfaces its own failure through the session state pill and its
    // success through the transcript divider; the catch only keeps the rejected
    // promise from becoming unhandled-rejection noise.
    compact: () => turn.compact().catch(() => undefined),
    exportConversation: (args) => void onExportConversation(args),
    // TODO: MCP has no @-mention kind yet, so this stays a natural-language
    // request until the mention grammar grows an `mcp` kind.
    useMcp: (name) => {
      if (!name) return
      void sendFromComposer(`Use the local MCP server ${name} for this request.`)
    },
  }))

  function dispatchSlash(name: string, args: string): void {
    findSlashCommand(slashRegistry.value, name)?.run(args)
  }

  function stopTurn(): void {
    turn.stop()
  }

  function dequeuePrompt(index: number): void {
    if (agentStore.active) agentStore.removeQueuedPrompt(agentStore.active.id, index)
  }

  /**
   * Addressable composer (ZCode's requestComposerTextInsert): any surface —
   * the command palette, a slash handler, the side chat — can inject text
   * into the one shared draft without owning or even finding the composer
   * component. The write goes through `composerInput`, so the session-draft
   * persistence and both views' bindings see it like any keystroke.
   */
  function requestComposerTextInsert(text: string, mode: ComposerInsertMode = 'append'): void {
    const value = text.trim()
    if (!value) return
    if (mode === 'prepend-if-missing') {
      if (composerInput.value.includes(value)) return
      composerInput.value = composerInput.value ? `${value}\n${composerInput.value}` : value
      return
    }
    composerInput.value = composerInput.value ? `${composerInput.value}\n${value}` : value
  }

  const instance: AgentConversation = {
    turn,
    composerInput,
    drafts,
    localMcpServers,
    refreshLocalMcpServers,
    sessionModelLabel,
    slashRegistry,
    dispatchSlash,
    sendFromComposer,
    stopTurn,
    dequeuePrompt,
    requestComposerTextInsert,
  }
  singleton = instance
  return instance
}
