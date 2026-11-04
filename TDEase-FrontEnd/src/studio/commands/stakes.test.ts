/**
 * The approval ladder — docs/STATUS.md.
 *
 * These tests exist because the failure they guard against is silent. An
 * approval surface that decides per call site how dangerous a command is will
 * disagree with the next surface that decides the same thing, and the
 * disagreement shows up as a four-hour Run approved from a chat bubble rather
 * than as a broken build.
 */
import { describe, expect, it } from 'vitest'
import {
  CommandRegistry,
  CommandRegistrationError,
  allowsSessionGrant,
  stakesOf,
  type CommandDefinition,
} from './registry'
import { studioCommandDefinitions } from './definitions'

function definition(overrides: Partial<CommandDefinition>): CommandDefinition {
  return {
    id: 'test.command',
    title: 'Test',
    summary: 'A test command.',
    args: { type: 'object', additionalProperties: false, properties: {} },
    mutates: false,
    run: async () => undefined,
    ...overrides,
  } as CommandDefinition
}

describe('command stakes', () => {
  it('derives silent for a read-only command and inline for a mutating one', () => {
    expect(stakesOf({ mutates: false })).toBe('silent')
    expect(stakesOf({ mutates: true })).toBe('inline')
  })

  it('prefers a declared tier over the derivation', () => {
    expect(stakesOf({ mutates: true, stakes: 'document' })).toBe('document')
  })

  it('refuses a read-only command that raises its own stakes', () => {
    expect(() => new CommandRegistry([definition({ mutates: false, stakes: 'document' })]))
      .toThrow(CommandRegistrationError)
  })

  it('refuses a mutating command that declares silent stakes', () => {
    expect(() => new CommandRegistry([
      definition({ mutates: true, permission: 'workspace.write', stakes: 'silent' }),
    ])).toThrow(CommandRegistrationError)
  })
})

describe('session grants', () => {
  it('offers a standing grant only at the inline tier', () => {
    expect(allowsSessionGrant('inline')).toBe(true)
    expect(allowsSessionGrant('silent')).toBe(false)
    // The rule that makes the document tier mean anything: if the grant
    // survives the instance, the next instance is never read.
    expect(allowsSessionGrant('document')).toBe(false)
  })

  it('never offers a standing grant for any registered document-tier command', () => {
    const grantable = studioCommandDefinitions()
      .filter((command) => allowsSessionGrant(stakesOf(command)))
      .map((command) => command.id)

    expect(grantable).not.toContain('workflow.submit')
    expect(grantable).not.toContain('workflow.submit')
    expect(grantable).not.toContain('runs.overwrite')
  })
})

describe('the registered ladder', () => {
  const commands = studioCommandDefinitions()

  it('assigns every registered command exactly one tier', () => {
    for (const command of commands) {
      expect(['silent', 'inline', 'document']).toContain(stakesOf(command))
    }
  })

  it('puts the command §8.5 names by name on the document tier', () => {
    for (const id of ['workflow.submit', 'workflow.run']) {
      const command = commands.find((entry) => entry.id === id)
      expect(command, `${id} is not registered`).toBeDefined()
      expect(stakesOf(command!), `${id} must be reviewed in a document`).toBe('document')
    }
  })

  it('leaves cheap reversible mutations inline, so the document tier stays meaningful', () => {
    // A ladder where everything is the top rung is a ladder with one rung.
    for (const id of ['runs.cancel', 'runs.trash', 'runs.restore', 'runs.resume']) {
      const command = commands.find((entry) => entry.id === id)
      expect(command, `${id} is not registered`).toBeDefined()
      expect(stakesOf(command!)).toBe('inline')
    }
  })

  it('keeps every read-only command silent', () => {
    for (const command of commands.filter((entry) => !entry.mutates)) {
      expect(stakesOf(command), `${command.id} is read-only`).toBe('silent')
    }
  })
})
