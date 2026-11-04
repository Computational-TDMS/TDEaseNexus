import { describe, expect, it } from 'vitest'
import { normalizeSpectrumViewerInput, peakTableToSpectra } from './spectrumInput'

describe('peakTableToSpectra', () => {
  const base = {
    id: 'peaks',
    kind: 'peak_table',
    columns: [
      { name: 'Spectrum ID', type: 'integer' as const },
      { name: 'mass', type: 'number' as const },
      { name: 'intensity', type: 'number' as const },
    ],
    rows: [
      { 'Spectrum ID': 88, mass: 300.1, intensity: 10 },
      { 'Spectrum ID': 88, mass: '400.2', intensity: 20 },
      { 'Spectrum ID': 90, mass: 500.3, intensity: 30 },
    ],
  }

  it('groups rows into scan-attributed spectra and coerces numeric strings', () => {
    const spectra = peakTableToSpectra(base)
    expect(spectra).toHaveLength(2)
    expect(spectra[0]).toMatchObject({
      spectrumId: 88,
      peaks: [{ mz: 300.1, intensity: 10 }, { mz: 400.2, intensity: 20 }],
    })
    expect(spectra[1]).toMatchObject({ spectrumId: 90, peaks: [{ mz: 500.3, intensity: 30 }] })
  })

  it('refuses tables whose peaks cannot be attributed to a scan', () => {
    expect(peakTableToSpectra({ ...base, columns: base.columns.slice(1) })).toEqual([])
  })

  it('refuses tables without a mass column', () => {
    expect(peakTableToSpectra({ ...base, columns: [base.columns[0]] })).toEqual([])
  })

  it('skips rows with unusable masses instead of fabricating peaks', () => {
    const spectra = peakTableToSpectra({
      ...base,
      rows: [
        { 'Spectrum ID': 88, mass: 'bad', intensity: 10 },
        { 'Spectrum ID': 88, mass: 300.1, intensity: 10 },
      ],
    })
    expect(spectra).toHaveLength(1)
    expect(spectra[0].peaks).toEqual([{ index: 0, mz: 300.1, intensity: 10 }])
  })
})

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
