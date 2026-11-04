/**
 * Slash command registry — the single source of truth for which `/`-commands
 * exist and what they do.
 *
 * Before this module the command list was hard-coded twice (SlashInput's
 * `defaultSlashCommands()` and AgentPage's local `slashCommands`) and the two
 * lists disagreed: SlashInput advertised reset/help/status/confirm/reject,
 * none of which had a handler, while AgentPage's if/else dispatch silently
 * dropped anything it did not recognize. Now the list and the dispatch come
 * from one table built here, so a command cannot be listed without being
 * runnable.
 *
 * Headless like the rest of `src/agent/` — descriptions are resolved through
 * the caller-supplied `t`, and side effects live in the injected handlers.
 */

import type { SlashCommand } from '@/types'

/** A slash command that actually runs something. */
export interface SlashCommandDef extends SlashCommand {
  /** Execute the command with the raw argument string (may be empty). */
  run(args: string): void
}

/** Side effects the registry needs, injected by the host (AgentPage). */
export interface SlashCommandHandlers {
  newSession(): void
  fork(): void | Promise<void>
  stop(): void
  compact(): void | Promise<void>
  /** Export the active conversation; raw arg picks the format (`pdf`, default html). */
  exportConversation(args: string): void
  /** Reference a locally configured MCP server by name. */
  useMcp?(name: string): void
}

/**
 * Build the canonical command list. Descriptions are resolved at call time
 * (not module-eval time) so they follow the active locale. Only implemented
 * commands are listed — a picker row is a promise the Enter key must keep.
 */
export function buildSlashRegistry(
  t: (key: string) => string,
  handlers: SlashCommandHandlers,
): SlashCommandDef[] {
  return [
    {
      name: 'new',
      description: t('agent.sessionBar.new'),
      permission: 'owner',
      run: () => handlers.newSession(),
    },
    {
      name: 'fork',
      description: t('agent.sessionBar.fork'),
      permission: 'owner',
      run: () => void handlers.fork(),
    },
    {
      name: 'compact',
      description: t('agent.slash.compact'),
      permission: 'owner',
      run: () => void handlers.compact(),
    },
    {
      name: 'export',
      description: t('agent.slash.export'),
      usage: '/export [pdf]',
      permission: 'owner',
      run: (args) => handlers.exportConversation(args),
    },
    {
      name: 'stop',
      description: t('agent.stop.title'),
      permission: 'owner',
      run: () => handlers.stop(),
    },
  ]
}

/** Find a command by typed name or alias (case-insensitive). */
export function findSlashCommand(
  registry: ReadonlyArray<SlashCommandDef>,
  typed: string,
): SlashCommandDef | undefined {
  const needle = typed.toLowerCase()
  return registry.find(
    (cmd) =>
      cmd.name.toLowerCase() === needle ||
      cmd.aliases?.some((alias) => alias.toLowerCase() === needle),
  )
}

/**
 * The completion row's label: the usage string MINUS the command itself —
 * the row's badge already carries `/name`, so a full usage (or the old
 * bare-name fallback) rendered the command twice (`/compact compact`,
 * `/export /export [pdf]`). What remains is the argument hint (`[pdf]`,
 * `<server>`), else the alias list, else nothing: a row reads
 * `/export [pdf] — description`, never the name twice. A misauthored usage
 * that does not start with the command is shown verbatim (author-visible).
 */
export function slashCommandRowLabel(command: SlashCommand): string {
  const usage = command.usage?.trim()
  if (usage) {
    const prefix = `/${command.name}`
    return usage.toLowerCase().startsWith(prefix.toLowerCase())
      ? usage.slice(prefix.length).trim()
      : usage
  }
  return command.aliases?.length ? `(${command.aliases.join(', ')})` : ''
}
