/**
 * ShareServer — the host-owned web sharing surface (workstream 5).
 *
 * The local user opts in from Settings (default OFF, loopback-only) and hands
 * out NAMED INVITATIONS, each with its own secret and capability tier. An
 * invitation is the unit of guest identity: it can be revoked alone (other
 * guests keep working), audited by name, and given a different tier than its
 * siblings. This replaced the original single shared token, where every
 * holder was one anonymous crowd — indistinguishable, unauditable, and
 * revocable only by rotating everyone at once.
 *
 * Guests browse two surfaces under their invitation:
 *
 * 1. The file VIEW of one registered workspace (`GET /`, `GET /file`) —
 *    read-only, 2MB inline cap, contained to the shared root.
 * 2. The collab mirror (`GET /collab`) — a live browser client for the AI
 *    conversation the host user has open: it streams the same turn events the
 *    host's own Renderer consumes (text/thinking deltas, tool commits,
 *    approvals, terminal states) over SSE and — when the INVITATION's tier
 *    says so — lets the guest send prompts. The host machine runs the agent
 *    and every tool; guests are observers/participants, never owners. Guest
 *    prompts are prefixed with the invitation's name so the host transcript
 *    always shows who is speaking.
 *
 * No Electron IPC, no preload, no desktop Bearer token ever crosses this
 * boundary. Enforcement is here, at the single entry point — a guest can
 * never reach the loopback Backend or the workspace outside the shared root.
 *
 * Lifecycle is deliberately boring: `apply(config)` is idempotent — enabled
 * starts, disabled stops. Only TOPOLOGY changes (port/mode/workspaceId)
 * restart the listener; invitation edits (create/revoke/tier) are HOT: the
 * config object is swapped, every request re-validates the caller's
 * invitation against it, so a revocation kills that guest on their very next
 * request without dropping anyone else's SSE stream. Mirrored sessions are
 * exactly the ones the main process registers (`notifySessionBound`) —
 * unknown ids (subagents bound internally) are NOT mirrored; visibility is
 * an explicit act, never a side effect.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readdirSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { containedPath } from './path_containment.cjs'

export type ShareTier = 'view' | 'continue' | 'control'
export type ShareMode = 'loopback' | 'lan'

/** A named guest invitation — the unit of identity, capability and revocation. */
export interface ShareInvite {
  readonly id: string
  /** Host-chosen label ("Lab colleague", "Reviewer") — shown in the audit log. */
  readonly name: string
  /** Per-invitation secret (24 random bytes). Login matches against this. */
  readonly token: string
  readonly tier: ShareTier
  readonly createdAt: string
  /** Set when revoked; the entry stays for audit, matching stops. */
  revokedAt?: string
}

/** The persisted, host-authored configuration (settings.json `sharing`). */
export interface ShareConfig {
  readonly enabled: boolean
  readonly mode: ShareMode
  /** 0 = let the OS assign; the effective port is reported by the server. */
  readonly port: number
  readonly invites: readonly ShareInvite[]
  /** The one registered workspace this share exposes. */
  readonly workspaceId: string
}

/** In-memory, non-persisted live facts the settings UI reads back. */
export interface ShareInviteStatus {
  readonly inviteId: string
  readonly lastSeenAt: string | null
}

/** One audit-recorded guest action (newest last, ring-bounded). */
export interface ShareAuditEntry {
  readonly at: string
  readonly name: string
  readonly action: 'login' | 'login-denied' | 'prompt' | 'prompt-denied' | 'revoked'
  readonly detail: string
}

export interface ShareServerDeps {
  /** Resolve the shared workspace's absolute root, or throw (unknown id). */
  resolveWorkspaceRoot(workspaceId: string): Promise<string>
  /** Host-side execution of a guest prompt (invitation tier 'continue'/'control'). */
  promptAgent(sessionId: string, message: string, guestName: string): Promise<{ ok: boolean; error?: string }>
  log(level: 'info' | 'warn', message: string, details?: unknown): void
}

export interface ShareServerStatus {
  running: boolean
  /** The bound port (present once listening). */
  port?: number
  /** Best-effort display URL for the host to copy. */
  url?: string
}

const SESSION_COOKIE = 'tdease_share_session'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const MAX_BODY_BYTES = 4 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_LISTED_FILES = 5_000
// Collab (live AI-conversation mirror) limits. The guest page is a minimal
// vanilla client: one EventSource, one fetch per prompt. The buffer exists so
// a guest joining mid-conversation sees a transcript, not a blank page.
const MAX_COLLAB_PROMPT_BYTES = 256 * 1024
const COLLAB_BUFFER_MAX = 2_000
const COLLAB_HEARTBEAT_MS = 15_000
// Login-throttle window: consecutive failures older than this stop counting,
// so a desktop that sat shared overnight does not punish its owner's first
// typo with a capped 30s penalty.
const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000
const LOGIN_PENALTY_BASE_MS = 400
const LOGIN_PENALTY_MAX_MS = 30_000
/** Audit ring bound: the log is a "who did what recently" view, not storage. */
const AUDIT_MAX = 200

/**
 * One mirrored Agent turn event. This is the RuntimeEvent vocabulary the
 * Renderer consumes (`src/contracts/agent-runtime.ts`): text_delta /
 * thinking_delta / approval_requested / event_committed / turn_terminal. The
 * ShareServer never needs the full type — it stores and forwards the JSON as
 * an opaque envelope; only the guest page interprets it.
 */
export type CollabEvent = Readonly<Record<string, unknown>> & { readonly type: string }

