import type { CommandContext, CommandDefinition } from '../registry'
import { objectSchema, optionalNumber, requiredString, stringSchema } from '../args'

// The round-trip collapser: the model writes one JS script whose
// tool(name, args) calls run N gated invocations inside this single tool
// call. Every sub-call passes the same policy gate and the same wrapped
// tool the direct path uses — a script is not a bypass lane. See
// docs/design/PTC-RUNTIME.md; the runtime lives in electron/agent/ptc-runtime.ts.
export function ptcCommands(): ReadonlyArray<CommandDefinition> {
  return ([
    {
      id: 'ptc.exec', title: 'Run Tool Script',
      exposure: { mindsets: 'analysis' },
      summary: 'Execute a JS tool script inline. The script has two globals: tool(name, args) awaits one gated call to any tool this session registers (returns { text, details }) and log(...) appends a line to the result. Loops, conditionals, and in-memory joins replace repeated round-trips; a failed tool() throws (catch it to tolerate). Budgets: 200 tool() calls, 120s wall clock (timeout caps at 300s). No filesystem or network globals — read/write go through tool(). Not for fixed pipelines with no data flowing between steps — those are one composite bash command. Return a compact digest: the returned result is capped at ~12k chars, so write bulky artifacts to files via tool() and return their paths plus a summary.',
      args: objectSchema({
        script: stringSchema(),
        timeout: { type: 'number', minimum: 1, maximum: 300 },
      }, ['script']),
      mutates: true, permission: 'shell.exec', stakes: 'inline',
      enabled: (context) => Boolean(context.ptc),
      run: async (args, context, execution) => requirePtc(context).exec({
        script: requiredString(args, 'script'),
        timeout: optionalNumber(args, 'timeout'),
        signal: execution?.signal,
      }),
      renderForAgent: (result) => {
        const record = result as { ok: boolean; result?: string; error?: string; calls?: Array<{ name: string; ok: boolean }>; log?: string[]; timedOut?: boolean; aborted?: boolean }
        const lines = [
          `ok: ${record.ok}${record.timedOut ? ' (timed out)' : ''}${record.aborted ? ' (aborted)' : ''}`,
          `tool() calls: ${record.calls?.length ?? 0}${record.calls?.some((call) => !call.ok) ? ` (${record.calls.filter((call) => !call.ok).length} failed)` : ''}`,
        ]
        if (record.log?.length) lines.push(`log:\n${record.log.map((line) => `  ${line}`).join('\n')}`)
        if (record.error) lines.push(`error:\n${record.error}`)
        if (record.result !== undefined) lines.push(`result:\n${record.result}`)
        return lines.join('\n')
      },
    },
  ] satisfies CommandDefinition[])
}

function requirePtc(context: CommandContext) {
  if (!context.ptc) throw new Error('Programmatic tool calling is unavailable in this session')
  return context.ptc
}
