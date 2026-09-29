import { describe, expect, it } from 'vitest'
import { normalizeSpectrumViewerInput } from './spectrumInput'

describe('normalizeSpectrumViewerInput', () => {
  it('normalizes multi-series datasets with explicit columns and annotations', () => {
    const input = normalizeSpectrumViewerInput({
      datasets: [
        {
          id: 'experimental',
          kind: 'peak_table',
          label: 'Experimental',
          color: '#409eff',
          columns: [
            { name: 'mass', type: 'number' },
            { name: 'height', type: 'number' },
          ],
          rows: [
            { mass: '500.2', height: '1000' },
            { mass: 'bad', height: 20 },
          ],
        },
        {
          id: 'theoretical',
          kind: 'peak_table',
          direction: 'down',
          columns: [
            { name: 'mz', type: 'number' },
            { name: 'intensity', type: 'number' },
          ],
          rows: [{ mz: 501.3, intensity: 750 }],
        },
      ],
      viewSpec: {
        mzColumn: 'mass',
        intensityColumn: 'height',
        mzRange: [400, '600'],
        annotations: [{ type: 'vline', x: 500.2, label: 'b7' }],
        interactionConfig: { broadcastColumn: 'ion_id' },
      },
    })

    expect(input.series).toHaveLength(1)
    expect(input.series[0]).toMatchObject({
      id: 'experimental',
      label: 'Experimental',
      color: '#409eff',
      direction: 'up',
      mzColumn: 'mass',
      intensityColumn: 'height',
    })
    expect(input.series[0].peaks).toEqual([
      { index: 0, mz: 500.2, intensity: 1000, sourceRow: { mass: '500.2', height: '1000' } },
    ])
    expect(input.annotations).toEqual([{ type: 'vline', x: 500.2, label: 'b7' }])
    expect(input.mzRange).toEqual([400, 600])
    expect(input.interactionConfig).toEqual({ broadcastColumn: 'ion_id' })
  })

  it('falls back to legacy table data and config column mapping', () => {
    const input = normalizeSpectrumViewerInput({
      data: {
        columns: [
          { id: 'mono_mass', name: 'mono_mass', type: 'number', visible: true },
          { id: 'apex', name: 'apex', type: 'number', visible: true },
        ],
        rows: [{ mono_mass: 712.4, apex: 42 }],
        totalRows: 1,
        sourceFile: 'peaks.tsv',
      },
      config: {
        mzColumn: 'mono_mass',
        intensityColumn: 'apex',
        selectionKeyField: 'peak_id',
      },
    })

    expect(input.series).toHaveLength(1)
    expect(input.series[0]).toMatchObject({
      id: 'peaks.tsv',
      label: 'peaks.tsv',
      mzColumn: 'mono_mass',
      intensityColumn: 'apex',
    })
    expect(input.series[0].peaks[0]).toMatchObject({ mz: 712.4, intensity: 42 })
    expect(input.interactionConfig).toEqual({ selectionKeyField: 'peak_id' })
  })

  it('excludes feature_table datasets from spectrum series — a feature table is not a spectrum', () => {
    const input = normalizeSpectrumViewerInput({
      datasets: [{
        id: 'ms1-features',
        kind: 'feature_table',
        columns: [
          { name: 'Feature ID', type: 'number' },
          { name: 'Mono Mass', type: 'number' },
          { name: 'Intensity', type: 'number' },
        ],
        rows: [
          { 'Feature ID': 101, 'Mono Mass': 500.2, Intensity: 1000 },
          { 'Feature ID': 202, 'Mono Mass': 712.4, Intensity: 2000 },
        ],
      }],
      selection: {
        selectedIndices: new Set([1]),
        selectedRefs: [{ field: 'feature_id', value: 202 }],
        filterCriteria: [],
        brushRegion: null,
      },
    })

    // A feature table carries neutral monoisotopic mass, not m/z, and selecting
    // a feature loads its actual spectrum by another path — the spectrum
    // normalizer must not project the feature table itself as a peak series.
    expect(input.series).toEqual([])
  })

  it('keeps all rows when an upstream identity has no field in the target dataset', () => {
    const input = normalizeSpectrumViewerInput({
      datasets: [{
        id: 'peaks',
        kind: 'peak_table',
        columns: [
          { name: 'mz', type: 'number' },
          { name: 'intensity', type: 'number' },
        ],
        rows: [
          { mz: 100, intensity: 10 },
          { mz: 200, intensity: 20 },
        ],
      }],
      selection: {
        selectedIndices: new Set([99]),
        selectedRefs: [{ field: 'unrelated_id', value: 'x' }],
        filterCriteria: [],
        brushRegion: null,
      },
    })

    expect(input.series[0].peaks).toHaveLength(2)
  })
})
