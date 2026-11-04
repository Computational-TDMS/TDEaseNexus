/**
 * Shared display formatters. One implementation per concept so surfaces never
 * disagree about what "5s" or "12.3k" means.
 */

/** Compact duration: `123ms`, `5s`, `2m 5s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  return `${minutes}m ${totalSeconds % 60}s`
}

/** Token counts in the compact readout voice: `12.3k`, `980`. */
export function formatTokensK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n)
}
