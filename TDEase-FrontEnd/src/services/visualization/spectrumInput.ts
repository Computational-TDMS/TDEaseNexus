import type {
  Annotation,
  Dataset,
  InteractionConfig,
  SelectionState,
  SpectrumViewerInput,
  TableData,
} from '@/types/visualization'
import { projectDatasetRowsByIdentity } from '@/services/visualization/selectionProjection'

const MZ_PATTERNS = ['m/z', 'mz']
const INTENSITY_PATTERNS = ['intensity', 'apexintensity', 'abundance', 'height']
const MASS_PATTERNS = ['mass']

interface NormalizeSpectrumInputParams {
  data?: TableData | null
  config?: Record<string, unknown>
  datasets?: Dataset[]
  viewSpec?: Record<string, unknown>
  selection?: SelectionState | null
}

export function normalizeSpectrumViewerInput(
  params: NormalizeSpectrumInputParams,
): SpectrumViewerInput {
  const viewSpec = params.viewSpec ?? {}
  const datasets = params.datasets?.length
    ? params.datasets
    : params.data
      ? [tableDataToDataset(params.data)]
      : []

  return {
    series: datasets
      .filter(dataset => dataset.kind !== 'feature_table')
      .map((dataset, index) => datasetToSpectrumSeries(
        dataset,
        index,
        params.config,
        viewSpec,
        params.selection,
      ))
      .filter((series) => series.peaks.length > 0),
    annotations: normalizeAnnotations(viewSpec.annotations),
    mzRange: normalizeMzRange(viewSpec.mzRange),
    interactionConfig: normalizeInteractionConfig(viewSpec.interactionConfig, params.config),
  }
}

function tableDataToDataset(data: TableData): Dataset {
  return {
    id: data.sourceFile || 'default',
    kind: 'peak_table',
    columns: data.columns.map((column) => ({
      name: column.id || column.name,
      type: column.type === 'number' ? 'number' : column.type === 'boolean' ? 'boolean' : 'string',
    })),
    rows: data.rows,
    label: data.sourceFile || 'Peaks',
  }
}

function datasetToSpectrumSeries(
  dataset: Dataset,
  index: number,
  config: Record<string, unknown> | undefined,
  viewSpec: Record<string, unknown>,
  selection: SelectionState | null | undefined,
) {
  const mzColumn = resolveColumn(
    dataset,
    stringValue(viewSpec.mzColumn) ?? stringValue(config?.mzColumn),
    MZ_PATTERNS,
    MASS_PATTERNS,  // broader fallback only when specific mz patterns miss
    dataset.columns[0]?.name ?? 'mz',
  )
  const intensityColumn = resolveColumn(
    dataset,
    stringValue(viewSpec.intensityColumn) ?? stringValue(config?.intensityColumn),
    INTENSITY_PATTERNS,
    null,  // no second-tier fallback
    dataset.columns[1]?.name ?? dataset.columns[0]?.name ?? 'intensity',
  )
  const selectedRows = projectDatasetRowsByIdentity(dataset, selection)
  const peaks = dataset.rows
    .map((row, rowIndex) => {
      if (selectedRows && !selectedRows.has(rowIndex)) return null
      const mz = toFiniteNumber(row[mzColumn])
      const intensity = toFiniteNumber(row[intensityColumn])
      if (mz === null || intensity === null) return null
      return { index: rowIndex, mz, intensity, sourceRow: row }
    })
    .filter((peak): peak is NonNullable<typeof peak> => peak !== null)

  return {
    id: dataset.id || `series_${index}`,
    label: dataset.label || dataset.seriesLabel || dataset.id || `Dataset ${index + 1}`,
    direction: dataset.direction ?? 'up',
    ...(dataset.color ? { color: dataset.color } : {}),
    mzColumn,
    intensityColumn,
    peaks,
  }
}

/**
 * Resolve a column name from the dataset using a two-tier pattern match.
 *
 * Tier 1 (specific): match columns against `primaryPatterns` — these are the
 *   unambiguous terms for the axis (e.g. "m/z", "mz" for m/z).
 * Tier 2 (fallback): if Tier 1 finds nothing, try `fallbackPatterns` — broader
 *   terms that could match the axis but would be wrong if a primary exists.
 *   Pass `null` to skip Tier 2 entirely.
 *
 * This prevents a feature-level column like "Mono Mass" (neutral monoisotopic
 * mass) from being picked when a proper "m/z" column also exists in the dataset.
 */
function resolveColumn(
  dataset: Dataset,
  explicit: string | undefined,
  primaryPatterns: string[],
  fallbackPatterns: string[] | null,
  fallback: string,
): string {
  if (explicit) return explicit

  const normalise = (text: string) => text.toLowerCase().replace(/[_\s]+/g, ' ')

  const matchTier = (patterns: string[]): string | undefined => {
    const normalised = patterns.map((p) => normalise(p))
    const column = dataset.columns.find((col) => {
      if (col.name.startsWith('__')) return false
      const cn = normalise(col.name)
      return normalised.some((p) => cn.includes(p))
    })
    return column?.name
  }

  return matchTier(primaryPatterns)
    ?? (fallbackPatterns ? matchTier(fallbackPatterns) : undefined)
    ?? fallback
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeAnnotations(value: unknown): Annotation[] {
  return Array.isArray(value) ? (value as Annotation[]) : []
}

function normalizeMzRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined
  const start = toFiniteNumber(value[0])
  const end = toFiniteNumber(value[1])
  return start === null || end === null ? undefined : [start, end]
}

function normalizeInteractionConfig(
  value: unknown,
  config: Record<string, unknown> | undefined,
): InteractionConfig | undefined {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const selectionKeyField = stringValue(record.selectionKeyField) ?? stringValue(config?.selectionKeyField)
  const broadcastColumn = stringValue(record.broadcastColumn) ?? stringValue(config?.broadcastColumn)
  if (!selectionKeyField && !broadcastColumn) return undefined
  return {
    ...(selectionKeyField ? { selectionKeyField } : {}),
    ...(broadcastColumn ? { broadcastColumn } : {}),
  }
}
