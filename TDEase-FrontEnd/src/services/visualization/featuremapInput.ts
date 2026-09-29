import type { Dataset, TableData } from '@/types/visualization'
import { FEATUREMAP_COLUMN_PATTERNS } from '@/services/visualization/registrations/featuremap'

/**
 * Normalized feature-map input.
 *
 * A feature is a horizontal trace: a line segment from `startTime` to `endTime`
 * at y = `mass`, colored by `intensity`. There is no separate "point" shape —
 * when a row only carries a single retention-time value (e.g. TopFD `Apex_time`),
 * `endTime` falls back to `startTime` and the trace degenerates to a zero-length
 * segment rather than switching rendering modes.
 */
export interface FeaturePoint {
  /** Original row index — used to write selections back to the source table. */
  index: number
  startTime: number
  endTime: number
  mass: number
  /** Positive number used for the color scale; `1` when no intensity column. */
  intensity: number
  sourceRow: Record<string, unknown>
}

export interface FeatureMapAxisMapping {
  startTime: string
  endTime: string
  mass: string
  /** Empty string when the dataset has no intensity-like column. */
  intensity: string
}

export interface FeatureMapViewerInput {
  features: FeaturePoint[]
  axisMapping: FeatureMapAxisMapping
  /** `[min, max]` of the resolved intensities, for color-scale layout. */
  intensityRange?: [number, number]
  /** True when the input exceeded `maxTraces` and was uniformly sampled. */
  sampled: boolean
  totalRows: number
}

interface NormalizeFeatureMapInputParams {
  data?: TableData | null
  datasets?: Dataset[]
  config?: Record<string, unknown>
  viewSpec?: Record<string, unknown>
  /** Maximum features to return; excess rows are uniformly sampled. Default 10000. */
  maxTraces?: number
}

/**
 * Resolve datasets + config + viewSpec into a typed {@link FeatureMapViewerInput}.
 *
 * This is the single entry point for feature-map data normalization; the viewer
 * component stays a thin render layer. Column resolution is kind-agnostic — a
 * `feature_table` and a generic `table` are treated identically — so the
 * featuremap path no longer depends on the upstream kind-inference pipeline.
 */
export function normalizeFeatureMapViewerInput(
  params: NormalizeFeatureMapInputParams,
): FeatureMapViewerInput {
  const dataset = pickDataset(params)
  if (!dataset) return empty()

  const axisMapping = resolveAxisMapping(dataset, params.config, params.viewSpec ?? {})
  const features = extractFeatures(dataset, axisMapping)
  const maxTraces = numberValue(params.maxTraces) ?? 10000
  const sampled = features.length > maxTraces
  const rendered = sampled ? uniformSample(features, maxTraces) : features

  return {
    features: rendered,
    axisMapping,
    intensityRange: intensityBounds(rendered),
    sampled,
    totalRows: dataset.rows.length,
  }
}

function pickDataset(params: NormalizeFeatureMapInputParams): Dataset | null {
  if (params.datasets?.length) return params.datasets[0]
  if (params.data) return tableDataToDataset(params.data)
  return null
}

function tableDataToDataset(data: TableData): Dataset {
  return {
    id: data.sourceFile || 'default',
    kind: 'feature_table',
    columns: data.columns.map((column) => ({
      name: column.id || column.name,
      type: column.type === 'number' ? 'number' : column.type === 'boolean' ? 'boolean' : 'string',
    })),
    rows: data.rows,
    label: data.sourceFile || 'Features',
  }
}

