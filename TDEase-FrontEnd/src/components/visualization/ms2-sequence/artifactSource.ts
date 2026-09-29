export interface MsalignSource {
  artifactId: string
  filePath?: string
}

function readStringField(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function resolveMsalignSource(row: Record<string, unknown>): MsalignSource | null {
  const artifactId = readStringField(row, ['MS2 Artifact ID', 'ms2_artifact_id', 'Artifact ID', 'artifact_id'])
  const filePath = readStringField(row, ['Data file name', 'data_file_name', 'MS2 File', 'ms2_file'])
  if (artifactId) {
    return filePath ? { artifactId, filePath } : { artifactId }
  }

  if (filePath) {
    return { artifactId: '__by_path__', filePath }
  }

  return null
}
