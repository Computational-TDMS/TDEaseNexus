import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { OpenDocument } from '@/studio/domain/document'
import { useWorkspaceStore } from './workspace'
import { documentId, useDocumentsStore } from './documents'

async function openWorkspace(id = 'ws-1', path = 'demo') {
  const workspaceStore = useWorkspaceStore()
  await workspaceStore.setWorkspace(path, { id })
  return workspaceStore
}

describe('documentStore', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
  })

  it('opening a Workspace lands on the Run Index', async () => {
    await openWorkspace()
    const store = useDocumentsStore()

    expect(store.activeKey).toEqual({ kind: 'run-index', workspaceId: 'ws-1' })
    expect(store.openDocuments).toHaveLength(1)
  })

  it('a preview tab is replaced rather than accumulated', async () => {
    await openWorkspace()
    const store = useDocumentsStore()

    store.openRun('run-1') // preview by default
    expect(store.openDocuments.map((doc) => doc.id)).toContain('run:run-1')
    expect(store.openDocuments).toHaveLength(2) // run-index (open) + run-1 (preview)

    store.openRun('run-2') // replaces the run-1 preview, does not accumulate
    const ids = store.openDocuments.map((doc) => doc.id)
    expect(ids).not.toContain('run:run-1')
    expect(ids).toContain('run:run-2')
    expect(store.openDocuments).toHaveLength(2)
    expect(store.previewDocumentId).toBe('run:run-2')
  })

  it('keeping a preview tab promotes it to Open tier and a further preview no longer replaces it', async () => {
    await openWorkspace()
    const store = useDocumentsStore()

    store.openRun('run-1')
    store.keep('run:run-1')
    expect(store.previewDocumentId).toBeNull()

    store.openRun('run-2')
    const ids = store.openDocuments.map((doc) => doc.id)
    expect(ids).toContain('run:run-1')
    expect(ids).toContain('run:run-2')
    expect(store.openDocuments).toHaveLength(3)
  })

  it('walks Ctrl+Tab in MRU order, not tab-strip (spatial) order', async () => {
    await openWorkspace()
    const store = useDocumentsStore()

    store.openRun('run-1', { preview: false })
    store.openRun('run-2', { preview: false })
    store.openRun('run-3', { preview: false })
    // Spatial/creation order: run-index, run-1, run-2, run-3. Re-visit run-1
    // out of that order so MRU and spatial order diverge.
    store.select('run:run-1')

    // MRU is now [run-1, run-3, run-2, run-index]. The next hop must be
    // run-3 (last visited before run-1), not run-2 (its spatial neighbour).
    store.selectByMruOffset(1)
    expect(store.activeDocumentId).toBe('run:run-3')
  })

  it('split clones the active document into a NEW group that owns its tabs', async () => {
    await openWorkspace()
    const store = useDocumentsStore()
    store.open({ kind: 'run', runId: 'run-1' } as never, { title: 'run-1', preview: false })
    store.open({ kind: 'run', runId: 'run-2' } as never, { title: 'run-2', preview: false })
    const firstGroup = store.focusedGroupId!

    store.splitFocusedGroup('horizontal')
    expect(store.layoutRoot).toMatchObject({ kind: 'branch', orientation: 'horizontal' })
    const cloneGroup = store.groupOf(store.focusedGroupId!)!
    expect(cloneGroup.id).not.toBe(firstGroup)
    expect(cloneGroup.tabs).toEqual(['run:run-2'])
    expect(store.activeDocumentId).toBe('run:run-2')

    // The original group keeps its own stack; activating there must not
    // disturb the clone group.
    store.activateInGroupAndFocus(firstGroup, 'run:run-1')
    expect(store.groupOf(firstGroup)!.tabs).toEqual(['run-index:ws-1', 'run:run-1', 'run:run-2'])
    expect(store.activeDocumentId).toBe('run:run-1')

    // Rotating flips the branch the focused group lives in.
    store.rotateFocusedBranch()
    expect(store.layoutRoot).toMatchObject({ kind: 'branch', orientation: 'vertical' })
  })

  it('any group can split again, and closing a group rebalances the tree', async () => {
    await openWorkspace()
    const store = useDocumentsStore()
    store.open({ kind: 'run', runId: 'run-1' } as never, { title: 'run-1', preview: false })

    store.splitFocusedGroup('horizontal')
    const second = store.focusedGroupId!
    store.splitFocusedGroup('vertical') // nested: the clone splits again
    const third = store.focusedGroupId!
    expect(store.layoutRoot).toMatchObject({
      kind: 'branch',
      orientation: 'horizontal',
      right: { kind: 'branch', orientation: 'vertical' },
    })
    expect(store.groupIdsOf(store.layoutRoot!)).toHaveLength(3)

    // Closing the middle group folds the tree: its sibling absorbs the slot.
    expect(store.closeGroup(second)).toBe(true)
    expect(store.groupIdsOf(store.layoutRoot!)).toEqual([firstLeafId(store), third])

    // Closing down to one group leaves a single leaf; closeGroup refuses the
    // last group (nothing to rebalance into).
    store.focusGroup(third)
    expect(store.closeGroup(third)).toBe(true)
    expect(store.layoutRoot!.kind).toBe('group')
    expect(store.closeGroup(store.focusedGroupId!)).toBe(true)
    expect(store.groupIdsOf(store.layoutRoot!)).toHaveLength(1)

    function firstLeafId(s: typeof store): string {
      return s.groupIdsOf(s.layoutRoot!)[0]!
    }
  })

  it('closing the document a cloned group shows prunes that group', async () => {
    await openWorkspace()
    const store = useDocumentsStore()
    store.open({ kind: 'run', runId: 'run-1' } as never, { title: 'run-1', preview: false })
    store.open({ kind: 'run', runId: 'run-2' } as never, { title: 'run-2', preview: false })
    store.splitFocusedGroup('horizontal')

    store.close('run:run-2')
    expect(store.layoutRoot!.kind).toBe('group')
    expect(store.openDocuments.map((doc) => doc.id)).toEqual(['run-index:ws-1', 'run:run-1'])
  })

  it('open() lands in the focused group', async () => {
    await openWorkspace()
    const store = useDocumentsStore()
    store.open({ kind: 'run', runId: 'run-1' } as never, { title: 'run-1', preview: false })
    const firstGroup = store.focusedGroupId!
    store.splitFocusedGroup('horizontal') // focus moves to the clone

    store.open({ kind: 'run', runId: 'run-2' } as never, { title: 'run-2', preview: false })
    expect(store.groupOf(store.focusedGroupId!)!.tabs).toEqual(['run:run-1', 'run:run-2'])
    expect(store.groupOf(firstGroup)!.tabs).toEqual(['run-index:ws-1', 'run:run-1'])

    store.focusGroup(firstGroup)
    store.open({ kind: 'run', runId: 'run-3' } as never, { title: 'run-3', preview: false })
    expect(store.groupOf(firstGroup)!.tabs).toEqual(['run-index:ws-1', 'run:run-1', 'run:run-3'])
    expect(store.activeDocumentId).toBe('run:run-3')
  })

  it('a tab moves between groups and drags out into a directional split', async () => {
    await openWorkspace()
    const store = useDocumentsStore()
    store.open({ kind: 'run', runId: 'run-1' } as never, { title: 'run-1', preview: false })
    store.open({ kind: 'run', runId: 'run-2' } as never, { title: 'run-2', preview: false })
    store.open({ kind: 'run', runId: 'run-3' } as never, { title: 'run-3', preview: false })
    const firstGroup = store.focusedGroupId!
    store.splitFocusedGroup('horizontal') // clones the ACTIVE doc (run-3)
    const cloneGroup = store.focusedGroupId!
    expect(store.groupOf(cloneGroup)!.tabs).toEqual(['run:run-3'])

    // Cross-group move (the drop-on-center gesture): run-2 leaves the first
    // group and joins the clone.
    expect(store.moveTab('run:run-2', cloneGroup)).toBe(true)
    expect(store.groupOf(cloneGroup)!.tabs).toEqual(['run:run-3', 'run:run-2'])
    expect(store.groupOf(firstGroup)!.tabs).toEqual(['run-index:ws-1', 'run:run-1', 'run:run-3'])

    // Dragging out to a group edge splits a NEW group off in that direction
    // and the tab moves into it.
    expect(store.moveTabToSplit('run:run-2', firstGroup, 'vertical', 'before')).toBe(true)
    const dropped = store.focusedGroupId!
    expect(store.groupOf(dropped)!.tabs).toEqual(['run:run-2'])
    expect(store.groupOf(firstGroup)!.tabs).toEqual(['run-index:ws-1', 'run:run-1', 'run:run-3'])
    expect(store.layoutRoot).toMatchObject({
      kind: 'branch',
      orientation: 'horizontal',
      left: { kind: 'branch', orientation: 'vertical' },
    })

    // Drop next to a tab: within-group reorder.
    expect(store.reorderTab(firstGroup, 'run:run-1', 0)).toBe(true)
    expect(store.groupOf(firstGroup)!.tabs).toEqual(['run:run-1', 'run-index:ws-1', 'run:run-3'])

    // A group's only tab dropped onto its own group/split is a no-op — never
    // an empty group.
    expect(store.moveTab('run:run-2', dropped)).toBe(false)
    expect(store.moveTabToSplit('run:run-2', dropped, 'horizontal', 'after')).toBe(false)
    expect(store.groupIdsOf(store.layoutRoot!)).toHaveLength(3)
  })

  it('dragging a CLONED tab names its drag source group, not the first holder', async () => {
    await openWorkspace()
    const store = useDocumentsStore()
    store.open({ kind: 'settings' } as never, { title: 'Settings', preview: false })
    const a = store.focusedGroupId!
    store.splitFocusedGroup('horizontal')
    const b = store.focusedGroupId!
    // The same document is now a member of both groups.

    // Drag B's member out to A's right edge: the tab must leave B (the named
    // source), not A — a first-holder scan would have stolen A's membership.
    expect(store.moveTabToSplit('settings', a, 'horizontal', 'after', b)).toBe(true)
    const c = store.focusedGroupId!
    expect(store.groupOf(c)!.tabs).toEqual(['settings'])
    expect(store.groupOf(b)).toBeNull() // emptied by the move → pruned
    expect(store.groupOf(a)!.tabs).toEqual(['run-index:ws-1', 'settings'])

    // Dropping C's member onto A merges them (A already holds it — dedupe).
    expect(store.moveTab('settings', a, undefined, c)).toBe(true)
    expect(store.groupOf(c)).toBeNull()
    expect(store.layoutRoot!.kind).toBe('group')
    expect(store.groupOf(a)!.tabs).toEqual(['run-index:ws-1', 'settings'])
  })

  it('restores a stored group layout when every tab it names is restored', async () => {
    window.localStorage.setItem('tdease.ui.ws-1.openDocuments', JSON.stringify([
      { key: { kind: 'run', runId: 'run-1' }, id: 'run:run-1', title: 'run-1', pinned: false, dirty: false, lastActiveAt: 1 },
      { key: { kind: 'run', runId: 'run-2' }, id: 'run:run-2', title: 'run-2', pinned: false, dirty: false, lastActiveAt: 2 },
    ]))
    window.localStorage.setItem('tdease.ui.ws-1.layout', JSON.stringify({
      root: { kind: 'branch', orientation: 'horizontal', ratio: 0.6, left: { kind: 'group', id: 'g1' }, right: { kind: 'group', id: 'g2' } },
      groups: [
        { id: 'g1', tabs: ['run:run-1'], activeId: 'run:run-1' },
        { id: 'g2', tabs: ['run:run-2'], activeId: 'run:run-2' },
      ],
    }))

    await openWorkspace()
    const store = useDocumentsStore()

    expect(store.layoutRoot).toMatchObject({ kind: 'branch', orientation: 'horizontal', ratio: 0.6 })
    expect(store.groupIdsOf(store.layoutRoot!)).toEqual(['g1', 'g2'])
    expect(store.groupOf('g1')!.tabs).toEqual(['run:run-1'])
    expect(store.groupOf('g2')!.tabs).toEqual(['run:run-2'])
    expect(store.focusedGroupId).toBe('g1')
  })

  it('a stored layout naming an unknown tab falls back to one group', async () => {
    window.localStorage.setItem('tdease.ui.ws-1.openDocuments', JSON.stringify([
      { key: { kind: 'run', runId: 'run-1' }, id: 'run:run-1', title: 'run-1', pinned: false, dirty: false, lastActiveAt: 1 },
    ]))
    window.localStorage.setItem('tdease.ui.ws-1.layout', JSON.stringify({
      root: { kind: 'branch', orientation: 'horizontal', ratio: 0.5, left: { kind: 'group', id: 'g1' }, right: { kind: 'group', id: 'g2' } },
      groups: [
        { id: 'g1', tabs: ['run:run-1'], activeId: 'run:run-1' },
        { id: 'g2', tabs: ['run:run-GONE'], activeId: 'run:run-GONE' },
      ],
    }))

    await openWorkspace()
    const store = useDocumentsStore()

    expect(store.layoutRoot!.kind).toBe('group')
    expect(store.groupOf(store.focusedGroupId!)!.tabs).toEqual(['run:run-1'])
  })

  it('a dirty document cannot be closed silently', async () => {
    await openWorkspace()
    const store = useDocumentsStore()

    store.openRun('run-1', { preview: false })
    store.setDirty('run:run-1', true)

    const closed = store.close('run:run-1')
    expect(closed).toBe(false)
    expect(store.openDocuments.map((doc) => doc.id)).toContain('run:run-1')

    const forced = store.close('run:run-1', { force: true })
    expect(forced).toBe(true)
    expect(store.openDocuments.map((doc) => doc.id)).not.toContain('run:run-1')
  })

  it('a restored analysis-review tab keyed on a dead planRef is dropped, not restored broken', async () => {
    const stale: ReadonlyArray<OpenDocument> = [
      {
        key: { kind: 'analysis-review', planRef: 'plan-dead' } as never,
        id: 'analysis-review:plan-dead',
        title: 'Stale review',
        pinned: false,
        dirty: true, // must also never be restored as true
        lastActiveAt: 1,
      },
      {
        key: { kind: 'run', runId: 'run-9' } as never,
        id: 'run:run-9',
        title: 'run-9',
        pinned: false,
        dirty: false,
        lastActiveAt: 2,
      },
    ]
    window.localStorage.setItem('tdease.ui.ws-1.openDocuments', JSON.stringify(stale))

    await openWorkspace()
    const store = useDocumentsStore()

    const ids = store.openDocuments.map((doc) => doc.id)
    expect(ids).not.toContain('analysis-review:plan-dead')
    expect(ids).toContain('run:run-9')
    expect(store.openDocuments.find((doc) => doc.id === 'run:run-9')?.dirty).toBe(false)
  })

  it('drops malformed and cross-Workspace documents during restore', async () => {
    window.localStorage.setItem('tdease.ui.ws-1.openDocuments', JSON.stringify([
      null,
      { id: 'file:ws-1:missing-key', title: 'broken', pinned: false, lastActiveAt: 1 },
      {
        key: { kind: 'file', workspaceId: 'ws-2', path: 'secret.txt' },
        id: 'file:ws-2:secret.txt', title: 'foreign', pinned: false, dirty: false, lastActiveAt: 2,
      },
      {
        key: { kind: 'file', workspaceId: 'ws-1', path: 'analysis.py' },
        id: 'file:ws-1:analysis.py', title: 'analysis.py', pinned: false, dirty: true, lastActiveAt: 3,
      },
    ]))

    await openWorkspace()
    const store = useDocumentsStore()

    expect(store.openDocuments.map((doc) => doc.id)).toEqual(['file:ws-1:analysis.py'])
    expect(store.openDocuments[0]?.dirty).toBe(false)
  })

  it('documentId is stable and collision-free per DocumentKey kind', () => {
    expect(documentId({ kind: 'run-index', workspaceId: 'ws-1' } as never)).toBe('run-index:ws-1')
    expect(documentId({ kind: 'run', runId: 'run-1' } as never)).toBe('run:run-1')
    expect(documentId({ kind: 'wiki', scope: 'workspace', page: 'a.md' } as never)).toBe('wiki:workspace:a.md')
  })

  it('a legacy run-files file tab restores as the runFile variant and round-trips its id', async () => {
    // What persistence wrote before the explicit variant existed: a `file`
    // key whose path encodes `run-files/<runId>/<path>`.
    const legacyId = 'file:ws-1:run-files/run-3/results/sample/table.csv'
    window.localStorage.setItem('tdease.ui.ws-1.openDocuments', JSON.stringify([
      {
        key: { kind: 'file', workspaceId: 'ws-1', path: 'run-files/run-3/results/sample/table.csv' },
        id: legacyId,
        title: 'table.csv',
        pinned: false,
        dirty: true,
        lastActiveAt: 5,
      },
    ]))

    await openWorkspace()
    const store = useDocumentsStore()

    // The key reads back as the explicit variant…
    const doc = store.openDocuments.find((entry) => entry.id === legacyId)
    expect(doc?.key).toEqual({
      kind: 'runFile',
      workspaceId: 'ws-1',
      runId: 'run-3',
      path: 'results/sample/table.csv',
    })
    // …and the variant serializes to the identical string, so the persisted
    // tab, its MRU entry and any group layout slot keep resolving.
    expect(documentId(doc!.key)).toBe(legacyId)
    expect(doc?.dirty).toBe(false)

    // Opening the same Run file again lands on the restored tab — the fresh
    // variant and the legacy encoding are one document, never a duplicate.
    const reopened = store.openRunFile('run-3', 'results/sample/table.csv')
    expect(reopened).toBe(legacyId)
    expect(store.openDocuments).toHaveLength(1)
  })
})
