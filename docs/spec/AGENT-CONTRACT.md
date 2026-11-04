---
type: contract
title: TDEase Agent contract
description: Sole authority for the registered Agent tool surface, the authority/permission model, and prompt/skill assembly.
status: implemented
---

# TDEase Agent contract

> Sole authority for the registered Agent tool surface, the authority/permission
> model, and prompt/skill assembly. This document describes intent; the running code is
> the final arbiter of actual file paths — when a path named here no longer matches the
> repository, the document is `stale`. Backend/workflow semantics are in
> `docs/spec/WORKFLOW-RUN.md`; paths in `docs/spec/FILE-LAYOUT.md`.

## 1. Boundary

The Agent composes science. It never owns identity, authorization, path containment or
Run truth — those belong to Backend and trusted Client code. Three rules hold without
exception:

1. **The Agent never authors identity.** Workspace IDs, Backend roots, absolute paths,
   digests, tree hashes and Node bindings are produced by trusted Client code and passed
   by opaque reference.
2. **The Agent stops rather than guesses.** A missing Node, an unreadable detail, an
   unknown input path, a failed freeze or a failed dry-run is a stop condition, not an
   invitation to invent a plausible value.
3. **The prompt is not a security boundary.** Prompts reduce error. Authorization and
   containment are enforced in Backend and in the Electron main process.

## 2. Registered tool surface

The registry is the code: `src/studio/commands/{definitions,registry}.ts` (canonical
`tdease.*` definitions), bound into a Pi turn by `electron/agent/session-host.ts`. The
Agent runtime runs in the Electron main process (`electron/agent/**`); the Renderer only
submits commands and renders events. No tool may open HTTP, touch the filesystem or
compute a digest directly.

The surface spans twelve command families — discovery (nodes/templates), the
analysis lifecycle (`workflow.inspect`/`validate`/`run`; the `workflow.prepare`/
`dryRun`/`submit` planRef trio stays registered for the analysis-review UI but is
`agentVisible: false`), Run observation and
management, UniProt reference, `skill.read`, session tools
(`session.reportBlocked`; turn cards are still recorded to
`.tdease/sessions/<id>/turns.jsonl` per turn, but carry no command surface),
background jobs
(`start`/`wait`/`peek`/`cancel`/`list`;
`job.status` is UI/diagnostics only — the Agent waits with `job.wait` and is
told about completions automatically), and the opt-in `ptc.exec` script
surface. Subagent delegation (8 commands incl. `wait`/`followup`;
`status`/`peek` are UI-only) is shared by both mindsets. Node/template
discovery (`nodes.*`, `templates.*`) is Workflow-only — composing Runs is what
the catalogs serve. Analysis-only are the scripted-tool surface (`ptc.exec`)
and the viewer pointer (`view.*`, opt-in). The Workflow-only set is catalog
discovery plus Run composition and control — `workflow.inspect`/`validate`/
`run`, `nodes.install`, and `runs.resume`/`overwrite`/`cancel`/`trash`/
`restore`. Analysis keeps the Run observation family (`runs.list`/`status`/
`wait`/…): reading published results is analysis work. The `evidence.*`
family is deleted outright (2026-10-14): claims live in analysis files the
Agent writes directly, auditable like any other Workspace artifact. The exact
commands, their args schemas and default permissions are the registry — read it rather
than this document for the current list. The wiki has no command surface: pages are
plain markdown the Agent reaches with read/grep/write/edit, including the virtual
`system-wiki/` prefix onto the System wiki directory (design
`design/KNOWLEDGE-WIKI.md`).

Invariants that the code cannot self-prove:

- The Agent's Run path is **atomic**: `workflow.run` freezes, dry-runs and submits one
  Run in a single call, and its args never contain a plan. The review-UI path
  (`workflow.prepare`/`dryRun`/`submit`, agent-invisible) handles plans through an
  opaque `planRef` — Client-session-local, scoped to one Workspace, expiring when a
  relevant file changes; `submit` rejects a missing, changed, expired or not-dry-run
  plan. The model never receives or authors a raw `CommitPlan` on either path.
- `managedNodes` is optional — a fully Workspace-native workflow (rules, `script:`,
  `notebook:`, `run:`, modules, wrappers, checkpoints) validates and runs from
  `runPath` alone.
