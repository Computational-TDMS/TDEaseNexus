import { describe, expect, it } from 'vitest'
import { normalizeFeatureMapViewerInput } from './featuremapInput'
import type { Dataset } from '@/types/visualization'

describe('normalizeFeatureMapViewerInput', () => {
  describe('column resolution', () => {
    it('detects standard interval feature columns by name patterns', () => {
      const dataset: Dataset = {
        id: 'features',
        kind: 'feature_table',
        columns: [
          { name: 'minElutionTime', type: 'number' },
          { name: 'maxElutionTime', type: 'number' },
          { name: 'monoMass', type: 'number' },
          { name: 'apexIntensity', type: 'number' },
        ],
        rows: [
          { minElutionTime: 10, maxElutionTime: 12, monoMass: 500.2, apexIntensity: 1000 },
          { minElutionTime: 20, maxElutionTime: 25, monoMass: 600.5, apexIntensity: 2000 },
        ],
      }

      const result = normalizeFeatureMapViewerInput({ datasets: [dataset] })

      expect(result.axisMapping).toEqual({
        startTime: 'minElutionTime',
        endTime: 'maxElutionTime',
        mass: 'monoMass',
        intensity: 'apexIntensity',
      })
      expect(result.features).toHaveLength(2)
      expect(result.features[0]).toMatchObject({
        startTime: 10, endTime: 12, mass: 500.2, intensity: 1000, index: 0,
      })
      expect(result.features[1]).toMatchObject({
        startTime: 20, endTime: 25, mass: 600.5, intensity: 2000, index: 1,
      })
      expect(result.intensityRange).toEqual([1000, 2000])
    })

    it('falls back endTime to startTime for single-RT TopFD shapes', () => {
      const dataset: Dataset = {
        id: 'topfd',
        kind: 'feature_table',
        columns: [
          { name: 'Feature_ID', type: 'integer' },
          { name: 'Mass', type: 'number' },
          { name: 'Apex_time', type: 'number' },
          { name: 'Abundance', type: 'number' },
        ],
        rows: [
          { Feature_ID: 1, Mass: 13877.44, Apex_time: 26.94, Abundance: 12345 },
        ],
      }

      const result = normalizeFeatureMapViewerInput({ datasets: [dataset] })

      expect(result.axisMapping).toEqual({
        startTime: 'Apex_time',
        endTime: 'Apex_time',
        mass: 'Mass',
        intensity: 'Abundance',
      })
      expect(result.features[0]).toMatchObject({
        startTime: 26.94, endTime: 26.94, mass: 13877.44, intensity: 12345,
      })
    })

    it('survives RunGraph metadata columns with spaces and underscores', () => {
      const dataset: Dataset = {
        id: 'topfd_feature',
        kind: 'feature_table',
        columns: [
          { name: '__run_id', type: 'string' },
          { name: 'Feature ID', type: 'integer' },
          { name: 'Mono Mass', type: 'number' },
          { name: 'Apex Time', type: 'number' },
          { name: 'Abundance', type: 'number' },
          { name: 'Charge', type: 'integer' },
        ],
        rows: [
          { __run_id: 'r1', 'Feature ID': 7, 'Mono Mass': 9123.45, 'Apex Time': 18.5, Abundance: 8100, Charge: 12 },
        ],
      }

      const result = normalizeFeatureMapViewerInput({ datasets: [dataset] })

      expect(result.axisMapping).toEqual({
        startTime: 'Apex Time',
        endTime: 'Apex Time',
        mass: 'Mono Mass',
        intensity: 'Abundance',
      })
      expect(result.features[0]).toMatchObject({
        startTime: 18.5, endTime: 18.5, mass: 9123.45, intensity: 8100,
      })
    })
  })

  describe('precedence (single truth: explicit config wins)', () => {
    it('honors config.axisMapping over pattern detection', () => {
      const dataset: Dataset = {
        id: 'features',
        kind: 'feature_table',
        columns: [
          { name: 'minElutionTime', type: 'number' },
          { name: 'maxElutionTime', type: 'number' },
          { name: 'monoMass', type: 'number' },
          { name: 'apexIntensity', type: 'number' },
        ],
        rows: [{ minElutionTime: 10, maxElutionTime: 12, monoMass: 500, apexIntensity: 100 }],
      }

      const result = normalizeFeatureMapViewerInput({
        datasets: [dataset],
        config: { axisMapping: { startTime: 'maxElutionTime', endTime: 'minElutionTime', mass: 'monoMass', intensity: 'apexIntensity' } },
      })

      // Even when swapped, startTime/endTime are normalized via min/max
      expect(result.features[0]).toMatchObject({ startTime: 10, endTime: 12 })
    })

    it('honors viewSpec.dataMapping role keys over pattern detection', () => {
      const dataset: Dataset = {
        id: 'features',
        kind: 'feature_table',
        columns: [
          { name: 't1', type: 'number' },
          { name: 't2', type: 'number' },
          { name: 'mw', type: 'number' },
          { name: 'abund', type: 'number' },
        ],
        rows: [{ t1: 5, t2: 8, mw: 700, abund: 900 }],
      }

      const result = normalizeFeatureMapViewerInput({
        datasets: [dataset],
        viewSpec: {
          dataMapping: { datasets: [{ source: 'features', mapping: { x: 't1', xEnd: 't2', y: 'mw', color: 'abund' } }] },
        },
      })

      expect(result.axisMapping).toEqual({ startTime: 't1', endTime: 't2', mass: 'mw', intensity: 'abund' })
    })

    it('honors renderer-packed viewSpec.options column roles', () => {
      const dataset: Dataset = {
        id: 'features',
        kind: 'feature_table',
        columns: [
          { name: 'rt_start', type: 'number' },
          { name: 'rt_end', type: 'number' },
          { name: 'mass_da', type: 'number' },
          { name: 'signal', type: 'number' },
        ],
        rows: [{ rt_start: 2, rt_end: 4, mass_da: 11290, signal: 1000 }],
      }

      const result = normalizeFeatureMapViewerInput({
        datasets: [dataset],
        viewSpec: {
          options: {
            startTimeColumn: 'rt_start',
            endTimeColumn: 'rt_end',
            massColumn: 'mass_da',
            intensityColumn: 'signal',
          },
        },
      })

      expect(result.axisMapping).toEqual({
        startTime: 'rt_start',
        endTime: 'rt_end',
        mass: 'mass_da',
        intensity: 'signal',
      })
      expect(result.features[0]).toMatchObject({
        startTime: 2,
        endTime: 4,
        mass: 11290,
        intensity: 1000,
      })
    })
  })

  describe('kind independence (the core fix)', () => {
    it('produces identical features for kind feature_table vs table', () => {
      const columns = [
        { name: 'Apex Time', type: 'number' as const },
        { name: 'Mono Mass', type: 'number' as const },
        { name: 'Abundance', type: 'number' as const },
      ]
      const rows = [{ 'Apex Time': 30, 'Mono Mass': 1000, Abundance: 5000 }]

      const fromFeatureTable = normalizeFeatureMapViewerInput({
        datasets: [{ id: 'a', kind: 'feature_table', columns, rows }],
      })
      const fromTable = normalizeFeatureMapViewerInput({
        datasets: [{ id: 'b', kind: 'table', columns, rows }],
      })

      expect(fromFeatureTable.axisMapping).toEqual(fromTable.axisMapping)
      expect(fromFeatureTable.features).toEqual(fromTable.features)
    })
  })

  describe('robustness', () => {
    it('drops rows with non-finite start/mass', () => {
      const dataset: Dataset = {
        id: 'features',
        kind: 'feature_table',
        columns: [
          { name: 'start', type: 'number' },
          { name: 'mass', type: 'number' },
        ],
        rows: [
          { start: 10, mass: 500 },
          { start: 'bad', mass: 600 },
          { start: 20, mass: Number.NaN },
        ],
      }

      const result = normalizeFeatureMapViewerInput({ datasets: [dataset] })
      expect(result.features).toHaveLength(1)
      expect(result.features[0]).toMatchObject({ startTime: 10, endTime: 10, mass: 500, intensity: 1 })
    })

    it('defaults intensity to 1 when no intensity column exists', () => {
      const dataset: Dataset = {
        id: 'features',
        kind: 'feature_table',
        columns: [
          { name: 'Apex Time', type: 'number' },
          { name: 'Mono Mass', type: 'number' },
        ],
        rows: [{ 'Apex Time': 5, 'Mono Mass': 800 }],
      }

      const result = normalizeFeatureMapViewerInput({ datasets: [dataset] })
      expect(result.axisMapping.intensity).toBe('')
      expect(result.features[0].intensity).toBe(1)
      expect(result.intensityRange).toEqual([1, 1])
    })

    it('returns empty input when no dataset is provided', () => {
      const result = normalizeFeatureMapViewerInput({})
      expect(result.features).toEqual([])
      expect(result.totalRows).toBe(0)
      expect(result.sampled).toBe(false)
    })

    it('uniformly samples when exceeding maxTraces', () => {
      const rows = Array.from({ length: 100 }, (_, i) => ({
        'Apex Time': i, 'Mono Mass': 1000 + i, Abundance: i + 1,
      }))
      const dataset: Dataset = {
        id: 'features',
        kind: 'feature_table',
        columns: [
          { name: 'Apex Time', type: 'number' },
          { name: 'Mono Mass', type: 'number' },
          { name: 'Abundance', type: 'number' },
        ],
        rows,
      }

      const result = normalizeFeatureMapViewerInput({ datasets: [dataset], maxTraces: 10 })
      expect(result.sampled).toBe(true)
      expect(result.totalRows).toBe(100)
      expect(result.features.length).toBeLessThanOrEqual(10)
      expect(result.features.length).toBeGreaterThan(0)
    })

    it('ignores a stale config.axisMapping that references non-existent columns', () => {
      // Regression: a persisted mapping from a different dataset shape would
      // previously force non-existent columns, filter every row, and render
      // "No data". The resolver must fall back to pattern detection when the
      // configured column is absent from the dataset.
      const dataset: Dataset = {
        id: 'features',
        kind: 'feature_table',
        columns: [
          { name: 'Apex_time', type: 'number' },
          { name: 'Mass', type: 'number' },
          { name: 'Intensity', type: 'number' },
        ],
        rows: [{ Apex_time: 13.1, Mass: 6000, Intensity: 7777 }],
      }

      const result = normalizeFeatureMapViewerInput({
        datasets: [dataset],
        config: {
          axisMapping: { startTime: 'min_elution_time', endTime: 'max_elution_time', mass: 'mono_mass', intensity: 'apex_intensity' },
        },
      })

      // Fell back to detection, not the stale names
      expect(result.axisMapping).toEqual({
        startTime: 'Apex_time',
        endTime: 'Apex_time',
        mass: 'Mass',
        intensity: 'Intensity',
      })
      expect(result.features).toHaveLength(1)
    })

    it('honors config.axisMapping when the columns it names actually exist', () => {
      const dataset: Dataset = {
        id: 'features',
        kind: 'feature_table',
        columns: [
          { name: 't1', type: 'number' },
          { name: 't2', type: 'number' },
          { name: 'mw', type: 'number' },
          { name: 'abund', type: 'number' },
        ],
        rows: [{ t1: 5, t2: 8, mw: 700, abund: 900 }],
      }

      const result = normalizeFeatureMapViewerInput({
        datasets: [dataset],
        config: { axisMapping: { startTime: 't1', endTime: 't2', mass: 'mw', intensity: 'abund' } },
      })

      expect(result.axisMapping).toEqual({ startTime: 't1', endTime: 't2', mass: 'mw', intensity: 'abund' })
      expect(result.features[0]).toMatchObject({ startTime: 5, endTime: 8, mass: 700, intensity: 900 })
    })

    it('never resolves a `__`-prefixed RunGraph metadata column as an axis', () => {
      // Regression for the real TopFD runtime: 24-column output where the
      // `__port_id` column ("ms1feature") was matched by the `rt` pattern
      // (po**rt**_id) and selected as startTime, filtering all 500 rows.
      const realTopfdColumns = [
        '__run_name', '__run_id', '__workflow_id', '__node_id', '__port_id',
        '__sample', 'File_name', 'Fraction_ID', 'Feature_ID', 'Mass',
        'Intensity', 'Min_time', 'Max_time', 'Min_scan', 'Max_scan',
        'Min_charge', 'Max_charge', 'Apex_time', 'Apex_scan', 'Apex_intensity',
        'Rep_charge', 'Rep_average_mz', 'Envelope_num', 'EC_score',
      ]
      const dataset: Dataset = {
        id: 'ms1feature',
        kind: 'feature_table',
        columns: realTopfdColumns.map((name) => ({ name, type: 'string' as const })),
        rows: [{
          __run_name: 'bacteria', __run_id: 'c064', __workflow_id: 'wf',
          __node_id: 'topfd_1', __port_id: 'ms1feature', __sample: 's1',
          File_name: 'bacteria.ms1', Fraction_ID: '1', Feature_ID: '43',
          Mass: '6000.0', Intensity: '7777.0', Min_time: '12.8', Max_time: '13.4',
          Min_scan: '100', Max_scan: '120', Min_charge: '5', Max_charge: '20',
          Apex_time: '13.1', Apex_scan: '110', Apex_intensity: '7777.0',
          Rep_charge: '12', Rep_average_mz: '500.0', Envelope_num: '3', EC_score: '0.9',
        }],
      }

      const result = normalizeFeatureMapViewerInput({ datasets: [dataset] })

      // Axes must resolve to real feature columns, not metadata
      expect(result.axisMapping.startTime).not.toMatch(/^__/)
      expect(result.axisMapping.mass).toBe('Mass')
      expect(result.features).toHaveLength(1)
      expect(result.features[0]).toMatchObject({
        startTime: 12.8, endTime: 13.4, mass: 6000, intensity: 7777,
      })
    })
  })

  describe('legacy TableData input', () => {
    it('normalizes a plain TableData object', () => {
      const result = normalizeFeatureMapViewerInput({
        data: {
          columns: [
            { id: 'start', name: 'start', type: 'number', visible: true },
            { id: 'mass', name: 'mass', type: 'number', visible: true },
          ],
          rows: [{ start: 10, mass: 500 }],
          totalRows: 1,
          sourceFile: 'features.tsv',
        },
      })

      expect(result.totalRows).toBe(1)
      expect(result.features[0]).toMatchObject({ startTime: 10, endTime: 10, mass: 500 })
    })
  })
})
