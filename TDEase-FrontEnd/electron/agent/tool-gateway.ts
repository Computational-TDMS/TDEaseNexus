/**
 * ToolGateway — the Node-side replacement for the renderer's tool execution.
 *
 * In the old renderer-engine model, builtin tools (read/write/bash/...), the
 * TDEase command tools and MCP were assembled inside
 * the old Renderer runtime against a boundary that round-tripped every
 * authorization through the renderer. In the Node AgentRuntime the boundary is
 * local: the PermissionGateway lives in the same process, the
 * `tool_call` hook in TDEaseExtension resolves 'ask' approvals against the
 * ApprovalCoordinator, and this gateway only has to:
 *
 *   - build Pi ToolDefinitions for each surface (builtin / studio / mcp)
 *   - enforce Workspace containment on every builtin execute (deny escapes),
 *     via the PermissionGateway's realpath-checked containment — never a
 *     string-prefix comparison, which symlinks/junctions defeat
 *   - enforce the deny-dominant permission ceiling (a 'deny' throws before any
 *     side effect; 'ask' is left for the hook because approval is interactive)
 *
 * Builtins and command tools are returned as `unknown[]` deliberately: the
 * composition root forwards them to `createAgentSession({ customTools })`,
 * which accepts Pi ToolDefinition[]; importing the deep ToolDefinition type
 * here would couple this file to the SDK's exact generic shape.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  defineTool,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import { assignChildToJob } from '../windows-job.cjs'
import { McpProvider } from '../../src/ai/core/mcp-provider'
import { createPersistentBashTool } from './persistent-bash-tool'
import { buildBashEnv } from './bash-env'
import { ResultDeduplicator } from './result-dedup'
import type { PtyTerminalService } from './pty-terminal'
import type { CostGuard } from './cost-guard'
import {
  renderCommandResult,
  type CommandDefinition,
  type CommandRegistry,
  type CommandContext,
} from '../../src/studio/commands/registry'
import type {
  AgentPermissionAction,
  AgentPermissionDecision,
  AgentToolPreferences,
} from '../../src/contracts/agent-runtime'
import type { PermissionGateway, SessionBinding } from './contracts'
import type { ProducedPathLedger } from './tool-call-gate'

const DEFAULT_BASH_TIMEOUT_SECONDS = 120
const MAX_BASH_TIMEOUT_SECONDS = 300

// A single model-facing read must stay inspectable. Larger data is paged or
// queried with rg/fd instead of being injected into the conversation whole.
const MAX_BASH_OUTPUT_CHARS = 12_000
const MAX_READ_LINES = 400
const MAX_GREP_MATCHES = 50
const MAX_GREP_CONTEXT_LINES = 2
const MAX_FIND_RESULTS = 100
const MAX_LS_ENTRIES = 100

// ── Options & surface ────────────────────────────────────────────────────────

export interface ToolGatewayProfile {
  /** Predicate over Studio command ids the binding permits. */
  readonly allowsStudioCommand: (id: string) => boolean
  /** The user's Agent Tools preferences (builtins/mcp). */
  readonly runtime: AgentToolPreferences
}

export interface ToolGatewayOptions {
  readonly binding: SessionBinding
  readonly permission: PermissionGateway
  readonly workspaceRoot: string
  readonly systemRoot: string
  /**
   * Owner-scoped PTY registry for this agent session: the persistent bash
   * tool's terminal sessions live here and are disposed with the session.
   */
  readonly terminals: PtyTerminalService
  /**
   * Read-only product assets root (holds `skills/`, `prompts/`, ...). Surfaced
   * as `TDEASE_SYSTEM_ASSETS` in the bash environment (via `bashEnv`) so a Skill
   * script is reached as `"$TDEASE_SYSTEM_ASSETS/skills/<skill>/scripts/<script>"`
   * without the model knowing an absolute path.
   */
  readonly systemAssetsRoot: string
  /**
   * The full TDEase skill runtime env the bash spawnHook installs as the
   * authoritative spawn environment — bundled uv on PATH, UV_CACHE_DIR,
   * UV_FIND_LINKS, UV_PYTHON and TDEASE_SYSTEM_ASSETS. Built
   * lazily from the composition root so an unused shell cannot block startup
   * when uv is unavailable.
   */
  readonly resolveBashEnv: () => NodeJS.ProcessEnv
  /** `<agentDir>/tools` — where the managed grep/find binaries live. */
  readonly managedBinDir: string
  /** Built by the composition root from Node-side ports (studio/evidence/...). */
  readonly studioContext: CommandContext
  readonly commandRegistry: CommandRegistry
  readonly profile: ToolGatewayProfile
  /** Same per-session ledger consulted by the tool_call hook. */
  readonly producedPaths?: ProducedPathLedger
  /** Cost guard for the builtin reads (whole-file size gate + slice budget); absent when the caller has none. */
  readonly costGuard?: CostGuard
}

