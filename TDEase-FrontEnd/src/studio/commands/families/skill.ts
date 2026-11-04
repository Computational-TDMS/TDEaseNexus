import type { CommandDefinition } from '../registry'
import { objectSchema, optionalString, requiredString, stringSchema } from '../args'

/** System/Workspace SKILL.md discovery and read (`context.skills`). */
export function skillCommands(): ReadonlyArray<CommandDefinition> {
  return ([
    {
      id: 'skill.read', title: 'Read Skill',
      exposure: { mindsets: 'all' },
      summary: 'Read one SKILL.md or one listed skill-relative resource by scoped skill id.',
      args: objectSchema({
        id: { ...stringSchema(), pattern: '^(system|workspace):[A-Za-z0-9_-]+$' },
        resource: { ...stringSchema(), pattern: '^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$' },
      }, ['id']),
      mutates: false,
      enabled: (context) => Boolean(context.skills),
      run: async (args, context) => {
        const skills = context.skills
        if (!skills) throw new Error('Skills are unavailable in this session')
        return skills.read(requiredString(args, 'id'), optionalString(args, 'resource'))
      },
    },
  ] satisfies CommandDefinition[])
}
