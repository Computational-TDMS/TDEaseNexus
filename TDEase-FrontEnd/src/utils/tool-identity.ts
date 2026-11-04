/**
 * Tool identity — the single source for the presentation facts of a tool NAME:
 * its bare form (`tdease.` prefix stripped), its process-UI category, THE
 * failure predicate, and its localized action phrase.
 *
 * Extracted because the same facts had accumulated in five independent copies
 * (ToolGroupBlock ×2, ProcessFold, PermissionCard, tool-detail ×2) and two
 * failure predicates that agreed only by coincidence — a cancelled call that
 * carried an error message counted as a failure on ProcessFold's fold line but
 * not in ToolGroupBlock's summary. One table, one predicate, every surface.
 */
import type { ToolCall } from '@/stores/chat-types'

/** The tool's name without the `tdease.` registry prefix (`bash` stays `bash`). */
export function bareToolName(name: string): string {
  return name.replace(/^tdease\./, '')
}

/** The process rows' glyph name (ToolIcon.vue renders it via @lucide/vue). */
export type ToolIconName =
  | 'terminal' | 'file' | 'pencil' | 'folder' | 'search' | 'list' | 'spark' | 'thought' | 'circle'
  | 'workflow' | 'run' | 'monitor' | 'log' | 'fileDown' | 'view'

export function toolIconName(name: string): ToolIconName {
  const bare = bareToolName(name)
  // Workflow orchestration reads as a graph, not a shell prompt.
  if (bare.startsWith('workflow')) return 'workflow'
  // Run lifecycle: resuming/overwriting continues a run (play), watching is
  // status work (pulse), log/file access are their own reading gestures.
  if (bare === 'runs.resume' || bare === 'runs.overwrite') return 'run'
  if (bare === 'runs.status' || bare === 'runs.wait' || bare.startsWith('job.')) return 'monitor'
  if (bare === 'runs.tailLog') return 'log'
  if (bare === 'runs.fetchFile' || bare === 'runs.pullFile') return 'fileDown'
  if (bare === 'bash') return 'terminal'
  if (bare === 'write' || bare === 'edit') return 'pencil'
  if (bare === 'read' || bare.startsWith('skill.')) return 'file'
  if (bare === 'ls' || bare === 'find' || bare === 'runs.listFiles') return 'folder'
  if (bare === 'grep') return 'search'
  if (bare === 'todo_write' || bare.startsWith('todo')) return 'list'
  if (bare === 'subagent.spawn') return 'spark'
  if (bare.startsWith('view.')) return 'view'
  return 'spark'
}

/**
 * THE failure predicate for a tool call. `failed` status, or a done call that
 * did not succeed and is neither running nor cancelled. Cancelled-with-error
 * is NOT a failure: the turn ended around the call — that is its own neutral
 * state (assistant-ui's status vocabulary), and every surface must agree.
 */
export function isToolFailure(tool: Pick<ToolCall, 'status' | 'done' | 'success'>): boolean {
  if (tool.status === 'failed') return true
  return tool.done && !tool.success && tool.status !== 'running' && tool.status !== 'cancelled'
}

/**
 * The closed set of tools whose summary title reads as a user action rather
 * than jargon (an action phrase instead of "bash"). Unknown tools return undefined —
 * the caller falls back to the bare name, an honest identity beats an invented
 * phrase. Registry commands not listed here stay as their bare name; the
 * registry's `title` field is English-only and would break the zh voice.
 */
const ACTION_KEYS: Readonly<Record<string, string>> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  ls: 'ls',
  grep: 'grep',
  find: 'find',
  bash: 'bash',
  'subagent.spawn': 'spawn',
  'runs.status': 'runWatch',
  'runs.wait': 'runWatch',
  'runs.tailLog': 'runLog',
  'runs.listFiles': 'runFiles',
  'runs.fetchFile': 'runFiles',
  'runs.pullFile': 'runFiles',
  'job.start': 'jobStart',
  'job.status': 'jobWatch',
  'job.peek': 'jobWatch',
  'job.list': 'jobWatch',
  'job.cancel': 'jobCancel',
  'ptc.exec': 'ptcExec',
  'view.open': 'viewOpen',
  'view.focus': 'viewFocus',
  'view.select': 'viewSelect',
}

/** The i18n key of the tool's action phrase (`agent.toolAction.*`), or
 *  undefined when the tool has no phrase and keeps its bare name. */
export function toolActionKey(name: string): string | undefined {
  const bare = bareToolName(name)
  if (bare.startsWith('todo')) return 'agent.toolAction.plan'
  const key = ACTION_KEYS[bare]
  return key ? `agent.toolAction.${key}` : undefined
}

/**
 * The tool call's SUBJECT — the one-line object the intent line shows beside
 * the action phrase. Distilled
 * from the call's args by the same single identity module, so the HUD never
 * disagrees with the transcript about what is running. No args / no known
 * field → undefined: the HUD shows the action alone, never an invented
 * subject.
 */
const SUBJECT_MAX_CHARS = 48

/** Args keys that carry a subject, in try order. `command` wins (bash); the
 *  search objects (`pattern`/`query`) beat the path-like scope keys — for a
 *  grep the intent is WHAT is being searched for, not where; then the
 *  path-like set the PermissionGateway constrains (tool-gateway.ts); then
 *  free-text keys. */
const SUBJECT_KEYS = ['command', 'pattern', 'query', 'path', 'filePath', 'directory', 'url', 'role', 'prompt', 'task'] as const

/** Collapse any whitespace run (incl. newlines) to single spaces — the subject
 *  renders on the HUD's single line. */
function toOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value: string): string {
  return value.length > SUBJECT_MAX_CHARS ? `${value.slice(0, SUBJECT_MAX_CHARS)}…` : value
}

export function toolSubject(name: string, args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined
  // The plan's subject is the task IN PROGRESS — its own activeForm is written
  // for exactly this "while working" reading.
  const bare = bareToolName(name)
  if (bare.startsWith('todo')) {
    const todos = Array.isArray(args.todos) ? args.todos : []
    const active = todos.find((t) => t && typeof t === 'object' && (t as Record<string, unknown>).status === 'in_progress')
    const text = active ? toOneLine(String((active as Record<string, unknown>).activeForm ?? '')) : ''
    return text ? truncate(text) : undefined
  }
  for (const key of SUBJECT_KEYS) {
    const value = args[key]
    if (typeof value !== 'string' || !value.trim()) continue
    if (key === 'path' || key === 'filePath' || key === 'directory') {
      // Paths arrive workspace-absolute; a basename is the HUD-grade granularity
      // (the transcript row already carries the full path on click).
      const segments = value.split(/[\\/]/).filter(Boolean)
      const leaf = segments[segments.length - 1]
      if (leaf) return truncate(leaf)
      continue
    }
    // A compound bash call shows its first line — that is the intent; the rest
    // is detail the transcript owns.
    const text = toOneLine(key === 'command' ? value.split('\n')[0] : value)
    if (text) return truncate(text)
  }
  return undefined
}
