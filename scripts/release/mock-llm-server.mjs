#!/usr/bin/env node
/**
 * Mock LLM provider for headless release testing of the installed app.
 *
 * Speaks the only wire protocol the agent uses for custom/builtin providers
 * ('openai-completions', provider-registry.ts): POST /v1/chat/completions,
 * streaming SSE and non-streaming JSON, plus GET /v1/models for discovery.
 * Deterministic canned reply; accepts any Authorization header (the product
 * requires a non-empty key — the mock frees tests from a real credential).
 *
 * Run on the VM: node mock-llm-server.mjs   (listens 127.0.0.1:9100)
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 9100);
const MODEL = 'mock-agent';
const REPLY =
  'mock 回复：这是一条来自 mock-llm-server 的确定性应答，用于无头验证 Agent 链路。';

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: MODEL, object: 'model', owned_by: 'tdease-mock' }],
    }));
    return;
  }
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* tolerated: canned reply anyway */ }
      const id = 'chatcmpl-mock-' + Date.now().toString(36);
      const created = Math.floor(Date.now() / 1000);

      // Tool roundtrip smoke: detect the last message role.
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      const lastRole = msgs.length ? msgs[msgs.length - 1]?.role : undefined;
      const lastUser = [...msgs].reverse().find((m) => m?.role === 'user');
      const userText = typeof lastUser?.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser.content.map((c) => c?.text ?? '').join('')
          : '';
      const roundtrips = msgs.filter((m) => m?.role === 'tool').length;
      if (userText.includes('E2E_TOOL_READ') && lastRole !== 'tool' && roundtrips === 0) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(sse({
          id, object: 'chat.completion.chunk', created, model: parsed.model ?? MODEL,
          choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_mock_read', type: 'function', function: { name: 'read', arguments: '' } }] }, finish_reason: null }],
        }));
        res.write(sse({
          id, object: 'chat.completion.chunk', created, model: parsed.model ?? MODEL,
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: 'README.md' }) } }] } }, ],
          finish_reason: 'tool_calls',
        }));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (userText.includes('E2E_TOOL_READ') && (lastRole === 'tool' || roundtrips > 0)) {
        const toolText = JSON.stringify(msgs.filter((m) => m?.role === 'tool'));
        const sawReadme = toolText.includes('e2e workspace');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id, object: 'chat.completion', created, model: parsed.model ?? MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: sawReadme
            ? 'E2E_TOOL_READ_OK: README 内容含 "e2e workspace"，工具回合成功。'
            : 'E2E_TOOL_READ_FAIL: 工具结果里没有 README 预期内容。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        }));
        return;
      }
      if (parsed.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        // two content chunks so the streaming render path is actually exercised
        for (const part of ['mock 回复：', '这是一条来自 mock-llm-server 的确定性应答，用于无头验证 Agent 链路。']) {
          res.write(sse({
            id, object: 'chat.completion.chunk', created, model: parsed.model ?? MODEL,
            choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
          }));
        }
        res.write(sse({
          id, object: 'chat.completion.chunk', created, model: parsed.model ?? MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id, object: 'chat.completion', created, model: parsed.model ?? MODEL,
          choices: [{
            index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }));
      }
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `mock: no route ${req.method} ${url.pathname}` } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-llm-server listening on http://127.0.0.1:${PORT}/v1 (model: ${MODEL})`);
});
