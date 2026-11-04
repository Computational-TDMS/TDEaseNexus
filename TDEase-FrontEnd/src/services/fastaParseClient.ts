/**
 * fastaParseClient — off-thread FASTA parsing, the sibling of
 * `documents/fileParseClient` (same Vite `new URL` worker convention).
 *
 * `parseFastaOffscreen(buffer)` posts the bytes to a module Web Worker and
 * resolves with the parsed `FastaDocument`, so a 100MB proteome's decode +
 * parse never freezes the renderer. If the worker cannot be created (jsdom,
 * exotic embedder) or fails at runtime, every job — including the in-flight
 * ones — falls back to the same pure `parseFasta` on the main thread, so
 * callers need no fallback branch of their own. The buffer is transferred,
 * not copied.
 */

import { parseFasta, type FastaDocument } from './fasta'

let worker: Worker | null = null
let workerTried = false

interface Pending {
  buffer: ArrayBuffer
  resolve: (result: FastaDocument) => void
  reject: (error: Error) => void
}

const pending = new Map<number, Pending>()
let nextId = 1

/** Run a job synchronously; a parse error rejects like the worker path would. */
function runLocally(entry: Pending): void {
  try {
    entry.resolve(parseFasta(new TextDecoder().decode(entry.buffer)))
  } catch (error) {
    entry.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

function disableWorker(): void {
  worker = null
  workerTried = true
  const entries = [...pending.values()]
  pending.clear()
  // The worker died before answering; the pure parse still succeeds locally.
  for (const entry of entries) runLocally(entry)
}

function acquireWorker(): Worker | null {
  if (workerTried) return worker
  workerTried = true
  try {
    const instance = new Worker(new URL('./fastaParse.worker.ts', import.meta.url), { type: 'module' })
    instance.addEventListener('message', (event: MessageEvent<{ id: number; ok: boolean; result?: FastaDocument; message?: string }>) => {
      const { id, ok, result, message } = event.data
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      if (ok && result) entry.resolve(result)
      else entry.reject(new Error(message ?? 'fasta parse worker failed'))
    })
    instance.addEventListener('error', () => disableWorker())
    worker = instance
  } catch {
    worker = null
  }
  return worker
}

/** Parse a FASTA file off the main thread. */
export function parseFastaOffscreen(buffer: ArrayBuffer): Promise<FastaDocument> {
  const instance = acquireWorker()
  if (!instance) {
    return new Promise((resolve, reject) => runLocally({ buffer, resolve, reject }))
  }
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { buffer, resolve, reject })
    instance.postMessage({ id, buffer }, [buffer])
  })
}
