/**
 * Node-side PermissionGateway: the unbypassable permission + containment layer.
 *
 * Every tool call (builtin read/write, TDEase studio command, or MCP
 * dispatch, bash) funnels through one `decide(action)` here before it touches
 * the world. The decisions are NOT recomputed per call — they were resolved
 * once at bind time (deny > ask > allow across system/user/workspace rules, in
 * src/services/agent/permissionResolver) and frozen into
 * `SessionBinding.permissionCeiling`. A Pi `context` hook can narrow the active
 * tool set mid-run, but it can never widen this ceiling: that is the security
 * boundary (AGENT-CONTRACT.md §1).
 *
 * Containment is the other half. `resolveWorkspacePath` and `assertCommandCwd`
 * route every filesystem access and every bash cwd through `containedPath`,
 * which rejects `../` escapes and symlink breaks out of the Workspace root. This
 * is the same primitive the workspace layer uses, so a tool and a direct
 * workspace edit cannot disagree about what "inside the workspace" means.
 *
 * Why freeze at construction rather than re-resolve per call? Two reasons:
 *   1. Determinism — a replay must see the exact decisions the original run saw,
 *      not whatever the rules file says at replay time.
 *   2. Security — if a hostile process rewrote `.tdease/permissions.json` mid-
 *      turn to add `shell.exec: allow`, re-resolving per call would honor it.
 *      Freezing at bind time means the answer for the whole binding was settled
 *      before any tool ran.
 */

import path from 'node:path'

import { containedPath } from '../path_containment.cjs'

import type {
  AgentPermissionAction,
  AgentPermissionDecision,
} from '../../src/contracts/agent-runtime'

import { evaluatePermissionDecision } from '../../src/services/agent/permissionResolver'

import type { PermissionGateway } from './contracts'
import type { SessionBinding } from './turn-definition'

/**
 * Workspace-relative paths the agent must never reach through the file tools.
 * The judgment is made on RESOLVED ABSOLUTE paths (after realpath-checked
 * containment), never on the raw input string — `.tdease/./permissions.json`,
 * `..`-segments, Windows case variants and absolute forms all normalize to the
 * same target and are caught identically. A symlink into a private path is
 * caught too, because containment already resolved it.
 */
const PRIVATE_WORKSPACE_SUFFIXES = [
  '.tdease/sessions',
  '.tdease/events.jsonl',
  // The workspace permission policy is the user's trust statement. An agent
  // that could rewrite it would self-elevate every FUTURE session (the frozen
  // ceiling already makes mid-session edits inert), so it is as unreachable
  // through the file tools and the shell as session state is.
  '.tdease/permissions.json',
] as const