export interface ToolGateway {
  /** Pi builtin ToolDefinitions (read/write/edit/bash/grep/find/ls), contained. */
  buildBuiltinTools(names: ReadonlyArray<string>): unknown[]
  /** TDEase command tools as Pi ToolDefinitions, permission-gated. */
  buildStudioTools(): unknown[]
  /** MCP tool, or null when the binding disables MCP. */
  buildMcpTool(): unknown | null
}

export function createToolGateway(options: ToolGatewayOptions): ToolGateway {
  const { binding, permission, workspaceRoot, systemRoot, systemAssetsRoot, resolveBashEnv, managedBinDir, studioContext, commandRegistry, profile } = options
  // One ledger per agent session: a repeated result is only suppressible
  // while the first copy it references is still in this session's context.
  const dedup = new ResultDeduplicator()

  return {
  buildBuiltinTools(names: ReadonlyArray<string>): unknown[] {
    return buildBuiltinTools(names, permission, workspaceRoot, managedBinDir, systemAssetsRoot, resolveBashEnv, options.terminals, binding.sessionId, options.producedPaths, dedup, options.costGuard)
  },
    buildStudioTools(): unknown[] {
      return buildStudioTools(commandRegistry, studioContext, permission, profile, dedup, workspaceRoot)
    },
    buildMcpTool(): unknown | null {
      if (!profile.runtime.mcp || !binding.toolCeiling.mcp) return null
      return buildMcpTool(workspaceRoot, systemRoot, permission, dedup)
    },
  }
}

// ── Pi result shape ──────────────────────────────────────────────────────────
//
// Pi tool execution returns an AgentToolResult (content + details).
// Errors are thrown, never encoded in content — Pi's event layer reads
// `isError` from the thrown path, not from a result field.

