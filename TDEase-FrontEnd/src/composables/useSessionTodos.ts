// useSessionTodos — the shared read model for the Agent's plan.
//
// `todo_write` produces `tool.requested` / `tool.completed` events, which the
// projection already maps to a `ToolGroupBlock` row inside the act. The plan is
// therefore a *derived, pinned summary* of the latest APPLIED `todo_write`
// payload in the projection: same events, no new block, no second data model.
// Replacement semantics — the last `todo_write` call that actually SUCCEEDED
// wins, because the tool takes the whole list every time. A declined, failed
// or cancelled call never wrote the plan, so its payload must not either —
// the card would otherwise contradict the failed tool row sitting next to it.
//
// Extracted from SessionTodoCard.vue so the new AgentActivityPanel and the
// in-conversation Todo card read from ONE projection (AGENTS.md §3: fix
// robustness by not duplicating the parser). Both surfaces are pure views over
// the messages the host already provides via `inject('chatMessages')`.

import { computed, type ComputedRef, type Ref } from 'vue'
import type { AgentChatMessage, ToolCall } from '@/stores/chat-types'
import { toolIconName, type ToolIconName } from '@/utils/tool-identity'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  key: string
  content: string
  activeForm: string
  status: TodoStatus
}

/** Per-todo tool-call attribution: how many calls ran while this todo was the
 *  plan's in_progress item, and which tool categories they were (first
 *  occurrence order, deduped). The spine renders this as the node's meta. */
export interface TodoCallStats {
  calls: number
  icons: ToolIconName[]
}

/**
 * Map a `TodoStatus` to its i18n key. Kept here so every consumer agrees on the
 * same status vocabulary; the caller binds it to `t()`.
 */
export const TODO_STATUS_KEY: Record<TodoStatus, string> = {
  pending: 'workbench.sessionTodo.statusPending',
  in_progress: 'workbench.sessionTodo.statusInProgress',
  completed: 'workbench.sessionTodo.statusCompleted',
}

/**
 * Read the latest `todo_write` payload off the provided message list. Returns
 * the derived plan (todos, counts, progress, current task). The source may be
 * the host's `inject('chatMessages')` ref or any `AgentChatMessage[]` ref — the
 * composable owns no state of its own.
 *
 * @param messages a reactive ref to the active session's message projection.
 */
export function useSessionTodos(messages: Ref<ReadonlyArray<AgentChatMessage>>): {
  todos: ComputedRef<TodoItem[]>
  completedCount: ComputedRef<number>
  progressFraction: ComputedRef<string>
  currentTask: ComputedRef<string>
} {
  const todos = computed<TodoItem[]>(() => walkPlan(messages.value).latest)

  const completedCount = computed(() => todos.value.filter((todo) => todo.status === 'completed').length)

  const progressFraction = computed(() => {
    if (todos.value.length === 0) return '0%'
    return `${Math.round((completedCount.value / todos.value.length) * 100)}%`
  })

  // Surface the in_progress task ("current task"); if none is in progress, the
  // most recent pending task or the last completed.
  const currentTask = computed(() => {
    const inProgress = todos.value.find((todo) => todo.status === 'in_progress')
    if (inProgress) return inProgress.activeForm || inProgress.content
    const pending = todos.value.find((todo) => todo.status === 'pending')
    if (pending) return pending.content
    return ''
  })

  return { todos, completedCount, progressFraction, currentTask }
}

/**
 * The ONE traversal over the message projection that every plan-derived read
 * goes through: yields the latest applied `todo_write` payload (the
 * card/plan-tab read model), the per-act-message intent phrases (the
 * ProcessFold read model) and the per-todo call stats (the spine's node meta)
 * — all in the same pass. `useSessionTodos`, `computeIntents` and
 * `computeTodoStats` are thin computeds over this — never a second walk.
 */
