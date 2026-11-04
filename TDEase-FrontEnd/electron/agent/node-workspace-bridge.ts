/**
 * Node-side WorkspaceBridge: the file-system surface the renderer used to reach
 * through `tdeaseDesktop.workspace.*` over IPC. Each method takes the workspace
 * `root` the renderer used to send and resolves it against the trusted
 * workspaceRoot this factory was built with, so a caller cannot read or write
 * outside the bound Workspace even if it supplied a different `root`.
 *
 * Reuses `containedPath` from `electron/path_containment.cjs` (the only
 * Electron-side import here) so the same real-path-resolving containment check
 * that backs the IPC handlers in main.ts backs the agent runtime too.
 */

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { containedPath } from '../path_containment.cjs'
import { writeBufferAtomicQueued, writeTextAtomicQueued } from '../atomic-write'
import type { WorkspaceBridge } from '../../src/services/workspace/studioWorkspaceRepository'

// Directories never surfaced as Workspace files. Matches the desktop snapshot
// policy: these are agent/runtime state, not user content, and listing them
// only gives the model noise to wade through.
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.tdease', '.snakemake'])

/** Extended WorkspaceBridge for Node: blob reads back the remote-submission path. */
export interface NodeWorkspaceBridge extends WorkspaceBridge {
  /** Raw bytes for `BackendGateway.prepareRemote` blob-store uploads. Contained. */
  readBytes(root: string, relative: string): Promise<Uint8Array>
}

export function createNodeWorkspaceBridge(workspaceRoot: string): NodeWorkspaceBridge {
  // Every method anchors on this trusted root; the `root` argument is accepted
  // for interface parity with the renderer-facing WorkspaceBridge but must
  // resolve to the same Workspace or the call is rejected. This is the same
  // trust boundary the IPC handlers in main.ts enforce.
  const trustedRoot = path.resolve(workspaceRoot)

  function assertRoot(root: string): void {
    if (path.resolve(root) !== trustedRoot) {
      throw new Error('workspace root does not match the bound Workspace')
    }
  }

  function resolve(root: string, relative: string, denial: string): string {
    assertRoot(root)
    return containedPath(trustedRoot, relative, denial)
  }

  async function walk(root: string): Promise<string[]> {
    const out: string[] = []
    async function recurse(dir: string): Promise<void> {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIPPED_DIRS.has(entry.name)) continue
          await recurse(path.join(dir, entry.name))
        } else if (entry.isFile()) {
          out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'))
        }
      }
    }
    await recurse(root)
    return out.sort()
  }

  return {
    async listFiles(root: string): Promise<string[]> {
      assertRoot(root)
      // WHY skip by directory: walking into .git just to filter every entry is
      // O(files); pruning at the directory test is O(dirs) and keeps symlinks
      // or nested node_modules out of the result entirely.
      return walk(trustedRoot)
    },

    async readText(root: string, relative: string): Promise<string> {
      const target = resolve(root, relative, 'workspace path traversal denied')
      return fsp.readFile(target, 'utf8')
    },

    async readBytes(root: string, relative: string): Promise<Uint8Array> {
      const target = resolve(root, relative, 'workspace path traversal denied')
      const buffer = await fsp.readFile(target)
      // WHY Uint8Array: Node Buffer is a Uint8Array subclass; the gateway wraps
      // it in `new Blob([new Uint8Array(...)])` and `Blob` copies the view.
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    },

    async fileSize(root: string, relative: string): Promise<number> {
      const target = resolve(root, relative, 'workspace path traversal denied')
      try {
        return (await fsp.stat(target)).size
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT') return 0
        throw error
      }
    },

    async sha256(root: string, relative: string): Promise<string> {
      const target = resolve(root, relative, 'workspace path traversal denied')
      const hash = createHash('sha256')
      // WHY stream: Workspace blobs may be hundreds of MB (mzML, FASTA). Reading
      // the whole file into memory before hashing doubles peak RSS per call.
      await pipelineHash(target, hash)
      return hash.digest('hex')
    },

    async writeTextAtomic(root: string, relative: string, content: string): Promise<void> {
      const target = resolve(root, relative, 'workspace path traversal denied')
      await writeTextAtomicQueued(target, content)
    },

    async writeBytesAtomic(root: string, relative: string, bytes: Uint8Array): Promise<void> {
      const target = resolve(root, relative, 'workspace path traversal denied')
      await writeBufferAtomicQueued(target, Buffer.from(bytes))
    },
  }
}

async function pipelineHash(target: string, hash: import('node:crypto').Hash): Promise<void> {
  const { createReadStream } = await import('node:fs')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(target)
    // Node typed the 'data' chunk as `string | Buffer`; binary streams emit
    // Buffer. Both are valid `hash.update` inputs.
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
}

