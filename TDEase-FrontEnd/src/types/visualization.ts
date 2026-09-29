/**
 * Visualization type definitions for interactive nodes
 * Enhanced version with heatmap, volcano plot, and advanced configurations
 */

/**
 * Column definition for tabular data
 */
export interface ColumnDef {
  id: string
  name: string
  type: 'text' | 'string' | 'number' | 'boolean' | 'date'
  visible: boolean
  sortable?: boolean
  filterable?: boolean
  detectedType?: 'continuous' | 'categorical'
}

/**
 * Table data structure used throughout visualization components.
 */
export interface VisualizationTableData {
  columns: ColumnDef[]
  rows: Record<string, unknown>[]
  totalRows: number
  sourceFile: string
}

/** @deprecated Use `VisualizationTableData` instead. */
export type TableData = VisualizationTableData

/**
 * Brush region for feature map selection
 */
export interface BrushRegion {
  xMin?: number
  xMax?: number
  yMin?: number
  yMax?: number
}

/**
 * Filter definition
 */
export interface FilterDef {
  columnId: string
  operator: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains'
  value: unknown
}

/**
 * Selection state for a node
 */
export interface SelectionState {
  selectedIndices: Set<number>
  selectedRefs?: import('@/services/visualization/runtime-types').SelectionRef[]
  filterCriteria: FilterDef[]
  brushRegion: BrushRegion | null
}

/**
 * Axis mapping configuration
 */
export interface AxisMapping {
  x?: string      // Column ID for X axis
  y?: string      // Column ID for Y axis
  z?: string      // Column ID for Z axis (3D or bubble size)
  color?: string  // Column ID for color mapping
  size?: string   // Column ID for size mapping
}

/**
 * Volcano plot specific configuration
 */
export interface VolcanoConfig {
  foldChangeColumn: string      // Log2 fold change column
  pValueColumn: string          // P-value column
  nameColumn?: string           // Gene/protein name column
  foldChangeThreshold: number   // Default: 1 or 2
  pValueThreshold: number       // Default: 0.05
  upregulatedColor: string      // Color for up-regulated points
  downregulatedColor: string    // Color for down-regulated points
  neutralColor: string          // Color for non-significant points
}

/**
 * Feature map specific configuration
 *
 * Each feature draws one horizontal trace from start/end time + mass + intensity.
 */
export interface FeatureMapConfig {
  axisMapping: {
    startTime: string
    endTime: string
    mass: string
    intensity?: string
  }
  colorScheme: ColorSchemeId
  /** Colour mapping: linear (default) or logarithmic. */
  colorScale?: 'linear' | 'log'
  opacity: number
  /**
   * Maximum number of features to render; beyond that, features are sampled
   * at even intervals by row number.
   */
  maxTraces: number
}

/**
 * Heatmap specific configuration
 */
export interface HeatmapConfig {
  rowColumn: string          // Column for row labels
  columnColumn?: string      // Column for column labels (if matrix data)
  valueColumn: string        // Column for cell values
  colorScheme: ColorSchemeId // Color scheme for intensity
  showRowLabels: boolean
  showColumnLabels: boolean
  clusteringEnabled: boolean
  missingValueColor: string  // Color for null/NaN cells
}

/**
 * Scatter plot specific configuration
 */
export interface ScatterConfig {
  axisMapping: AxisMapping
  colorScheme: ColorSchemeId
  showLegend: boolean
  symbolSize: number | 'auto'
  symbolType: 'circle' | 'square' | 'triangle' | 'diamond'
}

/**
 * Color scheme identifiers
 */
export type ColorSchemeId = 
  | 'viridis'
  | 'plasma'
  | 'inferno'
  | 'magma'
  | 'cividis'
  | 'cool'
  | 'warm'
  | 'rainbow'
  | 'spectral'
  | 'blues'
  | 'reds'
  | 'greens'
  | 'custom'

/**
 * Color scheme definition
 */
export interface ColorScheme {
  id: ColorSchemeId
  name: string
  type: 'sequential' | 'diverging' | 'categorical'
  colors: string[]
  description?: string
}

/**
 * Predefined color schemes
 */
