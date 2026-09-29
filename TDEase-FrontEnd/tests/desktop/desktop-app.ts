/**
 * The desktop fixture — Playwright driving the REAL Electron application.
 *
 * WHY THIS AND NOT A BROWSER. `tests/e2e/` loads the renderer in Chromium, where
 * `window.tdeaseDesktop` does not exist. Everything that makes TDEase a desktop
 * product lives behind that bridge: the workspace filesystem, the workspace
 * registry, the Pi runtime that runs Agent turns, the result cache, the skill
 * runtime. A browser spec therefore cannot fail for any of the reasons the
 * product actually breaks — which is precisely how a fully built Agent shipped
 * with a transcript nobody could reach.
 *
 * So this launches `electron/dist/main.bundle.cjs` the way `desktop:dev` does,
 * against the same Vite dev server, with the same preload and the same IPC
 * surface. The Backend is a `webServer` in `playwright.config.ts`, so a spec
 * that hits `/api/v2/...` exercises FastAPI, not a mock.
 *
 * ISOLATION. Each worker gets its own `--user-data-dir`, so a spec never reads
 * or writes the developer's real `workspaces.json`, layout state or Pi session
 * files. The seeded Workspace is written into that same temp root and
 * registered, which is what lets a spec attach a Workspace without a native
 * folder dialog Playwright cannot click.
 *
 * WHAT IS DELIBERATELY NOT FAKED: nothing in the app. The only concession to
 * being a test is `TDEASE_E2E=1`, which turns off four behaviours that would
 * hang the runner (hide-to-tray on close, detached DevTools stealing focus, the
 * tray icon). See the comment on `isE2E` in `electron/main.ts`.
 */
import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MAIN_BUNDLE = join(ROOT, 'electron', 'dist', 'main.bundle.cjs')
export const FIXTURE_PROVIDER = 'e2e-provider'
export const FIXTURE_MODEL = 'e2e-model'

/**
 * Opens the Agent page (the expanded agent view) from any shell state,
 * regardless of whether the docked sidebar is currently mounted. The rail
 * icon + the dock's expand action are the product's own affordances — this
 * helper composes them so specs stay black-box.
 */
export async function openAgentPage(page: import('@playwright/test').Page): Promise<void> {
  if (await page.locator('.agent-page:visible').count() > 0) return
  // The door handle — the ONE page control — hangs on the window edge facing
  // the Agent (right on Workbench, left on the Agent page).
  await page.locator('.page-handle').click()
  await expect(page.locator('.agent-page:visible')).toBeVisible()
}

/** Leaves the Agent page: the same handle has moved to the left edge. */
export async function closeAgentPage(page: import('@playwright/test').Page): Promise<void> {
  if (await page.locator('.agent-page:visible').count() === 0) return
  await page.locator('.page-handle').click()
  await expect(page.locator('.agent-page:visible')).toHaveCount(0)
}


export interface ProviderRequest {
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: Record<string, any>
}

export interface ProviderFixture {
  readonly baseUrl: string
  readonly requests: ProviderRequest[]
  /** GET /v1/models hits — the settings model-list refresher's discovery probe. */
  readonly modelListRequests: { count: number }
  reset(): void
}

export interface SeededWorkspace {
  /** Absolute path of the Workspace root the app will attach to. */
  path: string
  /** The name shown in the Workspace popover — the click target when attaching. */
  name: string
  workspaceId: string
}

export interface DesktopFixtures {
  /** Throwaway Electron user-data root; also holds the seeded Workspace. */
  userDataDir: string
  /** A Workspace already in the registry, not yet attached. */
  workspace: SeededWorkspace
  /** The launched Electron application. */
  app: ElectronApplication
  /** The main window's renderer page, after the shell has mounted. */
  page: Page
  /** Attaches `workspace` through the real Workspace popover. */
  openWorkspace: () => Promise<void>
  /** Everything the renderer logged as an error, so a spec can assert silence. */
  consoleErrors: string[]
  /** Real provider-compatible HTTP endpoint used by the real Pi adapter. */
  provider: ProviderFixture
  /** Selects the fixture provider through the renderer's persisted settings.
   *  The model id is overridable — specs exercising the aggregator-metadata
   *  digest bind a model the fixture settings carry no `models` entry for. */
  configureProvider: (model?: string) => Promise<void>
}

