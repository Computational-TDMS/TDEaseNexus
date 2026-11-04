import type {
  Dataset,
  SemanticSelection,
  SelectionState,
} from '@/types/visualization'

type CompileInput = {
  inputs: Readonly<Record<string, Dataset | readonly Dataset[]>>
  selections: Readonly<Record<string, SemanticSelection | null>>
  params: Readonly<Record<string, unknown>>
}

function values(input: Dataset | readonly Dataset[] | undefined): Dataset[] {
  if (!input) return []
  return Array.isArray(input) ? [...input] : [input]
}

function selectionState(
  selection: SemanticSelection | null | undefined,
  field: string,
): SelectionState | null {
  if (!selection) return null
  return {
    selectedIndices: new Set(),
    selectedRefs: selection.keys.map(value => ({ field, value })),
    filterCriteria: [],
    brushRegion: null,
  }
}

export function projectSpectrumBrushToFeatureIds(
  datasets: readonly Dataset[],
  leftMass: number,
  rightMass: number,
): Array<string | number> {
  const features = datasets.find(dataset => dataset.kind === 'feature_table')
  const peaks = datasets.find(dataset => dataset.kind === 'peak_table')
  const currentScan = Number(peaks?.rows[0]?.['spectrum.scan'])
  if (!features || !Number.isFinite(currentScan)) return []
  const minMass = Math.min(leftMass, rightMass)
  const maxMass = Math.max(leftMass, rightMass)
  return features.rows
    .filter((row) => {
      const mass = Number(row['feature.mass'])
      const minScan = Number(row['feature.minScan'])
      const maxScan = Number(row['feature.maxScan'])
      return Number.isFinite(mass)
        && mass >= minMass && mass <= maxMass
        && minScan <= currentScan && currentScan <= maxScan
    })
    .map(row => row['feature.id'])
    .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
}

export function compileTable(input: CompileInput): {
  datasets: Dataset[]
  selection: SelectionState | null
} {
  const datasets = Object.values(input.inputs).flatMap(values)
  const filters = [
    input.selections.features && { selection: input.selections.features, field: 'feature.id' },
    input.selections.feature && { selection: input.selections.feature, field: 'feature.id' },
    input.selections.spectrum && { selection: input.selections.spectrum, field: 'spectrum.id' },
  ].filter((value): value is { selection: SemanticSelection; field: string } => Boolean(value))
  if (!filters.length) return { datasets, selection: null }
  return {
    datasets: datasets.map(dataset => ({
      ...dataset,
      rows: dataset.rows.filter(row => filters.every(({ selection, field }) =>
        new Set(selection.keys.map(String)).has(String(row[field])),
      )),
    })),
    selection: selectionState(filters[0].selection, filters[0].field),
  }
}

export function compileSpectrum(input: CompileInput): {
  datasets: Dataset[]
  selection: null
} {
  const peaks = values(input.inputs.peaks)
  if (peaks.length) return { datasets: peaks, selection: null }

  const features = values(input.inputs.features)[0]
  const spectra = values(input.inputs.spectra)[0]
  const selected = input.selections.features
  if (!features || !spectra) return { datasets: [], selection: null }

  const keys = new Set(
    selected?.keys.map(String)
      ?? features.rows.slice(0, 1).map(row => String(row['feature.id'])),
  )
  const scans = new Set(
    features.rows
      .filter(row => keys.has(String(row['feature.id'])))
      .map(row => Number(row['feature.apexScan']))
      .filter(Number.isFinite),
  )
  return {
    datasets: [features, ...spectra.rows
      .filter(row => scans.has(Number(row['spectrum.scan'])))
      .map((row, index) => ({
        id: `${spectra.id}:${String(row['spectrum.scan'] ?? index)}`,
        kind: 'peak_table',
        columns: [
          { name: 'mz', type: 'number' as const },
          { name: 'intensity', type: 'number' as const },
        ],
        rows: Array.isArray(row.peaks)
            ? row.peaks.map((peak: Record<string, unknown>) => ({
              mz: peak.mz,
              intensity: peak.intensity,
              'spectrum.scan': row['spectrum.scan'],
            }))
          : [],
      }))],
    selection: null,
  }
}

export function compilePrsm(input: CompileInput): {
  datasets: Dataset[]
  selection: SelectionState | null
} {
  const datasets = Object.values(input.inputs).flatMap(values)
  const selected = input.selections.prsm
  return {
    datasets,
    selection: selectionState(selected, 'prsm.id'),
  }
}
