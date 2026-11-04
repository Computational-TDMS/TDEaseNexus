const VIEWER_TYPE_ALIASES: Record<string, string> = {
  feature_map: 'featuremap',
  featuremap_viewer: 'featuremap',
  ms2_sequence_viewer: 'fragment_spectrum',
  ms2_sequence: 'fragment_spectrum',
  ms2spectrum: 'fragment_spectrum',
  ms2_spectrum: 'fragment_spectrum',
  ms2_spectrum_viewer: 'fragment_spectrum',
  spectrum_viewer: 'spectrum',
  table_viewer: 'table',
  image: 'media',
  png: 'media',
  svg: 'media',
  html: 'media',
}

export function canonicalizeViewerType(type?: string | null): string | undefined {
  if (!type) return undefined
  return VIEWER_TYPE_ALIASES[type] ?? type
}
