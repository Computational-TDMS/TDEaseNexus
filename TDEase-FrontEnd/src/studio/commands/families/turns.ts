import { projectTurnCard } from '@/contracts/turn-card'
import type { CommandContext, CommandDefinition } from '../registry'
import { objectSchema, optionalInteger, requiredString, stringSchema } from '../args'

// The per-turn roadmap below Evidence: one compact programmatic record per
// settled turn (intent, outcome, tool counts, run-id pointers), written by the
// SessionHost for every outcome including failed and cancelled — the
// turns a retrospective most needs. Read is a projection: `turns.list`
// returns intent/outcome only, `turns.read` returns the full card.
export function turnsCommands(): ReadonlyArray<CommandDefinition> {
  return ([
    {
      id: 'turns.list', title: 'List Turn Cards',
      exposure: { mindsets: 'all' },
      summary: 'List this session\'s per-turn roadmap cards — what each turn intended and how it settled. Read this first to recover where a multi-turn task stands before planning the next step.',
      args: objectSchema({ tail: { type: 'integer', minimum: 1, maximum: 500 } }),
      mutates: false,
      enabled: (context) => Boolean(context.turns),
      run: async (args, context) => {
        const cards = await requireTurns(context).list()
        const tail = optionalInteger(args, 'tail')
        return (tail === undefined ? cards : cards.slice(-tail)).map(projectTurnCard)
      },
    },
    {
      id: 'turns.read', title: 'Read Turn Card',
      exposure: { mindsets: 'all' },
      summary: 'Read one full turn card, including its tool call summary, run-id pointers and token counts.',
      args: objectSchema({ turnId: stringSchema() }, ['turnId']),
      mutates: false,
      enabled: (context) => Boolean(context.turns),
      run: async (args, context) => {
        const turnId = requiredString(args, 'turnId')
        const card = (await requireTurns(context).list()).find((item) => item.turnId === turnId)
        // Same rule as runs.read: an absent card is answered as absent, not
        // as an empty one the model would then try to "fix".
        if (!card) throw new Error(`No turn card for turn "${turnId}" exists in this session. turns.list reports the recorded turns.`)
        return card
      },
    },
  ] satisfies CommandDefinition[])
}

function requireTurns(context: CommandContext) {
  if (!context.turns) throw new Error('Turn cards are unavailable in this session')
  return context.turns
}