// No explicit return type so defineTool
// infers the AgentToolResult shape, with `type: 'text' as const` so the content
// block narrows to the text variant. Errors are thrown, never encoded in content
// (SDK contract: "Throw on failure instead of encoding errors in content").
function textResult(value: unknown) {
  const text = typeof value === 'string' ? value : safeStringify(value)
  return {
    content: [{ type: 'text' as const, text: text || 'OK' }],
    details: {},
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** `$VAR`, `${VAR}`, `%VAR%` — shell-env spellings that never resolve in a
 *  builtin tool's path argument. */
const ENV_PATH_TOKEN = /(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_]+%)/

// ── Builtin tools ────────────────────────────────────────────────────────────

function buildBuiltinTools(
  names: ReadonlyArray<string>,
  permission: PermissionGateway,
  cwd: string,
  managedBinDir: string,
  systemAssetsRoot: string,
  resolveBashEnv: () => NodeJS.ProcessEnv,
  terminals: PtyTerminalService,
  owner: string,
  producedPaths?: ProducedPathLedger,
  dedup?: ResultDeduplicator,
  costGuard?: CostGuard,
): unknown[] {
  const factories: Record<string, () => unknown> = {
    read: () => createReadTool(cwd),
    write: () => createWriteTool(cwd),
    edit: () => createEditTool(cwd),
    // The persistent PTY bash (the DSH tool-bash-persistent port): state —
    // cwd, exported variables — survives across calls for this agent session,
    // commands are marker-framed against the terminal scrollback, and non-zero
    // exits are REPORTED as `[exit code: N]` + structured details, never
    // thrown. The shell is spawned with the full TDEase skill runtime env
    // (bundled uv on PATH, UV_*, TDEASE_SYSTEM_ASSETS) as the authoritative
    // environment, plus the managed-bin PATH prefix for the rg/fd short names.
    // The permission wrapper below still asserts cwd containment + destructive
    // command preflight per call; the shell itself starts in the Workspace.
    bash: () => {
      // The complete shell env is shared with background jobs
      // (bash-env.ts) so `$VAR` expansion and TDEASE_WORKSPACE behave the
      // same whether a command runs synchronously here or as a job.
      const spawnEnv = () => buildBashEnv(cwd, managedBinDir, systemAssetsRoot, resolveBashEnv)
      const { execute } = createPersistentBashTool({
        terminals,
        owner,
        env: spawnEnv,
        workspaceRoot: cwd,
        maxOutputChars: MAX_BASH_OUTPUT_CHARS,
      })
      return defineTool({
        name: 'bash',
        label: 'bash',
        description:
          `Run a persistent bash command in the Workspace. Output is capped at ${MAX_BASH_OUTPUT_CHARS} characters; use rg, fd, or a narrower query for large results. ` +
          'Non-zero exits are reported as `[exit code: N]`; timed-out commands return partial output and reset the shell.',
        parameters: Type.Object({
          command: Type.String({ description: 'The bash command to run. Relative paths are preferred.' }),
          timeout: Type.Optional(Type.Number({ description: 'Optional wait in seconds; cannot exceed the session ceiling (default 120). For anything longer, use tdease.job.start + tdease.job.wait instead of raising this.' })),
          cwd: Type.Optional(Type.String({ description: 'Working directory inside the Workspace for this call only (optional; default is the Workspace root).' })),
        }),
        execute,
      })
    },
    grep: () => createGrepTool(cwd),
    find: () => createFindTool(cwd),
    ls: () => createLsTool(cwd),
    // The session task plan. Stateless by design: every call carries the
    // whole list (replacement semantics), the renderer derives the plan card
    // from the tool call args themselves — there is no server-side state to
    // keep, the transcript is the durable state. Reaches this table only for
    // workflow profiles: buildToolCeiling appends the name when
    // includeTodo holds; subagent allowlist profiles never do.
    todo_write: () => defineTool({
      name: 'todo_write',
      label: 'Todo',
      description:
        'Manage the session task plan for multi-step work. Each call REPLACES the whole list. ' +
        'Keep one in_progress item at a time; not needed for single-step tasks.',
      parameters: Type.Object({
        todos: Type.Array(
          Type.Object({
            content: Type.String({ minLength: 1, description: 'Stable task description.' }),
            activeForm: Type.String({ minLength: 1, description: 'Present-tense text shown while this task is in progress.' }),
            status: Type.String({ enum: ['pending', 'in_progress', 'completed'] }),
          }),
          { description: 'The complete list; each call replaces the previous one.' },
        ),
      }),
      execute: async (_callId: string, args: Record<string, unknown>) => {
        const todos = args.todos
        if (!Array.isArray(todos)) throw new Error('todo_write requires a todos array')
        const valid = todos.every((item) => {
          if (!item || typeof item !== 'object') return false
          const todo = item as Record<string, unknown>
          return typeof todo.content === 'string' && todo.content.trim().length > 0
            && typeof todo.activeForm === 'string' && todo.activeForm.trim().length > 0
            && (todo.status === 'pending' || todo.status === 'in_progress' || todo.status === 'completed')
        })
        if (!valid) throw new Error('todo_write received an invalid todo item')
        const completed = todos.filter((item) => (item as Record<string, unknown>).status === 'completed').length
        return textResult(todos.length ? `Updated ${todos.length} tasks (${completed} completed).` : 'Cleared the task list.')
      },
    }),
  }

  return names.map((name) => {
    const factory = factories[name]
    if (!factory) throw new Error(`Unsupported Pi builtin tool: ${name}`)
    const tool = factory() as {
      execute: (callId: string, args: Record<string, unknown>, ...rest: unknown[]) => Promise<unknown>
    }

    // WHY wrap execute (not subclass): the Pi tool factories return plain
    // ToolDefinition objects with their own `execute`. Replacing `execute`
    // in-place keeps the tool's schema
    // and label intact and inserts the containment + permission gate as the
    // last step before the real tool runs.
    return {
      ...tool,
      ...(boundedBuiltinDescription(name) ? { description: boundedBuiltinDescription(name) } : {}),
      execute: async (callId: string, args: Record<string, unknown>, ...rest: unknown[]) => {
        // `refresh: true` opts a single call out of result dedup; the
        // underlying tool never sees the flag.
        const { refresh, ...callArgs } = args ?? {}
        // Environment variables expand only inside bash. A `$VAR`/`%VAR%` path
        // arg resolves to a literally-named file (ENOENT) — or, for
        // write/edit, creates one. Fail with the fix, not the mystery (probe
        // evidence: three wasted read attempts on $TDEASE_SYSTEM_ASSETS
        // paths before the model fell back to bash).
        if (typeof callArgs.path === 'string' && ENV_PATH_TOKEN.test(callArgs.path)) {
          throw new Error(
            `The path contains an environment variable ("${callArgs.path}"). Environment variables expand only in bash — run the command through bash, or pass the resolved Workspace-relative/absolute path.`,
          )
        }
        const constrained = constrainBuiltinArgs(name, callArgs, permission)
        enforceBuiltinPermission(name, permission, constrained)
        // The cost guard rides AFTER containment (the path is resolved here)
        // and BEFORE execution: a tripped rule throws the model-facing
        // denial, so the retry happens in-turn against the cheap path —
        // the expensive call never runs (cost-guard.ts).
        if (costGuard && name === 'read' && typeof constrained.path === 'string') {
          await costGuard.checkReadSize(constrained.path)
          costGuard.checkReadSlice(constrained.path)
        }
        const result = await tool.execute(callId, constrained, ...rest)
        if (!dedup) return result
        const block = singleTextBlock(result)
        if (block) block.text = dedup.filter(block.text, name, refresh === true)
        return result
      },
    }
  })
}

/** The single text content block of a Pi AgentToolResult, when that is all it holds. */
function singleTextBlock(result: unknown): { text: string } | undefined {
  const content = (result as { content?: unknown } | null | undefined)?.content
  if (!Array.isArray(content) || content.length !== 1) return undefined
  const block = content[0] as { type?: string; text?: unknown } | null
  if (!block || block.type !== 'text' || typeof block.text !== 'string') return undefined
  return block as { text: string }
}

/**
 * Contain builtin args through the PermissionGateway: resolve path-like fields
 * against the Workspace root with realpath-checked containment (symlink and
 * junction escapes throw), and for `bash` force the cwd inside the Workspace
 * and run the destructive-command preflight.
 */
function constrainBuiltinArgs(
  name: string,
  args: Record<string, unknown>,
  permission: PermissionGateway,
): Record<string, unknown> {
  const next = { ...args }
  const operation = name === 'write' || name === 'edit' ? 'write' : 'read'
  for (const key of ['path', 'filePath', 'directory']) {
    if (typeof next[key] === 'string') next[key] = permission.resolveWorkspacePath(next[key] as string, operation)
  }
  if (name === 'read') next.limit = boundedNumber(next.limit, MAX_READ_LINES, MAX_READ_LINES)
  if (name === 'grep') {
    next.limit = boundedNumber(next.limit, MAX_GREP_MATCHES, MAX_GREP_MATCHES)
    next.context = boundedNumber(next.context, 0, MAX_GREP_CONTEXT_LINES)
  }
  if (name === 'find') next.limit = boundedNumber(next.limit, MAX_FIND_RESULTS, MAX_FIND_RESULTS)
  if (name === 'ls') next.limit = boundedNumber(next.limit, MAX_LS_ENTRIES, MAX_LS_ENTRIES)
  if (name === 'bash') {
    // An explicit cwd is scoped to this call; absent cwd means Workspace root.
    if (typeof next.cwd === 'string') next.cwd = permission.assertCommandCwd(next.cwd)
    permission.assertShellCommand(String(next.command || ''))
    const requested = typeof next.timeout === 'number' && Number.isFinite(next.timeout) && next.timeout > 0
      ? next.timeout
      : DEFAULT_BASH_TIMEOUT_SECONDS
    next.timeout = Math.min(requested, MAX_BASH_TIMEOUT_SECONDS)
  }
  return next
}

function boundedNumber(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(maximum, Math.floor(value)))
}

