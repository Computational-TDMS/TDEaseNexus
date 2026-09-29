import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from './agent'
import { useAgentFilesStore } from './agentFiles'
import { useWorkspaceStore } from './workspace'
import { useSubagentsStore } from './subagents'

/**
 * The files store is a projection of the assistant text's Workspace file
 * citations — the same refs the renderer presents inline (images/SVG) or as
 * file cards. These tests pin the collection contract: all four syntaxes
 * collect, wiki page links and external URLs do not, paths dedup and
 * normalize, unknown extensions land as the generic `file` kind, and the
 * derivation is GROUPED by the producing exchange — main-session turns in
 * message order, then subagent children in spawn order, so the Files tab
 * answers "which exchange produced this".
 */
describe('useAgentFilesStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function seed(text: string) {
    const agents = useAgentStore()
    agents.bindWorkspace('ws-test')
    const session = agents.createSession()
    const msg = agents.addMessage(session.id, 'assistant')
    msg.blocks = [{ type: 'text', text }] as never
  }

  it('collects citations in all four syntaxes with the right kinds', () => {
    seed([
      '![figure](runs/r1/spec.png)',
      '[](runs/r1/candidates.tsv)',
      '![[runs/r1/report.html]]',
      '[[runs/r1/params.json]]',
    ].join('\n'))
    const files = useAgentFilesStore()
    expect(files.active.map((a) => [a.path, a.kind])).toEqual([
      ['runs/r1/spec.png', 'image'],
      ['runs/r1/candidates.tsv', 'table'],
      ['runs/r1/report.html', 'html'],
      ['runs/r1/params.json', 'json'],
    ])
  })

  it('does not collect wiki page links or external URLs', () => {
    seed([
      'see [[TopFD]] and [[method/TopFD]]',
      '[[notes.md]] and [[log.txt]] stay page links',
      'a remote figure ![x](https://example.com/fig.png) is not a file',
    ].join('\n'))
    const files = useAgentFilesStore()
    expect(files.active).toHaveLength(0)
    expect(files.hasFiles).toBe(false)
  })

  it('collects an unknown extension as the generic file kind', () => {
    seed('![[results/archive.xyz]]')
    const files = useAgentFilesStore()
    expect(files.active).toHaveLength(1)
    expect(files.active[0].kind).toBe('file')
  })

  it('dedups the same file across syntaxes and normalizes backslashes', () => {
    seed('![](results/T10/out.svg) and [[results/T10/out.svg]] and ![](results\\T10\\out.svg)')
    const files = useAgentFilesStore()
    expect(files.active).toHaveLength(1)
    expect(files.active[0].path).toBe('results/T10/out.svg')
  })

  it('keeps an embed of a .md/.txt page but not a bare page link', () => {
    seed('![[method/recipe.txt]] embeds as a text card; [[method/recipe.txt]] stays a link')
    const files = useAgentFilesStore()
    expect(files.active.map((a) => [a.path, a.kind])).toEqual([
      ['method/recipe.txt', 'text'],
    ])
  })

  it('groups main-session citations by turn, in message order', () => {
    const agents = useAgentStore()
    agents.bindWorkspace('ws-test')
    const session = agents.createSession()
    for (const text of [
      '第一轮给出 ![overview](runs/r1/overview.png)',
      '第三轮给出 ![detail](runs/r3/detail.png)',
    ]) {
      const msg = agents.addMessage(session.id, 'assistant')
      msg.blocks = [{ type: 'text', text }] as never
    }
    const files = useAgentFilesStore()
    expect(files.grouped.map((g) => [g.kind, g.turn])).toEqual([['turn', 1], ['turn', 2]])
    expect(files.grouped[0]?.files[0]?.path).toBe('runs/r1/overview.png')
    expect(files.grouped[1]?.files[0]?.path).toBe('runs/r3/detail.png')
    expect(files.grouped[0]?.snippet).toContain('第一轮')
    expect(files.active).toHaveLength(2)
  })

  it('collects a subagent child\'s citations from its session log', async () => {
    const agents = useAgentStore()
    agents.bindWorkspace('ws-test')
    const session = agents.createSession()
    // The parent's answer cites only the contract; the figure lives in the child.
    const msg = agents.addMessage(session.id, 'assistant')
    msg.blocks = [{ type: 'text', text: '契约见 [](runs/run1/contract.json)' }] as never

    const events = [
      { seq: 1, type: 'turn.started', turn_id: 't1', user_message: 'run the analysis', prompt_snapshot_digest: 'd', model: 'm', mindset: 'standard', authority: 'standard' },
      { seq: 2, type: 'message.completed', turn_id: 't1', role: 'assistant', content: '质谱图 ![fig](runs/run1/spectrum.png)' },
    ].map((event) => JSON.stringify(event)).join('\n')
    ;(globalThis as { tdeaseDesktop?: unknown }).tdeaseDesktop = {
      workspace: {
        async exists(_root: string, relative: string) { return relative.endsWith('sub_a1/events.jsonl') },
        async readText(_root: string, relative: string) {
          if (!relative.endsWith('sub_a1/events.jsonl')) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
          return events
        },
        async appendText() { /* unused in read-only reads */ },
        async writeTextAtomic() { /* unused in read-only reads */ },
      },
    }
    try {
      const workspace = useWorkspaceStore()
      workspace.workspacePath = 'C:/ws'
      const subagents = useSubagentsStore()
      subagents.snapshots = {
        [session.id]: [{ subagentId: 'sub_a1', role: 'analyzer', state: 'returned', createdAt: 1 }],
      }
      const files = useAgentFilesStore()
      await vi.waitFor(() => {
        expect(files.grouped.some((g) => g.kind === 'subagent' && g.role === 'analyzer')).toBe(true)
      })
      const childGroup = files.grouped.find((g) => g.kind === 'subagent')
      expect(childGroup?.files.map((a) => a.path)).toEqual(['runs/run1/spectrum.png'])
      expect(files.grouped[0]?.kind).toBe('turn')
      expect(files.active.map((a) => a.path).sort()).toEqual(['runs/run1/contract.json', 'runs/run1/spectrum.png'])
    } finally {
      delete (globalThis as { tdeaseDesktop?: unknown }).tdeaseDesktop
    }
  })
})
