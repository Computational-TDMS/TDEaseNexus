import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import DocumentTabs from './DocumentTabs.vue'
import { useDocumentsStore } from '@/stores/documents'

function mountTabs() {
  const store = useDocumentsStore()
  const groupId = store.ensureFocusedGroup().id
  const wrapper = mount(DocumentTabs, {
    props: { groupId },
    global: { stubs: { 'el-icon': true, 'el-dropdown': true, 'el-dropdown-menu': true, 'el-dropdown-item': true } },
  })
  return { wrapper, store, groupId }
}

describe('DocumentTabs', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  it('renders a preview tab in italic and an open tab in normal weight', () => {
    const store = useDocumentsStore()
    store.open({ kind: 'run', runId: 'run-1' } as never, { title: 'run-1', preview: true })
    store.open({ kind: 'run', runId: 'run-2' } as never, { title: 'run-2', preview: false })

    const wrapper = mountTabs().wrapper
    const tabs = wrapper.findAll('.document-tabs__tab')
    const preview = tabs.find((tab) => tab.text().includes('run-1'))
    const open = tabs.find((tab) => tab.text().includes('run-2'))

    expect(preview?.classes()).toContain('is-preview')
    expect(open?.classes()).not.toContain('is-preview')
  })

  it('shows a dirty dot instead of a close affordance, and never removes it silently', async () => {
    const store = useDocumentsStore()
    store.open({ kind: 'run', runId: 'run-1' } as never, { title: 'run-1', preview: false })
    store.setDirty('run:run-1', true)

    const wrapper = mountTabs().wrapper
    const tab = wrapper.findAll('.document-tabs__tab').find((t) => t.text().includes('run-1'))!

    expect(tab.find('.document-tabs__dirty-dot').exists()).toBe(true)
    expect(tab.find('.document-tabs__close').exists()).toBe(false)

    expect(store.close('run:run-1')).toBe(false)
    expect(store.openDocuments.map((doc) => doc.id)).toContain('run:run-1')
  })

  it('renders the group its own strip: another group\u2019s tabs do not appear', async () => {
    const store = useDocumentsStore()
    store.open({ kind: 'run', runId: 'run-1' } as never, { title: 'run-1', preview: false })
    const { wrapper, groupId } = mountTabs()
    // A second group holding run-2 (the split clone path) must not leak into
    // this strip — tabs are per-group now, not one shared list.
    const clone = store.splitFocusedGroup('horizontal')
    expect(clone).not.toBeNull()

    const texts = wrapper.findAll('.document-tabs__tab').map((tab) => tab.text())
    expect(texts.join(' ')).not.toContain('run-2')
    expect(store.groupOf(groupId)!.tabs).toEqual(['run:run-1'])
  })
})
