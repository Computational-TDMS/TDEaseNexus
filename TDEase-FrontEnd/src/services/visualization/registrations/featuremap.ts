import { defineAsyncComponent } from 'vue'
import type { ViewerRegistration } from '@/services/visualization/ViewerRegistry'

/**
 * Column-name patterns used to detect feature-map axes when no explicit
 * axisMapping is configured by `featuremapInput.ts`.
 *
 * Matching normalizes spaces/underscores and is substring-based. Patterns must
 * be specific enough to avoid false positives on RunGraph metadata columns
 * (e.g. `__port_id` must never match `rt`). Short ambiguous tokens like `rt`
 * alone are excluded — prefer `retention`, `rt_start`, `rt_end`.
 */
export const FEATUREMAP_COLUMN_PATTERNS = {
  startTime: ['min_elution_time', 'minelutiontime', 'min_time', 'start_time', 'time_start', 'apex_time', 'apextime', 'retention', 'rt_start'],
  endTime: ['max_elution_time', 'maxelutiontime', 'max_time', 'end_time', 'time_end', 'rt_end'],
  mass: ['monoisotopic_mass', 'monoisotopic', 'monomass', 'mass', 'mz'],
  intensity: ['apex_intensity', 'apexintensity', 'intensity', 'abundance'],
} as const

const registration: ViewerRegistration = {
  id: 'featuremap',
  component: defineAsyncComponent(() => import('@/components/visualization/FeatureMapViewer.vue')),
  label: 'Feature Map',
  category: 'plot',
  icon: 'ScatterPlot',
  ports: {
    data: [{ id: 'features', accepts: ['feature_table'], required: true }],
    selectionOutputs: [{ id: 'features', kind: 'proteomics/feature', keyField: 'feature.id' }],
  },
}
export default registration
