import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import CommandPalette from './CommandPalette.vue'
import {
  parsePaletteQuery,
  rankPaletteItems,
  scoreCandidate,
  usePaletteStore,
  type PaletteItem,
} from '@/stores/palette'
import { useDocumentsStore } from '@/stores/documents'
import { useWorkspaceStore } from '@/stores/workspace'

// The Run surface is mocked, not driven: `stores/runs.ts` attaches a
// RunRepository and an SSE multiplexer the moment a Workspace id appears, and
// this file is about the palette, not about the Backend. The mock keeps the
// one seam that matters visible -- the palette must reach a Run mutation
// through `useRunsStore()`, which is the store that owns the registry call.
const runsStoreMock = vi.hoisted(() => ({
  active: new Map<string, unknown>(),
  history: [] as Array<Record<string, unknown>>,
  cancel: vi.fn(async () => {}),
  rerun: vi.fn(async () => {}),
  trash: vi.fn(async () => {}),
  restore: vi.fn(async () => {}),
}))

vi.mock('@/stores/runs', () => ({ useRunsStore: () => runsStoreMock }))

function mountPalette() {
  return mount(CommandPalette, {
    attachTo: document.body,
    global: {
      stubs: {
        'el-icon': true,
        'el-input': true,
        'el-select': true,
        'el-option': true,
        'el-input-number': true,
        'el-switch': true,
      },
    },
  })
}

async function settle() {
  await nextTick()
  await nextTick()
  await flushPromises()
}

function item(partial: Partial<PaletteItem> & Pick<PaletteItem, 'key' | 'matchId' | 'title'>): PaletteItem {
  return { group: 'commands', detail: '', blocked: null, ...partial }
}

describe('scoreCandidate (no fuse.js)', () => {
  it('returns null when the query is not a subsequence of the target', () => {
    expect(scoreCandidate('zzz', 'runs.cancel')).toBeNull()
    expect(scoreCandidate('cancelx', 'runs.cancel')).toBeNull()
  })

  it('matches a scattered subsequence', () => {
    expect(scoreCandidate('rc', 'runs.cancel')).not.toBeNull()
  })

  it('scores an exact match at the maximum', () => {
    expect(scoreCandidate('runs.cancel', 'runs.cancel')).toBe(1)
  })

  it('prefers word-boundary matches over interior ones', () => {
    const boundary = scoreCandidate('rc', 'runs.cancel')!
    const interior = scoreCandidate('rc', 'aaarbbbc')!
    expect(boundary).toBeGreaterThan(interior)
  })
})

describe('parsePaletteQuery (prefixes)', () => {
  it('> restricts to commands and strips the prefix', () => {
    expect(parsePaletteQuery('>cancel')).toEqual({ group: 'commands', text: 'cancel' })
  })

  it('@ restricts to Runs and strips the prefix', () => {
    expect(parsePaletteQuery('@alpha')).toEqual({ group: 'runs', text: 'alpha' })
  })

  it('no prefix searches every group', () => {
    expect(parsePaletteQuery('  alpha ')).toEqual({ group: null, text: 'alpha' })
  })
})

describe('rankPaletteItems (recency, then id, then title)', () => {
  const none = () => 0

  it('excludes an item that matches neither its id nor its title', () => {
    const items = [
      item({ key: 'a', matchId: 'runs.cancel', title: 'Cancel Run' }),
      item({ key: 'b', matchId: 'wiki.list', title: 'List Knowledge Pages' }),
    ]
    expect(rankPaletteItems(items, 'cancel', none).map((entry) => entry.key)).toEqual(['a'])
  })

  it('ranks an id match above a title-only match', () => {
    const items = [
      item({ key: 'title-only', matchId: 'zzz.zzz', title: 'runs cancel something' }),
      item({ key: 'id-match', matchId: 'runs.cancel', title: 'Stop It' }),
    ]
    expect(rankPaletteItems(items, 'runs.cancel', none)[0].key).toBe('id-match')
  })

  it('breaks a tie between equal matches by recency', () => {
    const items = [
      item({ key: 'older', matchId: 'runs.cancel', title: 'Cancel Run' }),
      item({ key: 'newer', matchId: 'runs.cancel', title: 'Cancel Run' }),
    ]
    const recencyOf = (key: string) => (key === 'newer' ? 1 : 0)
    expect(rankPaletteItems(items, 'cancel', recencyOf)[0].key).toBe('newer')
  })

  it('keeps source order when nothing is typed and nothing is recent', () => {
    const items = [
      item({ key: 'first', matchId: 'a.a', title: 'A' }),
      item({ key: 'second', matchId: 'b.b', title: 'B' }),
    ]
    expect(rankPaletteItems(items, '', none).map((entry) => entry.key)).toEqual(['first', 'second'])
  })
})

