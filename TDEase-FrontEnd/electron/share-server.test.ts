import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ShareServer, newShareToken, type ShareConfig, type ShareInvite } from './share-server'

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'tdease-share-'))
  mkdirSync(join(root, 'runs', 'r1'), { recursive: true })
  writeFileSync(join(root, 'runs', 'r1', 'notes.md'), '# shared notes\n')
  writeFileSync(join(root, 'secret.txt'), 'outside-private\n')
  mkdirSync(join(root, '.tdease', 'sessions'), { recursive: true })
  writeFileSync(join(root, '.tdease', 'permissions.json'), '{"version":1,"rules":[]}')
  return root
}

function makeInvite(overrides: Partial<ShareInvite> = {}): ShareInvite {
  return {
    id: `inv-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Tester',
    token: newShareToken(),
    tier: 'view',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

const workspaces: string[] = []

interface PromptCall { sessionId: string; message: string; guestName: string }

function makeServer(
  overrides: Partial<ShareConfig> = {},
  invites: ShareInvite[] = [makeInvite()],
): { server: ShareServer; config: ShareConfig; root: string; prompts: PromptCall[] } {
  const root = makeWorkspace()
  workspaces.push(root)
  const config: ShareConfig = {
    enabled: true,
    mode: 'loopback',
    port: 0,
    invites,
    workspaceId: 'ws-share-test',
    ...overrides,
  }
  const prompts: PromptCall[] = []
  const server = new ShareServer(config, {
    resolveWorkspaceRoot: async (workspaceId) => {
      if (workspaceId !== 'ws-share-test') throw new Error(`unknown workspace ${workspaceId}`)
      return root
    },
    promptAgent: async (sessionId, message, guestName) => {
      prompts.push({ sessionId, message, guestName })
      return { ok: true }
    },
    log: () => undefined,
  })
  return { server, config, root, prompts }
}

function baseUrl(status: { port?: number }): string {
  if (!status.port) throw new Error('server not listening')
  return `http://127.0.0.1:${status.port}`
}

async function login(url: string, token: string, path = '/login'): Promise<Response> {
  return await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    redirect: 'manual',
  })
}

/** Minimal SSE client for tests: collects `data:` JSON frames until asked. */
function openSse(url: string, cookie: string): {
  next: (timeoutMs?: number) => Promise<Record<string, unknown>>
  close: () => void
} {
  const queue: Record<string, unknown>[] = []
  const waiters: Array<() => void> = []
  const controller = new AbortController()
  void (async () => {
    const response = await fetch(url, { headers: { cookie }, signal: controller.signal })
    if (response.status !== 200) {
      queue.push({ type: '__http_error__', status: response.status } as unknown as Record<string, unknown>)
      waiters.splice(0).forEach((w) => w())
      return
    }
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx = buffer.indexOf('\n\n')
      while (idx >= 0) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const dataLines = block.split('\n').filter((l) => l.startsWith('data:'))
        if (dataLines.length) {
          queue.push(JSON.parse(dataLines.map((l) => l.slice(5).trim()).join('\n')))
          waiters.splice(0).forEach((w) => w())
        }
        idx = buffer.indexOf('\n\n')
      }
    }
  })()
  return {
    next: async (timeoutMs = 3000): Promise<Record<string, unknown>> => {
      const started = Date.now()
      while (queue.length === 0 && Date.now() - started < timeoutMs) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve)
          setTimeout(resolve, 120).unref?.()
        })
      }
      const frame = queue.shift()
      if (!frame) throw new Error('no SSE frame within timeout')
      return frame
    },
    close: () => controller.abort(),
  }
}

