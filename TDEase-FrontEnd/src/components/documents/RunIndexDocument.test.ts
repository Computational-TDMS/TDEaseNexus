import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import type { ColDef } from 'ag-grid-community'
import RunIndexDocument from './RunIndexDocument.vue'
import { useRunsStore } from '@/stores/runs'
import { useWorkspaceStore } from '@/stores/workspace'

const AgGridVueStub = defineComponent({
  name: 'AgGridVueStub',
  props: { columnDefs: { type: Array, required: false, default: () => [] } },
  setup(props, { expose }) {
    expose({ columnDefs: props.columnDefs })
    return () => h('div', { class: 'ag-grid-vue-stub' })
  },
})

function mountDocument() {
  return mount(RunIndexDocument, {
    global: {
      stubs: { AgGridVue: AgGridVueStub, 'el-icon': true },
    },
  })
}

describe('RunIndexDocument', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    const workspaceStore = useWorkspaceStore()
    await workspaceStore.setWorkspace('demo', { id: 'ws-1' })
  })

  // The four example goals used to render here as inert `<li>`s AND in
  // `agent/EmptyState.vue` as clickable buttons.
  // They now live only in the Agent surface,
  // which is where a click can reach a composer. This asserts they stay gone:
  // duplicated onboarding copy is the failure, not missing copy.
  it('renders a one-line empty state and never a second copy of the onboarding goals', () => {
    const wrapper = mountDocument()

    expect(wrapper.text()).toContain('暂无运行')
    expect(wrapper.findAll('.run-index__goals li')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('识别原始文件中的蛋白质异构体')
  })

  it('renders Samples and Results as the honest unknown, never a guessed value', () => {
    const runsStore = useRunsStore()
    runsStore.active.set('run-1', {
      id: 'run-1', name: 'Run 1', workspaceId: 'ws-1', status: 'RUNNING',
      cores: 4, rerunMode: 'resume', labels: {},
      resultCount: 3, createdAt: new Date().toISOString(), lastEventSeq: 0,
    })

    const wrapper = mountDocument()
    const grid = wrapper.findComponent(AgGridVueStub)
    const columnDefs = grid.props('columnDefs') as ColDef[]

    const samples = columnDefs.find((col) => col.colId === 'samples')!
    const results = columnDefs.find((col) => col.colId === 'results')!

    expect((samples.valueGetter as () => string)({} as never)).toBe('—')
    expect((results.valueGetter as () => string)({} as never)).toBe('—')
    expect(typeof samples.tooltipValueGetter).toBe('function')
    expect(typeof results.tooltipValueGetter).toBe('function')
  })
})