describe('CommandPalette', () => {
  beforeEach(() => {
    window.localStorage.clear()
    runsStoreMock.active = new Map()
    runsStoreMock.history = [{
      id: 'run-alpha',
      name: 'Alpha TopPIC',
      status: 'SUCCEEDED',
      createdAt: '2026-07-20T10:00:00Z',
    }]
    runsStoreMock.cancel.mockClear()
    runsStoreMock.rerun.mockClear()
    runsStoreMock.trash.mockClear()
    runsStoreMock.restore.mockClear()

    setActivePinia(createPinia())
    useWorkspaceStore().workspaceId = 'ws-1'
  })

  it('renders exactly one native <dialog>, closed until asked for', () => {
    const wrapper = mountPalette()
    const dialogs = wrapper.findAll('dialog')
    expect(dialogs).toHaveLength(1)
    expect((dialogs[0].element as HTMLDialogElement).open).toBe(false)
    wrapper.unmount()
  })

  it('Ctrl+K opens it and a second Ctrl+K closes it', async () => {
    const wrapper = mountPalette()
    const palette = usePaletteStore()
    const dialog = wrapper.find('dialog').element as HTMLDialogElement

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await settle()
    expect(palette.isOpen).toBe(true)
    expect(dialog.open).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await settle()
    expect(palette.isOpen).toBe(false)
    expect(dialog.open).toBe(false)

    wrapper.unmount()
  })

  it('Cmd+K opens it too', async () => {
    const wrapper = mountPalette()
    const palette = usePaletteStore()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', metaKey: true }))
    await settle()
    expect(palette.isOpen).toBe(true)

    wrapper.unmount()
  })

  it('Esc closes it and destroys nothing that was typed', async () => {
    const wrapper = mountPalette()
    const palette = usePaletteStore()
    palette.open()
    palette.setQuery('>cancel')
    await settle()

    wrapper.find('dialog').element.dispatchEvent(new Event('cancel', { cancelable: true }))
    await settle()

    expect(palette.isOpen).toBe(false)
    expect(palette.query).toBe('>cancel')

    wrapper.unmount()
  })

  it('arrow keys move the active option without moving DOM focus off the input', async () => {
    const wrapper = mountPalette()
    const palette = usePaletteStore()
    palette.open()
    await settle()

    const input = wrapper.find('input')
    const first = input.attributes('aria-activedescendant')
    expect(first).toBeTruthy()

    await input.trigger('keydown', { key: 'ArrowDown' })
    const second = input.attributes('aria-activedescendant')
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)

    await input.trigger('keydown', { key: 'ArrowUp' })
    expect(input.attributes('aria-activedescendant')).toBe(first)

    wrapper.unmount()
  })

  it('Enter on a Run opens that Run document and closes', async () => {
    const wrapper = mountPalette()
    const palette = usePaletteStore()
    const documents = useDocumentsStore()
    palette.open()
    palette.setQuery('@alpha')
    await settle()

    await wrapper.find('input').trigger('keydown', { key: 'Enter' })
    await settle()

    expect(documents.openDocuments.map((doc) => doc.id)).toContain('run:run-alpha')
    expect(palette.isOpen).toBe(false)

    wrapper.unmount()
  })

  it('shows a command it cannot deliver, greyed, with the reason beside it (§7.4)', async () => {
    const wrapper = mountPalette()
    const palette = usePaletteStore()
    palette.open()
    palette.setQuery('>nodes.list')
    await settle()

    const row = wrapper.find('.command-palette__row')
    expect(row.exists()).toBe(true)
    expect(row.attributes('aria-disabled')).toBe('true')
    // Blocked rows render one compact muted hint (label · reason) instead of a
    // two-line warning block — they are documentation (§7.5), not errors.
    expect(row.find('.command-palette__row-blocked').text().length).toBeGreaterThan(0)

    wrapper.unmount()
  })

  it('Enter on a blocked command invokes nothing and leaves the palette open', async () => {
    const wrapper = mountPalette()
    const palette = usePaletteStore()
    palette.open()
    palette.setQuery('>runs.overwrite')
    await settle()

    await wrapper.find('input').trigger('keydown', { key: 'Enter' })
    await settle()

    expect(runsStoreMock.rerun).not.toHaveBeenCalled()
    expect(palette.isOpen).toBe(true)

    wrapper.unmount()
  })

  it('a command that needs arguments opens the SchemaForm step instead of running with empty args', async () => {
    const wrapper = mountPalette()
    const palette = usePaletteStore()
    palette.open()
    palette.setQuery('>runs.cancel')
    await settle()

    await wrapper.find('input').trigger('keydown', { key: 'Enter' })
    await settle()

    expect(palette.pendingCommandId).toBe('runs.cancel')
    expect(runsStoreMock.cancel).not.toHaveBeenCalled()
    expect(wrapper.find('.command-palette__args').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'SchemaForm' }).exists()).toBe(true)

    wrapper.unmount()
  })

  it('refuses to submit a required argument that is empty, then invokes through the runs store', async () => {
    const wrapper = mountPalette()
    const palette = usePaletteStore()
    palette.open()
    palette.setQuery('>runs.cancel')
    await settle()
    await wrapper.find('input').trigger('keydown', { key: 'Enter' })
    await settle()

    palette.setDraftArgs({})
    expect(await palette.submitPending()).toBe(false)
    expect(palette.argErrors.runId).toBeTruthy()
    expect(runsStoreMock.cancel).not.toHaveBeenCalled()

    palette.setDraftArgs({ runId: 'run-alpha' })
    expect(await palette.submitPending()).toBe(true)
    expect(runsStoreMock.cancel).toHaveBeenCalledTimes(1)
    expect(runsStoreMock.cancel).toHaveBeenCalledWith('run-alpha')
    expect(palette.isOpen).toBe(false)

    wrapper.unmount()
  })

  it('a failed invocation keeps the palette open with the failure visible', async () => {
    runsStoreMock.cancel.mockRejectedValueOnce(new Error('Backend refused'))
    const wrapper = mountPalette()
    const palette = usePaletteStore()
    palette.open()
    palette.setQuery('>runs.cancel')
    await settle()
    await wrapper.find('input').trigger('keydown', { key: 'Enter' })
    await settle()

    palette.setDraftArgs({ runId: 'run-alpha' })
    expect(await palette.submitPending()).toBe(false)
    await settle()

    expect(palette.isOpen).toBe(true)
    expect(palette.lastError).toBe('Backend refused')
    expect(wrapper.find('.command-palette__args-error').text()).toContain('Backend refused')

    wrapper.unmount()
  })

  it('lists commands, open documents and Runs, and the prefixes narrow to one group', async () => {
    const wrapper = mountPalette()
    const palette = usePaletteStore()
    palette.open()
    await settle()

    expect(new Set(palette.groupedResults.map((group) => group.group)))
      .toEqual(new Set(['commands', 'documents', 'runs']))

    palette.setQuery('>')
    await settle()
    expect(palette.groupedResults.map((group) => group.group)).toEqual(['commands'])

    palette.setQuery('@')
    await settle()
    expect(palette.groupedResults.map((group) => group.group)).toEqual(['runs'])

    wrapper.unmount()
  })

  it('reaches the Settings document, which has no route of its own (§3.1)', async () => {
    const wrapper = mountPalette()
    const palette = usePaletteStore()
    const documents = useDocumentsStore()
    palette.open()
    palette.setQuery('settings')
    await settle()

    await wrapper.find('input').trigger('keydown', { key: 'Enter' })
    await settle()

    expect(documents.openDocuments.map((doc) => doc.id)).toContain('settings')

    wrapper.unmount()
  })

  it('offers every Settings section as its own reachable entry', () => {
    const palette = usePaletteStore()
    const sectionItems = palette.allItems.filter((item) => item.settingsSection)
    expect(sectionItems.map((item) => item.settingsSection)).toEqual([
      'general', 'providers', 'statistics', 'permissions', 'agent-tools', 'mcp', 'sharing', 'appearance',
    ])
  })

  it('a section entry focuses the requested section through the documents store', async () => {
    const wrapper = mountPalette()
    const palette = usePaletteStore()
    const documents = useDocumentsStore()
    palette.open()
    palette.setQuery('settings: statistics')
    await settle()

    await wrapper.find('input').trigger('keydown', { key: 'Enter' })
    await settle()

    expect(documents.openDocuments.map((doc) => doc.id)).toContain('settings')
    expect(documents.requestedSettingsSection).toBe('statistics')

    wrapper.unmount()
  })
})
