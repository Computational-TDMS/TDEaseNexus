import { defineAsyncComponent } from 'vue'
import type { ViewerRegistration } from '@/services/visualization/ViewerRegistry'

const registration: ViewerRegistration = {
  id: 'heatmap',
  component: defineAsyncComponent(() => import('@/components/visualization/HeatmapViewer.vue')),
  label: 'Heatmap',
  category: 'plot',
  icon: 'Heatmap',
  ports: {
    data: [{ id: 'matrix', accepts: ['heatmap_table'], required: true, requiredColumns: ['row', 'col', 'value'] }],
  },
  defaultConfig: { colorScheme: 'viridis', missingValueColor: '#d3d3d3' },
}
export default registration
