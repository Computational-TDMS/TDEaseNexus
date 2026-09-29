import type { CommandDefinition } from '../registry'
import { objectSchema, optionalStringArray, requiredString, stringSchema } from '../args'

// `reportBlocked` makes "I cannot proceed" a structural fact instead of a
// sentence: the tool_call/tool_result hooks record the call on the active
// run and the SessionHost settles the turn as `blocked` (AGENT-LOOP.md §3).
// It writes no Workspace state, so it is read-only at this layer — default
// permission `allow`, silent stakes.
export function sessionCommands(): ReadonlyArray<CommandDefinition> {
  return ([
    {
      id: 'session.reportBlocked', title: 'Report Blocked',
      exposure: { mindsets: 'all' },
      summary: 'Declare that the turn cannot proceed, with the reason and what is needed to unblock it. This is how a turn settles as blocked — a question to the user, not a paragraph of prose. When the needed answer is a choice among 2-4 alternatives, also pass options: short self-contained answers (each phrased so it can be sent back as-is), and the UI offers them as one-tap replies.',
      args: objectSchema(
        {
          reason: stringSchema(),
          needed: stringSchema(),
          options: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 2, maxItems: 4 },
        },
        ['reason', 'needed'],
      ),
      mutates: false,
      run: async (args) => {
        const options = optionalStringArray(args, 'options')
          ?.map((option) => option.trim())
          .filter((option) => option.length > 0)
          .slice(0, 4)
        return {
          reported: true,
          reason: requiredString(args, 'reason'),
          needed: requiredString(args, 'needed'),
          ...(options?.length ? { options } : {}),
        }
      },
    },
  ] satisfies CommandDefinition[])
}
