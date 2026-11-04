import type { MatchedFragment, Modification } from '@/composables/ms2-sequence'

export interface ModificationSummaryItem {
  id: string
  text: string
}

export function formatNumber(value: unknown, digits: number): string {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return ''
  return parsed.toFixed(digits)
}

export function formatMassShift(value: number): string {
  const sign = value >= 0 ? '+' : ''
  return `Δ${sign}${value.toFixed(4)}`
}

export function buildModificationSummary(modifications: Modification[]): ModificationSummaryItem[] {
  return modifications.map((mod) => {
    const positionText = mod.positionEnd && mod.positionEnd !== mod.position
      ? `${mod.position}-${mod.positionEnd}`
      : `${mod.position}`
    const massText = formatMassShift(Number(mod.massShift || 0))
    return {
      id: mod.id,
      text: `${mod.name} @${positionText} ${massText}`,
    }
  })
}

export function buildMatchTableData(matchedFragments: MatchedFragment[]) {
  return matchedFragments.map((fragment) => ({
    ion: `${fragment.ionType}${fragment.position}`,
    ionType: fragment.ionType,
    position: fragment.position,
    charge: fragment.charge,
    theoreticalMz: fragment.theoreticalMz,
    observedMz: fragment.matchedPeak?.mz,
    errorPpm: fragment.matchErrorPpm,
    intensity: fragment.peakIntensity,
    matched: fragment.isMatched,
  }))
}

export function buildMatchTableColumnDefs() {
  return [
    { field: 'ion', headerName: 'Ion', minWidth: 90, sortable: true, filter: true },
    { field: 'ionType', headerName: 'Type', minWidth: 80, sortable: true, filter: true },
    { field: 'position', headerName: 'Pos', minWidth: 80, sortable: true, filter: true },
    { field: 'charge', headerName: 'Z', minWidth: 70, sortable: true, filter: true },
    {
      field: 'theoreticalMz',
      headerName: 'Theo. m/z',
      minWidth: 140,
      sortable: true,
      filter: true,
      valueFormatter: (params: { value: unknown }) => formatNumber(params.value, 4),
    },
    {
      field: 'observedMz',
      headerName: 'Obs. m/z',
      minWidth: 140,
      sortable: true,
      filter: true,
      valueFormatter: (params: { value: unknown }) => (params.value ? formatNumber(params.value, 4) : '-'),
    },
    {
      field: 'errorPpm',
      headerName: 'Error (ppm)',
      minWidth: 140,
      sortable: true,
      filter: true,
      valueFormatter: (params: { value: unknown }) => (params.value !== undefined ? formatNumber(params.value, 2) : '-'),
    },
    {
      field: 'intensity',
      headerName: 'Intensity',
      minWidth: 130,
      sortable: true,
      filter: true,
      valueFormatter: (params: { value: unknown }) => (params.value ? formatNumber(params.value, 0) : '-'),
    },
    { field: 'matched', headerName: 'Matched', minWidth: 110, sortable: true, filter: true },
  ]
}
