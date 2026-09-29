import { defineAsyncComponent } from 'vue'

import type { ViewerRegistration } from '@/services/visualization/ViewerRegistry'

const registration: ViewerRegistration = {
  id: 'evidence_graph',
  component: defineAsyncComponent(() => import('@/components/visualization/EvidenceGraphViewer.vue')),
  label: 'Evidence Graph',
  category: 'scientific',
  icon: 'GitBranch',
  ports: {
    data: [
      { id: 'nodes', accepts: ['evidence_nodes'], required: true, requiredColumns: ['id', 'kind'] },
      { id: 'edges', accepts: ['evidence_edges'], required: true, requiredColumns: ['from', 'to', 'kind'] },
    ],
  },
}

export default registration
