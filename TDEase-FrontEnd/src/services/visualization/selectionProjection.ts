import type { Dataset, SelectionState } from '@/types/visualization'
import { selectionFieldsMatch } from '@/services/visualization/selectionBridge'

export function projectDatasetRowsByIdentity(
  dataset: Dataset,
  selection: SelectionState | null | undefined,
): Set<number> | null {
  const refs = selection?.selectedRefs ?? []
  if (refs.length === 0) return null

  const applicableRefs = refs.flatMap((ref) => {
    const column = dataset.columns.find((candidate) => selectionFieldsMatch(candidate.name, ref.field))?.name
    return column ? [{ column, value: String(ref.value).trim() }] : []
  })
  if (applicableRefs.length === 0) return null

  const selected = new Set<number>()
  dataset.rows.forEach((row, index) => {
    if (applicableRefs.some((ref) => String(row[ref.column] ?? '').trim() === ref.value)) {
      selected.add(index)
    }
  })
  return selected
}