function normalizeAbsolute(value: string): string {
  return path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function isUnderRoot(absolute: string, root: string): boolean {
  const target = normalizeAbsolute(absolute)
  const base = normalizeAbsolute(root)
  return target === base || target.startsWith(`${base}/`)
}

/** Mask every spelling of `root` out of `text` so the outside-workspace rule
 * below cannot fire on a path the product deliberately exposes. Built
 * character by character: a separator is one character in the text but must
 * match either slash, and double-escaping it would demand two. */
function maskRoot(text: string, root: string, placeholder = '<app-data>'): string {
  const pattern = [...root]
    .map((ch) => {
      if (ch === '\\' || ch === '/') return '[\\\\/]'
      if ('[.*+?^${}()|]'.includes(ch)) return `\\${ch}`
      return ch
    })
    .join('')
  return text.replace(new RegExp(pattern, 'gi'), placeholder)
}

/** MSYS spelling of a normalized absolute path (`c:/x` → `/c/x`). git-bash
 * tools report workspace paths this way (`pwd`, error messages), so the
 * string-level rules must recognize both spellings of the same root. */
function msysForm(normalizedRoot: string): string {
  return normalizedRoot.replace(/^([a-z]):/, '/$1')
}

function isPrivateWorkspacePath(absolute: string, workspaceRoot: string): boolean {
  const target = normalizeAbsolute(absolute)
  const root = normalizeAbsolute(workspaceRoot)
  return PRIVATE_WORKSPACE_SUFFIXES.some((suffix) => {
    const privateRoot = `${root}/${suffix}`
    return target === privateRoot || target.startsWith(`${privateRoot}/`)
  })
}

/**
 * Provider credentials inside the product data root, relative to that root.
 * `system/settings.json` holds the API keys (and MCP server tokens);
 * `system/agent/auth.json` holds provider OAuth tokens. The app-data
 * relaxation exists so the agent can diagnose the product's own state, and
 * that is exactly why these two need their own deny: authority (ask/auto)
 * governs operations on the product's *state*, never the machine's
 * credentials. An `allow` must not put a user's key one `cat` away.
 */
const PRIVATE_APP_DATA_SUFFIXES = [
  'system/settings.json',
  'system/agent/auth.json',
] as const

function isPrivateAppDataPath(absolute: string, appDataRoot: string): boolean {
  const target = normalizeAbsolute(absolute)
  const root = normalizeAbsolute(appDataRoot)
  return PRIVATE_APP_DATA_SUFFIXES.some((suffix) => {
    const privatePath = `${root}/${suffix}`
    return target === privatePath || target.startsWith(`${privatePath}/`)
  })
}

/** The directories holding a credential file: a shell whose cwd is one of
 * them could reach the bare file name, which no command-text rule can see. */
function isPrivateAppDataDir(absolute: string, appDataRoot: string): boolean {
  const target = normalizeAbsolute(absolute)
  const root = normalizeAbsolute(appDataRoot)
  return PRIVATE_APP_DATA_SUFFIXES.some(
    (suffix) => target === normalizeAbsolute(`${root}/${suffix}`).replace(/\/[^/]*$/, ''),
  )
}

/**
 * Credential file names, shared by the shell rules below: settings.json
 * (API keys, MCP tokens) and auth.json (provider tokens). The installer's
 * one-shot seed (`settings.seed.json`, same key) has its own rule — its name
 * is product-specific, so it is denied unconditionally, wherever it sits.
 */
const CREDENTIAL_NAME = '(?:settings|auth)\\.json'

/** A credential file referenced through a `system/` or `agent/` segment —
 * absolute, workspace-relative, or mixed. */
const CREDENTIAL_PATH_RE = new RegExp(
  `(?:^|[\\s"'=<>|&;(])[^\\s"'=<>|&;]*(?:system|agent)[\\\\/](?:[^\\s"'=<>|&;]*[\\\\/])?${CREDENTIAL_NAME}(?=[\\s"';|&)<>,]|$)`,
  'i',
)

/** A bare credential file name anywhere in the command text. Only used
 * together with a reference to the data root, so a workspace file that
 * happens to share the name is not caught. */
const CREDENTIAL_NAME_RE = new RegExp(
  `(?:^|[\\s"'=<>|&;(])[^\\s"'=<>|&;]*${CREDENTIAL_NAME}(?=[\\s"';|&)<>,]|$)`,
  'i',
)

/** The shipped provider seed — a name only this product uses, so it is denied
 * wherever it is referenced (it sits in the install dir, not the data root). */
const CREDENTIAL_SEED_RE = /(?:^|[\s"'=<>|&;(])[^\s"'=<>|&;]*settings\.seed\.json(?=[\s"';|&)<>,]|$)/i

function normalizedWorkspacePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

export class NodePermissionGateway implements PermissionGateway {
  /**
   * The frozen ceiling is captured by reference, not copied: it is already
   * `Object.deepFreeze`'d in the SessionBinding (turn-definition.ts), so holding
   * the reference is both safe and keeps the gateway reading the exact object
   * the binding vouched for. No mutation is possible through it.
   *
   * `systemWikiRoot` is the ONE directory outside the Workspace the agent may
   * touch, reached through the virtual `system-wiki/` path prefix (below). The
   * wiki is plain markdown the agent reads and writes with the ordinary file
   * tools — no dedicated tool surface — so the boundary has to know about it.
   *
   * `appDataRoot` is the product's own data root (system + backend state).
   * It is reachable by absolute path — reading the node catalog, the logs or
   * the backend config is legitimate diagnosis — but it is NOT exempt from
   * authority: the gateway only stops blocking it, and the ask/auto ceiling
   * (workspace.read/write, shell.exec) decides whether it runs or prompts.
   * Provider credentials inside it (`system/settings.json`,
   * `system/agent/auth.json`) stay denied unconditionally, in every mode.
   */
  constructor(
    private readonly binding: SessionBinding,
    private readonly systemWikiRoot?: string,
    private readonly appDataRoot?: string,
    /** Read-only product assets root (skills/, prompts/...) — the same value
     * injected into bash as TDEASE_SYSTEM_ASSETS. An agent that resolves that
     * variable (or quotes a `pwd` of it) spells an ABSOLUTE path that lives
     * outside the Workspace; the string prefilter must not deny the product's
     * own exposed root. Runtime rules still apply: it stays read-only in
     * practice through the ask/auto ceiling, and `assertCommandCwd` containment
     * still governs actual execution. */
    private readonly systemAssetsRoot?: string,
  ) {}

