/**
 * media-blob-cache — module-lifetime object URLs for inline Workspace media.
 *
 * The transcript virtualizes its items, so a MarkdownContent that scrolls out
 * of range unmounts. A per-instance cache had to revoke every blob on unmount,
 * so each virtualization pass re-read the bytes over IPC, re-created the
 * object URL, and re-decoded the image — painting as constant image flicker
 * while scrolling. This module keeps URLs alive across remounts so the cache
 * hit is synchronous (bytes land in the same frame the img remounts, before
 * the virtualizer measures it).
 *
 * Keys are workspace-root-qualified: switching workspaces must never serve one
 * workspace's bytes for another's identical relative path. Entries are
 * evicted by recency past the cap to bound memory in long sessions — a
 * remounted image (the virtualizer re-entering range) refreshes its
 * recency, so eviction takes what nothing is looking at, not what merely
 * loaded first.
 */

const mediaBlobs = new Map<string, string>()
const inflight = new Set<string>()
const MEDIA_BLOB_CACHE_LIMIT = 64

export function mediaCacheKey(rootPath: string, path: string): string {
  return `${rootPath}::${path}`
}

export function cachedMediaBlob(key: string): string | undefined {
  const url = mediaBlobs.get(key)
  if (url === undefined) return undefined
  // LRU touch: re-insert so the entry becomes the most recently used one.
  mediaBlobs.delete(key)
  mediaBlobs.set(key, url)
  return url
}

export function mediaLoadInFlight(key: string): boolean {
  return inflight.has(key)
}

export function beginMediaLoad(key: string): void {
  inflight.add(key)
}

export function endMediaLoad(key: string): void {
  inflight.delete(key)
}

/** Remember a loaded blob, evicting the least recently used entry past the cap. */
export function cacheMediaBlob(key: string, url: string): void {
  if (mediaBlobs.has(key)) return
  mediaBlobs.set(key, url)
  while (mediaBlobs.size > MEDIA_BLOB_CACHE_LIMIT) {
    const oldest = mediaBlobs.keys().next().value
    if (oldest === undefined) break
    const evicted = mediaBlobs.get(oldest)
    mediaBlobs.delete(oldest)
    if (evicted) URL.revokeObjectURL(evicted)
  }
}
