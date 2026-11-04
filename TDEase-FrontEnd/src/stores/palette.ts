/**
 * paletteStore — (the palette), (`Ctrl/Cmd+K`),
 * (stores are projections and view state, never truth).
 *
 * Owns the palette's open/closed state, its query, and the one ranked list
 * the component renders. Three groups, exactly as §7.4 names them: registered
 * commands, open documents, and Runs.
 *
 * Two decisions in here are worth stating up front, because both are places
 * where the honest answer is smaller than the tempting one:
 *
 * ## 1. The ranker is thirty lines, not a dependency
 *
 * Refuses `fuse.js` by name: ~60 commands, and a
 * subsequence scorer ranks them *better* because it can weight an `id` match
 * over a `title` match — "runs.cancel" typed by someone who knows the
 * vocabulary must beat a fuzzy hit inside a summary. `scoreCandidate` below
 * is that scorer, exported so it is tested directly rather than through the
 * DOM.
 *
 * ## 2. A command the palette cannot deliver is shown, greyed, with a reason
 *
 * §7.4: "Disabled commands are shown greyed with the reason from `enabled()`,
 * because hiding them teaches nothing." The registry is the Agent's tool
 * surface, and most of its ~34 commands answer *with data* — `nodes.list`
 * returns a node array, `runs.tailLog` returns log text. The palette has no
 * surface for a JSON result, so running one from here would be a control that
 * appears to work and does not. Those entries carry a `blocked` code and the
 * component renders the sentence that says what to do instead.
 *
 * What the palette *can* deliver today is the four reversible Run mutations,
 * and it delivers them through `useRunsStore()`, which invokes the same
 * `CommandRegistry` with the same permission gate and the same provenance
 * capture a tool call gets (§7.1: the registry is the only verb). The palette
 * does not build a second command path.
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { RunStatus } from '@/services/backend/backend'
import type { RunSummary } from '@/studio/domain/run'
import { studioCommandDefinitions } from '@/studio/commands/definitions'
import { stakesOf, type CommandContext, type CommandDefinition, type JsonSchema } from '@/studio/commands/registry'
import { useDocumentsStore, type SettingsSectionId } from './documents'
import { useRunsStore } from './runs'
import { useWorkspaceStore } from './workspace'

export type PaletteGroup = 'commands' | 'documents' | 'runs'

/**
 * The palette's per-section Settings entries. Mirrors the SettingsNav
 * information architecture one-to-one; the id is the SettingsSectionId the
 * documents store carries, so a rename here has to survive a type check
 * against that union, not a stringly hope.
 */
const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSectionId; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'Providers' },
  { id: 'statistics', label: 'Statistics' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'agent-tools', label: 'Agent Tools' },
  { id: 'mcp', label: 'MCP' },
  { id: 'sharing', label: 'Sharing' },
  { id: 'appearance', label: 'Appearance' },
]

/**
 * Why an entry is shown but not runnable. A code, not a sentence: the store
 * holds no user-facing copy (that is `locales/`, read by the component), and
 * a code is what a test can assert on without asserting on translated text.
 */
export type PaletteBlockedReason =
  /** A Run mutation with no Workspace attached. */
  | 'no-workspace'
  /** `stakes: 'document'` — §8.5 rule 2 refuses a one-line approval. */
  | 'needs-review'
  /** The palette has nowhere to put what this command returns. */
  | 'no-result-surface'
  /** `enabled()` is false: it needs a session port the palette does not carry. */
  | 'session-capability'

export interface PaletteCommandInfo {
  id: string
  schema: JsonSchema
  /** Whether Enter must first collect arguments through `SchemaForm` (§7.3). */
  needsArgs: boolean
}

export interface PaletteItem {
  /** Unique across every group: the DOM id, the recency key, the v-for key. */
  key: string
  group: PaletteGroup
  /** The technical identity a power user types: a command id, a run id, a document id. */
  matchId: string
  title: string
  /** The secondary line: a command summary, a document kind, a run status. */
  detail: string
  blocked: PaletteBlockedReason | null
  command?: PaletteCommandInfo
  runStatus?: RunStatus
  /** Set on the entries that open a document that is not open yet. */
  opens?: 'settings' | 'run-index'
  /** Settings-section focus for `opens: 'settings'` rows (the palette's
   *  per-section entries; see SettingsSectionId in the documents store). */
  settingsSection?: SettingsSectionId
  documentId?: string
  runId?: string
}