  /**
   * Return the frozen decision for one action. Throws if the action is not in
   * the snapshot — that is a programming error (the snapshot covers every
   * member of AGENT_PERMISSION_ACTIONS), and silently defaulting to 'ask' or
   * 'deny' would hide a real gap in the ceiling from the caller.
   */
  decide(action: AgentPermissionAction): AgentPermissionDecision {
    const decision = this.binding.permissionCeiling[action]
    if (decision === undefined) {
      // A missing action means the snapshot was built against a stale action
      // list. Fail loud rather than guess: the alternative is a security-
      // sensitive default, and there is no safe default here.
      throw new Error(`Permission ceiling has no decision for action: ${action}`)
    }
    return decision
  }

  /**
   * Decide one concrete call: the binding's frozen parameterized rules are
   * consulted first (highest-priority predicate match wins), and with no match
   * the coarse ceiling above decides. The rules array was sorted and frozen at
   * bind time, so per-call work is a linear scan of an already-ordered list —
   * no re-read of the policy file, no mid-session widening, same replay
   * determinism as `decide`.
   */
  decideCall(action: AgentPermissionAction, input?: Readonly<Record<string, unknown>>): AgentPermissionDecision {
    const rules = this.binding.permissionRules ?? []
    return evaluatePermissionDecision(rules, this.binding.permissionCeiling, action, input).decision
  }

  /**
   * Resolve a Workspace-relative path and prove it stays inside the Workspace.
   * `containedPath` resolves against the frozen `workspaceRoot`, rejects `../`
   * escapes, and re-checks via `realpathSync` so a symlink cannot pivot outside
   * the root. Returns the absolute contained path.
   *
   * The `system-wiki/` prefix is a virtual namespace (the same trick as the
   * renderer's `run-files/`): it never resolves inside the Workspace, even if
   * a directory of that name exists there. It maps onto `<System>/wiki/` and
   * is containment-checked against that root with the identical realpath
   * discipline. Reads and writes use the same resolution; the *decision* to
   * permit the operation still lives in `decide('workspace.read'|
   * 'workspace.write')` for both namespaces.
   *
   * `operation` is accepted for symmetry with the contract but the containment
   * check itself is identical for read and write — the *decision* to permit the
   * operation lives in `decide('workspace.read'|'workspace.write')`, which the
   * caller must have already consulted. Splitting the two would invite a tool to
   * forget one of them.
   */
  resolveWorkspacePath(relative: string, operation: 'read' | 'write'): string {
    const normalized = normalizedWorkspacePath(relative)
    const SYSTEM_WIKI_PREFIX = 'system-wiki/'
    if (this.systemWikiRoot && (normalized === 'system-wiki' || normalized.startsWith(SYSTEM_WIKI_PREFIX))) {
      const page = normalized === 'system-wiki' ? '' : normalized.slice(SYSTEM_WIKI_PREFIX.length)
      return containedPath(this.systemWikiRoot, page || '.', 'system wiki path traversal denied')
    }
    // Containment FIRST, the private judgment on the resolved absolute path
    // SECOND. Checking the raw string before resolution was bypassable
    // (`.tdease/./permissions.json`, absolute paths, Windows case) — the
    // resolved form is the only thing that cannot lie about the target.
    // The product's own data root is reachable by absolute path. Containment
    // still applies (against that root, with the same realpath discipline), so
    // `..` cannot climb back out; whether the operation runs or prompts is the
    // ceiling's call, not this gateway's.
    if (this.appDataRoot && path.isAbsolute(relative) && isUnderRoot(relative, this.appDataRoot)) {
      const resolved = containedPath(
        this.appDataRoot,
        path.relative(this.appDataRoot, path.resolve(relative)) || '.',
        'app data path traversal denied',
      )
      if (isPrivateAppDataPath(resolved, this.appDataRoot)) {
        throw new Error('Agent access to provider credentials is denied.')
      }
      return resolved
    }
    const absolute = containedPath(
      this.binding.workspaceRoot,
      relative,
      'workspace path traversal denied',
    )
    if (isPrivateWorkspacePath(absolute, this.binding.workspaceRoot)) {
      throw new Error('Agent access to private session state is denied.')
    }
    return absolute
  }

