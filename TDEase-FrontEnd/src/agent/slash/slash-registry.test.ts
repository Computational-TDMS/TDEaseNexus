import { describe, expect, it, vi } from 'vitest'
import { buildSlashRegistry, findSlashCommand, slashCommandRowLabel, type SlashCommandDef } from './slash-registry'

// Identity `t`: descriptions land as their keys, which is enough to assert
// they were resolved through the caller-supplied function at build time.
const t = (key: string) => key

function makeHandlers() {
  return {
    newSession: vi.fn(),
    fork: vi.fn(),
    stop: vi.fn(),
    compact: vi.fn(),
    exportConversation: vi.fn(),
    useMcp: vi.fn(),
  }
}

describe('buildSlashRegistry', () => {
  it('builds exactly the implemented commands, each with a run', () => {
    const registry = buildSlashRegistry(t, makeHandlers())
    expect(registry.map((cmd) => cmd.name)).toEqual(['new', 'fork', 'compact', 'export', 'stop'])
    for (const cmd of registry) {
      expect(typeof cmd.run).toBe('function')
      expect(cmd.description).toBeTruthy()
    }
    // Unimplemented commands (reset/help/status/confirm/reject) are not listed.
    expect(findSlashCommand(registry, 'help')).toBeUndefined()
    expect(findSlashCommand(registry, 'reset')).toBeUndefined()
    // Skills are bound through the `$` picker now, not a slash command.
    expect(findSlashCommand(registry, 'skill')).toBeUndefined()
    // MCP has no real wiring yet (no @-mention kind), so it is not advertised.
    expect(findSlashCommand(registry, 'mcp')).toBeUndefined()
  })

  it('finds commands by name, case-insensitively, and by alias', () => {
    const registry = buildSlashRegistry(t, makeHandlers())
    expect(findSlashCommand(registry, 'STOP')?.name).toBe('stop')
    const withAlias: SlashCommandDef[] = [
      { name: 'stop', aliases: ['abort'], permission: 'owner', run: () => undefined },
    ]
    expect(findSlashCommand(withAlias, 'Abort')?.name).toBe('stop')
  })

  it('dispatches run to the injected handlers', () => {
    const handlers = makeHandlers()
    const registry = buildSlashRegistry(t, handlers)
    findSlashCommand(registry, 'new')?.run('')
    findSlashCommand(registry, 'stop')?.run('')
    findSlashCommand(registry, 'export')?.run('pdf')
    expect(handlers.newSession).toHaveBeenCalledOnce()
    expect(handlers.stop).toHaveBeenCalledOnce()
    expect(handlers.exportConversation).toHaveBeenCalledWith('pdf')
    expect(handlers.useMcp).not.toHaveBeenCalled()
    expect(handlers.fork).not.toHaveBeenCalled()
  })
})

describe('slashCommandRowLabel', () => {
  // The popup's badge already carries `/name`; the label must never repeat it
  // (the old bare-name fallback rendered `/compact compact`).
  it('reduces a full usage to its argument hint, and falls back to aliases or empty', () => {
    expect(slashCommandRowLabel({ name: 'export', usage: '/export [pdf]' } as SlashCommandDef)).toBe('[pdf]')
    expect(slashCommandRowLabel({ name: 'fork', usage: '/fork session' } as SlashCommandDef)).toBe('session')
    expect(slashCommandRowLabel({ name: 'stop', aliases: ['abort'] } as SlashCommandDef)).toBe('(abort)')
    expect(slashCommandRowLabel({ name: 'compact' } as SlashCommandDef)).toBe('')
  })

  it('shows a misauthored usage verbatim instead of silently mangling it', () => {
    expect(slashCommandRowLabel({ name: 'export', usage: 'to a file' } as SlashCommandDef)).toBe('to a file')
  })
})
