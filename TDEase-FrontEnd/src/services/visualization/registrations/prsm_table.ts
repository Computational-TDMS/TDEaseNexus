import { defineAsyncComponent } from 'vue'
import type { ViewerRegistration } from '@/services/visualization/ViewerRegistry'
import { compileTable } from '@/services/visualization/viewerCompilers'

const registration: ViewerRegistration = {
  id: 'prsm_table',
  component: defineAsyncComponent(() => import('@/components/visualization/TableViewer.vue')),
  label: 'Filtered PrSM Table',
  category: 'table',
  icon: 'Table',
  gallery: { size: 'compact' },
  ports: {
    data: [{ id: 'rows', accepts: ['prsm_table'], required: true }],
    selectionInputs: [
      { id: 'feature', kind: 'proteomics/feature', keyField: 'feature.id' },
      { id: 'spectrum', kind: 'proteomics/spectrum', keyField: 'spectrum.id' },
    ],
    selectionOutputs: [{ id: 'prsm', kind: 'proteomics/prsm', keyField: 'prsm.id' }],
  },
  compile: compileTable,
}

export default registration
