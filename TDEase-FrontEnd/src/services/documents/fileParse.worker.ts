/**
 * Worker entry for `fileParseClient`. Receives `{id, request}`, runs the pure
 * `runParseRequest`, posts `{id, ok, result|message}` back. The heavy payload
 * (rows / spectra) crosses the boundary once, via structured clone.
 */

import { runParseRequest, type FileParseRequest } from './fileParseCore'

export interface FileParseWorkerRequest {
  id: number
  request: FileParseRequest
}

addEventListener('message', (event: MessageEvent<FileParseWorkerRequest>) => {
  const { id, request } = event.data
  try {
    const result = runParseRequest(request)
    ;(self as unknown as Worker).postMessage({ id, ok: true, result })
  } catch (error) {
    ;(self as unknown as Worker).postMessage({
      id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    })
  }
})