- Permanent deletion is not exposed to the Agent.
- Where the evidence does not decide, the output is the floor —
  `null`/`inconclusive`/`unseparated`/`FAILED` — never the top-ranked candidate
  or a minted `supported`.
- Media reaches the model as Workspace path references — identity and location,
  never bytes: conversation images render inline in the transcript from workspace
  paths, and the bytes themselves never enter the model context.
- `bash` exists as a general runtime affordance but is **not** a workflow construct:
  the Agent must never turn shell invocations into workflow structure, and there is no
  Shell Node.
- `runs.wait` returns status at its deadline; timing out is a successful observation,
  not an error.
- `todo_write` and `tdease.session.reportBlocked` make "I cannot proceed" a structural
  fact rather than a sentence.

Every Agent session receives only the Pi builtins selected by its mindset tool profile.
All mindsets start with read/grep/find/ls; the user-controlled workspaceWrite setting
may add write/edit and the Shell setting may add bash to either mindset. `todo_write`
(in-transcript state only — it touches no Workspace file, so no permission action
gates it) is available to both parent mindsets; allowlist-narrowed subagent sessions
never receive it. The latest plan
is announced as a one-line status at the opening request of each loop (one turn, one
loop — AGENT-LOOP.md §1), so a new turn opens with the plan in view without repeating
the line on every step. Bash remains
permission-gated and Workspace-contained.
Every builtin is wrapped at the `ToolGateway` (`electron/agent/tool-gateway.ts`): the
PermissionGateway's realpath-checked containment denies Workspace escapes, the
deny-dominant permission ceiling throws before any side effect, `'ask'` is left to the
`tool_call` hook because approval is interactive, and every call is audited. The MCP bridge is opt-in; the subagent-dispatch tool is default for
non-subagent sessions and reuses the parent's registry, deadline, budget and permission
path. MCP calls are bounded by the SDK's 60 s default request timeout with a
per-server `timeoutMs` override for legitimately slow tools; a RequestTimeout
invalidates the cached connection, so a hung server reconnects with a fresh
process instead of burning the full timeout on every call (behavioral pins in
`mcp-provider.test.ts` against a real stdio server fixture).

The filesystem visibility contract is exactly two roots: the bound Workspace and
the read-only deployed System assets needed by registered Skills and reference
tools. The Agent must not read the repository root, paper drafts, RECORD files,
prior test dossiers or another Workspace. Analysis outputs are
Workspace-owned and begin empty for a blind session; historical results are
never an implicit input.

## 3. Authority and permissions

Three orthogonal concepts. None may substitute for another.

**Scope** — what the Agent reads about, named explicitly by the user. The user writes
`@run:<id>`, `@canvas:<id>`, `@file:<path>` or `@skill:<id>` in the message; those
tokens survive verbatim in the text the model reads, and the Client resolves each to its
model-facing form and freezes the result into the turn's prompt snapshot under a
`### Referenced` heading. Scope is explicit reference, never a focus derived from the
active document — only what the user typed is resolved.

**Mindset** — how the Agent works: `workflow` (workflow composition; the shipped UI
default) or `analysis` (scientific analysis). Both mindsets share the scientific
read/compute surface; the tool-level splits follow the working mode — workflow holds
catalog discovery and Run composition/control, analysis holds the scripted-tool and
viewer-pointer surfaces. Agent Tools settings may narrow that surface; they cannot
widen a mindset or Authority.

**Authority** — what may execute without asking: `Ask` (every mutating action requires
approval) or `Auto` (authorized actions run; Backend/Workspace constraints still apply).

The permission action vocabulary is closed (code in `permissionResolver.ts`). With no
matching rule, read/preflight/dry-run default to `allow`; everything else defaults to
`ask`. Workspace policy lives in `.tdease/permissions.json` (version 2; version 1
documents load unchanged — see the code). A frontend approval can never bypass the
Backend Principal, resource ownership or Workspace root validation.

