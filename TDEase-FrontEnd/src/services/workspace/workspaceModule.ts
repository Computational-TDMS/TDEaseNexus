export function validateRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`Invalid workspace path: ${path}`)
  }
  return normalized
}
