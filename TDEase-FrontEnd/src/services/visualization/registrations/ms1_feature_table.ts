import { defineAsyncComponent } from 'vue'
import type { ViewerRegistration } from '@/services/visualization/ViewerRegistry'
import { compileTable } from '@/services/visualization/viewerCompilers'

const registration: ViewerRegistration = {
  id: 'ms1_feature_table',
  component: defineAsyncComponent(() => import('@/components/visualization/TableViewer.vue')),
  label: 'MS1 Feature Table',
  category: 'table',
  icon: 'Table',
  gallery: { size: 'compact' },
  ports: {
    data: [{ id: 'rows', accepts: ['feature_table'], required: true }],
    selectionInputs: [{ id: 'features', kind: 'proteomics/feature', keyField: 'feature.id' }],
    selectionOutputs: [{ id: 'feature', kind: 'proteomics/feature', keyField: 'feature.id' }],
  },
  compile: compileTable,
}

export default registration