  /**
   * Assert a bash cwd is inside the Workspace. An undefined cwd means the tool
   * did not specify one, so we default to the Workspace root (the only safe
   * default — never the agent process's cwd, which could be anywhere). A
   * specified cwd is contained just like a workspace path, and — being a real
   * working directory a shell can act from — is held to the same private-path
   * rule as the file tools.
   */
  assertCommandCwd(cwd?: string): string {
    if (cwd === undefined) return this.binding.workspaceRoot
    if (this.appDataRoot && path.isAbsolute(cwd) && isUnderRoot(cwd, this.appDataRoot)) {
      const resolved = containedPath(
        this.appDataRoot,
        path.relative(this.appDataRoot, path.resolve(cwd)) || '.',
        'command cwd traversal denied',
      )
      if (isPrivateAppDataPath(resolved, this.appDataRoot) || isPrivateAppDataDir(resolved, this.appDataRoot)) {
        throw new Error('Command cwd must stay outside provider credentials.')
      }
      return resolved
    }
    const absolute = containedPath(
      this.binding.workspaceRoot,
      cwd,
      'command cwd must stay inside the workspace',
    )
    if (isPrivateWorkspacePath(absolute, this.binding.workspaceRoot)) {
      throw new Error('Command cwd must stay outside workspace runtime state.')
    }
    return absolute
  }