/** `>` restricts to commands, `@` to Runs (§7.4). */
export interface ParsedQuery {
  group: PaletteGroup | null
  text: string
}

export function parsePaletteQuery(raw: string): ParsedQuery {
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('>')) return { group: 'commands', text: trimmed.slice(1).trim() }
  if (trimmed.startsWith('@')) return { group: 'runs', text: trimmed.slice(1).trim() }
  return { group: null, text: trimmed.trim() }
}

/**
 * Case-insensitive subsequence score in `(0, 1]`, or `null` when `query` is
 * not a subsequence of `target` at all.
 *
 * Each matched character earns one point, plus one for continuing a run and
 * one for landing on a word boundary — so `rc` scores higher against
 * `runs.cancel` (two boundaries) than against `restore` (one boundary, one
 * interior). An exact match short-circuits to 1 so that typing a command id
 * in full can never be out-ranked by a longer string that merely contains it.
 */
export function scoreCandidate(query: string, target: string): number | null {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (q === t) return 1

  let qi = 0
  let raw = 0
  let streak = 0
  let firstIndex = -1

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) {
      streak = 0
      continue
    }
    if (firstIndex < 0) firstIndex = ti
    const boundary = ti === 0 || !/[a-z0-9]/.test(t[ti - 1])
    raw += 1 + streak + (boundary ? 1 : 0)
    streak = 1
    qi++
  }

  if (qi < q.length) return null

  // Best case per character is 3 (matched + contiguous + boundary), which is
  // unreachable for every character at once; normalising against it keeps the
  // result inside (0, 1) without a second pass.
  const normalized = Math.min(1, raw / (q.length * 3))
  // A match that starts near the front of the target is the better match.
  const lead = 1 - Math.min(firstIndex, 12) / 48
  return normalized * lead
}

/**
 * §7.4's ranking, in the order that section states it: recency, then an `id`
 * match, then a `title` match.
 *
 * Recency carries the largest weight *and the smallest domain*: only entries
 * the user has actually activated from the palette have a non-zero recency, so
 * on a cold palette the ranking is purely id-then-title, and on a warm one the
 * thing you just did is one keystroke away. An entry that matches neither the
 * id nor the title is excluded outright, so recency can never surface an
 * irrelevant row.
 */
const RECENCY_WEIGHT = 3
const ID_WEIGHT = 2
const TITLE_WEIGHT = 1
/** How many remembered activations still count as "recent". */
const RECENCY_WINDOW = 12

export function rankPaletteItems(
  items: ReadonlyArray<PaletteItem>,
  query: string,
  recencyOf: (key: string) => number,
): PaletteItem[] {
  const scored: Array<{ item: PaletteItem; score: number; order: number }> = []

  items.forEach((item, order) => {
    const recency = recencyOf(item.key)
    if (!query) {
      scored.push({ item, score: RECENCY_WEIGHT * recency, order })
      return
    }
    const idScore = scoreCandidate(query, item.matchId)
    const titleScore = scoreCandidate(query, item.title)
    if (idScore === null && titleScore === null) return
    scored.push({
      item,
      score: RECENCY_WEIGHT * recency + ID_WEIGHT * (idScore ?? 0) + TITLE_WEIGHT * (titleScore ?? 0),
      order,
    })
  })

  // A stable sort over the source order keeps the groups' natural ordering
  // (open documents by tab order, Runs newest first) intact for ties.
  scored.sort((a, b) => (b.score - a.score) || (a.order - b.order))
  return scored.map((entry) => entry.item)
}

/**
 * A capability probe, never an invocation context.
 *
 * Every `enabled()` in `studio/commands/definitions.ts` tests exactly one
 * thing: whether an optional session port is present (`skills`, `provenance`,
 * `knowledge`, `workspaceFiles`, `media`). The palette holds none of them, so
 * probing with an object that carries none of them is precisely the truth
 * §7.4 wants rendered — "this needs a session capability the palette does not
 * have". Nothing is ever *run* with this object; the palette's one invocation
 * path is `useRunsStore()`, which builds a real `CommandContext`.
 *
 * The cast is deliberate and is why this function exists rather than being
 * inlined: it marks the one place a partial context is legitimate.
 */
