import { defineAsyncComponent } from 'vue'
import type { ViewerRegistration } from '@/services/visualization/ViewerRegistry'

const registration: ViewerRegistration = {
  id: 'volcano',
  component: defineAsyncComponent(() => import('@/components/visualization/VolcanoPlotViewer.vue')),
  label: 'Volcano Plot',
  category: 'plot',
  icon: 'Volcano',
  ports: {
    data: [{ id: 'points', accepts: ['volcano_table'], required: true, requiredColumns: ['fold_change', 'p_value'] }],
  },
}
export default registration
