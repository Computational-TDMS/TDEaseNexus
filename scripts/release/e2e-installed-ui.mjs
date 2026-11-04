#!/usr/bin/env node
/**
 * Headless E2E for the installed TDEaseNexus desktop app (Windows VM).
 *
 * Plain node, zero npm deps, raw CDP over the global WebSocket (node >= 22).
 * Assumes the app is running with --remote-debugging-port=9333; if the CDP
 * endpoint is not reachable, launches the app via WMI and polls up to 60s.
 *
 * Checks:
 *   1. CDP reachable, exactly one page target under file:///...index.html
 *   2. Workspace reopen flow: seed localStorage keys, Page.reload, UI shows
 *      workspace name "Workspace" and 已连接 within 30s
 *   3. Fail-closed no-key guard: banner 当前模型还没有可用的 API 密钥 present,
 *      banner element exists in DOM (send is blocked; no key is configured)
 *   4. Session surface: a new session entry (未命名会话 or similar) in the list
 *   5. PNG screenshot evidence at .scratch/e2e-last-run.png
 *
 * Deterministic output: stable summary lines, no timestamps in PASS/FAIL.
 * Exit code 0 only if all checks pass.
 */

import { get } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Every value is env-overridable so the script is machine-independent; the
// defaults describe the standard release VM layout (docs/RELEASE-VM.md).
const env = (name, fallback) => process.env[name] ?? fallback;
const CDP_PORT = env('E2E_CDP_PORT', '9333');
const CDP_HTTP = `http://127.0.0.1:${CDP_PORT}`;
const INSTALL_DIR = env('E2E_INSTALL_DIR', String.raw`C:\Users\tdease\AppData\Local\Programs\TDEaseNexus`);
const APP_EXE = INSTALL_DIR + String.raw`\TDEaseNexus.exe`;
const GUEST_REPO = env('E2E_REPO', String.raw`C:\TDEase\TDEase-nexus`);
const SHOT_PATH = GUEST_REPO + String.raw`\.scratch\e2e-last-run.png`;
const WORKSPACE_PATH = env('E2E_WORKSPACE_PATH', String.raw`C:\Users\tdease\Workspace`);
const WORKSPACE_ID = env('E2E_WORKSPACE_ID', 'release-smoke');
const WORKSPACE_NAME = env('E2E_WORKSPACE_NAME', 'Workspace');
const MOCK_PORT = env('E2E_MOCK_PORT', '9100');
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const MOCK_SERVER = GUEST_REPO + String.raw`\scripts\release\mock-llm-server.mjs`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    get(url, { timeout: 5000 }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

async function cdpReachable() {
  try { await httpGetJson(CDP_HTTP + '/json/version'); return true; } catch { return false; }
}

async function launchAppViaWmi() {
  // Survives the ssh session: process is created by WMI, not our shell.
  const ps =
    `$exe = '${APP_EXE}'; ` +
    `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('\"' + $exe + '\" --remote-debugging-port=9333')} | Out-Null`;
  const { execFile } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], (err, so, se) =>
      err ? reject(new Error(se || err.message)) : resolve(so));
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('ws connect failed: ' + url)), { once: true });
    });
    const cdp = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        cdp.events.push(msg);
      }
    });
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 45000);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/** Evaluate an expression in the page, awaiting promises, returning the JSON value. */
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

