// Minimal MCP stdio server for behavioral tests (mcp-provider.test.ts).
// Speaks newline-delimited JSON-RPC 2.0: initialize / tools/list / tools/call.
// A tools/call whose arguments carry `hang: true` is deliberately NEVER
// answered — that hang is the whole point of the fixture. argv[2] names a
// counter file incremented once per process start, so tests can prove a
// reconnect spawned a fresh server rather than reusing a hung one.
import fs from 'node:fs'
import readline from 'node:readline/promises'

const counterFile = process.argv[2]
if (counterFile) {
  const previous = Number(fs.existsSync(counterFile) ? fs.readFileSync(counterFile, 'utf8') : '0')
  fs.writeFileSync(counterFile, String(previous + 1))
}

function reply(id, result, error) {
  process.stdout.write(`${JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result })}\n`)
}

const rl = readline.createInterface({ input: process.stdin })
for await (const line of rl) {
  if (!line.trim()) continue
  let message
  try { message = JSON.parse(line) } catch { continue }
  if (message.id === undefined) continue // notifications get no reply
  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '0.0.1' },
    })
  } else if (message.method === 'tools/list') {
    reply(message.id, {
      tools: [{
        name: 'echo',
        description: 'echo back',
        inputSchema: { type: 'object', properties: { hang: { type: 'boolean' }, text: { type: 'string' } } },
      }],
    })
  } else if (message.method === 'tools/call') {
    if (message.params?.arguments?.hang) continue // the deliberate hang
    if (message.params?.name !== 'echo') {
      // Answering with a JSON-RPC error = a server that IS responding (the
      // "keep the connection" branch of the error-class policy).
      reply(message.id, undefined, { code: -32602, message: `Unknown tool: ${message.params?.name}` })
    } else {
      reply(message.id, { content: [{ type: 'text', text: String(message.params?.arguments?.text ?? 'ok') }] })
    }
  } else {
    reply(message.id, undefined, { code: -32601, message: `unknown method ${message.method}` })
  }
}
