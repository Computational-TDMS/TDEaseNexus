/**
 * Files store — the renderer projection of files the Agent produced in a
 * session (palot inspector migration, Phase C).
 *
 * Pure frontend projection: NO new IPC. The data already lives in the
 * transcripts — it is derived from the assistant text's Workspace file
 * citations in all four syntaxes the renderer accepts (`![](path)`,
 * `[](path)`, `![[path]]`, `[[path]]`): the same refs MarkdownContent renders
 * inline (images/SVG) or as file cards (everything else). Citations are
 * read from BOTH conversations that make up a session's work: the main
 * session's messages, and each subagent child's own session log (read
 * read-only through the same storage bridge the conversation viewer uses —
 * a child IS a session; its answer is where an analysis run cites its
 * figures, so a main-session-only scan left every child-produced asset
 * uncollected).
 *
 * Dedup by path (first citation wins); grouped by the conversation turn that
 * cited each file — main-session turns numbered in message order, then one
 * group per subagent in spawn order — so the Files tab reads as "which
 * exchange produced this" instead of a flat, confusing pile. The inspector's
 * Files tab and the ActivityCapsule badge read this.
 *
 * First-principles: this store holds NO truth of its own. The transcripts are
 * the truth; this is a read-only, re-derived view.
 */

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useAgentStore } from './agent'
import { useSubagentsStore } from './subagents'
import { useWorkspaceStore } from './workspace'
import {
  HTML_EXTENSIONS,
  IMAGE_EXTENSIONS,
  TABLE_EXTENSIONS,
  TEXT_EXTENSIONS,
  extensionOf,
} from '@/services/visualization/fileTypes'
import { createWorkspaceSessionLog, desktopWorkspaceTextBridge } from '@/services/agent/agentSessionStorage'
import { projectSessionEvents, type SessionEvent } from '@/agent/events'
import type { AgentChatMessage } from './chat-types'
import type { SubagentStatus } from '@/studio/commands/registry'

export type AgentFileKind = 'image' | 'svg' | 'html' | 'table' | 'json' | 'text' | 'file'

export interface AgentFile {
  /** Workspace-relative path, as cited/produced. */
  path: string
  /** basename(path), precomputed for display. */
  name: string
  kind: AgentFileKind
  /** The id of the assistant message that cited it, in its own session. */
  messageId: string
}

/**
 * One producing exchange. Main-session groups are the transcript's turns:
 * `turn` is the 1-based index of the assistant message among assistant
 * messages, `snippet` its first text line (the "what was this about" cue).
 * Subagent groups carry the child's `role` — its whole conversation is one
 * producing unit under the turn that spawned it.
 */
export interface AgentFileGroup {
  /** Stable key: `main:<messageId>` or `sub:<subagentId>`. */
  key: string
  kind: 'turn' | 'subagent'
  turn?: number
  snippet?: string
  role?: string
  files: AgentFile[]
}

/** The single extension vocabulary (fileTypes), with `file` as the honest
 *  fallback for an unknown extension — the renderer cards it, so it collects. */
export function classifyKind(path: string): AgentFileKind {
  const ext = extensionOf(path)
  if (ext === 'svg') return 'svg'
  if (HTML_EXTENSIONS.has(ext)) return 'html'
  if (TABLE_EXTENSIONS.has(ext)) return 'table'
  if (ext === 'json') return 'json'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  return 'file'
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return slash >= 0 ? normalized.slice(slash + 1) : normalized
}

/** Mirror of the renderer's `isWorkspaceRelativeSrc`: absolute and protocol
 *  URLs (http(s):, data:, blob:, …) are browser surfaces, not files. */
function isWorkspaceRelative(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('//')) return false
  return !/^[a-z][a-z0-9+.-]*:/i.test(path)
}

/** A target names a FILE (collectable) only when its basename carries a real
 *  extension. Extensionless targets are wiki page names (`[[TopFD]]`). */
function hasFileExtension(path: string): boolean {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0
}

