import { describe, expect, it } from 'vitest'

import type { Dataset, SemanticSelection } from '@/types/visualization'
import {
  compilePrsm,
  compileSpectrum,
  compileTable,
  projectSpectrumBrushToFeatureIds,
} from './viewerCompilers'

const featureSelection: SemanticSelection = {
  kind: 'proteomics/feature',
  keys: ['F1'],
}

const prsmSelection: SemanticSelection = {
  kind: 'proteomics/prsm',
  keys: ['P1'],
}

const features: Dataset = {
  id: 'features',
  kind: 'feature_table',
  columns: [
    { name: 'feature.id', type: 'string' },
    { name: 'feature.apexScan', type: 'integer' },
  ],
  rows: [
    { 'feature.id': 'F1', 'feature.apexScan': 101 },
    { 'feature.id': 'F2', 'feature.apexScan': 202 },
  ],
}

const prsms: Dataset = {
  id: 'prsms',
  kind: 'prsm_table',
  columns: [
    { name: 'prsm.id', type: 'string' },
    { name: 'feature.id', type: 'string' },
  ],
  rows: [
    { 'prsm.id': 'P1', 'feature.id': 'F1' },
    { 'prsm.id': 'P2', 'feature.id': 'F2' },
  ],
}

describe('interactive proteomics viewer dataflow', () => {
  it('keeps the full table and provides a representative spectrum without a selection', () => {
    expect(compileTable({
      inputs: { rows: features },
      selections: {},
      params: {},
    }).datasets[0]?.rows).toEqual(features.rows)

    const spectrum = compileSpectrum({
      inputs: {
        features,
        spectra: {
          id: 'ms1',
          kind: 'ms1_spectra',
          columns: [{ name: 'spectrum.scan', type: 'integer' }],
          rows: [
            { 'spectrum.scan': 101, peaks: [{ mz: 500.2, intensity: 900 }] },
            { 'spectrum.scan': 202, peaks: [{ mz: 600.3, intensity: 100 }] },
          ],
        },
      },
      selections: {},
      params: {},
    })

    expect(spectrum.datasets.find(dataset => dataset.kind === 'peak_table')?.rows)
      .toEqual([{ mz: 500.2, intensity: 900, 'spectrum.scan': 101 }])
  })

  it('projects an MS1 neutral-mass brush to stable feature IDs at the current scan', () => {
    expect(projectSpectrumBrushToFeatureIds([
      {
        id: 'features', kind: 'feature_table', columns: [], rows: [
          { 'feature.id': 'F1', 'feature.mass': 500, 'feature.minScan': 90, 'feature.maxScan': 110 },
          { 'feature.id': 'F2', 'feature.mass': 500, 'feature.minScan': 120, 'feature.maxScan': 130 },
        ],
      },
      {
        id: 'peaks', kind: 'peak_table', columns: [],
        rows: [{ mz: 500, intensity: 1, 'spectrum.scan': 101 }],
      },
    ], 490, 510)).toEqual(['F1'])
  })

  it('narrows feature, spectrum and PrSM views through semantic selections', () => {
    const selectedFeatures = compileTable({
      inputs: { rows: features },
      selections: { features: featureSelection },
      params: {},
    })
    expect(selectedFeatures.datasets[0]?.rows).toEqual([
      { 'feature.id': 'F1', 'feature.apexScan': 101 },
    ])

    const spectrum = compileSpectrum({
      inputs: {
        features,
        spectra: {
          id: 'ms1',
          kind: 'ms1_spectra',
          columns: [{ name: 'spectrum.scan', type: 'integer' }],
          rows: [
            { 'spectrum.scan': 101, peaks: [{ mz: 500.2, intensity: 900 }] },
            { 'spectrum.scan': 202, peaks: [{ mz: 600.3, intensity: 100 }] },
          ],
        },
      },
      selections: { features: featureSelection },
      params: {},
    })
    expect(spectrum.datasets.filter(dataset => dataset.kind === 'peak_table')).toHaveLength(1)
    expect(spectrum.datasets.find(dataset => dataset.kind === 'peak_table')?.rows)
      .toEqual([{ mz: 500.2, intensity: 900, 'spectrum.scan': 101 }])

    const selectedPrsms = compileTable({
      inputs: { rows: prsms },
      selections: { feature: featureSelection },
      params: {},
    })
    expect(selectedPrsms.datasets[0]?.rows).toEqual([
      { 'prsm.id': 'P1', 'feature.id': 'F1' },
    ])

    const ms2 = compilePrsm({
      inputs: {
        prsms,
        spectra: {
          id: 'ms2',
          kind: 'ms2_spectra',
          columns: [{ name: 'spectrum.id', type: 'string' }],
          rows: [{ 'spectrum.id': 'S1' }],
        },
      },
      selections: { prsm: prsmSelection },
      params: {},
    })
    expect(ms2.selection?.selectedRefs).toEqual([{ field: 'prsm.id', value: 'P1' }])
  })
})