function boundedBuiltinDescription(name: string): string | undefined {
  switch (name) {
    case 'read':
      return `Read a bounded file slice (at most ${MAX_READ_LINES} lines per call). Use offset for the next slice or grep for a targeted match.`
    case 'grep':
      return `Search file contents. Results are capped at ${MAX_GREP_MATCHES} matches with at most ${MAX_GREP_CONTEXT_LINES} context lines.`
    case 'find':
      return `Find files by glob. Results are capped at ${MAX_FIND_RESULTS} paths.`
    case 'ls':
      return `List a directory. Results are capped at ${MAX_LS_ENTRIES} entries.`
    default:
      return undefined
  }
}

/**
 * Enforce the permission decision on builtins. 'deny' throws before any side
 * effect. 'allow' proceeds. 'ask' also proceeds here — the interactive
 * approval is resolved at the `tool_call` hook (TDEaseExtension) via the
 * ApprovalCoordinator, so by the time execute runs the call is already
 * permitted. Re-asking in execute would double-prompt.
 *
 * The decision is per CALL, not per action: `args` feeds the binding's
 * parameterized overrides (e.g. `bash ^git ` → allow, `bash rm -rf` → deny)
 * before the coarse action ceiling applies. MCP dispatch above stays on the
 * coarse `decide`: its arguments are server-specific, no predicate could be
 * written against them honestly.
 */