function resolveAxisMapping(
  dataset: Dataset,
  config: Record<string, unknown> | undefined,
  viewSpec: Record<string, unknown>,
): FeatureMapAxisMapping {
  const names = dataset.columns.map((column) => column.name)
  const present = new Set(names)
  // Validate a candidate column name against the dataset. A stale persisted
  // config (or a viewSpec mapping) may reference columns that no longer exist
  // in the current data; trusting it blindly yields `undefined` cell values,
  // filters every row, and renders "No data". Fall back to detection instead.
  const valid = (value: string | undefined): string | undefined =>
    value && present.has(value) ? value : undefined

  const configured = asStringRecord(config?.axisMapping)
  const options = asStringRecord(viewSpec.options)
  const roleMapping = firstDatasetMapping(viewSpec.dataMapping)
  const vs = asStringRecord(viewSpec)

  const startTime = valid(configured.startTime)
    ?? valid(stringValue(roleMapping?.x))
    ?? valid(stringValue(options.startTimeColumn))
    ?? valid(stringValue(options.xStartColumn))
    ?? valid(stringValue(vs.startTimeColumn))
    ?? valid(stringValue(vs.xStartColumn))
    ?? matchColumn(names, FEATUREMAP_COLUMN_PATTERNS.startTime)
    ?? names[0]
    ?? 'startTime'

  const endTime = valid(configured.endTime)
    ?? valid(stringValue(roleMapping?.xEnd))
    ?? valid(stringValue(options.endTimeColumn))
    ?? valid(stringValue(options.xEndColumn))
    ?? valid(stringValue(vs.endTimeColumn))
    ?? valid(stringValue(vs.xEndColumn))
    ?? matchColumn(names, FEATUREMAP_COLUMN_PATTERNS.endTime)
    ?? startTime

  const mass = valid(configured.mass)
    ?? valid(stringValue(roleMapping?.y))
    ?? valid(stringValue(options.massColumn))
    ?? valid(stringValue(options.yColumn))
    ?? valid(stringValue(vs.massColumn))
    ?? valid(stringValue(vs.yColumn))
    ?? matchColumn(names, FEATUREMAP_COLUMN_PATTERNS.mass)
    ?? names.find((name) => name !== startTime && name !== endTime)
    ?? 'mass'

  const intensity = valid(configured.intensity)
    ?? valid(stringValue(roleMapping?.color))
    ?? valid(stringValue(roleMapping?.size))
    ?? valid(stringValue(options.intensityColumn))
    ?? valid(stringValue(options.colorColumn))
    ?? valid(stringValue(vs.intensityColumn))
    ?? valid(stringValue(vs.colorColumn))
    ?? matchColumn(names, FEATUREMAP_COLUMN_PATTERNS.intensity)
    ?? ''

  return { startTime, endTime, mass, intensity }
}

function extractFeatures(dataset: Dataset, mapping: FeatureMapAxisMapping): FeaturePoint[] {
  return dataset.rows
    .map((row, index): FeaturePoint | null => {
      const start = toFiniteNumber(row[mapping.startTime])
      const end = toFiniteNumber(row[mapping.endTime])
      const mass = toFiniteNumber(row[mapping.mass])
      if (start === null || end === null || mass === null) return null
      const intensity = mapping.intensity ? toFiniteNumber(row[mapping.intensity]) : null
      return {
        index,
        startTime: Math.min(start, end),
        endTime: Math.max(start, end),
        mass,
        intensity: intensity !== null && intensity > 0 ? intensity : 1,
        sourceRow: row,
      }
    })
    .filter((feature): feature is FeaturePoint => feature !== null)
}

function firstDatasetMapping(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const datasets = (value as { datasets?: unknown }).datasets
  if (!Array.isArray(datasets)) return null
  const first = datasets.find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
  const mapping = (first as { mapping?: unknown } | undefined)?.mapping
  return mapping && typeof mapping === 'object' && !Array.isArray(mapping)
    ? mapping as Record<string, unknown>
    : null
}

/**
 * Normalise a column name or pattern so that underscores and spaces are
 * interchangeable during matching.  The caller should also lowercase.
 * Many downstream tools (TopFD, FragPipe, DIA-NN) emit column names with
 * spaces (e.g. "Apex Time", "Mono Mass") while our stored patterns are
 * written with underscores — this normalisation bridges the gap.
 */
function normaliseColumnToken(text: string): string {
  return text.toLowerCase().replace(/[_\s]+/g, ' ')
}

function matchColumn(names: string[], patterns: readonly string[]): string | undefined {
  return names.find((name) => {
    // RunGraph annotates rows with `__`-prefixed metadata columns
    // (__run_id, __port_id, __node_id, …). These are never coordinate axes,
    // so skip them outright — otherwise a short pattern like `rt` would match
    // `__port_id` (po**rt**_id) and poison every row.
    if (name.startsWith('__')) return false
    const normalised = normaliseColumnToken(name)
    return patterns.some((pattern) => normalised.includes(normaliseColumnToken(pattern)))
  })
}

function uniformSample<T>(items: T[], limit: number): T[] {
  if (limit <= 0) return items
  const step = Math.ceil(items.length / limit)
  return step <= 1 ? items : items.filter((_, index) => index % step === 0)
}

function intensityBounds(features: FeaturePoint[]): [number, number] | undefined {
  if (features.length === 0) return undefined
  let min = Infinity
  let max = -Infinity
  for (const feature of features) {
    if (feature.intensity < min) min = feature.intensity
    if (feature.intensity > max) max = feature.intensity
  }
  return [min, max]
}

function empty(): FeatureMapViewerInput {
  return {
    features: [],
    axisMapping: { startTime: 'startTime', endTime: 'endTime', mass: 'mass', intensity: '' },
    sampled: false,
    totalRows: 0,
  }
}

function asStringRecord(value: unknown): Record<string, string | undefined> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, string | undefined>
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(parsed) ? parsed : null
}
