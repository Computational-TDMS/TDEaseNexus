export function selectionFieldsMatch(left: string, right: string): boolean {
  return normalizeSelectionField(left) === normalizeSelectionField(right)
}

function normalizeSelectionField(field: string): string {
  return field.trim().toLowerCase().replace(/[\s_-]+/g, '')
}
