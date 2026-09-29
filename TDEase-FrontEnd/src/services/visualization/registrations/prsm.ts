import { defineAsyncComponent } from 'vue'
import type { ViewerRegistration } from '@/services/visualization/ViewerRegistry'
import { compilePrsm } from '@/services/visualization/viewerCompilers'

const registration: ViewerRegistration = {
  id: 'prsm',
  component: defineAsyncComponent(() => import('@/components/visualization/PrsmViewer.vue')),
  label: 'PrSM Viewer',
  category: 'scientific',
  icon: 'Sequence',
  gallery: { size: 'tall' },
  ports: {
    data: [
      { id: 'prsms', accepts: ['prsm_table'], required: true },
      { id: 'spectra', accepts: ['ms2_spectra'], required: true },
    ],
    selectionInputs: [{ id: 'prsm', kind: 'proteomics/prsm', keyField: 'prsm.id' }],
  },
  compile: compilePrsm,
}

export default registration