describe('ShareServer', () => {
  afterEach(() => {
    for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('rejects unauthenticated file access with the login page, not the file', async () => {
    const { server, config } = makeServer()
    try {
      const status = await server.apply(config)
      const file = await fetch(`${baseUrl(status)}/file?path=runs/r1/notes.md`)
      expect(file.status).toBe(401)
      const body = await file.text()
      expect(body).toContain('Sign in')
      expect(body).not.toContain('shared notes')
      // The login pages carry a sign-in form, so the CSP must name a VALID
      // form-action source. A bare path ('/login') is not one: the browser
      // discards it and enforces the directive as 'none' — blocking the very
      // form these pages render (live reproduction, 2026-09-08).
      const root = await fetch(`${baseUrl(status)}/`)
      const csp = root.headers.get('content-security-policy') ?? ''
      expect(csp).toContain("form-action 'self'")
    } finally {
      await server.stop()
    }
  })

  it('rejects a wrong token and admits the right invitation, then serves the file', async () => {
    const invite = makeInvite({ name: 'Alice' })
    const { server, config } = makeServer({}, [invite])
    try {
      const url = baseUrl(await server.apply(config))

      const bad = await login(url, 'wrong-token')
      expect(bad.status).toBe(401)

      const good = await login(url, invite.token)
      expect(good.status).toBe(303)
      const cookie = good.headers.get('set-cookie')?.split(';')[0] ?? ''
      expect(cookie).toContain('tdease_share_session=')
      expect(good.headers.get('set-cookie')).toContain('HttpOnly')
      expect(good.headers.get('set-cookie')).toContain('SameSite=Strict')

      const file = await fetch(`${url}/file?path=runs/r1/notes.md`, { headers: { cookie } })
      expect(file.status).toBe(200)
      expect(await file.text()).toContain('shared notes')

      // The file list lives at /files (the root lands on the collab chat) and
      // never lists runtime-private state.
      const index = await fetch(`${url}/files`, { headers: { cookie } })
      const html = await index.text()
      expect(html).toContain('runs/r1/notes.md')
      expect(html).not.toContain('permissions.json')
      expect(html).not.toContain('.tdease')
    } finally {
      await server.stop()
    }
  })

  it('denies traversal and absolute-path escapes from an authenticated guest', async () => {
    const invite = makeInvite()
    const { server, config, root } = makeServer({}, [invite])
    try {
      const url = baseUrl(await server.apply(config))
      const cookie = (await login(url, invite.token)).headers.get('set-cookie')?.split(';')[0] ?? ''

      const escape = await fetch(`${url}/file?path=${encodeURIComponent('../../etc/passwd')}`, { headers: { cookie } })
      expect(escape.status).toBe(403)

      const absolute = await fetch(`${url}/file?path=${encodeURIComponent(join(root, 'secret.txt'))}`, { headers: { cookie } })
      // containedPath resolves an in-root absolute to the file itself — that is
      // the SAME file a relative path reaches, so it serves; the guarantee
      // under test is that OUT-of-root absolutes are denied.
      expect(absolute.status).toBe(200)

      const outside = await fetch(`${url}/file?path=${encodeURIComponent(join(root, '..', 'outside.txt'))}`, { headers: { cookie } })
      expect(outside.status).toBe(403)
    } finally {
      await server.stop()
    }
  })

  it('revoking one invitation is HOT: the guest dies, the server and other guests stay', async () => {
    const alice = makeInvite({ name: 'Alice' })
    const bob = makeInvite({ name: 'Bob' })
    const { server, config } = makeServer({}, [alice, bob])
    const url = baseUrl(await server.apply(config))
    expect(server.getStatus().running).toBe(true)
    const aliceCookie = (await login(url, alice.token)).headers.get('set-cookie')?.split(';')[0] ?? ''
    const bobCookie = (await login(url, bob.token)).headers.get('set-cookie')?.split(';')[0] ?? ''

    // Hot apply: same topology, alice revoked. No listener restart.
    await server.apply({
      ...config,
      invites: [alice, bob].map((invite) => invite.id === alice.id
        ? { ...invite, revokedAt: new Date().toISOString() }
        : invite),
    })
    expect(server.getStatus().running).toBe(true)

    const aliceFile = await fetch(`${url}/file?path=runs/r1/notes.md`, { headers: { cookie: aliceCookie } })
    expect(aliceFile.status).toBe(401)
    expect(await aliceFile.text()).not.toContain('shared notes')
    // Bob was never touched by alice's goodbye.
    const bobFile = await fetch(`${url}/file?path=runs/r1/notes.md`, { headers: { cookie: bobCookie } })
    expect(bobFile.status).toBe(200)

    // The revoked token no longer logs in either.
    expect((await login(url, alice.token)).status).toBe(401)
    await server.stop()
  })

  it('revocation ends the revoked guest\'s open SSE stream', async () => {
    const alice = makeInvite({ name: 'Alice' })
    const bob = makeInvite({ name: 'Bob' })
    const { server, config } = makeServer({}, [alice, bob])
    server.notifySessionBound('s1', {})
    const url = baseUrl(await server.apply(config))
    const aliceSse = openSse(`${url}/collab/events`, (await login(url, alice.token)).headers.get('set-cookie')?.split(';')[0] ?? '')
    const bobSse = openSse(`${url}/collab/events`, (await login(url, bob.token)).headers.get('set-cookie')?.split(';')[0] ?? '')
    await aliceSse.next(); await bobSse.next()

    await server.apply({
      ...config,
      invites: [{ ...alice, revokedAt: new Date().toISOString() }, bob],
    })
    // Alice's open page is told goodbye; Bob's stream is untouched.
    expect(await aliceSse.next()).toEqual({ type: 'bye' })
    server.publishTurnEvent('s1', { type: 'text_delta', text: 'still here' })
    expect(await bobSse.next()).toMatchObject({ type: 'event', sessionId: 's1' })
    aliceSse.close(); bobSse.close()
    await server.stop()
  })

  it('each invitation carries its own tier: view watches, continue prompts', async () => {
    const viewer = makeInvite({ name: 'Watcher', tier: 'view' })
    const talker = makeInvite({ name: 'Talker', tier: 'continue' })
    const { server, config, prompts } = makeServer({}, [viewer, talker])
    server.notifySessionBound('s1', {})
    try {
      const url = baseUrl(await server.apply(config))

      const viewerLogin = await login(url, viewer.token, '/collab/login')
      const viewerCookie = viewerLogin.headers.get('set-cookie')?.split(';')[0] ?? ''
      const viewerSse = openSse(`${url}/collab/events`, viewerCookie)
      const hello = await viewerSse.next()
      expect(hello.type).toBe('hello')
      expect(hello.canPrompt).toBe(false)
      viewerSse.close()
      const denied = await fetch(`${url}/collab/prompt`, {
        method: 'POST',
        headers: { cookie: viewerCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', message: 'do something' }),
      })
      expect(denied.status).toBe(403)

      const talkerCookie = (await login(url, talker.token, '/collab/login')).headers.get('set-cookie')?.split(';')[0] ?? ''
      const accepted = await fetch(`${url}/collab/prompt`, {
        method: 'POST',
        headers: { cookie: talkerCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', message: 'continue the analysis' }),
      })
      expect(accepted.status).toBe(200)
      // The runtime receives the guest's NAME — provenance rides the prompt.
      expect(prompts).toEqual([{ sessionId: 's1', message: 'continue the analysis', guestName: 'Talker' }])

      const unknown = await fetch(`${url}/collab/prompt`, {
        method: 'POST',
        headers: { cookie: talkerCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'nope', message: 'hi' }),
      })
      expect(unknown.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  it('subagent sessions are NOT mirrored: unknown ids never join the share', async () => {
    const invite = makeInvite({ tier: 'continue' })
    const { server, config } = makeServer({}, [invite])
    try {
      const url = baseUrl(await server.apply(config))
      const cookie = (await login(url, invite.token, '/collab/login')).headers.get('set-cookie')?.split(';')[0] ?? ''

      // An internally-bound subagent publishes turn events without ever being
      // session-bound: those events must reach nobody.
      server.publishTurnEvent('subagent-1', { type: 'text_delta', text: 'internal' })
      const sse = openSse(`${url}/collab/events`, cookie)
      const hello = await sse.next()
      expect(hello.sessions).toEqual([])
      const prompt = await fetch(`${url}/collab/prompt`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'subagent-1', message: 'hi' }),
      })
      expect(prompt.status).toBe(404)
      sse.close()
    } finally {
      await server.stop()
    }
  })

  it('a bound session mirrors replay + live events; disposal tells guests', async () => {
    const invite = makeInvite({ tier: 'continue' })
    const { server, config } = makeServer({}, [invite])
    server.notifySessionBound('s1', { workspaceId: 'ws-share-test' })
    try {
      const url = baseUrl(await server.apply(config))
      const cookie = (await login(url, invite.token, '/collab/login')).headers.get('set-cookie')?.split(';')[0] ?? ''
      server.publishTurnEvent('s1', { type: 'text_delta', text: 'hi' })

      const sse = openSse(`${url}/collab/events`, cookie)
      const hello = await sse.next()
      expect(hello.sessions).toEqual([{ sessionId: 's1', workspaceId: 'ws-share-test' }])
      const replay = await sse.next()
      expect(replay).toMatchObject({ type: 'event', sessionId: 's1', event: { type: 'text_delta', text: 'hi' } })
      server.publishTurnEvent('s1', { type: 'turn_terminal', outcome: 'resolved' })
      const live = await sse.next()
      expect(live).toMatchObject({ type: 'event', sessionId: 's1', event: { type: 'turn_terminal' } })

      server.notifySessionDisposed('s1')
      const gone = await sse.next()
      expect(gone).toEqual({ type: 'session-gone', sessionId: 's1' })
      sse.close()
      const prompt = await fetch(`${url}/collab/prompt`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', message: 'hi' }),
      })
      expect(prompt.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  it('POSTs with a foreign Origin are refused before any handler runs', async () => {
    const invite = makeInvite()
    const { server, config } = makeServer({}, [invite])
    try {
      const url = baseUrl(await server.apply(config))
      const forged = await fetch(`${url}/collab/prompt`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', message: 'hi' }),
      })
      expect(forged.status).toBe(403)
      // Same-origin (and absent) Origin still pass — the next test's logins
      // run without an Origin header at all and succeed.
      expect((await login(url, invite.token)).status).toBe(303)
    } finally {
      await server.stop()
    }
  })

  it('the audit trail names who logged in, who was denied, and who prompted', async () => {
    const talker = makeInvite({ name: 'Talker', tier: 'continue' })
    const { server, config } = makeServer({}, [talker])
    server.notifySessionBound('s1', {})
    try {
      const url = baseUrl(await server.apply(config))
      await login(url, 'wrong-token')
      const cookie = (await login(url, talker.token, '/collab/login')).headers.get('set-cookie')?.split(';')[0] ?? ''
      await fetch(`${url}/collab/prompt`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', message: 'hello world' }),
      })
      const audit = server.getAudit(10)
      expect(audit.map((entry) => [entry.name, entry.action])).toEqual([
        ['?', 'login-denied'],
        ['Talker', 'login'],
        ['Talker', 'prompt'],
      ])
      expect(audit[2].detail).toBe('hello world')
      // Live statuses answer "when was this guest last seen".
      expect(server.getInviteStatuses().find((entry) => entry.inviteId === talker.id)?.lastSeenAt).toBeTruthy()
    } finally {
      await server.stop()
    }
  })

  it('collab: unauthenticated guests get the login page, not the chat or stream', async () => {
    const { server, config } = makeServer()
    try {
      const url = baseUrl(await server.apply(config))
      const page = await fetch(`${url}/collab`)
      expect(await page.text()).toContain('协作对话')
      const stream = await fetch(`${url}/collab/events`)
      expect(stream.status).toBe(401)
      const prompt = await fetch(`${url}/collab/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', message: 'hi' }),
      })
      expect(prompt.status).toBe(401)
    } finally {
      await server.stop()
    }
  })

  it('a disabled config stops the server', async () => {
    const { server, config } = makeServer()
    await server.apply(config)
    expect(server.getStatus().running).toBe(true)
    await server.apply({ ...config, enabled: false })
    expect(server.getStatus().running).toBe(false)
  })
})
