import { defineAsyncComponent } from 'vue'
import type { ViewerRegistration } from '@/services/visualization/ViewerRegistry'

const registration: ViewerRegistration = {
  id: 'fragment_annotation',
  component: defineAsyncComponent(() => import('@/components/visualization/FragmentAnnotationViewer.vue')),
  label: 'Fragment Annotation',
  category: 'scientific',
  icon: 'ChartScatter',
  ports: {
    data: [
      { id: 'peaks', accepts: ['peak_table'], required: true, requiredColumns: ['mz', 'intensity'] },
      { id: 'annotations', accepts: ['annotation_table'] },
      { id: 'c_ion_error', accepts: ['heatmap_grid'], requiredColumns: ['position', 'charge', 'value'] },
      { id: 'z_ion_error', accepts: ['heatmap_grid'] },
    ],
  },
}
export default registration