export interface CollabSessionMeta {
  readonly workspaceId?: string
  readonly label?: string
}
const LIST_EXCLUDED = new Set(['.git', 'node_modules', '.tdease', '.snakemake'])
/** Rendered inline as text; everything else downloads as an octet stream. */
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.csv', '.tsv', '.log', '.yaml', '.yml', '.py', '.r', '.ts', '.js', '.mjs',
])

export function newShareToken(): string {
  return randomBytes(24).toString('base64url')
}

/** Constant-time token comparison: hash both sides to equal length first. */
function tokenMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/**
 * A POST may only come from our own origin. Same-site browsers may omit the
 * Origin header on same-origin form posts — absent passes; present must name
 * the same host:port this request was addressed to (the Host header). A
 * cross-site attacker's page cannot forge either.
 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  const host = req.headers.host
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function lanAddresses(): string[] {
  // Virtual adapters (WSL, Docker, Hyper-V, VPNs) report IPv4s that answer on
  // this host but not on the LAN the guest is on. Prefer real interfaces;
  // fall back to every candidate so the spread below can still pick one.
  const candidates: string[] = []
  for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
    for (const info of interfaces ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      if (/virtual|wsl|docker|hyper-v|vethernet|vmware|virtualbox|vpn|tun|tap|utun/i.test(name)) continue
      candidates.push(info.address)
    }
  }
  if (candidates.length > 0) return candidates
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const info of interfaces ?? []) {
      if (info.family === 'IPv4' && !info.internal) candidates.push(info.address)
    }
  }
  return candidates.length > 0 ? candidates : ['127.0.0.1']
}

function lanAddress(): string {
  return lanAddresses()[0]
}

function securityHeaders(): Record<string, string> {
  // No client script exists, so the CSP can be fully closed: the pages are
  // plain HTML forms and links, styled inline. `form-action 'self'` — a bare
  // path ('/login') is not a valid CSP source expression; the browser
  // discards it and enforces the directive as 'none', silently blocking every
  // sign-in form on these pages.
  return {
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  }
}

/**
 * CSP for the collab surface: a real client script runs there (inline),
 * EventSource and the prompt fetch are same-origin. Everything else stays
 * closed — no external sources, no objects, no frames, no base-uri.
 * `form-action 'self'` covers both the `/login` and `/collab/login` forms.
 */
