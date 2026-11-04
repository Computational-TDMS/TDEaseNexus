/**
 * fastaParse.worker — off-thread FASTA decoding/parsing for file documents.
 *
 * A proteome FASTA runs to tens/hundreds of MB; `parseFasta` splits the whole
 * text and rebuilds every sequence on strings, which freezes the renderer
 * main thread for seconds. The bytes decode AND parse here; only the parsed
 * `FastaDocument` crosses back. Mirrors the fileParseClient/fileParse.worker
 * pair in src/services/documents (kept separate so that module's owners stay
 * decoupled — see the process-isolation audit).
 */

import { parseFasta } from './fasta'

export interface FastaParseRequest {
  id: number
  buffer: ArrayBuffer
}

export interface FastaParseResponse {
  id: number
  ok: boolean
  result?: ReturnType<typeof parseFasta>
  message?: string
}

// The DOM lib types `self` as Window (whose postMessage has a different
// signature); the dedicated-worker global's postMessage takes (message,
// transfer). One local wrapper keeps both call sites typed.
const post = (message: FastaParseResponse, transfer?: ArrayBuffer[]): void => {
  (self as unknown as { postMessage(message: FastaParseResponse, transfer?: ArrayBuffer[]): void }).postMessage(message, transfer)
}

self.addEventListener('message', (event: MessageEvent<FastaParseRequest>) => {
  const { id, buffer } = event.data
  try {
    const text = new TextDecoder().decode(buffer)
    post({ id, ok: true, result: parseFasta(text) }, [buffer])
  } catch (error) {
    post({ id, ok: false, message: error instanceof Error ? error.message : String(error) })
  }
})
