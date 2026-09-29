/**
 * View runtime contract — the Agent's reach into the Workbench's viewers.
 *
 * First principles: the Agent already PRODUCES the things a researcher needs
 * to look at (runs, evidence, spectra); without this seam it could only cite
 * them in prose or embed an HTML copy in the chat. `view.*` lets it point the
 * user's own native viewer at the thing — open a file, move a viewer to a
 * region, select an ion or residue — and nothing more. It never writes a
 * file, never changes a run, never takes an approval: the renderer owns what
 * happens (Follow agent on → the tab takes focus; off → it opens in the
 * background with a marker), so the Agent cannot pull a reading user away.
 *
 * Direction: main → renderer push only (`agent-view:command`), owner-routed
 * per session exactly like `session-run:changed`. The command result the
 * model sees is the delivery fact, not what the user chose to look at.
 */

/** A viewer region. Every field optional: a viewer applies what it has. */
export interface ViewFocus {
  mzMin?: number
  mzMax?: number
  residueStart?: number
  residueEnd?: number
}

/** A viewer selection — the same thing the user could click. */
export interface ViewSelect {
  /** Fragment ion label, e.g. `b2`, `y12`, optionally with charge `b2+1`. */
  ion?: string
  /** 1-based residue position in the displayed sequence. */
  residue?: number
  /** Candidate/model id in a comparison viewer, e.g. `A` / `B`. */
  model?: string
}

export type ViewCommand =
  | { op: 'open'; path: string; viewer?: string; focus?: ViewFocus; select?: ViewSelect }
  | { op: 'focus'; path: string; focus: ViewFocus }
  | { op: 'select'; path: string; select: ViewSelect }

/** What crosses IPC: the command plus who issued it. */
export interface ViewCommandEnvelope {
  sessionId: string
  command: ViewCommand
  issuedAt: number
}

export interface ViewBridge {
  /** Subscribe to Agent view commands for sessions bound by this window. */
  onCommand(handler: (envelope: ViewCommandEnvelope) => void): () => void
}