Decisions resolve in two tiers with one semantics. **Action-level rules** (no `match`)
merge into the coarse per-action ceiling deny-dominantly — a layer can only ever tighten
the Authority ladder, never loosen it. **Parameterized rules** (carrying `match`: a
command regex for `shell.exec`, path globs for path-carrying tools, optional
`pathParam`, `priority`, `note`) are the override channel in the style of pi's
permission extensions: at call time the highest-priority rule whose predicate matches
decides, ties resolve `deny > ask > allow`, and with no match the coarse ceiling
decides — so a workspace may say `bash ^git ` → allow while the ladder keeps
`shell.exec` ask. Both tiers are resolved once at bind time and frozen into the binding
(`permissionCeiling` + sorted `permissionRules`); a predicate that cannot compile is
rejected at parse time and never reaches a binding. The action tiers (code in
`permissionResolver.ts`): **read** actions allow in both
authorities; **write** actions allow in `Auto`, ask in `Ask` — this includes
`shell.exec` (gates bash and MCP) and `subagent.spawn`, whose real safety boundary is
the `permission-gateway.ts` cwd containment + destructive-command blacklist, which holds
regardless of the decision; **always-ask** actions (`run.trash`, `run.overwrite`,
`run.cancel`, `workflow.cancel`, `overwrite.conflict`, `subagent.cancel`) ask in every
authority because they are irreversible.

The gateway's containment is what holds regardless of the decision, and it is the only
place that may widen or narrow reach without touching the ladder. Three facts about that
reach: paths resolve against the frozen Workspace root (plus the `system-wiki/` prefix,
§2); the product's own data root is additionally reachable by **absolute path** so the
Agent can diagnose the product's own state — the ask/auto ladder still governs every
operation there; and the provider credentials inside that data root
(`system/settings.json`, `system/agent/auth.json`, and the shipped `settings.seed.json`)
are **denied in every authority and mode** through the file tools, the shell preflight and
the shell cwd. A Workspace file that merely shares a credential file's name is unaffected.

A third resolve choice, **`allow_session`**, records a standing per-Session grant for the
action (in-memory runtime state in the `ApprovalCoordinator`, keyed by sessionId; never
part of the `allow|ask|deny` decision vocabulary, never persisted to disk, cleared on
session dispose). The `tool_call` hook consults it before prompting: if the user already
chose "Allow for this session" for an action this session, subsequent calls skip the
prompt. Grants die with the session — they never cross sessions or survive a restart
(consistent with §4). The card only offers the grant at the `inline` command tier
(`allowsSessionGrant` in `registry.ts`); at `document` each instance must be read, so a
standing grant there is a contradiction.

A fourth resolve choice, **`allow_always`**, deepens the approval into the whitelist
(code in `permissionWhitelist.ts`). The call's shape derives a parameterized allow rule
at `priority: -1` — a bash command becomes its two-token anchored prefix (`git status
-sb` → `^git status\b`; a single token matches exactly), a path-carrying write becomes
the parent-directory glob; calls with no honest narrower shape (irreversible abstract
actions) never offer the choice, and the card's button text names the granted scope.
The rule joins a session-scoped overlay that takes effect immediately and is persisted
by the host into the workspace `.tdease/permissions.json` (idempotent merge; the Agent
can never write that file itself). The `-1` priority IS the whitelist contract: the
evaluation order is hand-written rules (≥ 0, deny > ask > allow on ties) → whitelist
(-1) → the coarse ladder fallback — a click-approved convenience can silence the
ladder's default ask, but never a rule the user wrote by hand. The overlay dies with
the session; the persisted rule survives it, which is what future binds freeze in.

**Ask authority ships a default review policy** (code in
`defaultPermissionPolicy.ts`, mounted only when the authority is `ask`; `auto`
keeps its original run-through). The policy is parameterized rules at
`priority: -2`, completing the fixed evaluation order: hand-written rules
(≥ 0) → whitelist (−1) → shipped policy (−2) → the coarse ladder. Dangerous
operations (credential material, disk-level tools, history rewrite) are
isolated outright, risky ones (recursive deletion, elevated execution, remote
access, git history/remote mutation, package publishing, system configuration)
ask, and the innocuous majority of shell commands run without prompting — the
policy reviews so the user does not have to. A card approval outranks the
policy by construction (−1 > −2), which is what "allow with user consent"
means here. The permission-gateway's destructive-command blacklist and
credential denial are mode-independent and hold regardless of every layer
above.