function enforceBuiltinPermission(
  name: string,
  permission: PermissionGateway,
  args: Record<string, unknown>,
): void {
  const action = builtinActionFor(name)
  if (!action) return
  const decision = permission.decideCall(action, args)
  if (decision === 'deny') {
    throw new Error(`Permission denied by main-process policy: ${action}`)
  }
}

function builtinActionFor(name: string): AgentPermissionAction | undefined {
  // todo_write is exempt: its only effect is the tool call appearing in the
  // transcript — no workspace or shell side effect exists to gate. Mapping it
  // to any file action would tie the plan to a permission the plan never
  // touches (an workflow with workspace-write denied could no longer plan).
  if (name === 'todo_write') return undefined
  if (name === 'bash') return 'shell.exec'
  if (name === 'read' || name === 'grep' || name === 'find' || name === 'ls') return 'workspace.read'
  // Unknown builtins fail safe: treated as the strongest gated action.
  return 'workspace.write'
}

// ── Studio command tools ─────────────────────────────────────────────────────

function buildStudioTools(
  registry: CommandRegistry,
  context: CommandContext,
  permission: PermissionGateway,
  profile: ToolGatewayProfile,
  dedup: ResultDeduplicator,
  workspaceRoot: string,
): unknown[] {
  const allowed = registry.list().filter((definition) => {
    if (definition.agentVisible === false) return false
    // WHY filter on both profile and permission: the binding's toolCeiling is
    // the mindset+preferences filter, and `allowsStudioCommand` is that
    // ceiling's predicate. The permission gateway is the deny-dominant runtime
    // decision. A command denied by either is not advertised: a tool the model
    // can only fail to use is the phantom-tool defect (see registry.agentTools).
    if (!profile.allowsStudioCommand(definition.id)) return false
    if (definition.permission && permission.decide(definition.permission) === 'deny') return false
    if (definition.enabled && !definition.enabled(context)) return false
    return true
  })

  return allowed.map((definition) => buildStudioTool(definition, registry, context, dedup, workspaceRoot))
}

/** The `runs.*` commands are Backend-registered-Run tools only. A model that
 *  aims them at a local workspace Run source root (`runs/<id>` on disk, never
 *  submitted through the Backend) gets a bare RUN_NOT_FOUND — a dead end it
 *  then works around with extra tool calls. When the named run exists as a
 *  local directory, answer with the guidance instead of the error. */
function localRunGuidance(definition: CommandDefinition, params: Record<string, unknown> | undefined, workspaceRoot: string): string | null {
  if (!definition.id.startsWith('runs.')) return null
  const runId = params?.runId
  if (typeof runId !== 'string' || !runId || runId.includes('/') || runId.includes('\\')) return null
  if (!fs.existsSync(path.join(workspaceRoot, 'runs', runId))) return null
  return `${runId} is a local workspace Run directory (runs/${runId}), not a Backend-registered Run — ` +
    `${definition.id} only covers Backend-registered Runs and will always report RUN_NOT_FOUND for it. ` +
    `Work directly on the files under runs/${runId} with the filesystem tools instead; Backend registration is unnecessary.`
}