function capabilityProbe(workspaceId: string): CommandContext {
  return { workspaceId } as unknown as CommandContext
}

/**
 * The commands the palette can actually carry out, mapped onto the Run
 * surface's existing registry calls.
 *
 * Deliberately short. `runs.overwrite` is absent because it declares
 * `stakes: 'document'` — a document-tier
 * mutation is approved on a real surface, not from a one-line row, and the
 * Analysis Review document that would host it is not built
 * (docs/STATUS.md). It is listed greyed with that reason
 * instead of being quietly dropped.
 */
const RUN_MUTATIONS = new Set(['runs.cancel', 'runs.resume', 'runs.trash', 'runs.restore'])

export const usePaletteStore = defineStore('palette', () => {
  const documentsStore = useDocumentsStore()
  const runsStore = useRunsStore()
  const workspaceStore = useWorkspaceStore()

  const isOpen = ref(false)
  const query = ref('')
  /**
   * Esc "dismisses, never destroys" (§7.5): the query, the pending command
   * and its half-filled arguments all survive a close/reopen cycle, so
   * hitting Esc by reflex never costs work that was already typed.
   */
  const pendingCommandId = ref<string | null>(null)
  /** Keyed by command id so one command's half-filled form never leaks into another's. */
  const drafts = ref<Record<string, Record<string, unknown>>>({})
  const argErrors = ref<Record<string, string>>({})
  const lastError = ref<string | null>(null)
  const busy = ref(false)
  /** Most-recently-activated palette keys, newest first. */
  const recent = ref<string[]>([])

  const definitions = studioCommandDefinitions()

  const parsed = computed(() => parsePaletteQuery(query.value))

  function recencyOf(key: string): number {
    const index = recent.value.indexOf(key)
    if (index < 0) return 0
    return Math.max(0, 1 - index / RECENCY_WINDOW)
  }

  function blockedReasonFor(definition: CommandDefinition): PaletteBlockedReason | null {
    // The probe first, because "it needs a capability this surface does not
    // have" is the most specific true sentence available and §7.4 asks for
    // the reason `enabled()` gives.
    if (definition.enabled && !definition.enabled(capabilityProbe(workspaceStore.workspaceId))) {
      return 'session-capability'
    }
    if (!definition.mutates) return 'no-result-surface'
    if (stakesOf(definition) === 'document') return 'needs-review'
    if (!RUN_MUTATIONS.has(definition.id)) return 'no-result-surface'
    if (!workspaceStore.workspaceId) return 'no-workspace'
    return null
  }

  const commandItems = computed<PaletteItem[]>(() => definitions.map((definition) => ({
    key: `command:${definition.id}`,
    group: 'commands' as const,
    matchId: definition.id,
    title: definition.title,
    detail: definition.summary,
    blocked: blockedReasonFor(definition),
    command: {
      id: definition.id,
      schema: definition.args,
      needsArgs: (definition.args.required?.length ?? 0) > 0,
    },
  })))

  const documentItems = computed<PaletteItem[]>(() => {
    const items: PaletteItem[] = documentsStore.openDocuments.map((doc) => ({
      key: `document:${doc.id}`,
      group: 'documents' as const,
      matchId: doc.id,
      title: doc.title,
      detail: doc.key.kind,
      blocked: null,
      documentId: doc.id,
    }))

    // §3.1: "Settings becomes a document kind, not a route, so that it is
    // reachable from the command palette". Offered only while it is closed —
    // once open it is already in the list above, and two rows that do the
    // same thing is how a palette stops being scannable.
    const openIds = new Set(items.map((item) => item.matchId))
    if (!openIds.has('settings')) {
      items.push({
        key: 'open:settings',
        group: 'documents',
        matchId: 'settings',
        title: 'Settings',
        detail: 'settings',
        blocked: null,
        opens: 'settings',
      })
    }
    // Per-section entries: "Settings: Statistics" opens the document FOCUSED
    // on that section (and re-focuses it when already open) — the palette
    // could previously only land on the default Providers section, leaving
    // Statistics/Sharing/… searchable-but-unreachable. Always offered: a
    // section switch is a distinct action from "open the document", whether
    // or not the document is open. Titles stay in the palette's plain
    // vocabulary (no i18n here — the store holds no user-facing copy).
    for (const section of SETTINGS_SECTIONS) {
      items.push({
        key: `open:settings:${section.id}`,
        group: 'documents',
        matchId: `settings:${section.id}`,
        title: `Settings: ${section.label}`,
        detail: 'settings-section',
        blocked: null,
        opens: 'settings',
        settingsSection: section.id,
      })
    }
    const workspaceId = workspaceStore.workspaceId
    if (workspaceId && !openIds.has(`run-index:${workspaceId}`)) {
      items.push({
        key: 'open:run-index',
        group: 'documents',
        matchId: `run-index:${workspaceId}`,
        title: 'Run Index',
        detail: 'run-index',
        blocked: null,
        opens: 'run-index',
      })
    }
    return items
  })

  const runItems = computed<PaletteItem[]>(() => {
    const live = Array.from(runsStore.active.values())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    const all: RunSummary[] = [...live, ...runsStore.history]
    return all.map((run) => ({
      key: `run:${run.id}`,
      group: 'runs' as const,
      matchId: run.id,
      title: run.title || run.id.slice(0, 10),
      detail: run.id,
      blocked: null,
      runStatus: run.status,
      runId: run.id,
    }))
  })

  /** Every candidate, before the query narrows it. Group order is §7.4's. */
  const allItems = computed<PaletteItem[]>(() => {
    const group = parsed.value.group
    const groups: PaletteItem[] = []
    if (!group || group === 'commands') groups.push(...commandItems.value)
    if (!group || group === 'documents') groups.push(...documentItems.value)
    if (!group || group === 'runs') groups.push(...runItems.value)
    return groups
  })

  const results = computed<PaletteItem[]>(() =>
    rankPaletteItems(allItems.value, parsed.value.text, recencyOf))

  /** The ranked list re-grouped for rendering; empty groups are dropped.
   *  Blocked rows sink to the bottom of their group (stable): they are
   *  documentation of Agent-only verbs, not peers of runnable commands, and
   *  interleaved two-line warning blocks read as breakage — the 2026-09-05
   *  review found six of eleven visible rows were blocked. */
  const groupedResults = computed<Array<{ group: PaletteGroup; items: PaletteItem[] }>>(() => {
    const order: PaletteGroup[] = ['commands', 'documents', 'runs']
    const sortByBlocked = (a: PaletteItem, b: PaletteItem) =>
      Number(!!a.blocked) - Number(!!b.blocked)
    return order
      .map((group) => ({
        group,
        items: results.value.filter((item) => item.group === group).sort(sortByBlocked),
      }))
      .filter((entry) => entry.items.length > 0)
  })

  const pendingCommand = computed<PaletteItem | null>(() =>
    pendingCommandId.value
      ? commandItems.value.find((item) => item.command?.id === pendingCommandId.value) ?? null
      : null)

  const draftArgs = computed<Record<string, unknown>>(() =>
    (pendingCommandId.value ? drafts.value[pendingCommandId.value] : undefined) ?? {})

  function open(prefix = '') {
    if (prefix) query.value = prefix
    isOpen.value = true
  }

  /**
   * Esc, the backdrop, and a completed activation all land here.
   *
   * §7.5's "Esc dismisses, never destroys": the query and every typed
   * argument survive. Only the *step* resets, so reopening lands on the list
   * rather than dropping the user back into a form they had walked away from
   * — re-entering the same command restores its draft verbatim.
   */
  function close() {
    isOpen.value = false
    pendingCommandId.value = null
    argErrors.value = {}
    lastError.value = null
  }

  function toggle() {
    if (isOpen.value) close()
    else open()
  }

  function setQuery(next: string) {
    query.value = next
  }

  function remember(key: string) {
    recent.value = [key, ...recent.value.filter((entry) => entry !== key)].slice(0, RECENCY_WINDOW * 2)
  }

  /**
   * Moves an argument-taking command into the argument step (§7.3), seeding
   * `runId` from the active Run document when there is one — the overwhelmingly
   * common case is "cancel the Run I am looking at".
   */
  function beginArgs(item: PaletteItem) {
    if (!item.command) return
    const commandId = item.command.id
    pendingCommandId.value = commandId
    argErrors.value = {}
    lastError.value = null

    const existing = drafts.value[commandId] ?? {}
    const activeKey = documentsStore.activeKey
    const seed: Record<string, unknown> = {}
    if (activeKey?.kind === 'run' && item.command.schema.properties?.runId && !existing.runId) {
      seed.runId = activeKey.runId
    }
    drafts.value = { ...drafts.value, [commandId]: { ...seed, ...existing } }
  }

  /** Back to the list. The draft stays; only the step changes. */
  function cancelArgs() {
    pendingCommandId.value = null
    argErrors.value = {}
    lastError.value = null
  }

  function setDraftArgs(next: Record<string, unknown>) {
    const commandId = pendingCommandId.value
    if (!commandId) return
    drafts.value = { ...drafts.value, [commandId]: next }
  }

  function missingRequired(schema: JsonSchema, args: Record<string, unknown>): string[] {
    return (schema.required ?? []).filter((key) => {
      const value = args[key]
      return value === undefined || value === null || value === ''
    })
  }

  /**
   * The single invocation seam. Run mutations go through `useRunsStore()`,
   * which calls `CommandRegistry.invoke` with a real `CommandContext` — the
   * permission gate and the provenance ledger apply to this exactly as they
   * apply to the Agent's own tool call (§7.1).
   */
  async function invokeCommand(commandId: string, args: Record<string, unknown>): Promise<void> {
    const runId = typeof args.runId === 'string' ? args.runId : ''
    switch (commandId) {
      case 'runs.cancel': return runsStore.cancel(runId)
      case 'runs.resume': return runsStore.rerun(runId, 'resume')
      case 'runs.trash': return runsStore.trash(runId)
      case 'runs.restore': return runsStore.restore(runId)
      default:
        throw new Error(`The palette has no route for ${commandId}`)
    }
  }

  /**
   * Runs the pending command with the collected arguments. Returns true when
   * the palette should close; false leaves it open with the failure visible,
   * because a failed mutation is not something to report in a toast the user
   * has already navigated away from.
   */
  async function submitPending(): Promise<boolean> {
    const item = pendingCommand.value
    if (!item?.command) return false
    const missing = missingRequired(item.command.schema, draftArgs.value)
    if (missing.length) {
      argErrors.value = Object.fromEntries(missing.map((key) => [key, 'required']))
      return false
    }
    const commandId = item.command.id
    busy.value = true
    lastError.value = null
    try {
      await invokeCommand(commandId, draftArgs.value)
      remember(item.key)
      // The draft is discarded only once it has actually been carried out —
      // every other exit from this surface preserves it (§7.5).
      const remaining = { ...drafts.value }
      delete remaining[commandId]
      drafts.value = remaining
      close()
      return true
    } catch (cause) {
      lastError.value = cause instanceof Error ? cause.message : String(cause)
      return false
    } finally {
      busy.value = false
    }
  }

  /**
   * Enter on a row. A blocked row is a no-op that leaves the palette open —
   * its reason is already rendered beside it, so there is nothing to announce
   * and nothing to punish the user with.
   */
  async function activate(item: PaletteItem): Promise<void> {
    if (item.blocked) return

    if (item.group === 'commands' && item.command) {
      if (item.command.needsArgs) {
        beginArgs(item)
        return
      }
      remember(item.key)
      busy.value = true
      try {
        await invokeCommand(item.command.id, {})
        close()
      } catch (cause) {
        lastError.value = cause instanceof Error ? cause.message : String(cause)
      } finally {
        busy.value = false
      }
      return
    }

    if (item.group === 'runs' && item.runId) {
      documentsStore.openRun(item.runId, { title: item.title, preview: false })
      remember(item.key)
      close()
      return
    }

    if (item.group === 'documents') {
      if (item.opens === 'settings') documentsStore.openSettings(undefined, item.settingsSection)
      else if (item.opens === 'run-index') documentsStore.openRunIndex(workspaceStore.workspaceId)
      else if (item.documentId) documentsStore.select(item.documentId)
      remember(item.key)
      close()
    }
  }

  return {
    isOpen, query, parsed, results, groupedResults, allItems,
    pendingCommandId, pendingCommand, draftArgs, argErrors, lastError, busy, recent,
    open, close, toggle, setQuery, activate, beginArgs, cancelArgs, setDraftArgs, submitPending,
    recencyOf, remember,
  }
})