**Delegation is monotonic.** The local host is the only permission-elevation
source: elevation happens exactly when the user picks the authority and when
the user answers an approval card. A subagent child inherits its parent's
frozen permission ceiling AND parameterized rules verbatim
(`delegation.permissionCeiling` / `delegation.permissionRules`, IPC-rejected
internal fields — only the in-process registry supplies them) and never
re-resolves `.tdease/permissions.json` or an authority ladder, so per call
`decisionOf(child) ≤ decisionOf(parent)` holds by construction — the child
evaluates the identical frozen rules against its own calls. A
child's `ask` decision surfaces an approval card on the parent conversation's
stream and resolves back to the child's own coordinator by `approvalId`; a
grant recorded for a child is scoped to that child and dies with it. The
delegation identity (parent session, narrowed scope) is recorded on the
binding (`delegatedFrom`, `delegationScope`) and in the compact tool audit.

**The sandbox is the third layer, held regardless of every decision.** Rule
engines stop the model; containment and the destructive-command blacklist stop
known-bad arguments; only the OS makes "ran but could not escape" true
(`electron/agent/sandbox.ts`). Where the platform provides a primitive, the
persistent bash process is born inside it at spawn: writes confined to the
Workspace and the OS temp area, everything else read-only — macOS via
sandbox-exec/Seatbelt, Linux via bubblewrap. Windows has no sandbox primitive
an Electron app can use without a privileged helper: there the agent bash runs
unsandboxed and containment + blacklist remain the boundary, stated as such
rather than pretended. Sandbox availability changes the box around a command,
never the command and never any ask/allow decision; a session that runs
sandboxed records the backend in `TDEASE_SANDBOX`. Network restriction is
deliberately out of scope until a domain proxy exists — git push and pip
install are legitimate workflows, and a sandbox that silently broke them would
be worked around, not respected.

## 4. Session binding

Each Agent session fixes one `workspace_id`, one canonical Workspace root and one
permission profile. Switching Workspace creates or rebinds a session; it never inherits
the previous cwd, authorization or tool context. The durable Session is exactly
`.tdease/sessions/<session_id>/` under that Workspace (layout in `FILE-LAYOUT.md` §3.1);
Session enumeration reads `session.json` from those directories — neither Backend
storage, an SDK-global session directory nor localStorage is a Session truth source
(localStorage may remember only the selected Session id).

## 5. Prompt and skill assembly

System prompt fragments and Skills are Client assets, deployed and versioned with the
product, loaded from `tdease-ai-capability/system/prompts/internal/` (by
`electron/agent/prompt-pipeline.ts`) and `tdease-ai-capability/system/skills/<name>/`.

Assembly order for one turn (the assembler is `src/agent/prompt/system-prompt.ts`;
the 15 frozen artifacts live in `tdease-ai-capability/system/prompts/internal/`):

```text
base_role
  -> tool-policy family (see below)
  -> inline_visualization (only on turns dispatched with the composer's
     inline-visualization toggle; frozen into that turn's definition, so
     later toggles never rewrite an assembled turn)
  -> delegation_policy   (when the subagent surface is present; both parent mindsets)
  -> ptc_policy           (only when the binding enables PTC and the mindset is analysis)
  -> mode prompt (active Mindset)
  -> safety_policy
  -> subagent_role        (child sessions with a role override only)
  -> skill_index (compact, one line per skill)
  -> explicitly referenced Skill text, if any
  -> workspace context
```

The tool-policy family assembles in order (`tool_policy`, `bash_policy` when
shell is enabled, `native_toolchain` for analysis with shell,
`scientific_honesty`, `terminology`, `analysis_layout` for analysis), all
mapping to the external `tool-policy` slot. The mindset-gated fragments are
prompt doctrine only (`native_toolchain`, `analysis_layout`); tool-surface splits
are declared in the registry exposure, not in this list. `terminology` is the
canonical scientific vocabulary contract:
standard top-down proteomics terms are used directly everywhere (no in-house
synonyms exist to translate).

