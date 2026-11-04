/**
 * Tree hash — client-side workspace tree manifest for RunCommit.
 *
 * Contract: src/contracts/tree.py TreeEntry + RunCommit.workspace_tree_hash.
 * The manifest covers the workflow-relevant files only (Snakefile, config,
 * scripts, *.smk) — raw data is addressed separately via push-data.
 */

import { bufferToHex } from '@/utils/hex'

export interface TreeEntryPayload {
  path: string
  blob_hash: string
  size: number
}

const TEXT_ENCODER = new TextEncoder()

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return bufferToHex(digest)
}

/** Canonical tree hash: sha256 over sorted "path:blob_hash:size" lines. */
export async function computeTreeHash(entries: TreeEntryPayload[]): Promise<string> {
  const canonical = entries
    .map((e) => `${e.path}:${e.blob_hash}:${e.size}`)
    .sort()
    .join('\n')
  return sha256Hex(TEXT_ENCODER.encode(canonical))
}
