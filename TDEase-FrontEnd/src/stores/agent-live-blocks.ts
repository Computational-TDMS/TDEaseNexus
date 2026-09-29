/**
 * The agent store's live-blocks slice: incremental message and ContentBlock
 * assembly while a turn streams — the text/thinking/tool_group/permission
 * folds that `useAgentTurn` applies per runtime event, plus the compaction
 * divider appended at settle time. History that arrives already settled goes
 * through the metadata slice's `replaceSessionProjection` instead.
 *
 * The slice resolves sessions through the metadata slice's `sessionOf`
 * (injected, see agent.ts) — a stream keeps writing to its own session even
 * after the user switches the active view.
 */

import type {
  AgentChatMessage,
  ContentBlock,
  ToolCall,
  ThinkingBlock,
  ToolGroupBlock,
  TextBlock,
  PermissionBlock,
} from './chat-types'
import type { SessionEvent } from '@/agent/events'
import type { AgentSession } from './agent-session-meta'
import { nextId } from './agent-id'

export function createLiveBlocksSlice(
  sessionOf: (sessionId: string) => AgentSession | undefined,
) {
  // ── Messages ──

  function addMessage(sessionId: string, role: AgentChatMessage['role'], content = ''): AgentChatMessage {
    const session = sessionOf(sessionId)
    if (!session) throw new Error(`No agent session: ${sessionId}`)
    const msg: AgentChatMessage = {
      id: nextId('msg'),
      role,
      ...(role === 'user' ? { content } : { blocks: [] }),
    }
    session.messages.push(msg)
    session.updatedAt = Date.now()
    if (role === 'user' && session.untitled) {
      const name = content.slice(0, 24)
      if (name) {
        session.title = name
        session.untitled = false
      }
      // Empty content leaves the session untitled; the i18n placeholder still shows.
    }
    return msg
  }

  function findMessage(sessionId: string, id: string): AgentChatMessage | undefined {
    return sessionOf(sessionId)?.messages.find(m => m.id === id)
  }

  /**
   * Append the settled `context.compacted` event as its own divider message,
   * mirroring `project.ts`'s replay shape EXACTLY (same message id
   * `event:<seq>`, same block fields) so the settle-time re-projection is an
   * id-for-id swap, not a remove-and-readd. The live path otherwise showed no
   * divider until the next reload: the context gauge would drop while the
   * transcript carried no explanation.
   */
  function appendCompactionDivider(sessionId: string, event: Extract<SessionEvent, { type: 'context.compacted' }>): void {
    const session = sessionOf(sessionId)
    if (!session) return
    session.messages.push({
      id: `event:${event.seq}`,
      role: 'assistant',
      blocks: [{
        type: 'compaction',
        id: `event:${event.seq}`,
        reason: event.reason,
        ...(event.tokens_before !== undefined ? { tokensBefore: event.tokens_before } : {}),
        ...(event.tokens_after !== undefined ? { tokensAfter: event.tokens_after } : {}),
      }],
    })
  }

  /** Ensure the message has a blocks array (assistant messages). */
  function ensureBlocks(msg: AgentChatMessage): ContentBlock[] {
    if (!msg.blocks) msg.blocks = []
    return msg.blocks
  }

  // ── TextDecorator block assembly (chronological: blocks stay where they arrived) ──

  /** Append text to the last text block of the message, creating one if absent. */
  function appendText(sessionId: string, messageId: string, delta: string): void {
    const msg = findMessage(sessionId, messageId)
    if (!msg) return
    const blocks = ensureBlocks(msg)
    const last = blocks[blocks.length - 1]
    if (!last || last.type !== 'text') {
      const textBlock: TextBlock = { type: 'text', id: nextId('blk'), text: delta }
      blocks.push(textBlock)
      return
    }
    last.text += delta
  }

  /** Append thinking text; create/open a thinking block if none is open. */
  function appendThinking(sessionId: string, messageId: string, delta: string): void {
    const msg = findMessage(sessionId, messageId)
    if (!msg) return
    const blocks = ensureBlocks(msg)
    const last = blocks[blocks.length - 1]
    let thinking = last?.type === 'thinking' && !(last as ThinkingBlock).sealed
      ? last as ThinkingBlock
      : undefined
    if (!thinking) {
      // Chronological placement: a reasoning step belongs where it happened,
      // next to the tool calls it produced — not pinned to the top of the act.
      thinking = { type: 'thinking', id: nextId('blk'), text: '', sealed: false }
      blocks.push(thinking)
    }
    if (!thinkingStarts.has(thinking.id)) thinkingStarts.set(thinking.id, Date.now())
    thinking.text += delta
  }

  /**
   * Wall-clock anchors for OPEN thinking blocks (id → first-delta time). The
   * seal stamps the span onto the block so the live transcript shows the
   * duration the moment reasoning ends; the settle re-projection replaces the
   * block with the event-log record carrying the collector's own
   * `duration_ms` (nearly identical). Keyed by id because reactive proxies
   * would defeat a WeakMap on the block objects.
   */
  const thinkingStarts = new Map<string, number>()

  /** Seal the open thinking block (model finished emitting reasoning). */
  function sealThinking(sessionId: string, messageId: string): void {
    const msg = findMessage(sessionId, messageId)
    if (!msg) return
    const thinking = msg.blocks?.find(b => b.type === 'thinking' && !(b as ThinkingBlock).sealed) as ThinkingBlock | undefined
    if (!thinking) return
    thinking.sealed = true
    const startedAt = thinkingStarts.get(thinking.id)
    if (startedAt !== undefined) {
      thinking.durationMs = Math.max(0, Date.now() - startedAt)
      thinkingStarts.delete(thinking.id)
    }
  }

  /**
   * Upsert a tool into the message. An existing call is patched wherever it
   * lives (its completion may arrive after later text). A NEW call joins the
   * current tool_group — the last block when it is a tool group (consecutive
   * calls share one fold), else a fresh group appended at the end — so each
   * call appears at the position it was issued.
   *
   * `groupId` pins the id a FRESH group is minted with: callers pass the
   * committed `tool.requested` event's `event:<seq>` so the live group id
   * matches what the replay projection will mint for the same group
   * (`project.ts`'s `toolGroupFor` names the group after its first tool's
   * seq). Without this, every group id changed `blk-N` → `event:<seq>` at the
   * settle swap and the transcript-wide fold map dropped the user's
   * expansion at that instant.
   */
  function upsertTool(sessionId: string, messageId: string, tool: Partial<ToolCall> & { id: string }, groupId?: string): void {
    const msg = findMessage(sessionId, messageId)
    if (!msg) return
    const blocks = ensureBlocks(msg)
    for (const block of blocks) {
      if (block.type !== 'tool_group') continue
      const existing = (block as ToolGroupBlock).tools.find(t => t.id === tool.id)
      if (existing) {
        // Merge the patch: only keys the patch supplies are overwritten, so a
        // completion patch (id + status) cannot clobber the name/args an
        // earlier requested patch set. Symmetric with StreamBuffer.upsertTool.
        Object.assign(existing, tool)
        return
      }
    }
    const last = blocks[blocks.length - 1]
    let group = last?.type === 'tool_group' ? last as ToolGroupBlock : undefined
    if (!group) {
      group = { type: 'tool_group', id: groupId ?? nextId('blk'), tools: [] }
      blocks.push(group)
    }
    // A brand-new tool arrives only from `tool.requested`, which always carries
    // a full ToolCall; the patch type is widened only so completion patches can
    // flow through the same entry point.
    group.tools.push(tool as ToolCall)
  }

  /** Patch a tool by id, searching every tool_group in the message. */
  function patchTool(sessionId: string, messageId: string, toolId: string, patch: Partial<ToolCall>): void {
    const msg = findMessage(sessionId, messageId)
    if (!msg) return
    for (const block of msg.blocks ?? []) {
      if (block.type !== 'tool_group') continue
      const tool = (block as ToolGroupBlock).tools.find(t => t.id === toolId)
      if (tool) {
        Object.assign(tool, patch)
        return
      }
    }
  }

  /** Push a rich block (e.g. permission) onto the message. */
  function pushBlock(sessionId: string, messageId: string, block: ContentBlock): void {
    const msg = findMessage(sessionId, messageId)
    if (!msg) return
    ensureBlocks(msg).push(block)
  }

  /** Update a permission block's status by id. */
  function patchPermission(sessionId: string, messageId: string, blockId: string, status: PermissionBlock['status']): void {
    const msg = findMessage(sessionId, messageId)
    if (!msg) return
    const perm = msg.blocks?.find(b => b.type === 'permission' && b.id === blockId) as PermissionBlock | undefined
    if (perm) perm.status = status
  }

  return {
    addMessage,
    findMessage,
    appendCompactionDivider,
    appendText,
    appendThinking,
    sealThinking,
    upsertTool,
    patchTool,
    pushBlock,
    patchPermission,
  }
}