The assembled prompt is frozen so a mid-turn file edit cannot change instructions
already being acted on. A user `@skill:<scope>:<name>` reference resolves and freezes
that exact `SKILL.md` into the snapshot; otherwise no Skill text is preloaded — the
Agent reads one procedure via `skill.read` only when needed. System Skills come from `system/skills/<name>/`; Workspace Skills from
`.tdease/skills/<name>/`. There is no third implicit Skill root.

Generic Agent filesystem tools cannot read Workspace runtime-private session
state under `.tdease/sessions/` or `.tdease/events.jsonl`, nor the workspace
permission policy `.tdease/permissions.json` — the user's trust statement; an
agent that could rewrite it would self-elevate every future session. This includes prior
conversation events, prompt snapshots, model transcripts, subagent state, and
workflow journals. Runtime components retain access through their typed internal
ports. Workspace Skills remain available through the Skill loader and their
documented `.tdease/skills/<name>/scripts/` entry points. Product System Skills
and scripts remain read-only capabilities reached by Skill id,
`TDEASE_SYSTEM_ASSETS`, or a managed binary short name; they do not widen generic
filesystem access beyond the Workspace.

**Every tool named in any prompt fragment must be registered.** This is a mechanical
build-time check, not a review convention: a prompt naming an unregistered tool teaches
the model to emit calls that can only fail.

What belongs inside a skill: three roles, each with a constraint — **access**
(read-only against user data, reports source identity such as a digest or URL+time,
holds all format knowledge), **derivation** (deterministic, rules visible and editable,
states its own limits — a derivation that cannot decide says so), and **presentation**
(the data ships with every figure so a chart rebuilds without re-running, nothing
invented, and the figure is not the finding — a conclusion still requires an
explicit statement tied to the measured evidence).

### 5.1 Skill script runtime environment

Skill execution has one path: `uv run --script
"$TDEASE_SYSTEM_ASSETS/skills/<skill>/scripts/<script>.py" <args>` through the
controlled Workspace bash tool; tests invoke the same PEP 723 script through
`uv`. There is no second product-specific script executor.

The bash child receives an environment constructed from an empty object — it
does not inherit the Electron process environment:

| Entry | Purpose |
|---|---|
| `PATH` | Managed `tdeasenexus-toolbox`, provisioned `rg`/`fd`, `uv`, and minimum OS command directories |
| `TDEASE_SYSTEM_ASSETS` | Read-only installed Skills/prompts/reference root |
| `TDEASE_WORKSPACE` | The bound Workspace root anchor — stable across per-call `cwd` changes, so the `bash` tool and background jobs expand the same variables |
| `UV_CACHE_DIR` / `UV_FIND_LINKS` / `UV_PYTHON` | Product-owned PEP 723 cache, offline wheelhouse, packaged Python interpreter |
| `TEMP`, `TMP` | Workspace-local `.tdease/tmp` |
| OS bootstrap fields | Only `SystemRoot`, `WINDIR`, `ComSpec`, `PATHEXT`, locale and timezone when present |

Exactly two `TDEASE_*` pointers are set by design (`TDEASE_SYSTEM_ASSETS`,
`TDEASE_WORKSPACE`); `TDEASE_SYSTEM_ROOT`, `TDEASENEXUS_TOOLBOX_BIN`,
`TDEASE_ENV` and arbitrary inheritance never cross. Desktop provider/API
secrets and Backend configuration or data paths are forbidden in the child.
`TDEASE_SYSTEM_ASSETS` is a sandbox capability pointer, not product
configuration; `TDEASE_WORKSPACE` anchors the bound Workspace (jobs/bash
parity), not a discovery affordance.

File boundary: every bash call starts in the bound Workspace; the command cwd
is containment-checked against it; no absolute Workspace path is injected;
temporaries default to Workspace `.tdease/tmp`; System assets are read-only and
mutable outputs use Workspace-relative paths. This reduces accidental
discovery but is not an operating-system filesystem sandbox — an arbitrary
shell program can still address an absolute host path; permission policy,
command preflight and deployment isolation remain required for untrusted shell
workloads. Each script owns its dependencies in its PEP 723 header; release
automation collects those headers into the offline wheelhouse; no shared skill
virtualenv is maintained.

### 5.2 Subagent roles and the result envelope

