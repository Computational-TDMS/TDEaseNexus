import { defineAsyncComponent } from 'vue'
import type { ViewerRegistration } from '@/services/visualization/ViewerRegistry'

const registration: ViewerRegistration = {
  id: 'scatter',
  component: defineAsyncComponent(() => import('@/components/visualization/ScatterPlotViewer.vue')),
  label: 'Scatter Plot',
  category: 'plot',
  icon: 'ScatterPlot',
  ports: {
    data: [{ id: 'points', accepts: ['scatter_table'], required: true, requiredColumns: ['x', 'y'] }],
  },
}
export default registration