  /**
   * Preflight a shell command against machine-destructive operations and the
   * most common forms of deliberate path discovery outside the Workspace.
   * Every pattern runs against the raw text AND a normalized view (backslashes
   * folded, duplicate separators collapsed, `/./` segments removed, case
   * folded), so `.tdease\.\PERMISSIONS.JSON`-style spellings don't slip the
   * private-state rules. This is best-effort policy, not an OS filesystem
   * sandbox — string matching on shell syntax is inherently spoofable
   * (indirection, globs), and the real answer for arbitrary interpreters is
   * SMK sandbox isolation, not a longer blacklist.
   */
  assertShellCommand(command: string): void {
    const text = String(command || '').trim()
    if (!text) throw new Error('A shell command is required.')
    const normalized = collapseDotSegments(text.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase())
    // The app's own data root AND the workspace root itself are masked out
    // first: the outside-workspace rule below must not fire on paths that
    // resolve inside either. The workspace mask covers Windows AND MSYS
    // spellings — git-bash reports the workspace as `/c/<...>`, and an agent
    // quoting its own `pwd` back was being denied its own workspace
    // (2026-10-19: two such denials derailed a case turn into wrapper-script
    // workarounds). Masking is a relaxation of the string prefilter only:
    // runtime containment (`containedPath`) still rejects real escapes, and
    // the data root still costs an approval in `ask` mode (shell.exec).
    const views = [text, normalized].map((v) => {
      let out = v
      if (this.appDataRoot) {
        out = maskRoot(out, this.appDataRoot)
        out = maskRoot(out, normalizeAbsolute(this.appDataRoot))
      }
      if (this.systemAssetsRoot) {
        const sa = normalizeAbsolute(this.systemAssetsRoot)
        out = maskRoot(maskRoot(out, sa, '<system-assets>'), msysForm(sa), '<system-assets>')
      }
      const ws = normalizeAbsolute(this.binding.workspaceRoot)
      return maskRoot(maskRoot(out, ws, '<workspace>'), msysForm(ws), '<workspace>')
    })
    const blocked: Array<[RegExp, string]> = [
      [/(?:^|[\s;&|])(?:format|diskpart|bcdedit)(?=$|[\s;&|])/i, 'disk administration'],
      [/\b(?:shutdown|restart-computer|stop-computer)\b/i, 'system shutdown'],
      // Redirecting to a *system-critical* location is destructive; `/dev/null`
      // (`2>/dev/null` — the standard stderr suppress) and anything inside the
      // workspace are safe. This stays a short policy, never a claim of complete
      // shell-language parsing.
      [/(?<!\/dev\/)>\s*(?:\/etc|\/usr|\/var|\/bin|\/sbin|\/boot|\/Windows|\\Windows|[A-Za-z]:\\Windows)\b/i, 'system-critical redirection'],
      [/\b(?:cd|ls|find|rg|grep|cat|head|tail)\s+(?:["']?)(?:~(?:[\\/]|\s|$)|\$(?:HOME|USERPROFILE|TMP|TEMP)\b|%(?:HOME|USERPROFILE|TMP|TEMP)%|\/(?!dev\/null\b)|[A-Za-z]:[\\/])/i, 'filesystem access outside the workspace'],
      // Private workspace state: sessions, the event log, and the permission
      // policy. Matched on both views above, so `.`-segments and case cannot
      // hide them.
      [/(?:^|[\s"'=])\.?\/?\.tdease\/(?:\.\/|\.\.\/)*(?:sessions|events\.jsonl|permissions\.json)(?:[\\/\s"']|$)/i, 'workspace runtime state access'],
      // Provider credentials: settings.json (API keys, MCP tokens) and
      // agent/auth.json (provider tokens), plus the shipped seed below.
      // Matched by path segment so a workspace file of the same name
      // (`.vscode/settings.json`) is not caught — only the credential
      // locations themselves.
      [CREDENTIAL_PATH_RE, 'provider credential access'],
      [CREDENTIAL_SEED_RE, 'provider credential access'],
    ]
    for (const view of views) {
      for (const [pattern, label] of blocked) {
        if (pattern.test(view)) throw new Error(`Sandbox denied ${label}.`)
      }
    }
    this.assertScopedDeleteMove(views)
    // A command that names the data root and then a bare credential file
    // (`cd <dataRoot>/system && type settings.json`) hides the file from the
    // segment rule above. The masked view spells the data root as
    // `<app-data>`, so the two conditions together are precise: the data root
    // is in play AND a credential file name appears in the same command.
    if (this.appDataRoot && views.some(
      (view) => view.includes('<app-data>') && CREDENTIAL_NAME_RE.test(view),
    )) {
      throw new Error('Sandbox denied provider credential access.')
    }
  }

  /**
   * File deletion/movement is allowed for Workspace-RELATIVE targets and
   * denied for everything else (2026-10-14 relaxation; author directive:
   * re-running after an error is normal work, so in-workspace cleanup —
   * emptying an analysis output dir before a rebuild — must not be blocked).
   * The previous unconditional deny (adopted after the harness_5a5857d4
   * incident) made every pipeline retry either fail on a non-empty output
   * directory or detour through temp-dir-and-rename gymnastics. The incident
   * itself stays shut by the cd-escape rule ($TMP/$TEMP now match alongside
   * $HOME), and this pass still denies operands that are absolute
   * (posix/UNC/drive-letter), home- or env-var-rooted, or depth-escaping
   * (leading `..`): those are the shapes that reach outside the Workspace
   * from a drifted cwd, and "where rm points" stays unparseable in general —
   * this is best-effort policy with the same honesty as the list above.
   */
  private assertScopedDeleteMove(views: string[]): void {
    for (const view of views) {
      // F2: resolve the command's `cd` chain against the workspace root first.
      // Failure scenario: `cd .. && rm -rf x` — every operand rule judged `x`
      // workspace-relative, but by the time rm runs the cwd is OUTSIDE the
      // workspace, so `x` deletes an arbitrary sibling directory. Deny-dominant:
      // once the cd chain escapes the root, every delete/move operand in the
      // WHOLE command is treated as an outside target.
      const escaped = cdChainEscapesWorkspace(view)
      for (const segment of view.split(/(?:&&|\|\||[;|\n])/)) {
        if (!DELETE_MOVE_VERB.test(segment)) continue
        for (const operand of deleteMoveOperands(segment)) {
          if (escaped || OUTSIDE_TARGET.test(operand) || DEPTH_ESCAPE.test(operand)) {
            throw new Error('Sandbox denied file deletion or movement outside the workspace.')
          }
        }
      }
    }
  }
}

/** Verbs whose OPERANDS decide the verdict. Token-exact so `form.rs` /
 *  `model_del.txt` / `mvn` never match. */
const DELETE_MOVE_VERB = /(?:^|[\s"'])(?:rm|rmdir|unlink|shred|mv|del|erase|rd|ren|remove-item|move-item)(?=[\s"']|$)/i

/** An operand shape that can leave the Workspace from any cwd inside it:
 *  absolute posix/UNC (`/x`, `\x`), drive letters, home tilde, env-var roots. */
const OUTSIDE_TARGET = /^(?:[a-z]:[\\/]|\/|\\|~|\$|%)/i

/** First segment `..` — depth depends on the drifted cwd, so it can escape. */
const DEPTH_ESCAPE = /^\.\.(?:[\\/]|$)/i

/** Tokens after every delete/move verb in one command segment, with flags and
 *  redirections skipped. Best-effort tokenization — see the class doc. */
function deleteMoveOperands(segment: string): string[] {
  const operands: string[] = []
  const tokens = segment.split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    if (!DELETE_MOVE_VERB.test(tokens[i])) continue
    for (let j = i + 1; j < tokens.length; j++) {
      const token = tokens[j]
      if (DELETE_MOVE_VERB.test(token)) { i = j - 1; break }
      if (/^(?:\d*)>{1,2}/.test(token)) continue // redirection (`>x`, `2>>y`)
      if (/^-[^\s]*$/.test(token) || /^\/[a-z]$/i.test(token)) continue // flags (`-rf`, `rd /s`)
      operands.push(token.replace(/^["']+|["']+$/g, ''))
    }
  }
  return operands
}

/**
 * F2: walk the command's `cd` segments in order, tracking a workspace-relative
 * depth (root = 0). Runs on the MASKED view, where every spelling of the
 * workspace root is `<workspace>`; other masked roots (`<app-data>`,
 * `<system-assets>`) and unresolvable targets (`cd -`, subshells) stop tracking
 * without an escape verdict — same best-effort honesty as the rest of this
 * layer. Returns true when a `cd` chain's `..` count crosses above the
 * workspace root or lands on an outside absolute/home/env target.
 */
function cdChainEscapesWorkspace(view: string): boolean {
  const CD_TOKEN = /^cd$/i
  let depth = 0
  const segments = view.split(/(?:&&|\|\||[;|\n])/)
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0 || !CD_TOKEN.test(tokens[0])) continue
    let operand: string | undefined
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === '--') continue
      operand = tokens[i].replace(/^["']+|["']+$/g, '')
      break
    }
    if (operand === undefined || operand === '-') return false // bare `cd` (→ $HOME) is denied by the cd rule; `cd -` is untrackable
    if (operand.startsWith('<workspace>')) {
      depth = 0
      operand = operand.slice('<workspace>'.length)
    } else if (/^<[a-z-]+>/.test(operand)) {
      return false // another deliberately exposed root — not a workspace escape
    } else if (OUTSIDE_TARGET.test(operand)) {
      return true
    }
    for (const part of operand.split(/[\\/]/)) {
      if (part === '' || part === '.') continue
      if (part === '..') {
        depth -= 1
        if (depth < 0) return true
      } else {
        depth += 1
      }
    }
  }
  return false
}

/** Remove interior `/./` segments (repeatedly — `a/././b` collapses over two
 *  passes). `..` segments are left alone: collapsing them needs the cwd. */
function collapseDotSegments(value: string): string {
  let out = value
  let previous: string
  do {
    previous = out
    out = out.replace(/\/\.\//g, '/')
  } while (out !== previous)
  return out
}
