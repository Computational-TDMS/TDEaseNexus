import { defineAsyncComponent } from 'vue'
import type { ViewerRegistration } from '@/services/visualization/ViewerRegistry'

const registration: ViewerRegistration = {
  id: 'plotly',
  component: defineAsyncComponent(() => import('@/components/visualization/PlotlyViewer.vue')),
  label: 'Plotly',
  category: 'plot',
  icon: 'ChartScatter',
  ports: {
    data: [{ id: 'figure', accepts: ['plotly_figure'], cardinality: 'many', required: true }],
  },
}

export default registration
