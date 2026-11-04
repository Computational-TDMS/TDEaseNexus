/**
 * Launch-token recovery on 401 (per-launch bearer tokens).
 *
 * Tokens die with their Backend launch: a restart (splash retry, in-process
 * restart) mints a fresh pair, and a client holding the dead token gets 401
 * on every authenticated call while the public health probes still read
 * "online". The client must re-handshake through the desktop bridge once and
 * retry; a 401 whose re-handshake yields the SAME token is a real rejection
 * and must surface untouched.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TDEaseClient } from './backend'

let authorizations: Array<string | undefined> = []
let bridgeToken = 'token-old'

beforeEach(() => {
  authorizations = []
  bridgeToken = 'token-old'
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const header = init.headers as Record<string, string> | undefined
    authorizations.push(header?.Authorization)
    const fresh = header?.Authorization === 'Bearer token-new'
    return new Response(fresh ? '{"files":[]}' : '{"error":{}}', {
      status: fresh ? 200 : 401,
      headers: { 'content-type': 'application/json' },
    })
  }))
  ;(globalThis as Record<string, unknown>).tdeaseDesktop = {
    backend: { connection: async () => ({ baseUrl: 'http://127.0.0.1:8000', accessToken: bridgeToken }) },
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as Record<string, unknown>).tdeaseDesktop
})

it('recovers once when the bridge hands back a fresh launch token', async () => {
  const client = new TDEaseClient('http://127.0.0.1:8000', 'token-old')
  // The backend restarted while the client lived: the bridge now serves the
  // new launch's token.
  bridgeToken = 'token-new'

  const files = await client.pullFiles('run_auth')

  expect(files).toEqual([])
  expect(authorizations).toEqual(['Bearer token-old', 'Bearer token-new'])
})

it('surfaces a 401 whose re-handshake yields the same token', async () => {
  const client = new TDEaseClient('http://127.0.0.1:8000', 'token-old')

  await expect(client.pullFiles('run_auth')).rejects.toThrow()
  // One attempt only: an unchanged token is a real rejection, never retried.
  expect(authorizations).toEqual(['Bearer token-old'])
})

it('does not touch the bridge outside the desktop context', async () => {
  delete (globalThis as Record<string, unknown>).tdeaseDesktop
  const client = new TDEaseClient('http://127.0.0.1:8000', 'token-old')

  await expect(client.pullFiles('run_auth')).rejects.toThrow()
  expect(authorizations).toEqual(['Bearer token-old'])
})