function walkPlan(messages: ReadonlyArray<AgentChatMessage>): {
  latest: TodoItem[]
  intents: ReadonlyMap<string, string>
  stats: ReadonlyMap<string, TodoCallStats>
} {
  let latest: TodoItem[] = []
  const intents = new Map<string, string>()
  const stats = new Map<string, TodoCallStats>()
  // The stats' ERA — the key of the plan's current first in_progress item.
  // Tools are walked in order, so an applied todo_write switches the era
  // mid-message; every OTHER call lands in the era it ran under. No plan yet /
  // nothing in progress → no era → those calls are nobody's work and stay out.
  let era: string | null = null
  const activeIntent = (): string => {
    const item = latest.find((todo) => todo.status === 'in_progress')
    return item ? item.activeForm || item.content : ''
  }
  const switchEra = (): void => {
    const item = latest.find((todo) => todo.status === 'in_progress')
    era = item ? item.key : null
  }
  const bump = (tool: ToolCall): void => {
    if (!era) return
    const icon = toolIconName(tool.name)
    const entry = stats.get(era)
    if (!entry) stats.set(era, { calls: 1, icons: [icon] })
    else {
      entry.calls += 1
      if (!entry.icons.includes(icon)) entry.icons.push(icon)
    }
  }
  for (const message of messages) {
    const blocks = message.blocks ?? []
    const isAct = blocks.some((b) => b.type === 'thinking' || b.type === 'tool_group')
    const before = activeIntent()
    for (const block of blocks) {
      if (block.type !== 'tool_group') continue
      for (const tool of block.tools) {
        // A todo_write is plan bookkeeping, not work under an era: applied →
        // move the plan and switch the era; anything else → never counted.
        if (isTodoTool(tool)) {
          const parsed = parseTodos(tool)
          if (parsed) {
            latest = parsed
            switchEra()
          }
        } else {
          bump(tool)
        }
      }
    }
    if (!isAct) continue
    // Attribution: prefer the in_progress item AFTER this message's blocks
    // (a todo_write inside the message already speaks for it), else the one
    // that was in progress while the message did its work. No plan at all →
    // the message simply has no intent and stays out of the map.
    const intent = activeIntent() || before
    if (intent) intents.set(message.id, intent)
  }
  return { latest, intents, stats }
}

/**
 * Map each act message id (a message carrying thinking or tool_group blocks)
 * to the intent phrase the plan attributes to it — the current in_progress
 * todo's `activeForm` at that point in the walk. The fold line renders this
 * instead of the generic "worked", so a collapsed act reads as what it was
 * doing, not how many calls it made. Reactive over the same projection the
 * transcript renders; one traversal per recompute (see `walkPlan`).
 */
export function computeIntents(messages: Ref<ReadonlyArray<AgentChatMessage>>): ComputedRef<ReadonlyMap<string, string>> {
  return computed(() => walkPlan(messages.value).intents)
}

/** The plan-writing tool names. Shared by `parseTodos` and the walk so "is
 *  this call plan bookkeeping rather than work" has exactly one answer. */
export function isTodoTool(tool: Pick<ToolCall, 'name'>): boolean {
  return tool.name === 'todo_write' || tool.name === 'Todo'
}

/**
 * Per-todo tool-call stats over the same single walk (see `walkPlan`): for each
 * todo key, the calls that ran while it was the in_progress item, and their
 * tool categories in first-occurrence order, deduped. The capsule's spine
 * renders this as the node's right-side meta (chips + count).
 */
export function computeTodoStats(messages: Ref<ReadonlyArray<AgentChatMessage>>): ComputedRef<ReadonlyMap<string, TodoCallStats>> {
  return computed(() => walkPlan(messages.value).stats)
}

/**
 * Parse a `todo_write` / `Todo` tool call into a `TodoItem[]`. Returns `null`
 * for any other tool, a call that did not SUCCEED (a requested-but-declined,
 * failed or cancelled call never wrote the plan — only `status: 'succeeded'`
 * is an applied fact), or a malformed payload, so a `find`/loop over a tool
 * group skips such tools without branching at the call site. Defensive about
 * the arg shape: a tool's args come from the wire and may be anything.
 */
export function parseTodos(tool: ToolCall): TodoItem[] | null {
  if (!isTodoTool(tool)) return null
  if (tool.status !== 'succeeded') return null
  const raw = tool.args?.todos
  if (!Array.isArray(raw)) return null
  return raw.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return []
    const item = value as Record<string, unknown>
    const content = typeof item.content === 'string' ? item.content.trim() : ''
    const activeForm = typeof item.activeForm === 'string' ? item.activeForm.trim() : content
    const status = item.status
    if (!content || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return []
    return [{ key: `${index}:${content}`, content, activeForm, status }]
  })
}