function buildStudioTool(
  definition: CommandDefinition,
  registry: CommandRegistry,
  context: CommandContext,
  dedup: ResultDeduplicator,
  workspaceRoot: string,
): unknown {
  return defineTool({
    name: `tdease.${definition.id}`,
    // ToolDefinition requires a label; Studio commands expose a human title,
    // which is the right display string for a tool picker.
    label: definition.title,
    description: definition.summary,
    // definition.args is a validated JSON Schema object (CommandDefinition
    // rejects non-object schemas at registration); defineTool's parameter
    // slot wants a TypeBox TSchema, which a plain JSON Schema structurally
    // satisfies — this bridge is the only cast, and it is one explicit hop
    // (unknown → TSchema) rather than an `as any` that would hide anything.
    parameters: definition.args as unknown as TSchema,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: any,
    ) => {
      // CommandRegistry.invoke already enforces the command's own permission
      // action against context.permission (the same gateway), so this path does
      // not re-check here. The Studio permission ladder (silent/inline/document)
      // is what turns an 'ask' into an interactive review surface.
      // `refresh: true` opts a single call out of result dedup; the command
      // itself never sees the flag.
      const { refresh, ...callParams } = params ?? {}
      const localRun = localRunGuidance(definition, callParams, workspaceRoot)
      if (localRun) return textResult(localRun)
      const result = await registry.invoke(definition.id, callParams, context, { signal: _signal })
      return textResult(dedup.filter(renderCommandResult(definition, result), `tdease.${definition.id}`, refresh === true))
    },
  })
}

// ── MCP tool ─────────────────────────────────────────────────────────────────

function buildMcpTool(workspaceRoot: string, systemRoot: string, permission: PermissionGateway, dedup: ResultDeduplicator): unknown {
  // The McpProvider reads `.tdease/settings.json` (workspace) and the System
  // settings.json in its constructor. Both roots are supplied explicitly by
  // the Node composition root. Spawned MCP servers join the kill-on-close
  // job so they cannot outlive a crashed main process.
  const provider = new McpProvider(workspaceRoot, systemRoot, {
    onChildProcess: (pid) => { if (pid) assignChildToJob(pid) },
  })

  return defineTool({
    name: 'mcp',
    label: 'MCP',
    description: 'Use an enabled workspace MCP server. List servers or tools before calling a tool.',
    parameters: Type.Object({
      action: Type.String({ enum: ['servers', 'tools', 'call'] }),
      server: Type.Optional(Type.String()),
      tool: Type.Optional(Type.String()),
      arguments: Type.Optional(Type.Any()),
    }),
    execute: async (
      _callId: string,
      params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: any,
    ) => {
      const { refresh, ...call } = params ?? {}
      const action = String(call?.action || '')
      // F15: 'servers' is gated like tools/call — listing configured MCP
      // servers (their names, commands and args) is itself reconnaissance
      // value; leaving it ungated let a denied session enumerate the MCP
      // surface it was denied from using.
      enforcePermission(permission, 'shell.exec')
      if (action === 'servers') return textResult(dedup.filter(mcpText(provider.listServers()), 'mcp', refresh === true))
      const server = String(call?.server || '')
      if (!server) throw new Error('mcp server is required')
      if (action === 'tools') {
        enforcePermission(permission, 'shell.exec')
        return textResult(dedup.filter(mcpText(await provider.listTools(server)), 'mcp', refresh === true))
      }
      if (action !== 'call') throw new Error(`Unsupported MCP action: ${action}`)
      const tool = String(call?.tool || '')
      if (!tool) throw new Error('mcp tool is required')
      const args = call?.arguments && typeof call.arguments === 'object'
        ? (call.arguments as Record<string, unknown>)
        : {}
      // WHY gate every MCP call on shell.exec: an MCP tool is arbitrary code
      // execution by another name. The renderer's ToolBoundary mapped
      // 'mcp.call' → 'ask'; here we re-use the existing 'shell.exec' decision
      // so the permission ceiling stays the single source of truth and
      // there is no second, MCP-only action to keep in sync with the contract.
      enforcePermission(permission, 'shell.exec')
      return textResult(dedup.filter(mcpText(await provider.callTool(server, tool, args, _signal)), 'mcp', refresh === true))
    },
  })
}

/** The model-facing text for an MCP payload, exactly what textResult would render. */
function mcpText(value: unknown): string {
  return typeof value === 'string' ? value : safeStringify(value)
}

// ── Permission helpers ───────────────────────────────────────────────────────

function enforcePermission(permission: PermissionGateway, action: AgentPermissionAction): void {
  const decision: AgentPermissionDecision = permission.decide(action)
  if (decision === 'deny') {
    throw new Error(`Permission denied by main-process policy: ${action}`)
  }
  // 'ask' is resolved by the tool_call hook; see enforceBuiltinPermission.
}