async function readJson(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendSse(response: ServerResponse, chunks: ReadonlyArray<Record<string, unknown>>): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  response.end('data: [DONE]\n\n')
}

/** Per-suite fixture tuning (defaults mirror the merged journey's needs).
 *  A large-context spec overrides `keepRecentTokens`/`contextWindow` in
 *  beforeAll and RESTORES them in afterAll — module state, not process.env,
 *  because one worker process may run several spec files and an env
 *  mutation would leak into the next suite (observed: a leaked
 *  keepRecentTokens=200000 made the journey's /compact a no-op, so
 *  `context.compacted` never fired). */
export const fixtureTuning = { keepRecentTokens: 10, contextWindow: 32_000 }

function lastUserText(body: Record<string, any>): string {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const message = [...messages].reverse().find((candidate) => candidate?.role === 'user')
  if (typeof message?.content === 'string') return message.content
  if (Array.isArray(message?.content)) {
    return message.content.map((part: any) => part?.text ?? '').join('')
  }
  return ''
}

/** Every user-role text in the request, joined — context-hook injections are
 *  appended as user messages AFTER the real prompt, so marker matching for a
 *  turn's script must scan all of them, not just the last. */
function allUserText(body: Record<string, any>): string {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages
    .filter((candidate: any) => candidate?.role === 'user')
    .map((candidate: any) => {
      if (typeof candidate.content === 'string') return candidate.content
      if (Array.isArray(candidate.content)) return candidate.content.map((part: any) => part?.text ?? '').join('')
      return ''
    })
    .join('\n')
}

function hasToolResult(body: Record<string, any>, callId?: string): boolean {
  return Array.isArray(body.messages) && body.messages.some((message: any) =>
    message?.role === 'tool' && (!callId || message.tool_call_id === callId))
}

function toolResult(body: Record<string, any>, callId: string): any | undefined {
  if (!Array.isArray(body.messages)) return undefined
  return [...body.messages].reverse().find((message: any) =>
    message?.role === 'tool' && message.tool_call_id === callId)
}

function submittedWorkflowResult(message: any): boolean {
  if (!message || typeof message.content !== 'string') return false
  try {
    return JSON.parse(message.content)?.status === 'submitted'
  } catch {
    return false
  }
}