export const COLOR_SCHEMES: ColorScheme[] = [
  { id: 'viridis', name: 'Viridis', type: 'sequential', colors: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'] },
  { id: 'plasma', name: 'Plasma', type: 'sequential', colors: ['#0d0887', '#6a00a8', '#b12a90', '#e16462', '#fca636'] },
  { id: 'inferno', name: 'Inferno', type: 'sequential', colors: ['#000004', '#420a68', '#932667', '#dd513a', '#fca50a'] },
  { id: 'magma', name: 'Magma', type: 'sequential', colors: ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fec287'] },
  { id: 'cividis', name: 'Cividis', type: 'sequential', colors: ['#00204d', '#414287', '#7c7b78', '#beae6e', '#ffe945'] },
  { id: 'cool', name: 'Cool', type: 'diverging', colors: ['#6e40aa', '#6054c8', '#4c6edb', '#368ce1', '#23abd8', '#1ac7c2', '#1ddfa3', '#30ef82', '#52f667', '#7fff56'] },
  { id: 'warm', name: 'Warm', type: 'diverging', colors: ['#6e40aa', '#963db3', '#bf3caf', '#e4419d', '#fe4b83', '#ff5e63', '#ff7847', '#fb9633', '#e2b72f', '#c6d63c'] },
  { id: 'rainbow', name: 'Rainbow', type: 'categorical', colors: ['#9e0142', '#d53e4f', '#f46d43', '#fdae61', '#fee08b', '#e6f598', '#abdda4', '#66c2a5', '#3288bd', '#5e4fa2'] },
  { id: 'spectral', name: 'Spectral', type: 'diverging', colors: ['#9e0142', '#d53e4f', '#f46d43', '#fdae61', '#fee08b', '#e6f598', '#abdda4', '#66c2a5', '#3288bd', '#5e4fa2'] },
  { id: 'blues', name: 'Blues', type: 'sequential', colors: ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b'] },
  { id: 'reds', name: 'Reds', type: 'sequential', colors: ['#fff5f0', '#fee0d2', '#fcbba1', '#fc9272', '#fb6a4a', '#ef3b2c', '#cb181d', '#a50f15', '#67000d'] },
  { id: 'greens', name: 'Greens', type: 'sequential', colors: ['#f7fcf5', '#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476', '#41ab5d', '#238b45', '#006d2c', '#00441b'] },
]

/**
 * Volcano point data
 */
export interface VolcanoPoint {
  name: string
  log2FoldChange: number
  negLog10PValue: number
  index: number
  isSignificant: boolean
  regulation: 'up' | 'down' | 'neutral'
}

/**
 * Heatmap cell data
 */
export interface HeatmapCell {
  row: string
  column: string
  value: number | null
  rowIndex: number
  columnIndex: number
}

// ── Unified Viewer Input Contract ──

export interface Dataset {
  id: string
  kind: string
  columns: Column[]
  rows: Record<string, unknown>[]
  direction?: 'up' | 'down'
  color?: string
  label?: string
  seriesLabel?: string
  sequenceLength?: number
  maxCharge?: number
}

export interface Column {
  name: string
  type: 'string' | 'number' | 'integer' | 'boolean'
  unit?: string
}

export interface Annotation {
  type: 'vline' | 'hline' | 'region' | 'point'
  x?: number | [number, number]
  y?: number | [number, number]
  label?: string
  color?: string
  dash?: boolean
  fill?: string
  symbol?: 'circle' | 'diamond' | 'cross'
}

export interface InteractionConfig {
  selectionKeyField?: string
  broadcastColumn?: string
  linkColumns?: Record<string, string>
}

export interface SpectrumPeak {
  index: number
  mz: number
  intensity: number
  sourceRow: Record<string, unknown>
}

export interface SpectrumSeries {
  id: string
  label: string
  direction: 'up' | 'down'
  color?: string
  mzColumn: string
  intensityColumn: string
  peaks: SpectrumPeak[]
}

export interface SpectrumViewerInput {
  series: SpectrumSeries[]
  annotations: Annotation[]
  mzRange?: [number, number]
  interactionConfig?: InteractionConfig
}

export type SemanticSelectionKey = string | number | boolean

export interface SemanticSelection {
  kind: string
  keys: readonly SemanticSelectionKey[]
}

/**
 * The sole input accepted by the rendering seam.
 *
 * Sources, paths, Run identity, loading and presentation chrome deliberately
 * stay outside this contract. Input keys are static viewer data-port ids.
 */
export interface ViewerRenderInput {
  viewer: string
  inputs: Readonly<Record<string, Dataset | readonly Dataset[]>>
  selections?: Readonly<Record<string, SemanticSelection | null>>
  params?: Readonly<Record<string, unknown>>
}

export interface ViewerSelectionEvent {
  port: string
  kind: string
  keys: readonly SemanticSelectionKey[]
}
