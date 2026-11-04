import { defineAsyncComponent } from 'vue'
import type { ViewerRegistration } from '@/services/visualization/ViewerRegistry'
import { compileTable } from '@/services/visualization/viewerCompilers'

const registration: ViewerRegistration = {
  id: 'table',
  component: defineAsyncComponent(() => import('@/components/visualization/TableViewer.vue')),
  label: 'Data Table',
  category: 'table',
  icon: 'Table',
  defaultConfig: { pageSize: 50 },
  ports: {
    data: [{ id: 'rows', accepts: ['table'], required: true }],
  },
  compile: compileTable,
}
export default registration