async function handleProviderRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: ProviderRequest[],
  modelListRequests: { count: number },
): Promise<void> {
  // A client abort (user stop) destroys the socket while a delayed response
  // is still pending; the late write must not surface as an unhandled
  // stream error inside the fixture process.
  response.on('error', () => undefined)
  // The settings model-list refresher probes the vendor's listing endpoint
  // (GET {baseUrl}/models, baseUrl already ends in /v1). Serve the fixture's
  // own model plus one the static catalog does not know, so a spec can assert
  // the additive merge of a genuinely discovered id.
  if (request.method === 'GET' && request.url === '/v1/models') {
    modelListRequests.count += 1
    sendJson(response, 200, { data: [{ id: FIXTURE_MODEL }, { id: 'e2e-model-discovered' }] })
    return
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    sendJson(response, 404, { error: { message: 'fixture route not found' } })
    return
  }
  const body = await readJson(request)
  requests.push({ headers: { ...request.headers }, body })
  const prompt = lastUserText(body)

  if (prompt.includes('E2E_HTTP_401')) {
    sendJson(response, 401, { error: { message: 'fixture credential rejected', code: 'fixture_unauthorized' } })
    return
  }
  if (prompt.includes('E2E_HTTP_400')) {
    sendJson(response, 400, { error: { message: 'fixture request rejected', code: 'fixture_bad_request' } })
    return
  }

  const id = `chatcmpl-e2e-${requests.length}`
  // Pi's compaction summarizer announces itself with an unmistakable system
  // prompt; answer with a plain structured-summary head so the compaction
  // completes and the settled marker flows through the canonical log.
  const systemText = Array.isArray(body.messages) && body.messages[0]?.role === 'system'
    ? String(body.messages[0]?.content ?? '')
    : ''
  if (systemText.includes('context summarization assistant')) {
    sendSse(response, [{
      id, model: FIXTURE_MODEL,
      choices: [{ index: 0, delta: { role: 'assistant', content: '## Goal\nCompact the fixture session.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 },
    }])
    return
  }
  if (prompt.includes('E2E_STOP_ERROR')) {
    sendSse(response, [{
      id, model: FIXTURE_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: 'network_error' }],
      usage: { prompt_tokens: 7, completion_tokens: 0, total_tokens: 7 },
    }])
    return
  }

  // Bloat seeding for the large-context crash repro: one turn streams a large
  // assistant message (in chunks, like a real stream). E2E_BLOAT = ~60 KB;
  // E2E_BLOAT_BIG = ~130 KB in ONE message, the recorded defect's shape ("a
  // failed turn whose context carries a >100 KB message").
  if (prompt.includes('E2E_BLOAT')) {
    const big = prompt.includes('E2E_BLOAT_BIG')
    const line = 'bloat ' + 'x'.repeat(140) + ' padding sentence for the large-context repro.'
    const body = Array.from({ length: big ? 800 : 400 }, () => line).join('\n')
    const chunks: Record<string, unknown>[] = []
    const piece = Math.ceil(body.length / 10)
    for (let index = 0; index < body.length; index += piece) {
      chunks.push({
        id, model: FIXTURE_MODEL,
        choices: [{ index: 0, delta: { role: index === 0 ? 'assistant' : undefined, content: body.slice(index, index + piece) } }],
      })
    }
    chunks.push({
      id, model: FIXTURE_MODEL,
      choices: [{ index: 0, delta: { content: '\nBLOAT_TURN_DONE' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 40_000, completion_tokens: 15_000, total_tokens: 55_000 },
    })
    sendSse(response, chunks)
    return
  }

  // The prompt-queue scenario: the first turn HELD in flight for several
  // seconds so the spec can type the next message into a genuinely busy
  // session; the queued message then drains as its own later request.
  if (prompt.includes('E2E_QUEUE_SLOW')) {
    await new Promise((resolve) => setTimeout(resolve, 6_000))
    sendSse(response, [{
      id, model: FIXTURE_MODEL,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'QUEUE_FIRST_OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 13, completion_tokens: 4, total_tokens: 17 },
    }])
    return
  }
  if (prompt.includes('E2E_QUEUE_FAST')) {
    sendSse(response, [{
      id, model: FIXTURE_MODEL,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'QUEUE_SECOND_OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 13, completion_tokens: 4, total_tokens: 17 },
    }])
    return
  }

  // A blocked turn with one-tap options: reportBlocked settles the turn as
  // blocked and the offered options must reach the transcript as clickable
  // answers.
  // The blocked card must be scriptable PER TURN, not per session: a merged
  // journey hits E2E_REPORT_BLOCKED twice. A fresh blocked request is the one
  // whose LAST message is the user prompt; the tool-result roundtrip (last
  // message role = 'tool') falls through to the default text reply. The call
  // id is unique per occurrence, so session history never suppresses a card.
  const blockedMessages = Array.isArray(body.messages) ? body.messages : []
  const blockedLastRole = blockedMessages.length ? blockedMessages[blockedMessages.length - 1]?.role : undefined
  const blockedRound = blockedMessages
    .filter((message: any) => message?.role === 'tool' && String(message?.tool_call_id ?? '').startsWith('call_blocked')).length
  const blockedCallId = `call_blocked_${blockedRound + 1}`
  if (prompt.includes('E2E_REPORT_BLOCKED') && blockedLastRole === 'user') {
    sendSse(response, [
      {
        id, model: FIXTURE_MODEL,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: blockedCallId, type: 'function', function: { name: 'tdease_session_reportBlocked', arguments: '' } }],
          },
          finish_reason: null,
        }],
      },
      {
        id, model: FIXTURE_MODEL,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({
            reason: 'Two readings of the dimethyl question.',
            needed: 'Confirm which one you meant.',
            options: ['(a) K20 dimethyl localization', '(b) +121.9 explanation'],
          }) } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      },
    ])
    return
  }

  if (prompt.includes('E2E_TOOL_ROUNDTRIP') && !hasToolResult(body, 'call_readme')) {    sendSse(response, [
      {
        id, model: FIXTURE_MODEL,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: 'call_readme', type: 'function', function: { name: 'read', arguments: '' } }],
          },
          finish_reason: null,
        }],
      },
      {
        id, model: FIXTURE_MODEL,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"README.md"}' } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      },
    ])
    return
  }

  if (prompt.includes('E2E_SKILL_FIGURE') && !hasToolResult(body, 'call_plot')) {
    sendSse(response, [
      {
        id, model: FIXTURE_MODEL,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: 'call_plot', type: 'function', function: { name: 'bash', arguments: '' } }],
          },
          finish_reason: null,
        }],
      },
      {
        id, model: FIXTURE_MODEL,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({
            command: 'uv run --script ".tdease/skills/e2e-plot/scripts/plot.py"',
          }) } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      },
    ])
    return
  }

  if (prompt.includes('E2E_RUN_SUBMIT') && !hasToolResult(body, 'call_workflow_run')) {
    sendSse(response, [
      {
        id, model: FIXTURE_MODEL,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: 'call_workflow_run', type: 'function', function: { name: 'tdease_workflow_run', arguments: '' } }],
          },
          finish_reason: null,
        }],
      },
      {
        id, model: FIXTURE_MODEL,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"runPath":"runs/e2e-run"}' } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      },
    ])
    return
  }

  // The recall turn: a NEW loop must re-announce the tripped cost rule via
  // the context hook — the compaction-survival half of the guard's contract.
  if (allUserText(body).includes('E2E_COST_RULE_RECALL')) {
    const pinned = JSON.stringify(body).includes('[cost] Session rules')
    sendSse(response, [{
      id, model: FIXTURE_MODEL,
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: pinned ? 'COST_RULE_PINNED_OK' : 'COST_RULE_PINNED_MISSING' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 13, completion_tokens: 4, total_tokens: 17 },
    }])
    return
  }
  // The cost-guard chain: round one requests an oversized acquisition file
  // (seeded at 9 MB, past the guard's 8 MB whole-file threshold); the tool
  // must be DENIED before execution, and the denial must reach this second
  // request as the read's error result.
  if (allUserText(body).includes('E2E_COST_READ') && !hasToolResult(body, 'call_read_big')) {
    sendSse(response, [
      {
        id, model: FIXTURE_MODEL,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: 'call_read_big', type: 'function', function: { name: 'read', arguments: '' } }],
          },
          finish_reason: null,
        }],
      },
      {
        id, model: FIXTURE_MODEL,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"spectra/huge.mzML"}' } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      },
    ])
    return
  }
  if (allUserText(body).includes('E2E_COST_READ')) {
    const readResult = toolResult(body, 'call_read_big')
    const denied = typeof readResult?.content === 'string' && readResult.content.includes('[cost]')
    sendSse(response, [{
      id, model: FIXTURE_MODEL,
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: denied ? 'COST_GUARD_OK' : `COST_GUARD_MISSING:${String(readResult?.content ?? 'no tool result').slice(0, 120)}` },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 13, completion_tokens: 4, total_tokens: 17 },
    }])
    return
  }

  const workflowResult = toolResult(body, 'call_workflow_run')
  const plotResult = toolResult(body, 'call_plot')
  const toolMessage = Array.isArray(body.messages)
    ? [...body.messages].reverse().find((message: any) => message?.role === 'tool')
    : undefined
  // The bash tool result is the script's verbatim stdout — the bash-delta
  // scanner that used to append markdown links for produced figures was
  // removed in the produced-path guardrail rework, so the chain the fixture
  // verifies is "stdout reached the model", not "figure link was injected".
  const plotStdoutSeen = typeof plotResult?.content === 'string'
    && plotResult.content.includes('analysis/e2e-plot/result.json')
  const finalText = prompt.includes('E2E_SKILL_FIGURE') && plotResult
    ? plotStdoutSeen ? 'FIGURE_CHAIN_OK' : 'FIGURE_CHAIN_MISSING_LINK'
    : prompt.includes('E2E_RUN_SUBMIT') && workflowResult
    ? submittedWorkflowResult(workflowResult)
      ? 'RUN_SUBMITTED_OK'
      : `RUN_SUBMITTED_FAILED:${String(workflowResult.content)}`
    // The GATEWAY_OK verdict belongs to the E2E_TOOL_ROUNDTRIP scenario only:
    // later turns replay the earlier tool result in their history, and an
    // unguarded toolMessage check would hijack every subsequent fallback.
    : prompt.includes('E2E_TOOL_ROUNDTRIP') && toolMessage
    ? `GATEWAY_OK:${String(toolMessage.content).includes('e2e workspace') ? 'README_SEEN' : 'README_MISSING'}`
    : 'FIXTURE_OK'
  sendSse(response, [{
    id, model: FIXTURE_MODEL,
    choices: [{ index: 0, delta: { role: 'assistant', content: finalText }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 13, completion_tokens: 4, total_tokens: 17 },
  }])
}