/** `target#heading|label` → `target` (the part the renderer resolves). */
function wikiTarget(inner: string): string {
  let target = inner
  const pipe = target.lastIndexOf('|')
  if (pipe >= 0) target = target.slice(0, pipe)
  const hash = target.indexOf('#')
  if (hash >= 0) target = target.slice(0, hash)
  return target.trim()
}

/** Strip wrapping quotes/punctuation and leading `./`, and normalize Windows
 *  backslashes to forward slashes. Dedup is by this cleaned key, so the same
 *  figure cited as `results\T10\out.svg` (a bash arg on Windows) and
 *  `results/T10/out.svg` (a markdown ref) collapses to one file. */
function cleanPath(path: string): string {
  let p = path.trim().replace(/^['"`]|['"`]$/g, '')
  if (p.startsWith('./')) p = p.slice(2)
  return p.replaceAll('\\', '/')
}

const MD_LINK_RE = /!?\[[^\]\n]*\]\(([^()\s]+)\)/g
const WIKI_RE = /(!?)\[\[([^\]\n]+)\]\]/g

/**
 * Extract Workspace file paths from a markdown string, in the same four
 * syntaxes the renderer presents. A bare `[[page]]` / `[[page.md]]` / `[[page.txt]]`
 * stays a wiki page link in the renderer, so it is NOT an asset; every other
 * Workspace-relative file citation collects, whatever its extension (an
 * unknown extension renders as the generic file card). Kept deliberately
 * simple — markdown.ts is the authoritative parser; this only needs the
 * *paths*, not a render tree.
 */
function extractCitations(markdown: string): string[] {
  const found: Array<{ at: number; path: string }> = []
  for (const match of markdown.matchAll(WIKI_RE)) {
    const embed = match[1] === '!'
    const target = cleanPath(wikiTarget(match[2]))
    if (!isWorkspaceRelative(target) || !hasFileExtension(target)) continue
    if (!embed) {
      const ext = extensionOf(target)
      if (ext === 'md' || ext === 'txt') continue
      const cardable = IMAGE_EXTENSIONS.has(ext) || HTML_EXTENSIONS.has(ext)
        || TABLE_EXTENSIONS.has(ext) || ext === 'json' || TEXT_EXTENSIONS.has(ext)
      if (!cardable) continue
    }
    found.push({ at: match.index ?? 0, path: target })
  }
  for (const match of markdown.matchAll(MD_LINK_RE)) {
    const target = cleanPath(match[1])
    if (!isWorkspaceRelative(target) || !hasFileExtension(target)) continue
    found.push({ at: match.index ?? 0, path: target })
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.path)
}

/** The first non-empty line of an assistant turn's text — the group's
 *  "what was this about" cue, capped for a one-line header. */
function turnSnippet(message: AgentChatMessage): string | undefined {
  for (const block of message.blocks ?? []) {
    if (block.type !== 'text') continue
    const line = block.text.split('\n').map((part) => part.trim()).find((part) => part.length > 0)
    if (!line) continue
    return line.length > 64 ? `${line.slice(0, 64)}…` : line
  }
  return undefined
}

/**
 * `projectSessionEvents` returns a projection whose message union is
 * pathologically deep to instantiate (TS2589) — the same narrowing wrapper
 * `useLiveSessionProjection` uses, truncated to the one field this store
 * reads. The data is a projected message array; the assertion only truncates
 * inference.
 */
function projectChildMessages(events: ReadonlyArray<SessionEvent>): ReadonlyArray<AgentChatMessage> {
  const projection = projectSessionEvents(events) as unknown as { messages: ReadonlyArray<AgentChatMessage> }
  return projection.messages
}

