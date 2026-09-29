import type { CommandContext, CommandDefinition } from '../registry'
import { objectSchema, requiredString, stringSchema } from '../args'
import type { ViewFocus, ViewSelect } from '@/contracts/view-runtime'

// The Agent's pointer into the Workbench (contracts/view-runtime.ts): open a
// workspace file in the user's native viewer, move a viewer to a region,
// select what the user could click. Read-only toward data — nothing here
// writes, runs or approves — so no permission action and silent stakes. The
// port is injected by electron/agent/agent-runtime.ts for top-level sessions;
// `enabled` keeps the family unadvertised where no window can show it.

const focusSchema = objectSchema({
  mzMin: { type: 'number' },
  mzMax: { type: 'number' },
  residueStart: { type: 'integer', minimum: 1 },
  residueEnd: { type: 'integer', minimum: 1 },
}, [])

const selectSchema = objectSchema({
  ion: stringSchema(),
  residue: { type: 'integer', minimum: 1 },
  model: stringSchema(),
}, [])

function readFocus(value: unknown): ViewFocus | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
  const focus: ViewFocus = {
    mzMin: num(v.mzMin), mzMax: num(v.mzMax),
    residueStart: num(v.residueStart), residueEnd: num(v.residueEnd),
  }
  if (focus.mzMin !== undefined && focus.mzMax !== undefined && focus.mzMin >= focus.mzMax) {
    throw new Error('view focus: mzMin must be below mzMax')
  }
  return Object.values(focus).some((x) => x !== undefined) ? focus : undefined
}

function readSelect(value: unknown): ViewSelect | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const select: ViewSelect = {
    ion: typeof v.ion === 'string' && v.ion.trim() ? v.ion.trim() : undefined,
    residue: typeof v.residue === 'number' ? v.residue : undefined,
    model: typeof v.model === 'string' && v.model.trim() ? v.model.trim() : undefined,
  }
  return Object.values(select).some((x) => x !== undefined) ? select : undefined
}

function requireView(context: CommandContext) {
  if (!context.view) throw new Error('view.* is unavailable: no Workbench window is bound to this session')
  return context.view
}

export function viewCommands(): ReadonlyArray<CommandDefinition> {
  return ([
    {
      id: 'view.open', title: 'Open In Viewer',
      // Experimental beta, default OFF (viewTools): advertised tools spend
      // schema tokens in every session. The viewer family stays registered —
      // the Workbench renders natively regardless — but the Agent only
      // carries the pointer after the user opts in, per tool settings.
      exposure: { mindsets: 'scientific', setting: 'viewTools' },
      summary: 'Open a Workspace file in the user\'s native Workbench viewer (spectra, tables, evidence, MS2 candidate comparisons) instead of describing it or embedding an HTML copy. Optional focus (m/z or residue range) and select (ion like "b2", residue, or model id) apply once it opens. The user decides whether the tab takes focus (Follow agent); the result reports delivery, not what the user is looking at. Use when a claim is best checked by looking — typically right after producing the file.',
      args: objectSchema({
        path: stringSchema(),
        viewer: stringSchema(),
        focus: focusSchema,
        select: selectSchema,
      }, ['path']),
      mutates: false,
      enabled: (context) => Boolean(context.view),
      run: async (args, context) => requireView(context).issue({
        op: 'open',
        path: requiredString(args, 'path'),
        ...(typeof args.viewer === 'string' ? { viewer: args.viewer } : {}),
        ...(readFocus(args.focus) ? { focus: readFocus(args.focus) } : {}),
        ...(readSelect(args.select) ? { select: readSelect(args.select) } : {}),
      }),
    },
    {
      id: 'view.focus', title: 'Focus Viewer',
      exposure: { mindsets: 'scientific', setting: 'viewTools' },
      summary: 'Move an open (or openable) viewer to a region: an m/z window {mzMin, mzMax} in a spectrum, or a residue window in a sequence. The viewer animates there so the user keeps their bearings. Use to show exactly where the evidence is, e.g. zooming to the b1/b2 region.',
      args: objectSchema({ path: stringSchema(), focus: focusSchema }, ['path', 'focus']),
      mutates: false,
      enabled: (context) => Boolean(context.view),
      run: async (args, context) => {
        const focus = readFocus(args.focus)
        if (!focus) throw new Error('view.focus needs at least one focus field')
        return requireView(context).issue({ op: 'focus', path: requiredString(args, 'path'), focus })
      },
    },
    {
      id: 'view.select', title: 'Select In Viewer',
      exposure: { mindsets: 'scientific', setting: 'viewTools' },
      summary: 'Select what the user could click in a viewer: a fragment ion ("b2", "y12"), a residue position, or a candidate model id ("A"/"B") in a comparison. Linked viewers follow the selection (e.g. an ion lights its residues in the sequence).',
      args: objectSchema({ path: stringSchema(), select: selectSchema }, ['path', 'select']),
      mutates: false,
      enabled: (context) => Boolean(context.view),
      run: async (args, context) => {
        const select = readSelect(args.select)
        if (!select) throw new Error('view.select needs at least one select field')
        return requireView(context).issue({ op: 'select', path: requiredString(args, 'path'), select })
      },
    },
  ] satisfies CommandDefinition[])
}