async function startProviderFixture(): Promise<{ fixture: ProviderFixture; close(): Promise<void> }> {
  const requests: ProviderRequest[] = []
  const modelListRequests = { count: 0 }
  const server = createServer((request, response) => {
    void handleProviderRequest(request, response, requests, modelListRequests).catch((error) => {
      sendJson(response, 500, { error: { message: error instanceof Error ? error.message : String(error) } })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Provider fixture did not bind a TCP port')
  return {
    fixture: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      requests,
      modelListRequests,
      reset: () => { requests.length = 0 },
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

/**
 * A Workspace with one complete flat Run. The fixture follows the production
 * contract exactly: `runs/<run>/Snakefile` is the one workflow entry point and
 * its inputs live beside it.
 */
function writeWorkspace(userDataDir: string, index: number): SeededWorkspace {
  const path = join(userDataDir, `workspace-${index}`)
  const run = join(path, 'runs', 'e2e-run')
  mkdirSync(run, { recursive: true })
  mkdirSync(join(path, 'views'), { recursive: true })
  mkdirSync(join(path, '.tdease', 'skills', 'e2e-plot', 'scripts'), { recursive: true })
  // An oversized acquisition file (9 MB, past the cost guard's 8 MB whole-file
  // threshold) — its read must be DENIED before any bytes reach the model.
  mkdirSync(join(path, 'spectra'), { recursive: true })
  writeFileSync(join(path, 'spectra', 'huge.mzML'), Buffer.alloc(9 * 1024 * 1024, 0x61))

  writeFileSync(
    join(run, 'sample-a.mzML'),
    '<?xml version="1.0" encoding="utf-8"?>\n<mzML><run id="sample-a"/></mzML>\n',
    'utf8',
  )
  writeFileSync(
    join(run, 'reference.fasta'),
    '>sp|TEST|TEST_HUMAN Test protein\nMKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQ\n',
    'utf8',
  )
  writeFileSync(join(path, 'README.md'), '# e2e workspace\n', 'utf8')
  writeFileSync(
    join(path, '.tdease', 'skills', 'e2e-plot', 'SKILL.md'),
    [
      '---',
      'name: e2e-plot',
      'description: Desktop acceptance fixture for a PEP 723 plotting script.',
      '---',
      '',
      '# E2E plot',
      '',
      'Run `scripts/plot.py` through controlled bash.',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(path, '.tdease', 'skills', 'e2e-plot', 'scripts', 'plot.py'),
    [
      '# /// script',
      '# requires-python = ">=3.11"',
      '# dependencies = []',
      '# ///',
      'import base64',
      'import json',
      'from pathlib import Path',
      '',
      'out = Path("analysis/e2e-plot")',
      'out.mkdir(parents=True, exist_ok=True)',
      '(out / "result.json").write_text(json.dumps({"status": "ok", "points": [1, 2, 3]}), encoding="utf-8")',
      '(out / "figure.png").write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))',
      'print(json.dumps({"status": "ok", "result": "analysis/e2e-plot/result.json"}))',
      '',
    ].join('\n'),
    'utf8',
  )

  writeFileSync(
    join(run, 'Snakefile'),
    [
      'SAMPLES = ["sample-a"]',
      '',
      'rule all:',
      '    input: expand("{sample}-report.txt", sample=SAMPLES)',
      '',
      'rule report:',
      '    input: "{sample}.mzML"',
      '    output: "{sample}-report.txt"',
      '    shell: "echo done > {output}"',
      '',
    ].join('\n'),
    'utf8',
  )

  // A Canvas: `views/*.json` is the spec shape `CanvasesSection` scans for, so
  // the Canvases section has something real to list and open.
  writeFileSync(
    join(path, 'views', 'qc-overview.json'),
    `${JSON.stringify(
      {
        id: 'qc-overview',
        title: 'QC overview',
        blocks: [
          { id: 'headline', type: 'markdown', text: '# QC overview\n\nSeeded by the desktop e2e fixture.' },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  const workspaceId = `e2e-ws-${index}`
  const name = `workspace-${index}`
  mkdirSync(join(userDataDir, 'system'), { recursive: true })
  writeFileSync(
    join(userDataDir, 'system', 'workspaces.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        workspaces: [
          { workspace_id: workspaceId, name, local_path: path, last_opened_at: '2026-01-01T00:00:00.000Z' },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  return { path, name, workspaceId }
}

/**
 * Opt-in: copy the developer's REAL Client System settings into this run's
 * throwaway profile, so a model key already configured through Settings can
 * drive a live Agent turn without being retyped or put in a file.
 *
 *   TDEASE_E2E_INHERIT_CREDENTIALS=1 npx playwright test --project=desktop
 *
 * Off by default, and one-directional: the real profile is only READ. The copy
 * lands in the temp user-data dir, which is deleted with the rest of the run,
 * so nothing the suite does can disturb the app you actually use.
 *
 * `TDEASE_E2E_API_KEY` remains the explicit alternative for CI, where there is
 * no developer profile to inherit from.
 */
function inheritCredentials(userDataDir: string): void {
  if (process.env.TDEASE_E2E_INHERIT_CREDENTIALS !== '1') return
  const appData = process.env.APPDATA
    || (process.platform === 'darwin' ? join(process.env.HOME ?? '', 'Library', 'Application Support') : process.env.HOME)
  if (!appData) return

  const source = join(appData, 'TDEase', 'system', 'settings.json')
  if (!existsSync(source)) {
    console.warn(`[e2e] TDEASE_E2E_INHERIT_CREDENTIALS is set but ${source} does not exist`)
    return
  }
  try {
    const destination = join(userDataDir, 'system', 'settings.json')
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination)
  } catch (error) {
    console.warn('[e2e] could not inherit credentials:', error)
  }
}

export const test = base.extend<DesktopFixtures>({
  provider: async ({}, use) => {
    const running = await startProviderFixture()
    await use(running.fixture)
    await running.close()
  },

  userDataDir: async ({ provider }, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'tdease-e2e-'))
    inheritCredentials(dir)
    mkdirSync(join(dir, 'system'), { recursive: true })
    writeFileSync(join(dir, 'system', 'settings.json'), `${JSON.stringify({
      schemaVersion: 3,
      // Pi reads the same file's compaction block; a tiny keepRecentTokens
      // makes the journey's own (fixture-sized) history compactable, so the
      // compact-marker step stays deterministic instead of seeding oversized
      // messages (which the virtualized transcript cannot anchor). The
      // `fixtureTuning` seam lets a large-context repro keep bloat
      // UNcompacted, as in the real product's wide context windows.
      compaction: { keepRecentTokens: fixtureTuning.keepRecentTokens },
      providers: {
        [FIXTURE_PROVIDER]: {
          api: 'openai-completions',
          baseUrl: provider.baseUrl,
          apiKey: 'fixture-key',
          models: {
            [FIXTURE_MODEL]: {
              reasoning: false,
              input: ['text'],
              contextWindow: fixtureTuning.contextWindow,
              maxTokens: 2_048,
            },
          },
        },
      },
    }, null, 2)}\n`, 'utf8')
    await use(dir)
    // Best-effort: on Windows the Pi runtime can hold a handle for a moment
    // after the app closes. A leaked temp dir is noise; a throwing teardown
    // that masks the spec's own result is not.
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  },

  workspace: async ({ userDataDir }, use, testInfo) => {
    await use(writeWorkspace(userDataDir, testInfo.workerIndex))
  },

  // Depends on `workspace` so the registry file exists BEFORE Electron reads it.
  app: async ({ userDataDir, workspace }, use) => {
    void workspace
    const app = await electron.launch({
      args: [MAIN_BUNDLE, `--user-data-dir=${userDataDir}`],
      cwd: ROOT,
      env: {
        ...process.env,
        TDEASE_E2E: '1',
        TDEASE_E2E_RECREATE_WINDOWS: '1',
        TDEASE_E2E_DEVTOOLS: '1',
        TDEASE_ELECTRON_DEV_URL: process.env.TDEASE_ELECTRON_DEV_URL || 'http://127.0.0.1:1430',
      },
      timeout: 60_000,
    })
    await use(app)
    await app.close().catch(() => undefined)
  },

  page: async ({ app }, use) => {
    const mainUrl = process.env.TDEASE_ELECTRON_DEV_URL || 'http://127.0.0.1:1430'
    const page = app.windows().find((candidate) => candidate.url().startsWith(mainUrl))
      ?? await app.waitForEvent('window', {
        predicate: (candidate) => candidate.url().startsWith(mainUrl),
        timeout: 60_000,
      })
    await page.waitForLoadState('domcontentloaded')
    // The shell mounts behind `initializeTDEaseClient()`, so #app is empty for
    // a beat after load. Waiting on the SideBar rather than a fixed timeout
    // means a regression that never mounts fails here, with a message that
    // says so.
    await page.waitForSelector('.side-bar', { timeout: 30_000 })
    await use(page)
  },

  consoleErrors: async ({ page }, use) => {
    const errors: string[] = []
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('pageerror', (error) => errors.push(error.message))
    await use(errors)
  },

  configureProvider: async ({ page }, use) => {
    await use(async (model: string = FIXTURE_MODEL) => {
      await page.evaluate(({ provider, model }) => {
        localStorage.setItem('tdease.settings', JSON.stringify({
          provider,
          model,
          agentTools: {
            discovery: true,
            workflow: true,
            runObservation: true,
            runControl: false,
            media: true,
            canvas: false,
            workspaceWrite: false,
            shell: true,
            mcp: false,
          },
        }))
      }, { provider: FIXTURE_PROVIDER, model })
      await page.reload()
      await page.waitForSelector('.side-bar', { timeout: 30_000 })
    })
  },

  openWorkspace: async ({ page, workspace }, use) => {
    await use(async () => {
      await page.locator('.ws-rail-wrap .activity-btn').click()
      // The shell preserves hidden page instances across a route switch. Use
      // the visible popover so a reload cannot make the fixture click a stale
      // workspace item from the inactive instance.
      const popover = page.locator('.ws-popover:visible')
      await popover.locator('.ws-item', { hasText: workspace.name }).click()
      await popover.waitFor({ state: 'hidden', timeout: 10_000 })
    })
  },
})

export { expect } from '@playwright/test'