function collabSecurityHeaders(): Record<string, string> {
  return {
    'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  }
}

export class ShareServer {
  private server: Server | null = null
  /** sid → { inviteId, expiry }. The invite is re-resolved on EVERY request:
   *  a hot config swap (revocation) must kill the guest immediately. */
  private sessions = new Map<string, { inviteId: string; expiry: number }>()
  private status: ShareServerStatus = { running: false }
  private cachedRoot: { workspaceId: string; root: string } | null = null
  // Collab state: which agent sessions are shareable, their replay buffer,
  // and the live SSE clients. In-memory only — a stopped/restarted share
  // kills every guest connection, exactly like a revocation does.
  private collabSessions = new Map<string, CollabSessionMeta>()
  private collabBuffers = new Map<string, CollabEvent[]>()
  /** Live SSE stream → the invitation it authenticated as. A revocation must
   *  cut the stream itself, not just the cookie — the open page would keep
   *  receiving events until its next reconnect. */
  private collabClients = new Map<ServerResponse, string>()
  private collabHeartbeat: ReturnType<typeof setInterval> | null = null
  /** inviteId → last successful login. In-memory: a login is not a settings
   *  change, and persisting one would rewrite settings.json per guest click. */
  private readonly lastSeen = new Map<string, string>()
  private readonly audit: ShareAuditEntry[] = []
  /**
   * Per-peer failed-login ledger: a fixed penalty made each online guess
   * expensive, but nothing stopped a patient LAN peer from guessing forever
   * at a fixed rate. Consecutive failures double this peer's penalty (capped
   * at 30s); a success or a quiet window resets it. In-memory by design — a
   * restart clears it, which is the right cost for a desktop share.
   */
  private readonly loginFailures = new Map<string, { count: number; lastAt: number }>()

  constructor(
    private config: ShareConfig,
    private readonly deps: ShareServerDeps,
  ) {}

  private auditPush(entry: ShareAuditEntry): void {
    this.audit.push(entry)
    if (this.audit.length > AUDIT_MAX) this.audit.splice(0, this.audit.length - AUDIT_MAX)
  }

  private inviteById(id: string): ShareInvite | null {
    const invite = this.config.invites.find((candidate) => candidate.id === id)
    return invite && !invite.revokedAt ? invite : null
  }

  /** Constant-time match of a presented secret against the LIVE invitations. */
  private inviteByToken(given: string): ShareInvite | null {
    if (!given) return null
    for (const invite of this.config.invites) {
      if (invite.revokedAt) continue
      if (tokenMatches(given, invite.token)) return invite
    }
    return null
  }

  /** Live facts for the settings UI (last activity per invitation). */
  getInviteStatuses(): ShareInviteStatus[] {
    return this.config.invites.map((invite) => ({
      inviteId: invite.id,
      lastSeenAt: this.lastSeen.get(invite.id) ?? null,
    }))
  }

  /** Newest-last audit tail for the settings UI. */
  getAudit(limit = 20): ShareAuditEntry[] {
    return this.audit.slice(-limit)
  }

  private async penalizeFailedLogin(peer: string): Promise<void> {
    const now = Date.now()
    const prior = this.loginFailures.get(peer)
    const count = prior && now - prior.lastAt < LOGIN_FAILURE_WINDOW_MS ? prior.count + 1 : 1
    this.loginFailures.set(peer, { count, lastAt: now })
    const delay = Math.min(LOGIN_PENALTY_BASE_MS * 2 ** (count - 1), LOGIN_PENALTY_MAX_MS)
    await new Promise((resolve) => setTimeout(resolve, delay))
  }

  getStatus(): ShareServerStatus {
    return { ...this.status }
  }

  /** Idempotent apply: starts, restarts (TOPOLOGY change only), or stops, so
   *  the settings page's write path can call this blindly. Invitation edits
   *  (create/revoke/tier) never restart the listener — they swap the config
   *  object, every request re-resolves the caller's invite against it, and a
   *  revoked guest dies on their next request without dropping anyone's SSE. */
  async apply(config: ShareConfig): Promise<ShareServerStatus> {
    if (!config.enabled) return await this.stop()
    const topologyChanged = this.server !== null
      && (config.port !== this.config.port
        || config.mode !== this.config.mode
        || config.workspaceId !== this.config.workspaceId)
    this.recordRevocations(this.config.invites, config.invites)
    this.dropSessionsOfMissingInvites(config.invites)
    this.config = config
    if (topologyChanged) await this.stop()
    if (this.server) return this.status
    await this.start()
    return this.status
  }

  /** A live invite that vanished or gained `revokedAt` is a named goodbye. */
  private recordRevocations(before: readonly ShareInvite[], after: readonly ShareInvite[]): void {
    const afterById = new Map(after.map((invite) => [invite.id, invite]))
    for (const invite of before) {
      if (invite.revokedAt) continue
      const next = afterById.get(invite.id)
      if (!next || next.revokedAt) {
        this.auditPush({ at: new Date().toISOString(), name: invite.name, action: 'revoked', detail: '' })
      }
    }
  }

  /** Sessions of invites that no longer answer are dead cookies — drop them
   *  eagerly, END their live SSE streams, so a revocation cuts the guest's
   *  open page at the same moment it kills their cookie. */
  private dropSessionsOfMissingInvites(invites: readonly ShareInvite[]): void {
    const liveIds = new Set(invites.filter((invite) => !invite.revokedAt).map((invite) => invite.id))
    for (const [sid, session] of this.sessions) {
      if (!liveIds.has(session.inviteId)) this.sessions.delete(sid)
    }
    for (const [client, inviteId] of this.collabClients) {
      if (!liveIds.has(inviteId)) {
        this.collabClients.delete(client)
        client.end('event: bye\ndata: {"type":"bye"}\n\n')
      }
    }
  }

  async stop(): Promise<ShareServerStatus> {
    const server = this.server
    this.server = null
    // Sessions die with the server instance: a stopped share and a rotated
    // token must both invalidate outstanding cookies at once.
    this.sessions.clear()
    this.cachedRoot = null
    // Guests lose their live view at the same moment. closeAllConnections
    // would kill them anyway, but the timer goes away with the server.
    for (const [client] of this.collabClients) {
      client.end('event: bye\ndata: {"type":"bye"}\n\n')
    }
    this.collabClients.clear()
    if (this.collabHeartbeat) clearInterval(this.collabHeartbeat)
    this.collabHeartbeat = null
    this.status = { running: false }
    if (!server) return this.status
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // In-flight keep-alive sockets can hold close open; force them shut.
      server.closeAllConnections?.()
      setTimeout(resolve, 1_000).unref()
    })
    return this.status
  }

  private async start(): Promise<void> {
    const host = this.config.mode === 'lan' ? '0.0.0.0' : '127.0.0.1'
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        this.deps.log('warn', 'share-server request failed', error)
        if (!res.headersSent) res.writeHead(500).end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.config.port, host, () => resolve())
    })
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : this.config.port
    this.server = server
    this.status = {
      running: true,
      port,
      url: `http://${this.config.mode === 'lan' ? lanAddress() : '127.0.0.1'}:${port}/`,
    }
    this.deps.log('info', `share server listening on ${host}:${port} (${this.config.invites.filter((i) => !i.revokedAt).length} live invites)`)
    if (this.config.mode === 'lan') {
      // The status URL picks the first real adapter; log every candidate so a
      // guest reporting an unreachable address can be matched to an interface.
      this.deps.log('info', `share lan addresses: ${lanAddresses().join(', ')}`)
    }
    if (!this.collabHeartbeat) {
      this.collabHeartbeat = setInterval(() => {
        for (const client of this.collabClients.keys()) client.write(': ping\n\n')
      }, COLLAB_HEARTBEAT_MS)
      this.collabHeartbeat.unref?.()
    }
  }

  // ── Collab: live AI-conversation mirror ────────────────────────────────────

  /**
   * A host-bound parent session becomes shareable. Called by the main process
   * when the Renderer binds a session (agent:bind-session success) — the same
   * moment the host user's own Agent page starts showing it.
   */
  notifySessionBound(sessionId: string, meta: CollabSessionMeta = {}): void {
    this.collabSessions.set(sessionId, meta)
    // A bind means a fresh conversation (or a fresh generation of one): start
    // the replay buffer over so guests never see the previous incarnation.
    this.collabBuffers.set(sessionId, [])
  }

  /** A session was disposed: stop mirroring it and tell guests it is gone. */
  notifySessionDisposed(sessionId: string): void {
    this.collabSessions.delete(sessionId)
    this.collabBuffers.delete(sessionId)
    this.collabBroadcast({ type: 'session-gone', sessionId })
  }

  /**
   * Forward one turn event to guests. Called from the runtime's
   * `push.turnEvent` (main.ts) — the same channel the host Renderer consumes,
   * so guest visibility can never drift from what the host user sees.
   * ONLY sessions the main process registered (notifySessionBound) are
   * mirrored: unknown ids — subagents bound internally — are dropped, not
   * lazily published. Guest visibility is an explicit act of the host, never
   * a side effect of an internal bind.
   */
  publishTurnEvent(sessionId: string, event: CollabEvent): void {
    if (!this.collabSessions.has(sessionId)) return
    let buffer = this.collabBuffers.get(sessionId)
    if (!buffer) {
      buffer = [event]
      this.collabBuffers.set(sessionId, buffer)
    } else {
      buffer.push(event)
      if (buffer.length > COLLAB_BUFFER_MAX) buffer.splice(0, buffer.length - COLLAB_BUFFER_MAX)
    }
    if (this.collabClients.size > 0) this.collabBroadcast({ type: 'event', sessionId, event })
  }

  private collabBroadcast(frame: Record<string, unknown>): void {
    const payload = `data: ${JSON.stringify(frame)}\n\n`
    for (const client of this.collabClients.keys()) client.write(payload)
  }

  private static canPrompt(tier: ShareTier): boolean {
    return tier === 'continue' || tier === 'control'
  }

  // ── Request handling ──────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CSRF second line (after SameSite=Strict cookies): a browser always
    // sends Origin on a cross-site POST; ours may only name ourselves.
    if (req.method === 'POST' && !originAllowed(req)) {
      res.writeHead(403, securityHeaders()).end('forbidden')
      return
    }
    const url = new URL(req.url ?? '/', 'http://share.local')
    const route = `${req.method} ${url.pathname}`
    if (route === 'GET /') return this.serveRoot(req, res)
    if (route === 'POST /login') return this.serveLogin(req, res)
    if (route === 'GET /files') return this.serveFileList(req, res)
    if (route === 'GET /file') return this.serveFile(req, url, res)
    if (route === 'GET /collab') return this.serveCollabPage(req, res)
    if (route === 'POST /collab/login') return this.serveCollabLogin(req, res)
    if (route === 'GET /collab/events') return this.serveCollabEvents(req, res)
    if (route === 'POST /collab/prompt') return this.serveCollabPrompt(req, res)
    res.writeHead(404, securityHeaders()).end(shell('Not found', '<p>Not found.</p>'))
  }

  /** Landing: the collab chat is the share headline; files live at /files. */
  private async serveRoot(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.guestOf(req)) {
      res.writeHead(200, { ...securityHeaders(), 'content-type': 'text/html; charset=utf-8' })
      res.end(shell('Sign in — TDEaseNexus 分享', loginForm(null)))
      return
    }
    res.writeHead(302, { ...securityHeaders(), location: '/collab' })
    res.end()
  }

  /**
   * Resolve the caller's session AND re-resolve its invitation against the
   * LIVE config. The invite lookup is what makes hot revocation immediate:
   * a cookie whose invite no longer answers is exactly as dead as a missing
   * one, and it dies here — on the guest's next request — without anyone
   * else's stream being touched.
   */
  private guestOf(req: IncomingMessage): { sid: string; invite: ShareInvite } | null {
    const cookie = req.headers.cookie ?? ''
    const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([A-Za-z0-9_-]+)`).exec(cookie)
    if (!match) return null
    const session = this.sessions.get(match[1])
    if (session === undefined) return null
    if (Date.now() > session.expiry) {
      this.sessions.delete(match[1])
      return null
    }
    const invite = this.inviteById(session.inviteId)
    if (!invite) {
      this.sessions.delete(match[1])
      return null
    }
    return { sid: match[1], invite }
  }

  private async workspaceRoot(): Promise<string> {
    if (this.cachedRoot?.workspaceId === this.config.workspaceId) return this.cachedRoot.root
    const root = await this.deps.resolveWorkspaceRoot(this.config.workspaceId)
    this.cachedRoot = { workspaceId: this.config.workspaceId, root }
    return root
  }

  private async serveFileList(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.guestOf(req)) {
      res.writeHead(200, { ...securityHeaders(), 'content-type': 'text/html; charset=utf-8' })
      res.end(shell('Sign in — TDEase Workspace', loginForm(null)))
      return
    }
    const root = await this.workspaceRoot()
    const files = listWorkspaceFiles(root)
    const items = files
      .map((rel) => `<li><a href="/file?path=${encodeURIComponent(rel)}">${escapeHtml(rel)}</a></li>`)
      .join('\n')
    res.writeHead(200, { ...securityHeaders(), 'content-type': 'text/html; charset=utf-8' })
    res.end(shell('Shared workspace — TDEase', [
      `<p class="meta"><a href="/collab">← 协作对话</a> · ${escapeHtml(path.basename(root))} · read-only view (${files.length} files)</p>`,
      `<ul class="files">${items || '<li class="meta">(no shareable files)</li>'}</ul>`,
    ].join('\n')))
  }

  private async serveLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    const given = new URLSearchParams(body).get('token') ?? ''
    const peer = req.socket.remoteAddress ?? 'unknown'
    const invite = this.inviteByToken(given)
    if (!invite) {
      this.auditPush({ at: new Date().toISOString(), name: '?', action: 'login-denied', detail: peer })
      await this.penalizeFailedLogin(peer)
      res.writeHead(401, securityHeaders())
      res.end(shell('Sign in — TDEase Workspace', loginForm('Invalid token.')))
      return
    }
    this.loginFailures.delete(peer)
    this.establishSession(invite, req, res, '/', securityHeaders())
  }

  /** Shared success path of both login endpoints: bind a session cookie to
   *  one invitation, stamp last-seen, audit the login by name. */
  private establishSession(invite: ShareInvite, req: IncomingMessage, res: ServerResponse, location: string, headers: Record<string, string>): void {
    const sid = randomBytes(18).toString('base64url')
    this.sessions.set(sid, { inviteId: invite.id, expiry: Date.now() + SESSION_TTL_MS })
    this.lastSeen.set(invite.id, new Date().toISOString())
    this.auditPush({ at: new Date().toISOString(), name: invite.name, action: 'login', detail: req.socket.remoteAddress ?? '' })
    res.writeHead(303, {
      ...headers,
      'set-cookie': `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      location,
    })
    res.end()
  }

  private async serveCollabPage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.guestOf(req)) {
      res.writeHead(200, { ...collabSecurityHeaders(), 'content-type': 'text/html; charset=utf-8' })
      res.end(shell('Sign in — TDEaseNexus 协作对话', collabLoginForm(false)))
      return
    }
    res.writeHead(200, { ...collabSecurityHeaders(), 'content-type': 'text/html; charset=utf-8' })
    res.end(collabPage(this.guestOf(req)?.invite.tier ?? 'view'))
  }

  private async serveCollabLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    const given = new URLSearchParams(body).get('token') ?? ''
    const peer = req.socket.remoteAddress ?? 'unknown'
    const invite = this.inviteByToken(given)
    if (!invite) {
      this.auditPush({ at: new Date().toISOString(), name: '?', action: 'login-denied', detail: peer })
      await this.penalizeFailedLogin(peer)
      res.writeHead(401, collabSecurityHeaders())
      res.end(shell('Sign in — TDEaseNexus 协作对话', collabLoginForm(true)))
      return
    }
    this.loginFailures.delete(peer)
    this.establishSession(invite, req, res, '/collab', collabSecurityHeaders())
  }

  private async serveCollabEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const guest = this.guestOf(req)
    if (!guest) {
      res.writeHead(401, collabSecurityHeaders())
      res.end(shell('Sign in — TDEaseNexus 协作对话', collabLoginForm(false)))
      return
    }
    // SSE is an authenticated read-only channel: a view-tier guest may watch
    // every mirrored session; prompting is gated by the guest's invitation
    // separately. The stream is registered under its invite id so a hot
    // revocation can end it (see dropSessionsOfMissingInvites).
    res.writeHead(200, {
      ...collabSecurityHeaders(),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const welcome: Record<string, unknown> = {
      type: 'hello',
      canPrompt: ShareServer.canPrompt(guest.invite.tier),
      tier: guest.invite.tier,
      sessions: [...this.collabSessions.entries()].map(([sessionId, meta]) => ({
        sessionId,
        ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
        ...(meta.label ? { label: meta.label } : {}),
      })),
    }
    res.write(`event: hello\ndata: ${JSON.stringify(welcome)}\n\n`)
    // Replay the buffer first, then live — a new client must see the whole
    // transcript, not a blank page that only gets future events.
    for (const [sessionId, buffer] of this.collabBuffers) {
      for (const event of buffer) {
        res.write(`data: ${JSON.stringify({ type: 'event', sessionId, event })}\n\n`)
      }
    }
    this.collabClients.set(res, guest.invite.id)
    const drop = () => this.collabClients.delete(res)
    req.on('close', drop)
    res.on('error', drop)
  }

  private async serveCollabPrompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const guest = this.guestOf(req)
    if (!guest) {
      res.writeHead(401, collabSecurityHeaders())
      res.end(shell('Sign in — TDEaseNexus 协作对话', collabLoginForm(false)))
      return
    }
    if (!ShareServer.canPrompt(guest.invite.tier)) {
      this.auditPush({ at: new Date().toISOString(), name: guest.invite.name, action: 'prompt-denied', detail: 'view tier' })
      res.writeHead(403, { ...collabSecurityHeaders(), 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: '此邀请为只读(view)权限,提问需主机分配 continue 权限。' }))
      return
    }
    let input: unknown
    try {
      input = JSON.parse(await readBody(req, MAX_COLLAB_PROMPT_BYTES))
    } catch {
      res.writeHead(400, { ...collabSecurityHeaders(), 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Invalid prompt body.' }))
      return
    }
    const body = (input ?? {}) as Record<string, unknown>
    if (typeof body.sessionId !== 'string' || typeof body.message !== 'string' || !body.message.trim()) {
      res.writeHead(400, { ...collabSecurityHeaders(), 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'sessionId and message are required.' }))
      return
    }
    if (!this.collabSessions.has(body.sessionId)) {
      res.writeHead(404, { ...collabSecurityHeaders(), 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: '没有正在共享的会话。请在主机端打开 Agent 页面。' }))
      return
    }
    const message = body.message.slice(0, MAX_COLLAB_PROMPT_BYTES)
    this.auditPush({
      at: new Date().toISOString(),
      name: guest.invite.name,
      action: 'prompt',
      detail: message.length > 80 ? `${message.slice(0, 80)}…` : message,
    })
    const result = await this.deps.promptAgent(body.sessionId, message, guest.invite.name)
    res.writeHead(result.ok ? 200 : 409, { ...collabSecurityHeaders(), 'content-type': 'application/json' })
    res.end(JSON.stringify(result))
  }

  private async serveFile(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    if (!this.guestOf(req)) {
      res.writeHead(401, securityHeaders())
      res.end(shell('Sign in — TDEase Workspace', loginForm('Sign in to view files.')))
      return
    }
    const rel = url.searchParams.get('path') ?? ''
    const root = await this.workspaceRoot()
    let absolute: string
    try {
      absolute = containedPath(root, rel, 'shared path traversal denied')
    } catch {
      res.writeHead(403, securityHeaders())
      res.end(shell('Denied — TDEase Workspace', '<p>Path is outside the shared workspace.</p>'))
      return
    }
    let size: number
    try {
      const info = await stat(absolute)
      if (!info.isFile()) throw new Error('not a file')
      size = info.size
    } catch {
      res.writeHead(404, securityHeaders())
      res.end(shell('Not found — TDEase Workspace', '<p>No such file.</p>'))
      return
    }
    if (size > MAX_FILE_BYTES) {
      res.writeHead(200, { ...securityHeaders(), 'content-type': 'text/plain; charset=utf-8' })
      res.end(`File is ${size} bytes and exceeds the ${MAX_FILE_BYTES / 1024 / 1024}MB inline view limit of this slice.`)
      return
    }
    // Async on purpose: this handler runs on the MAIN process event loop, and
    // a synchronous read of a multi-MB artifact would stall every other guest
    // connection (and the whole app's IPC) for the duration of the disk hit.
    const bytes = await readFile(absolute)
    if (TEXT_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
      res.writeHead(200, { ...securityHeaders(), 'content-type': 'text/plain; charset=utf-8' })
      res.end(bytes)
      return
    }
    res.writeHead(200, {
      ...securityHeaders(),
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${encodeURIComponent(path.basename(absolute))}"`,
    })
    res.end(bytes)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer | string) => {
      body += chunk
      if (body.length > limit) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function listWorkspaceFiles(root: string): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (LIST_EXCLUDED.has(entry.name)) continue
      if (files.length >= MAX_LISTED_FILES) return
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'))
    }
  }
  walk(root)
  return files.sort()
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #f6f5f2; color: #1f2a30; }
  main { max-width: 720px; margin: 12vh auto 0; padding: 0 24px; }
  h1 { font-size: 18px; font-weight: 600; }
  .card { background: #fff; border: 1px solid #e3e0da; border-radius: 10px; padding: 24px; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #cfcbc3; border-radius: 8px; font-size: 14px; }
  button { margin-top: 12px; padding: 10px 18px; border: 0; border-radius: 8px; background: #2f6f62; color: #fff; font-size: 14px; cursor: pointer; }
  .error { color: #a8402f; font-size: 13px; margin: 8px 0 0; }
  .meta { color: #6d6a63; font-size: 13px; }
  ul.files { list-style: none; padding: 0; }
  ul.files li { padding: 6px 0; border-bottom: 1px solid #efece7; font-size: 14px; }
  a { color: #2f6f62; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body><main><div class="card">${body}</div></main></body>
</html>`
}

function loginForm(error: string | null): string {
  return [
    '<h1>TDEase Workspace</h1>',
    `<form method="POST" action="/login">`,
    `<input type="password" name="token" placeholder="Access token" autocomplete="off" required>`,
    `<button type="submit">Sign in</button>`,
    error ? `<p class="error">${escapeHtml(error)}</p>` : '',
    `</form>`,
  ].join('\n')
}

function collabLoginForm(error: boolean): string {
  return [
    '<h1>TDEaseNexus 协作对话</h1>',
    '<p class="meta">输入主机端分享的访问令牌,以加入实时 AI 对话。</p>',
    `<form method="POST" action="/collab/login">`,
    `<input type="password" name="token" placeholder="Access token" autocomplete="off" required>`,
    `<button type="submit">登录</button>`,
    error ? '<p class="error">令牌不正确。</p>' : '',
    `</form>`,
  ].join('\n')
}

/**
 * The guest collab client: one plain HTML page, no bundler, no external
 * assets. It consumes the same turn-event vocabulary the host Renderer does,
 * via the /collab/events SSE stream, and (tier permitting) sends prompts to
 * /collab/prompt. Deliberately minimal: stack all mirrored sessions, render
 * what the host sees, let the host user resolve approvals and run the tools.
 */
function collabPage(tier: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TDEaseNexus 协作对话</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #14181d; color: #d9dee4; font: 14px/1.6 system-ui, sans-serif; height: 100vh; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid #262c33; background: #181d23; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header a { color: #4fb08a; font-size: 12px; text-decoration: none; }
  header a:hover { text-decoration: underline; }
  .status { color: #7f8b98; font-size: 12px; }
  .status.live { color: #4fb08a; }
  #stage { flex: 1; overflow-y: auto; padding: 16px; }
  .session-block { max-width: 860px; margin: 0 auto 24px; border: 1px solid #262c33; border-radius: 10px; overflow: hidden; }
  .session-block .session-head { padding: 6px 12px; background: #1b2128; font-size: 12px; color: #8f9aa6; display: flex; justify-content: space-between; cursor: default; }
  .session-content { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
  .role { max-width: 85%; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
  .user { align-self: flex-end; background: #2a4a44; }
  .assistant { align-self: flex-start; background: #1f252d; border: 1px solid #2a323c; }
  .thinking { align-self: flex-start; background: #1a1f26; border-left: 3px solid #4a5560; color: #96a2ae; padding: 6px 10px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
  .tool { align-self: flex-start; max-width: 100%; background: #1c222b; border: 1px solid #2a323c; border-radius: 8px; padding: 6px 10px; font-size: 13px; }
  .tool b { color: #c5cdd6; }
  .tool .detail { color: #8f9aa6; white-space: pre-wrap; word-break: break-all; margin-top: 4px; font-size: 12px; }
  .tool .ok { color: #4fb08a; }
  .tool .fail { color: #e37d61; }
  .line { font-size: 12px; color: #7f8b98; }
  .line.warn { color: #d9a95c; }
  .placeholder { text-align: center; color: #6b7683; padding: 40px 0; }
  #composer { display: flex; gap: 10px; padding: 12px 16px 16px; max-width: 860px; margin: 0 auto; width: 100%; }
  #composer.hidden { display: none; }
  #input { flex: 1; resize: vertical; background: #1b2128; color: #d9dee4; border: 1px solid #2a323c; border-radius: 8px; padding: 10px 12px; font: 14px inherit; }
  #send { padding: 0 22px; border: 0; border-radius: 8px; background: #2f6f62; color: #fff; font-size: 14px; cursor: pointer; }
  #send:disabled { opacity: .5; cursor: wait; }
  .hint { color: #5f6a76; font-size: 12px; text-align: center; padding: 0 16px 12px; }
  .hint.hidden { display: none; }
</style>
</head>
<body>
  <header><h1>TDEaseNexus 协作对话</h1><span id="status" class="status">连接中…</span><a href="/files">工作区文件</a></header>
  <main id="stage"><p id="placeholder" class="placeholder">正在连接主机端会话…</p></main>
  <form id="composer" class="hidden">
    <textarea id="input" rows="2" placeholder="向主机端的 agent 提问(Enter 发送, Shift+Enter 换行)"></textarea>
    <button id="send" type="submit">发送</button>
  </form>
  <p id="hint" class="hint hidden">只读视角:可观看主机端实时对话与工具过程;提问需要主机端把分享档位提升到 continue/control。</p>
<script>
(function () {
  var SHARE_TIER = "${escapeHtml(tier)}";
  var stage = document.getElementById('stage');
  var placeholder = document.getElementById('placeholder');
  var statusEl = document.getElementById('status');
  var composer = document.getElementById('composer');
  var input = document.getElementById('input');
  var hint = document.getElementById('hint');
  var sendBtn = document.getElementById('send');
  var sessions = new Map();
  var pendingTools = new Map();
  var activeId = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function scroll() { stage.scrollTop = stage.scrollHeight; }
  function ensureSession(id, workspaceId) {
    var s = sessions.get(id);
    if (s) { if (workspaceId && !s.workspaceId) s.workspaceId = workspaceId; if (!activeId) activeId = id; return s; }
    var block = el('section', 'session-block');
    var head = el('div', 'session-head');
    head.appendChild(el('span', null, '会话 ' + id.slice(0, 8) + (workspaceId ? ' · ' + workspaceId : '')));
    var tag = el('span', null, '');
    if (activeId === id) tag.textContent = '(当前)';
    head.appendChild(tag);
    block.appendChild(head);
    var content = el('div', 'session-content');
    block.appendChild(content);
    stage.appendChild(block);
    if (placeholder) { placeholder.remove(); placeholder = null; }
    s = { id: id, content: content, headTag: tag, workspaceId: workspaceId || '', liveBubble: null, liveThinking: null };
    sessions.set(id, s);
    if (!activeId) activeId = id;
    scroll();
    return s;
  }
  function userRow(s, text) {
    s.content.appendChild(el('div', 'role user', text));
    s.liveBubble = null; s.liveThinking = null;
  }
  function assistantRow(s, text) {
    var n = el('div', 'role assistant', text);
    s.content.appendChild(n);
    s.liveBubble = n;
  }
  function thinkingRow(s, text) {
    var n = el('div', 'thinking', text);
    s.content.appendChild(n);
    s.liveThinking = n;
  }
  function line(s, text, warn) {
    s.content.appendChild(el('div', 'line' + (warn ? ' warn' : ''), text));
  }
  function toolCard(s, name, argsJson, resultText, ok) {
    var n = el('div', 'tool');
    n.appendChild(el('b', null, '工具 ' + name));
    n.appendChild(el('div', 'detail', '参数 ' + String(argsJson || '').slice(0, 600)));
    if (resultText !== undefined) n.appendChild(el('div', 'detail ' + (ok ? 'ok' : 'fail'), resultText));
    s.content.appendChild(n);
    return n;
  }
  function truncate(value) {
    var text = typeof value === 'string' ? value : JSON.stringify(value, null, 0);
    return text.slice(0, 2000) + (text.length > 2000 ? ' …' : '');
  }
  function handleCommitted(s, ev) {
    if (!ev || !ev.type) return;
    switch (ev.type) {
      case 'turn.started':
        userRow(s, ev.user_message || '');
        line(s, '回合开始 · ' + (ev.model || '') + (ev.mindset ? ' · ' + ev.mindset : ''));
        break;
      case 'thinking.recorded':
        thinkingRow(s, ev.content || '');
        break;
      case 'tool.requested':
        pendingTools.set(ev.call_id, toolCard(s, ev.name, ev.args, '执行中…', true));
        break;
      case 'tool.completed':
        if (pendingTools.has(ev.call_id)) {
          var t = pendingTools.get(ev.call_id);
          t.removeChild(t.lastChild);
          t.appendChild(el('div', 'detail ' + (ev.ok ? 'ok' : 'fail'), (ev.ok ? '完成' : '失败: ' + ((ev.error && ev.error.message) || '未知错误')) + (ev.ok ? ' · ' + truncate(ev.result).slice(0, 600) : '')));
          pendingTools.delete(ev.call_id);
        } else {
          toolCard(s, '(工具完成)', '', truncate(ev.ok ? ev.result : (ev.error && ev.error.message)), ev.ok);
        }
        break;
      case 'approval.requested':
        line(s, '审批: ' + ev.action + ' — ' + ev.basis + '(等待主机端处理)', true);
        break;
      case 'approval.resolved':
        line(s, '审批结果: ' + (ev.decision || '') + '(' + (ev.by || '') + ')');
        break;
      case 'message.completed':
        if (s.liveBubble) { s.liveBubble.textContent = ev.content || ''; s.liveBubble = null; }
        else assistantRow(s, ev.content || '');
        s.liveThinking = null;
        break;
      case 'card.created':
        line(s, '卡片: ' + ev.kind + ' → ' + (ev.ref || ''));
        break;
      case 'turn.completed':
        line(s, '回合完成: ' + (ev.outcome || '') + ' · ' + JSON.stringify(ev.usage || {}));
        s.liveBubble = null; s.liveThinking = null;
        break;
      case 'turn.failed':
        line(s, '回合失败: ' + ((ev.error && ev.error.message) || ''), true);
        s.liveBubble = null; s.liveThinking = null;
        break;
      case 'turn.cancelled':
        line(s, '回合已取消');
        s.liveBubble = null; s.liveThinking = null;
        break;
      case 'context.compacted':
        line(s, '上下文已压缩' + (ev.reason ? ' (' + ev.reason + ')' : ''));
        break;
      case 'model.request.prepared':
      default:
        break;
    }
  }
  function handleFrame(frame) {
    if (!frame || !frame.type) return;
    if (frame.type === 'bye') { statusEl.textContent = '分享已停止'; statusEl.className = 'status'; return; }
    if (frame.type === 'hello') {
      stage.innerHTML = '';
      placeholder = el('p', 'placeholder', '暂无共享会话 — 请在主机端打开 Agent 页面'); 
      stage.appendChild(placeholder);
      sessions = new Map();
      pendingTools = new Map();
      activeId = null;
      var list = frame.sessions || [];
      for (var i = 0; i < list.length; i++) ensureSession(list[i].sessionId, list[i].workspaceId);
      if (placeholder) { placeholder.remove(); placeholder = null; }
      var canPrompt = !!frame.canPrompt;
      composer.className = canPrompt ? '' : 'hidden';
      hint.className = canPrompt ? 'hint hidden' : 'hint';
      statusEl.textContent = '已连接 · ' + list.length + ' 个会话' + (canPrompt ? ' · 可提问' : ' · 只读');
      statusEl.className = 'status' + (canPrompt ? ' live' : '');
      return;
    }
    if (frame.type === 'session-gone') {
      var gone = sessions.get(frame.sessionId);
      if (gone) { gone.content.appendChild(el('div', 'line', '该会话已关闭')); }
      return;
    }
    if (frame.type === 'event') {
      var s = ensureSession(frame.sessionId);
      activeId = frame.sessionId;
      var ev = frame.event;
      if (!ev || !ev.type) return;
      if (ev.type === 'text_delta') {
        if (!s.liveBubble) assistantRow(s, '');
        s.liveBubble.textContent += ev.text || '';
      } else if (ev.type === 'thinking_delta') {
        if (!s.liveThinking) thinkingRow(s, '');
        s.liveThinking.textContent += ev.text || '';
      } else if (ev.type === 'turn_terminal') {
        line(s, '回合结束(' + (ev.outcome || '') + ') · ' + JSON.stringify(ev.usage || {}));
        s.liveBubble = null; s.liveThinking = null;
      } else if (ev.type === 'approval_requested') {
        line(s, '需要审批: ' + ev.action + ' — ' + (ev.basis || '') + '(由主机端处理)', true);
      } else if (ev.type === 'event_committed') {
        handleCommitted(s, ev.event);
      }
      scroll();
    }
  }

  composer.addEventListener('submit', function (ev2) {
    ev2.preventDefault();
    var id = activeId;
    var text = input.value.trim();
    if (!id || !text) return;
    sendBtn.disabled = true;
    fetch('/collab/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: id, message: text })
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: '请求失败(' + r.status + ')' }; });
    }).then(function (res) {
      if (res && res.ok) {
        input.value = '';
        statusEl.textContent = '已提交到会话 ' + id.slice(0, 8);
        statusEl.className = 'status live';
      } else {
        statusEl.textContent = (res && res.error) || '发送失败';
        statusEl.className = 'status';
      }
    }).catch(function () {
      statusEl.textContent = '发送失败';
      statusEl.className = 'status';
    }).then(function () { sendBtn.disabled = false; });
  });

  var es = new EventSource('/collab/events');
  es.addEventListener('hello', function (m) {
    try { handleFrame(JSON.parse(m.data)); } catch (e) { statusEl.textContent = '通信异常: ' + e.message; }
  });
  es.onmessage = function (m) {
    try { handleFrame(JSON.parse(m.data)); } catch (e) { statusEl.textContent = '通信异常: ' + e.message; }
  };
  es.onerror = function () {
    statusEl.textContent = '连接断开,重连中…';
    statusEl.className = 'status';
  };
})();
</script>
</body>
</html>`
}
