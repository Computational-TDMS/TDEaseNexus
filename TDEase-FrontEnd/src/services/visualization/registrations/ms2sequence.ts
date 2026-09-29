import { defineAsyncComponent } from 'vue'
import type { ViewerRegistration } from '@/services/visualization/ViewerRegistry'

const registration: ViewerRegistration = {
  id: 'fragment_spectrum',
  component: defineAsyncComponent(() => import('@/components/visualization/MS2SpectrumViewer.vue')),
  label: 'MS2 Sequence',
  category: 'scientific',
  icon: 'Sequence',
  ports: {
    data: [
      { id: 'peaks_table', accepts: ['peak_table'], required: true, requiredColumns: ['mass', 'intensity'] },
      { id: 'ions_table', accepts: ['annotation_table'] },
      { id: 'error_scatter', accepts: ['error_scatter'], requiredColumns: ['position', 'ppm_error'] },
    ],
  },
}
export default registration
