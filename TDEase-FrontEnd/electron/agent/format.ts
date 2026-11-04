/**
 * Shared display formatters for the electron/agent layer. One implementation
 * per concept so the cost guard's denials and the prompt pipeline's file
 * listings never disagree about what "1.2 MB" means.
 */

/** Compact, one-decimal human-readable byte size: `12 B`, `1.2 KB`, `3.4 MB`, `1.5 GB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
