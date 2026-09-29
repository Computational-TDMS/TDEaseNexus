/**
 * Counts raw spectra and fasta reference files in the Workspace file tree,
 * for the empty state's "3 raw files · 1 fasta" summary
 * Best-effort: only counts nodes already scanned —
 * the root `fileTree` plus whatever the lazy-loading `directoryCache` has
 * listed (subdirectories the Navigator has not expanded yet are not walked).
 * Deriving this from what has already been scanned costs nothing extra;
 * walking the whole Workspace on every dock mount would not be free.
 *
 * Paths are deduped across the two sources: a directory's children can be
 * present both in the seed tree and in its cache listing, and a file must
 * never count twice.
 */
import type { FileTreeNode } from '@/types/workspace-data'

const RAW_EXTENSIONS = new Set(['.raw', '.mzml', '.mzml.gz'])
const FASTA_EXTENSIONS = new Set(['.fasta', '.fa'])

export interface WorkspaceFileCounts {
  rawFileCount: number
  fastaFileCount: number
}

export function countWorkspaceFiles(
  tree: ReadonlyArray<FileTreeNode>,
  cache?: ReadonlyMap<string, ReadonlyArray<FileTreeNode>>,
): WorkspaceFileCounts {
  let rawFileCount = 0
  let fastaFileCount = 0
  const seen = new Set<string>()

  const walk = (nodes: ReadonlyArray<FileTreeNode>): void => {
    for (const node of nodes) {
      if (seen.has(node.path)) continue
      seen.add(node.path)
      if (node.type === 'file') {
        const lower = node.name.toLowerCase()
        if ([...RAW_EXTENSIONS].some((ext) => lower.endsWith(ext))) rawFileCount += 1
        else if ([...FASTA_EXTENSIONS].some((ext) => lower.endsWith(ext))) fastaFileCount += 1
      } else if ('children' in node && Array.isArray((node as { children?: FileTreeNode[] }).children)) {
        walk((node as { children: FileTreeNode[] }).children)
      }
    }
  }
  walk(tree)
  if (cache) for (const nodes of cache.values()) walk(nodes)

  return { rawFileCount, fastaFileCount }
}
