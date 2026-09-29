import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import TableViewer from '@/components/visualization/TableViewer.vue'

const AgGridTableStub = defineComponent({
  name: 'AgGridTableStub',
  props: {
    rowData: { type: Array, required: false, default: () => [] },
    selectionKeyField: { type: String, required: false, default: null },
  },
  emits: ['selection-change', 'cell-clicked'],
  setup(_props, { emit }) {
    return () => h('div', [
      h('button', {
        class: 'emit-selection',
        onClick: () => emit('selection-change', {
          selectedIndices: new Set([1]),
          filterCriteria: [],
          brushRegion: null,
        }),
      }),
      h('button', {
        class: 'emit-link',
        onClick: () => emit('cell-clicked', {
          colId: 'Prsm ID',
          value: 'B-2',
          data: { 'Prsm ID': 'B-2' },
        }),
      }),
      h('button', {
        class: 'emit-identity-selection',
        onClick: () => emit('selection-change', {
          selectedIndices: new Set(),
          selectedRefs: [{ field: 'feature.id', value: 'F-2' }],
          filterCriteria: [],
          brushRegion: null,
        }),
      }),
    ])
  },
})

describe('TableViewer', () => {
  it('enriches emitted selections with selectedRefs when a stable key field exists', async () => {
    const wrapper = mount(TableViewer, {
      props: {
        data: {
          columns: [
            { id: 'Prsm ID', name: 'Prsm ID', type: 'string', visible: true },
            { id: 'value', name: 'value', type: 'number', visible: true },
          ],
          rows: [
            { 'Prsm ID': 'A-1', value: 10 },
            { 'Prsm ID': 'B-2', value: 20 },
          ],
          totalRows: 2,
          sourceFile: 'mock.tsv',
        },
        config: {
          selectionKeyField: 'Prsm ID',
          linkColumns: { 'Prsm ID': 'prsm' },
        },
      },
      global: {
        stubs: {
          AgGridTable: AgGridTableStub,
        },
      },
    })

    await wrapper.find('.emit-selection').trigger('click')
    const selectionEvent = wrapper.emitted('selectionChange')?.[0]?.[0] as { selectedRefs: Array<{ field: string; value: unknown }> }
    expect(selectionEvent.selectedRefs).toEqual([{ field: 'Prsm ID', value: 'B-2' }])

    await wrapper.find('.emit-link').trigger('click')
    const linkSelectionEvent = wrapper.emitted('selectionChange')?.[1]?.[0] as { selectedRefs: Array<{ field: string; value: unknown }> }
    expect(linkSelectionEvent.selectedRefs).toEqual([{ field: 'Prsm ID', value: 'B-2' }])
  })

  it('preserves stable identity refs from the grid for the Canvas dataflow', async () => {
    const wrapper = mount(TableViewer, {
      props: {
        datasets: [{
          id: 'features',
          kind: 'feature_table',
          columns: [{ name: 'feature.id', type: 'string' }],
          rows: [{ 'feature.id': 'F-1' }, { 'feature.id': 'F-2' }],
        }],
        viewSpec: {
          interactionConfig: { selectionKeyField: 'feature.id' },
        },
      },
      global: { stubs: { AgGridTable: AgGridTableStub } },
    })

    await wrapper.find('.emit-identity-selection').trigger('click')

    expect(wrapper.emitted('selectionChange')?.[0]?.[0]).toMatchObject({
      selectedRefs: [{ field: 'feature.id', value: 'F-2' }],
    })
  })
})
