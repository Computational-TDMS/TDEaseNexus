import { defineAsyncComponent } from 'vue'
import type { ViewerRegistration } from '@/services/visualization/ViewerRegistry'
import { compileSpectrum } from '@/services/visualization/viewerCompilers'

const registration: ViewerRegistration = {
  id: 'spectrum',
  // SpectrumViewer normalizes peak datasets and compiles a Plotly figure.
  component: defineAsyncComponent(() => import('@/components/visualization/SpectrumViewer.vue')),
  label: 'Mass Spectrum',
  category: 'scientific',
  icon: 'Spectrum',
  gallery: { size: 'standard' },
  ports: {
    data: [
      { id: 'peaks', accepts: ['peak_table'], cardinality: 'many' },
      { id: 'features', accepts: ['feature_table'] },
      { id: 'spectra', accepts: ['ms1_spectra'] },
    ],
    selectionInputs: [{ id: 'features', kind: 'proteomics/feature', keyField: 'feature.id' }],
    selectionOutputs: [{ id: 'features', kind: 'proteomics/feature', keyField: 'feature.id' }],
  },
  compile: compileSpectrum,
}
export default registration
