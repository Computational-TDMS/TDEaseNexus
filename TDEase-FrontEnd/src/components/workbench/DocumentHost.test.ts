import workbenchZh from '@/locales/zh-CN/workbench.json'
import { beforeEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import DocumentHost from './DocumentHost.vue'
import { useDocumentsStore } from '@/stores/documents'
import { useWorkspaceStore } from '@/stores/workspace'
import type { DocumentKey } from '@/studio/domain/document'

const stubs = {
  'el-icon': true,
  RunDocument: defineComponent({
    name: 'RunDocumentStub',
    props: { runId: String },
    setup: (props) => () => h('div', { class: 'run-document-stub' }, props.runId),
  }),
  FileDocument: defineComponent({
    name: 'FileDocumentStub',
    props: { workspaceId: String, path: String },
    setup: (props) => () => h('div', { class: 'file-document-stub' }, `${props.workspaceId}:${props.path}`),
  }),
  ResultDocument: defineComponent({
    name: 'ResultDocumentStub',
    props: { resultRef: Object },
    setup: (props) => () => h('div', { class: 'result-document-stub' }, JSON.stringify(props.resultRef)),
  }),
  SettingsDocument: defineComponent({ name: 'SettingsDocumentStub', setup: () => () => h('div', { class: 'settings-document-stub' }) }),
}

/** Bypasses `open()`'s branded-value construction to place an arbitrary
 * `DocumentKey` (including a deliberately invalid one) directly on the
 * store, the way a corrupted persisted tab list would arrive. */
function setActiveKey(key: DocumentKey, id = 'doc-1') {
  const documentsStore = useDocumentsStore()
  documentsStore.openDocuments.push({ key, id, title: 'Doc', pinned: false, dirty: false, lastActiveAt: Date.now() })
  const group = documentsStore.ensureFocusedGroup()
  group.tabs = [id]
  group.activeId = id
}

describe('DocumentHost', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    const workspaceStore = useWorkspaceStore()
    await workspaceStore.setWorkspace('demo', { id: 'ws-1' })
    const documentsStore = useDocumentsStore()
    documentsStore.reset()
  })

  it('dispatches run-index to a real component', async () => {
    const documentsStore = useDocumentsStore()
    documentsStore.openRunIndex('ws-1')
    const wrapper = mount(DocumentHost, { global: { stubs } })
    // run-index registers an async component so ag-grid stays out of the
    // entry chunk; let the dynamic import resolve before asserting. With no
    // runs the real document renders its empty state, so no ag-grid mounts.
    await import('@/components/documents/RunIndexDocument.vue')
    await flushPromises()
    expect(wrapper.find('.run-index').exists()).toBe(true)
  })

  it('dispatches run to a real component with the runId', async () => {
    setActiveKey({ kind: 'run', runId: 'run-1' } as DocumentKey)
    const wrapper = mount(DocumentHost, { global: { stubs } })
    // The document rows are async components (heavy deps stay out of the
    // entry chunk); resolve the import before asserting — same as run-index.
    // The fresh-import chain (ag-grid graph) routinely exceeds the 5s default
    // when the full suite's workers compete for disk/CPU, so this test owns
    // an explicit budget instead of flaking on the global one.
    await import('@/components/documents/RunDocument.vue')
    await flushPromises()
    expect(wrapper.find('.run-document-stub').text()).toBe('run-1')
  }, 30_000)

  it('dispatches file to a real component with workspaceId and path', async () => {
    setActiveKey({ kind: 'file', workspaceId: 'ws-1', path: 'runs/run-1/a.csv' } as DocumentKey)
    const wrapper = mount(DocumentHost, { global: { stubs } })
    await import('@/components/documents/FileDocument.vue')
    await flushPromises()
    expect(wrapper.find('.file-document-stub').text()).toBe('ws-1:runs/run-1/a.csv')
  })

  it('dispatches result with its complete identity', async () => {
    const ref = { workspaceId: 'ws-1', runId: 'run-1', resultId: 'r1', digest: 'a'.repeat(64) }
    setActiveKey({ kind: 'result', ref } as DocumentKey)
    const wrapper = mount(DocumentHost, { global: { stubs } })
    await import('@/components/documents/ResultDocument.vue')
    await flushPromises()
    expect(wrapper.find('.result-document-stub').text()).toBe(JSON.stringify(ref))
  })

  it('renders the analysis-review not-built state, distinct from the guide', () => {
    setActiveKey({ kind: 'analysis-review', planRef: 'plan-1' } as DocumentKey)
    const wrapper = mount(DocumentHost, { global: { stubs } })

    expect(wrapper.text()).not.toContain(workbenchZh.welcome.title)
    expect(wrapper.text()).not.toContain('暂不可用') // the old shared "unavailable" fallback string
    expect(wrapper.find('.run-index-stub').exists()).toBe(false)
    expect(wrapper.find('.run-document-stub').exists()).toBe(false)
    expect(wrapper.find('.file-document-stub').exists()).toBe(false)
  })

  it('dispatches settings to the reused components/settings surface', async () => {
    const documentsStore = useDocumentsStore()
    documentsStore.openSettings()
    const wrapper = mount(DocumentHost, { global: { stubs } })
    await import('@/components/documents/SettingsDocument.vue')
    await flushPromises()
    expect(wrapper.find('.settings-document-stub').exists()).toBe(true)
  })

  it('shows the guide when no document is open', () => {
    const wrapper = mount(DocumentHost, { global: { stubs } })
    expect(wrapper.text()).toContain(workbenchZh.welcome.title)
    expect(wrapper.text()).toContain(workbenchZh.welcome.workspaceTitle)
  })

  it('Ctrl+Tab walks the store MRU order (one listener for the whole group area)', async () => {
    const documentsStore = useDocumentsStore()
    documentsStore.open({ kind: 'run', runId: 'run-1' } as never, { title: 'run-1', preview: false })
    documentsStore.open({ kind: 'run', runId: 'run-2' } as never, { title: 'run-2', preview: false })
    documentsStore.select('run:run-1')

    mount(DocumentHost, { global: { stubs } })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true }))

    expect(documentsStore.activeDocumentId).toBe('run:run-2')
  })

  it('fails loudly for an unmapped DocumentKey.kind instead of silently rendering the generic Empty', () => {
    setActiveKey({ kind: 'bogus-kind' } as unknown as DocumentKey)

    // §5.1: "an unmapped key is a startup assertion failure" — this is not
    // a state the shell recovers from into a friendly screen; mounting
    // itself throws, with a message naming the offending kind.
    expect(() => mount(DocumentHost, { global: { stubs } }))
      .toThrow(/no dispatch for DocumentKey\.kind = "bogus-kind"/)
  })
})