const results = [];
function check(name, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`;
  console.log(line);
  results.push({ name, ok });
  return ok;
}


async function restartApp() {
  // Full main-process restart so settings.json provider changes are re-read
  // from disk — a renderer Page.reload does not refresh the agent registry.
  const { execFile } = await import('node:child_process');
  await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command',
      "Get-Process TDEaseNexus,python,tdease-backend -ErrorAction SilentlyContinue | Stop-Process -Force"],
      () => resolve());
  });
  await sleep(3000);
  await launchAppViaWmi();
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (await cdpReachable()) return true;
  }
  return false;
}

async function main() {
  // --- Step 1: ensure app with debugging flag is up -----------------------
  let up = await cdpReachable();
  if (!up) {
    console.log('CDP endpoint not reachable; launching app with --remote-debugging-port=9333 via WMI...');
    await launchAppViaWmi();
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await sleep(1500);
      if (await cdpReachable()) { up = true; break; }
    }
  }
  if (!check('cdp-endpoint-reachable', up, CDP_HTTP + '/json/version')) {
    finish();
    return;
  }

  // --- Check 1a: exactly one page target under file:///...index.html ------
  const targets = await httpGetJson(CDP_HTTP + '/json/list');
  const pages = targets.filter((t) => t.type === 'page');
  const indexPages = pages.filter((t) => /^file:\/\/\/.*index\.html/.test(t.url));
  // Startup can transiently surface extra targets (about:blank etc.);
  // the contract is that exactly one renderer hosts the app UI.
  const onePage = indexPages.length === 1;
  check('one-page-target-index-html', onePage,
    `pages=${pages.length} indexPages=${indexPages.length} url=${indexPages[0]?.url ?? 'none'}`);
  if (!onePage) { finish(); return; }

  let cdp = await Cdp.connect(indexPages[0].webSocketDebuggerUrl.replace('ws://127.0.0.1:9333', 'ws://127.0.0.1:9333'));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // --- Check 1b: workspace reopen flow ------------------------------------
  await evaluate(cdp, `(() => {
    localStorage.setItem('tdease.workspace.path', ${JSON.stringify(WORKSPACE_PATH)});
    localStorage.setItem('tdease.workspace.id', ${JSON.stringify(WORKSPACE_ID)});
    return true;
  })()`);
  await cdp.send('Page.reload');
  // Wait for reload to settle, then poll innerText for workspace name + 已连接.
  await sleep(2000);
  let reopened = false;
  let bodyText = '';
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      bodyText = await evaluate(cdp, 'document.body ? document.body.innerText : ""');
    } catch { /* page navigating; retry */ }
    if (bodyText.includes(WORKSPACE_NAME) && bodyText.includes('已连接')) { reopened = true; break; }
    await sleep(1000);
  }
  // Reset any provider credentials persisted by a previous run, then restart
  // so the fail-closed guard below is asserted against a credential-less app.
  let resetOk = false;
  try {
    resetOk = await evaluate(cdp, `(async () => {
      const bridge = window.tdeaseDesktop;
      if (!bridge?.agentProviders) return false;
      const r = await bridge.agentProviders.write('deepseek', {});
      return !!(r && r.ok);
    })()`);
  } catch { resetOk = false; }
  let restarted = resetOk ? await restartApp() : false;
  check('provider-reset-restart', restarted, resetOk ? 'deepseek entry cleared; app restarted' : 'bridge write failed');
  // reconnect after restart
  {
    const page2 = (await httpGetJson(CDP_HTTP + '/json/list')).filter((t) => t.type === 'page' && /^file:\/\/.*index\.html/.test(t.url))[0];
    if (page2) {
      try { cdp.close(); } catch {}
      cdp = await Cdp.connect(page2.webSocketDebuggerUrl);
    }
  }

  // readiness: let the rebooted app settle before behavioral assertions
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      if (await evaluate(cdp, `document.body.innerText.includes('已连接')`)) break;
    } catch {}
  }

  check('workspace-reopen-flow', reopened,
    `innerText includes "${WORKSPACE_NAME}" and 已连接 within 30s`);

  // --- Check 1c: fail-closed no-key guard ---------------------------------
  let bannerInfo = null;
  try {
    bannerInfo = await evaluate(cdp, `(() => {
      const text = document.body.innerText;
      const hasBannerText = text.includes('当前模型还没有可用的 API 密钥');
      let bannerEl = null;
      if (hasBannerText) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walker.nextNode())) {
          const own = Array.from(node.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent)
            .join('');
          if (own.includes('当前模型还没有可用的 API 密钥')) { bannerEl = node; break; }
        }
      }
      return { hasBannerText, bannerFound: !!bannerEl,
               bannerTag: bannerEl ? bannerEl.tagName + '.' + String(bannerEl.className).slice(0, 80) : null };
    })()`);
  } catch (e) {
    bannerInfo = { hasBannerText: false, bannerFound: false, error: e.message };
  }
  const guardOk = !!(bannerInfo && bannerInfo.hasBannerText && bannerInfo.bannerFound);
  check('fail-closed-no-key-guard', guardOk,
    `banner text present=${!!bannerInfo?.hasBannerText} banner element found=${!!bannerInfo?.bannerFound}${bannerInfo?.bannerTag ? ' (' + bannerInfo.bannerTag + ')' : ''}`);

  // --- Check 1d: session surface -------------------------------------------
  let hasSession = false;
  try {
    hasSession = await evaluate(cdp, `(() => {
      const text = document.body.innerText;
      // a fresh install shows the untitled session; a re-run shows the
      // persisted previous session — accept any session entry shape
      return ['未命名会话', '新会话', '新对话'].some((s) => text.includes(s))
        || /\\b\\d{1,2}:\\d{2}\\b/.test(text);
    })()`);
  } catch { hasSession = false; }
  check('session-entry-visible', hasSession, '未命名会话 (or similar) present in sessions list');

  // --- Check 2: mock provider (headless stand-in for a real API key) -------
  // The wire protocol is 'openai-completions' (provider-registry.ts); the
  // mock speaks POST /v1/chat/completions on 127.0.0.1:9100 and accepts any
  // key, so the agent chain runs without a real credential.
  let mockUp = false;
  const mockAlive = () => new Promise((resolve) => {
    get(MOCK_BASE + '/v1/models', { timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode === 200); })
      .on('error', () => resolve(false));
  });
  try {
    mockUp = await mockAlive();
    if (!mockUp) {
      const { spawn } = await import('node:child_process');
      const child = spawn(process.execPath, [MOCK_SERVER], { detached: true, stdio: 'ignore', env: { ...process.env, MOCK_PORT } });
      child.unref();
      for (let i = 0; i < 10 && !mockUp; i++) { await sleep(500); mockUp = await mockAlive(); }
    }
  } catch { mockUp = false; }
  check('mock-provider-server', mockUp, `${MOCK_BASE}/v1 (deterministic canned reply)`);

  let providerOk = false;
  try {
    providerOk = await evaluate(cdp, `(async () => {
      const bridge = window.tdeaseDesktop;
      if (!bridge?.agentProviders) return false;
      const r = await bridge.agentProviders.write('deepseek', { apiKey: 'mock-key', baseUrl: '${MOCK_BASE}/v1' });
      return !!(r && r.ok);
    })()`);
  } catch { providerOk = false; }
  check('mock-provider-configured', providerOk, `deepseek -> ${MOCK_BASE}/v1 (bridge write)`);

  // Full main-process restart: the agent registry reads settings.json at
  // resolve time, and a renderer reload does not refresh it (observed: the
  // turn still hit the real vendor endpoint after a reload-only change).
  let reconnected = await restartApp();
  {
    const page2 = (await httpGetJson(CDP_HTTP + '/json/list')).filter((t) => t.type === 'page' && /^file:\/\/.*index\.html/.test(t.url))[0];
    if (page2) {
      try { cdp.close(); } catch {}
      cdp = await Cdp.connect(page2.webSocketDebuggerUrl);
      await sleep(3000);
      for (let i = 0; i < 30 && !reconnected; i++) {
        await sleep(1000);
        try {
          reconnected = await evaluate(cdp, `document.body.innerText.includes('已连接') && document.body.innerText.includes('Workspace')`);
        } catch { reconnected = false; }
      }
    }
  }
  check('reconnect-after-provider-write', reconnected, 'status bar Workspace + 已连接 (full restart)');

  // --- Check 3: a real agent turn against the mock -------------------------
  let agentTurn = false; let turnDetail = '';
  try {
    // Trusted input only: the app ignores synthetic KeyboardEvents, so the
    // send goes through the real input pipeline (CDP Input domain).
    await cdp.send('Runtime.evaluate', { expression: `document.querySelector('textarea')?.focus()` });
    await sleep(200);
    // Ctrl+A, Backspace — clear any text left by a previous run
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await cdp.send('Input.insertText', { text: 'mock 链路测试' });
    await sleep(300);
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    for (let i = 0; i < 90 && !agentTurn; i++) {
      await sleep(1000);
      try {
        agentTurn = await evaluate(cdp, `document.body.innerText.includes('mock 回复')`);
      } catch { agentTurn = false; }
    }
    if (agentTurn) {
      turnDetail = 'assistant mock reply rendered in transcript';
    } else {
      let tail = '';
      try { tail = await evaluate(cdp, `document.body.innerText.slice(-400).replace(/\\n/g, ' | ')`); } catch {}
      turnDetail = 'mock reply not rendered within 90s; transcript tail: ' + tail;
    }
  } catch (e) { turnDetail = 'error: ' + e.message; }
  check('agent-turn-renders-mock-reply', agentTurn, turnDetail);

  // --- Check 1e: screenshot evidence ---------------------------------------
  let shotOk = false;
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = SHOT_PATH.replace(/^\w:\\/, (m) => m); // keep as-is
    await mkdir(dirname(SHOT_PATH), { recursive: true });
    await writeFile(SHOT_PATH, Buffer.from(shot.data, 'base64'));
    shotOk = true;
  } catch (e) {
    console.log('screenshot error: ' + e.message);
  }
  check('screenshot-captured', shotOk, SHOT_PATH);

  cdp.close();
  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`=== E2E summary: ${results.length - failed.length}/${results.length} checks passed ===`);
  if (failed.length > 0) {
    console.log('failed: ' + failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.log('FAIL script-error :: ' + e.message);
  finish();
});