A role = `tdease-ai-capability/system/subagents/<role>/SKILL.md` (global) or
`tdease-ai-capability/system/skills/<skill>/subagents/<role>/SKILL.md`
(skill-local). There is no third implicit role root.
**`parseFrontmatter` consumes exactly four fields**:

```yaml
name: <role>                     # identity (list output)
description: <one sentence>      # list output only
allowed_tool_refs: [<command.id | builtin>...]   # the allowlist narrowAgentTools narrows
subagent_profile: explore | general              # base tool set before the allowlist narrows (default explore)
thinking_level: off | low | medium | high | xhigh | max
system_prompt: "<role-specific instructions>"   # injected via systemPromptOverride
```

`system_prompt` is a double-quoted YAML string supporting `\"` / `\\` escapes.
`subagent.list` discovery additionally surfaces `defaultContext: fresh | fork`
and `output` (list metadata; spawn itself does not consume them). Role
SKILL.md files belong to the prompt-contract corpus: the build-time gate
validates their `allowed_tool_refs` / `tdease.*` names against the registry,
same as prompt fragments.

The child's **final message** is a single JSON envelope (may be wrapped in a
```json fence):

```json
{
  "findings":      ["<conclusions>"],
  "evidenceLinks": [{"kind": "...", "label": "...", "path": "<workspace-relative path>"}],
  "confidence":    "high | medium | low",
  "openQuestions": ["<left for humans>"],
  "state":         "<terminal state defined by the role, optional>"
}
```

- `path` is meaningful only for workspace files; downstream persistence accepts
  only paths that actually exist on disk — a file link without `path` cannot
  support an assignment.
- `state` is a single value from the role's own vocabulary, passed 1:1 to the
  parent; there is no runtime mapping layer.
- Plain-string evidenceLinks coerce into `{kind:'file', label:s, path:s}` —
  silently dropping them would sever the evidence chain.
- `parseResult` validates the `confidence` enum (invalid → `low`),
  type-filters the arrays, and applies the non-JSON fallback
  `{findings:[{raw: <original text>}], confidence:'low'}` — a child's
  conclusions are **never silently dropped**.

## 6. Non-goals

- No Agent-only Backend protocol or endpoint family.
- No product CLI in the Agent tool contract (a CLI may exist for ops/debugging, but the
  Agent main chain must not depend on it).
- No visual workflow editor and no form model that can overwrite source files.
- No generic Shell Node or arbitrary-command workflow block.
- No inference of Run terminal state from log text.
- No automatic scientific provenance capture, background claim writing or cron —
  claims reach the Workspace only through approved, model-initiated file writes.
- No all-Skill prompt assembly or second Agent loop/runtime critic/hidden revision
  prompt. Offline replay and evaluation inspect settled records but never feed an extra
  model act into a production turn.

## 7. Alternatives considered

> This contract predates the format rule; the section is reconstructed from
> the surviving decision records, not invented.

- **A fourth permission decision value `allow_session`** — lost: a grant is a
  fact about the user's prior choice, not a safety judgment; modeling it as
  runtime state in the `ApprovalCoordinator` keeps the decision vocabulary
  closed and the grant dies with the session by construction
  (archive: `docs-prune-2026-10-12/docs/design/PERMISSION-AUTO-FIX.md` §4).
- **Children re-resolving authority / workspace policy at bind** — lost:
  inheriting the parent's frozen ceiling verbatim makes
  `decisionOf(child) ≤ decisionOf(parent)` hold by construction; the
  2026-09-05 external review found the code had drifted to re-resolution and
  the contract was upheld, the code fixed (`design/AGENT-LIFECYCLE.md`
  §Conflicts 1).
- **A second agent engine for delegation** — lost: a
  subagent is an ordinary bound session; PTC is a thin shell
  over the same registry (`design/SUBAGENT-RUNTIME.md` D1,
  `design/PTC-RUNTIME.md` §1).
- **`job.status` / `subagent.status` / `subagent.peek` as model-facing
  polling surfaces** — lost: completion injection plus the `wait` commands
  exist precisely so the model never polls; the commands stay registered for
  the UI inspector only (`design/AGENT-LIFECYCLE.md` §Conflicts 2).
