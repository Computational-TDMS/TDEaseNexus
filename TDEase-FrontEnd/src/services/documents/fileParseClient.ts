/**
 * fileParseClient — off-thread parsing for large file documents.
 *
 * `parseFile(request)` posts the bytes/text to a module Web Worker (Vite's
 * `new URL` convention) and resolves with the parsed model, so a 100MB TSV's
 * decode + d3 parse never freezes the renderer. If the worker cannot be
 * created (jsdom, exotic embedder) or fails at runtime (script load error),
 * every job — including the in-flight ones — falls back to the same pure
 * `runParseRequest` on the main thread, so callers need no fallback branch
 * of their own. Byte payloads are transferred, not copied.
 */

import { runParseRequest, type FileParseRequest, type FileParseResult } from './fileParseCore'

let worker: Worker | null = null
let workerTried = false

interface Pending {
  request: FileParseRequest
  resolve: (result: FileParseResult) => void
  reject: (error: Error) => void
}

const pending = new Map<number, Pending>()
let nextId = 1

/** Run a job synchronously; a parse error rejects like the worker path would. */
function runLocally(entry: Pending): void {
  try {
    entry.resolve(runParseRequest(entry.request))
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
    const instance = new Worker(new URL('./fileParse.worker.ts', import.meta.url), { type: 'module' })
    instance.addEventListener('message', (event: MessageEvent<{ id: number; ok: boolean; result?: FileParseResult; message?: string }>) => {
      const { id, ok, result, message } = event.data
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      if (ok && result) entry.resolve(result)
      else entry.reject(new Error(message ?? 'parse worker failed'))
    })
    instance.addEventListener('error', () => disableWorker())
    worker = instance
  } catch {
    worker = null
  }
  return worker
}

/** Parse a delimited table or msalign spectra off the main thread. */
export function parseFile(request: FileParseRequest): Promise<FileParseResult> {
  const instance = acquireWorker()
  if (!instance) {
    return new Promise((resolve, reject) => runLocally({ request, resolve, reject }))
  }
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { request, resolve, reject })
    const transfer: ArrayBuffer[] = request.buffer ? [request.buffer] : []
    instance.postMessage({ id, request }, transfer)
  })
}
