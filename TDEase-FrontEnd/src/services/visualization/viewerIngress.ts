import type { Dataset, ViewerRenderInput } from '@/types/visualization'
import { viewerRegistry } from './ViewerRegistry'

export function datasetFromRows(
  id: string,
  rows: Record<string, unknown>[],
  columns: readonly string[],
  kind = 'table',
): Dataset {
  return {
    id,
    kind,
    columns: columns.map(name => ({
      name,
      type: inferColumnType(rows, name),
    })),
    rows,
  }
}

export function bindSingleDataset(
  viewer: string,
  dataset: Dataset,
  params: Readonly<Record<string, unknown>> = {},
): ViewerRenderInput {
  const compatible = viewerRegistry.compatiblePorts(viewer, dataset.kind)
  if (compatible.length !== 1) {
    throw new Error(
      compatible.length === 0
        ? `Viewer ${viewer} does not accept ${dataset.kind}`
        : `Viewer ${viewer} has ambiguous ports for ${dataset.kind}`,
    )
  }
  return {
    viewer,
    inputs: { [compatible[0].id]: dataset },
    params,
  }
}

export function bindMedia(
  url: string,
  mediaType: string,
  label: string,
): ViewerRenderInput {
  return bindSingleDataset('media', {
    id: label,
    kind: 'media',
    columns: [
      { name: 'url', type: 'string' },
      { name: 'type', type: 'string' },
      { name: 'label', type: 'string' },
    ],
    rows: [{ url, type: mediaType, label }],
  })
}

function inferColumnType(
  rows: readonly Record<string, unknown>[],
  column: string,
): Dataset['columns'][number]['type'] {
  const sample = rows.slice(0, 50).map(row => row[column]).filter(value => value != null && value !== '')
  if (!sample.length) return 'string'
  if (sample.every(value => typeof value === 'boolean')) return 'boolean'
  if (sample.every(value => Number.isFinite(Number(value)))) {
    return sample.every(value => Number.isInteger(Number(value))) ? 'integer' : 'number'
  }
  return 'string'
}
