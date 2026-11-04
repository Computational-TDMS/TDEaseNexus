import { defineAsyncComponent } from 'vue'
import type { ViewerRegistration } from '@/services/visualization/ViewerRegistry'

const registration: ViewerRegistration = {
  id: 'media',
  component: defineAsyncComponent(() => import('@/components/visualization/MediaViewer.vue')),
  label: 'Media',
  category: 'scientific',
  icon: 'Image',
  ports: {
    data: [{ id: 'media', accepts: ['media'], required: true, requiredColumns: ['url', 'type', 'label'] }],
  },
}

export default registration
