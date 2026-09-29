/**
 * MS2 sequence composition helpers.
 *
 * FRONTEND-ZERO: pure functions for resolving selection context from table rows.
 * The API-dependent loadMs2CompositionInput is removed — data loading now
 * happens via file-based pipeline.
 */

import type { SelectionState, TableData } from '@/types/visualization'

export interface Ms2SelectionContext {
  selectedPrsmId: number | null
  selectedRow: Record<string, unknown> | null
}

function toNumericId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function resolveMs2SelectionContext(
  rows: Record<string, unknown>[],
  selection?: SelectionState | null,
): Ms2SelectionContext {
  const selectedRefs = selection?.selectedRefs || []
  let selectedPrsmId: number | null = null

  // Strategy 1: Find a matching ref whose field is 'Prsm ID' or 'prsm_id'.
  for (const ref of [...selectedRefs].reverse()) {
    if (ref.field !== 'Prsm ID' && ref.field !== 'prsm_id') continue
    const record = ref as typeof ref & { val?: unknown }
    const parsed = toNumericId(ref.value ?? record.val)
    if (parsed !== null) {
      selectedPrsmId = parsed
      break
    }
  }

  // Strategy 2: Search all refs by value against rows' 'Prsm ID' column.
  if (selectedPrsmId === null && selectedRefs.length > 0) {
    for (const ref of [...selectedRefs].reverse()) {
      const refValue = String(ref.value).trim()
      if (!refValue) continue
      const matched = rows.find((row) => {
        const prsmVal = row['Prsm ID'] ?? row.prsm_id
        return prsmVal !== undefined && prsmVal !== null && String(prsmVal).trim() === refValue
      })
      if (matched) {
        selectedPrsmId = toNumericId(ref.value) ?? toNumericId(matched['Prsm ID'] ?? matched.prsm_id)
        break
      }
    }
  }

  if (selectedPrsmId === null) {
    const indices = selection?.selectedIndices
    if (indices?.size) {
      const rowIndex = [...indices].reverse().map((value) => toNumericId(value)).find((value) => value !== null)
      if (rowIndex !== undefined && rowIndex !== null && rowIndex >= 0 && rowIndex < rows.length) {
        const row = rows[rowIndex]
        selectedPrsmId = toNumericId(row?.['Prsm ID']) ?? toNumericId(row?.prsm_id)
      }
      if (selectedPrsmId === null && rowIndex !== undefined && rowIndex !== null) {
        selectedPrsmId = rows.some((row) => (
          toNumericId(row['Prsm ID']) === rowIndex || toNumericId(row.prsm_id) === rowIndex
        ))
          ? rowIndex
          : null
      }
    }
  }

  if (selectedPrsmId === null) {
    const firstPrsmRow = rows.find((row) => (
      toNumericId(row['Prsm ID']) !== null || toNumericId(row.prsm_id) !== null
    ))
    selectedPrsmId = firstPrsmRow
      ? toNumericId(firstPrsmRow['Prsm ID']) ?? toNumericId(firstPrsmRow.prsm_id)
      : null
  }

  const selectedRow = selectedPrsmId === null
    ? null
    : rows.find((row) => toNumericId(row['Prsm ID']) === selectedPrsmId || toNumericId(row.prsm_id) === selectedPrsmId) ?? null

  return {
    selectedPrsmId,
    selectedRow,
  }
}

export function tableRows(data: TableData | null | undefined): Record<string, unknown>[] {
  return ((data?.rows as Record<string, unknown>[] | undefined) ?? [])
}
