import { defineAsyncComponent } from 'vue'
import type { ViewerRegistration } from '@/services/visualization/ViewerRegistry'
import { compileTable } from '@/services/visualization/viewerCompilers'

const registration: ViewerRegistration = {
  id: 'ms2_feature_table',
  component: defineAsyncComponent(() => import('@/components/visualization/TableViewer.vue')),
  label: 'Associated MS2 Scans',
  category: 'table',
  icon: 'Table',
  gallery: { size: 'compact' },
  ports: {
    data: [{ id: 'rows', accepts: ['ms2_feature_table'], required: true }],
    selectionInputs: [{ id: 'feature', kind: 'proteomics/feature', keyField: 'feature.id' }],
    selectionOutputs: [{ id: 'spectrum', kind: 'proteomics/spectrum', keyField: 'spectrum.id' }],
  },
  compile: compileTable,
}

export default registration
