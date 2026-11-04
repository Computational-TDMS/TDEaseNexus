/**
 * view-port — the main-process half of `view.*` (src/contracts/view-runtime.ts).
 *
 * Validates the target against the Workspace (inside the root, an existing
 * file) so the model gets an honest failure instead of a tab that errors, then
 * pushes the command to the session's owning window. Delivery is the whole
 * result: whether the tab takes focus is the user's Follow-agent choice,
 * which main neither knows nor needs.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ViewCommand, ViewCommandEnvelope } from '../../src/contracts/view-runtime'
import type { ViewCommandPort } from '../../src/studio/commands/registry'

export function createViewPort(input: {
  workspaceRoot: string
  sessionId: string
  emit: (envelope: ViewCommandEnvelope) => void
}): ViewCommandPort {
  return {
    async issue(command: ViewCommand) {
      const relative = command.path.replace(/\\/g, '/').replace(/^\.\//, '')
      const absolute = path.resolve(input.workspaceRoot, relative)
      const inside = path.relative(input.workspaceRoot, absolute)
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
        throw new Error(`view: path must be inside the Workspace: ${command.path}`)
      }
      const stat = await fs.stat(absolute).catch(() => null)
      if (!stat?.isFile()) throw new Error(`view: no such Workspace file: ${relative}`)
      const normalized = inside.split(path.sep).join('/')
      input.emit({ sessionId: input.sessionId, command: { ...command, path: normalized }, issuedAt: Date.now() })
      return {
        delivered: true,
        path: normalized,
        note: 'Delivered to the Workbench. The user controls focus (Follow agent); do not assume they are looking at it.',
      }
    },
  }
}
