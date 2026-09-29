import type { CommandDefinition } from './registry'
import { CommandRegistry } from './registry'
import { discoveryCommands } from './families/discovery'
import { workflowCommands } from './families/workflow'
import { runsCommands } from './families/runs'
import { referenceCommands } from './families/reference'
import { skillCommands } from './families/skill'
import { evidenceCommands } from './families/evidence'
import { turnsCommands } from './families/turns'
import { sessionCommands } from './families/session'
import { subagentCommands } from './families/subagent'
import { orchestrateCommands } from './families/orchestrate'
import { ptcCommands } from './families/ptc'
import { jobCommands } from './families/job'

/**
 * The Studio command surface, assembled.
 *
 * Each family in `families/` is one capability seam: it binds a port (the
 * Service Definition, declared in `registry.ts` or the port module that
 * augments `CommandContext`) to the model-visible command contract, and holds
 * every family-local schema and input builder. Families never import each
 * other or this manifest — composition happens here, and here only, in
 * registration order: adding a command family means adding one module plus
 * one line below, touching nothing else (the seam rule this layout follows is
 * the capability-seam pattern: contract, provider, and consumer evolve
 * independently because they never share a module boundary).
 *
 * The order below is the registry's registration order. It is part of the
 * observable surface (agent tool listing, palette grouping) — insert new
 * families deliberately, do not sort.
 */
export function studioCommandDefinitions(): ReadonlyArray<CommandDefinition> {
  return [
    ...discoveryCommands(),
    ...workflowCommands(),
    ...runsCommands(),
    ...referenceCommands(),
    ...skillCommands(),
    ...evidenceCommands(),
    ...turnsCommands(),
    ...sessionCommands(),
    ...subagentCommands(),
    ...orchestrateCommands(),
    ...ptcCommands(),
    ...jobCommands(),
  ]
}

export function createStudioCommandRegistry(): CommandRegistry {
  return new CommandRegistry(studioCommandDefinitions())
}