export const useAgentFilesStore = defineStore('agentFiles', () => {
  const agentStore = useAgentStore()
  const subagentsStore = useSubagentsStore()
  const workspaceStore = useWorkspaceStore()

  /**
   * Citations read out of the active subagent children's session logs, keyed
   * by subagentId. A child's log is re-read only when its record's state or
   * role changes (spawn → running → returned is three reads, not one per
   * streamed token); while a child is mid-run its uncommitted citations stay
   * unseen — they land with the commit that settles it.
   */
  const childCitations = ref<Record<string, { role: string; state: string; paths: Array<{ path: string; messageId: string }> }>>({})

  async function readChildCitations(root: string, record: SubagentStatus): Promise<Array<{ path: string; messageId: string }>> {
    try {
      const log = createWorkspaceSessionLog(desktopWorkspaceTextBridge(), root, record.subagentId, { readOnly: true })
      const loaded = await log.readWithPresence()
      if (!loaded.exists) return []
      const messages = projectChildMessages(loaded.events)
      const out: Array<{ path: string; messageId: string }> = []
      for (const message of messages) {
        if (message.role !== 'assistant' || !message.blocks) continue
        for (const block of message.blocks) {
          if (block.type !== 'text') continue
          for (const path of extractCitations(block.text)) {
            const cleaned = cleanPath(path)
            if (!cleaned) continue
            out.push({ path: cleaned, messageId: message.id })
          }
        }
      }
      return out
    } catch {
      // No desktop bridge (web/demo builds) or an unreadable child log — the
      // child contributes nothing rather than breaking the tab.
      return []
    }
  }

  watch(
    () => ({ sid: agentStore.active?.id ?? null, records: subagentsStore.active }),
    (next, prev) => {
      if (next.sid !== prev?.sid) childCitations.value = {}
      const root = workspaceStore.workspacePath
      if (!next.sid || !root || next.records.length === 0) return
      void (async () => {
        for (const record of next.records) {
          const cached = childCitations.value[record.subagentId]
          if (cached && cached.state === record.state && cached.role === record.role) continue
          const paths = await readChildCitations(root, record)
          // A read that outlived its session (or was superseded by a newer
          // record state while in flight) must not land stale data.
          if (agentStore.active?.id !== next.sid) return
          if (cached && cached.state === record.state && cached.role === record.role) return
          childCitations.value = {
            ...childCitations.value,
            [record.subagentId]: { role: record.role, state: record.state, paths },
          }
        }
      })()
    },
    { immediate: true },
  )

  /**
   * The derivation, in one pass: main-session turns in message order, then
   * one group per subagent in spawn order. Dedup by path across ALL groups —
   * the first conversation to cite a file owns it, so a figure a child
   * produced but the parent's answer re-cited shows once, under the turn.
   */
  const grouped = computed<AgentFileGroup[]>(() => {
    const session = agentStore.active
    const out: AgentFileGroup[] = []
    const seen = new Set<string>()
    if (session) {
      let turnNo = 0
      for (const message of session.messages) {
        if (message.role !== 'assistant' || !message.blocks) continue
        turnNo += 1
        const files: AgentFile[] = []
        for (const block of message.blocks) {
          if (block.type !== 'text') continue
          for (const raw of extractCitations(block.text)) {
            const cleaned = cleanPath(raw)
            if (!cleaned || seen.has(cleaned)) continue
            seen.add(cleaned)
            files.push({ path: cleaned, name: basename(cleaned), kind: classifyKind(cleaned), messageId: message.id })
          }
        }
        if (files.length === 0) continue
        out.push({
          key: `main:${message.id}`,
          kind: 'turn',
          turn: turnNo,
          snippet: turnSnippet(message),
          files,
        })
      }
    }
    const records = [...subagentsStore.active].sort((a, b) => a.createdAt - b.createdAt)
    for (const record of records) {
      const entry = childCitations.value[record.subagentId]
      if (!entry || entry.paths.length === 0) continue
      const files: AgentFile[] = []
      for (const citation of entry.paths) {
        if (seen.has(citation.path)) continue
        seen.add(citation.path)
        files.push({
          path: citation.path,
          name: basename(citation.path),
          kind: classifyKind(citation.path),
          messageId: citation.messageId,
        })
      }
      if (files.length === 0) continue
      out.push({ key: `sub:${record.subagentId}`, kind: 'subagent', role: record.role, files })
    }
    return out
  })

  const active = computed<AgentFile[]>(() => grouped.value.flatMap((group) => group.files))

  const hasFiles = computed(() => active.value.length > 0)

  return { active, grouped, hasFiles }
})
