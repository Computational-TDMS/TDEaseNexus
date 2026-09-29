/**
 * Tool detail extraction — pulls a human-readable detail string out of a tool
 * call's args (e.g. the command for bash, the path for file ops).
 *
 * Two layers over one source of truth:
 *   - extractToolFullDetail → the UN-truncated string (full command/path/...).
 *                             The expanded tool body renders this, so opening
 *                             a tool always reveals more than its summary.
 *   - extractToolDetail     → a one-line truncation of the above for the
 *                             collapsed summary row; `title` carries the full
 *                             string so the summary hover tooltip shows it too.
 *
 * Ported from openhanako's message-parser.extractToolDetail, adapted to
 * TDEase's tdease.* tool registry. Unknown/plugin tools fall back to a
 * compact "k=v k=v" rendering of their string/number args.
 */
import type { ToolDetail } from '@/stores/chat-types'
import { bareToolName } from '@/utils/tool-identity'

function truncatePath(p: string): string {
  if (!p || p.length <= 35) return p
  return '…' + p.slice(-34)
}

function truncateHead(s: string, max: number): string {
  if (!s || s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

// File-path tools show the TAIL of the detail in the summary (the filename is
// the identity); everything else shows the HEAD (command verb / query start).
const TAIL_DETAIL_TOOLS = new Set([
  'templates.get', 'evidence.read', 'evidence.write',
  'read', 'write', 'edit', 'ls',
])

/**
 * The full, un-truncated human-readable detail for a tool call — the complete
 * command, path, pattern or query. The expanded tool body renders this so a
 * click always reveals more than the truncated summary. Returns '' when the
 * tool has no single meaningful detail (e.g. list/graph calls).
 */
export function extractToolFullDetail(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return ''
  const bare = bareToolName(name)

  switch (bare) {
    case 'runs.list':
    case 'nodes.list':
    case 'templates.list':
    case 'evidence.list':
    case 'evidence.graph':
      return ''
    case 'runs.status':
    case 'runs.wait':
    case 'runs.tailLog':
    case 'runs.listFiles':
    case 'runs.fetchFile':
      return String(args.run_id || args.runId || '')
    case 'nodes.get':
      return String(args.node_id || args.name || '')
    case 'templates.get':
      return String(args.template_id || args.name || '')
    case 'evidence.read':
    case 'evidence.write':
      return String(args.path || args.key || '')
    case 'bash':
      return typeof args.command === 'string' ? args.command
        : typeof args.cmd === 'string' ? args.cmd : ''
    case 'read':
    case 'write':
    case 'edit':
    case 'ls':
      return String(args.file_path || args.path || '')
    case 'grep':
      return String(args.pattern || '') + (args.path ? ` in ${args.path}` : '')
    case 'find':
      return String(args.pattern || '')
    default: {
      const parts = Object.entries(args)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
        .map(([k, v]) => `${k}=${v}`)
      return parts.length ? parts.join(' ') : ''
    }
  }
}

/**
 * One-line summary detail for the collapsed tool row: the full detail
 * truncated to fit. `title` carries the un-truncated string for the summary's
 * hover tooltip; the expanded body shows the full detail directly via
 * extractToolFullDetail.
 */
export function extractToolDetail(name: string, args: Record<string, unknown> | undefined): ToolDetail {
  const full = extractToolFullDetail(name, args)
  if (!full) return { text: '' }
  const bare = bareToolName(name)
  const text = TAIL_DETAIL_TOOLS.has(bare) ? truncatePath(full) : truncateHead(full, 40)
  return { text, title: full }
}

/**
 * Whether a tool call should be hidden from the process/group UI because a
 * dedicated card (e.g. permission) is rendering it instead. TDEase has no
 * card-backed tools beyond permission, so this always returns false — kept
 * as an explicit extension point mirroring openhanako's tool-call-visibility.
 */
export function isToolCallHiddenFromProcessUi(_tool: { name: string }): boolean {
  return false
}
