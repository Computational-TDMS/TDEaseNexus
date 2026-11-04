export function canOverwrite(localDigest: string | undefined, remoteDigest: string): 'write' | 'skip' | 'conflict' {
  if (!localDigest) return 'write'
  if (localDigest === remoteDigest) return 'skip'
  return 'conflict'
}
