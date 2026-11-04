import { defineAsyncComponent } from 'vue'
import type { ViewerRegistration } from '@/services/visualization/ViewerRegistry'

/**
 * MetricsCardViewer had no registration module, so the registry's
 * `import.meta.glob` over this directory never picked it up and the viewer was
 * unreachable. This is that missing entry.
 */
const registration: ViewerRegistration = {
  id: 'metrics_card',
  component: defineAsyncComponent(() => import('@/components/visualization/viewers/MetricsCardViewer.vue')),
  label: 'QC Metrics',
  category: 'scientific' as const,
  icon: 'Metrics',
  ports: {
    data: [{ id: 'metrics', accepts: ['metrics'], required: true }],
  },
}
export default registration
