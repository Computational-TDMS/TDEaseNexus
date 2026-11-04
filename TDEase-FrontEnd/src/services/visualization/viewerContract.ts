import type {
  Dataset,
  SemanticSelection,
  SelectionState,
} from '@/types/visualization'

export interface ViewerPortContract {
  data: Array<{
    id: string
    accepts: string[]
    cardinality?: 'one' | 'many'
    required?: boolean
    requiredColumns?: string[]
  }>
  selectionInputs?: Array<{ id: string; kind: string; keyField: string }>
  selectionOutputs?: Array<{ id: string; kind: string; keyField: string }>
}

export interface ViewerCompileInput {
  inputs: Readonly<Record<string, Dataset | readonly Dataset[]>>
  selections: Readonly<Record<string, SemanticSelection | null>>
  params: Readonly<Record<string, unknown>>
}

export interface ViewerCompileResult {
  datasets: Dataset[]
  selection?: SelectionState | null
}

/**
 * The stable viewer-plugin contract: metadata, typed data/selection ports and
 * an optional compile step. This module must stay framework-free — it is the
 * piece an external viewer package would compile against, so no app or Vue
 * types may leak in. `ComponentType` is instantiated by the host
 * (ViewerRegistry binds it to Vue's `Component`).
 */
export interface ViewerContract<ComponentType = unknown> {
  id: string
  component: ComponentType
  label: string
  category?: 'plot' | 'table' | 'scientific'
  icon?: string
  gallery?: {
    size: 'compact' | 'standard' | 'tall'
  }
  defaultConfig?: Record<string, unknown>
  ports: ViewerPortContract
  compile?: (input: ViewerCompileInput) => ViewerCompileResult
}

export function assertViewerContract(registration: ViewerContract): void {
  if (!registration.id.trim()) throw new Error('Viewer id cannot be empty')
  if (!registration.ports?.data) {
    throw new Error(`Viewer ${registration.id} has no data-port contract`)
  }
  const portIds = [
    ...registration.ports.data.map(port => `data:${port.id}`),
    ...(registration.ports.selectionInputs ?? []).map(port => `selection-in:${port.id}`),
    ...(registration.ports.selectionOutputs ?? []).map(port => `selection-out:${port.id}`),
  ]
  if (new Set(portIds).size !== portIds.length) {
    throw new Error(`Viewer ${registration.id} has duplicate ports`)
  }
}
