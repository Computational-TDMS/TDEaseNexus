import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import FilesSection from './FilesSection.vue'
import { useDocumentsStore } from '@/stores/documents'
import { useWorkspaceStore } from '@/stores/workspace'
import type { FileTreeNode } from '@/types/workspace-data'

const watcherState = vi.hoisted(() => ({ started: [] as string[], stopped: [] as string[] }))

// FileTree starts a real file watcher on mount (chokidar in Electron, polling
// in the browser). Neither belongs in a component test, and the polling variant
// would leave an interval running past the assertion.
vi.mock('@/services/workspace/fileWatcher', () => ({
  createFileWatcher: (root: string) => ({
    root,
    on: () => () => {},
    start: async () => { watcherState.started.push(root) },
    stop: async () => { watcherState.stopped.push(root) },
  }),
}))

function dir(path: string, children: FileTreeNode[]): FileTreeNode {
  return {
    name: path.split('/').pop() ?? path,
    path,
    type: 'directory',
    status: 'local',
    children,
    loaded: true,
  }
}

function file(path: string): FileTreeNode {
  return {
    name: path.split('/').pop() ?? path,
    path,
    type: 'file',
    status: 'local',
    loaded: true,
  }
}

async function openWorkspace() {
  const workspaceStore = useWorkspaceStore()
  await workspaceStore.setWorkspace('demo', { id: 'ws-1' })
  return workspaceStore
}

/** The Workspace tree the Files section browses: a wiki note where §3.1.1's
 * role dispatch sends pages to the wiki document, and an ordinary script. */
function seedTree(workspaceStore: ReturnType<typeof useWorkspaceStore>) {
  workspaceStore.fileTree = [
    dir('wiki', [
      file('wiki/method.md'),
    ]),
    file('analysis.py'),
  ]
  workspaceStore.expandedPaths = new Set(['wiki'])
}

function mountSection() {
  return mount(FilesSection, { global: { stubs: { 'el-icon': true } } })
}

describe('openWorkspaceFile — role-first dispatch', () => {
  beforeEach(() => {
    window.localStorage.clear()
    watcherState.started.length = 0
    watcherState.stopped.length = 0
    setActivePinia(createPinia())
  })

  it('opens a wiki/*.md path as the wiki document, not as generic file text', async () => {
    await openWorkspace()
    const documents = useDocumentsStore()

    documents.openWorkspaceFile('wiki/method.md')

    expect(documents.activeKey).toEqual({ kind: 'wiki', scope: 'workspace', page: 'method.md' })
  })

  it('opens an ordinary .py path as a file document', async () => {
    await openWorkspace()
    const documents = useDocumentsStore()

    documents.openWorkspaceFile('analysis.py')

    expect(documents.activeKey).toEqual({ kind: 'file', workspaceId: 'ws-1', path: 'analysis.py' })
    expect(documents.activeDocument?.title).toBe('analysis.py')
  })

  it('normalizes a Windows separator before dispatching', async () => {
    await openWorkspace()
    const documents = useDocumentsStore()

    documents.openWorkspaceFile('wiki\\method.md')

    expect(documents.activeKey).toEqual({ kind: 'wiki', scope: 'workspace', page: 'method.md' })
  })
})

describe('FilesSection', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
  })

  it('offers a way out when no Workspace is open instead of an inert placeholder', async () => {
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-state="no-workspace"]').exists()).toBe(true)
    expect(wrapper.find('.file-tree').exists()).toBe(false)
    // An empty state with no action is the shrug VISUAL-SYSTEM.md §11 forbids.
    expect(wrapper.find('[data-state="no-workspace"] button').exists()).toBe(true)
  })

  it('mounts the existing FileTree — the Workspace tree is reachable from the Rail', async () => {
    const workspaceStore = await openWorkspace()
    seedTree(workspaceStore)

    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('.file-tree').exists()).toBe(true)
    expect(wrapper.find('[data-tree-path="analysis.py"]').exists()).toBe(true)
    expect(wrapper.find('[data-tree-path="wiki/method.md"]').exists()).toBe(true)
  })

  it('rebinds its watcher and restores tree state when the mounted section switches Workspace', async () => {
    const workspaceStore = await openWorkspace()
    workspaceStore.fileTree = [dir('alpha', [file('alpha/a.txt')])]
    window.localStorage.setItem('tdease.tree-state.ws-1', JSON.stringify({ expanded: ['alpha'] }))

    const wrapper = mountSection()
    await flushPromises()
    expect(workspaceStore.expandedPaths.has('alpha')).toBe(true)
    expect(watcherState.started).toContain('demo')

    window.localStorage.setItem('tdease.tree-state.ws-2', JSON.stringify({ expanded: ['beta'] }))
    await workspaceStore.setWorkspace('demo-b', { id: 'ws-2' })
    workspaceStore.fileTree = [dir('beta', [file('beta/b.txt')])]
    await flushPromises()

    expect(watcherState.stopped).toContain('demo')
    expect(watcherState.started).toContain('demo-b')
    expect(workspaceStore.expandedPaths.has('alpha')).toBe(false)
    expect(workspaceStore.expandedPaths.has('beta')).toBe(true)
    wrapper.unmount()
  })

  it('selecting a file in the tree opens it as a document', async () => {
    const workspaceStore = await openWorkspace()
    seedTree(workspaceStore)
    const documents = useDocumentsStore()

    const wrapper = mountSection()
    await flushPromises()

    await wrapper.find('[data-tree-path="analysis.py"]').trigger('click')

    expect(documents.activeKey).toEqual({ kind: 'file', workspaceId: 'ws-1', path: 'analysis.py' })
  })

  // `FileDocument.vue` now reads Workspace bytes through
  // `documentsStore.readWorkspaceFile`, so the old "the tab will be blank"
  // advisory would be a false statement. Silence is the honest outcome: the
  // tab shows the file.
  it('does not warn about a plain Workspace file — the document renders it now', async () => {
    const workspaceStore = await openWorkspace()
    seedTree(workspaceStore)

    const wrapper = mountSection()
    await flushPromises()

    await wrapper.find('[data-tree-path="analysis.py"]').trigger('click')

    expect(wrapper.find('.files-section__note').exists()).toBe(false)
  })
})
