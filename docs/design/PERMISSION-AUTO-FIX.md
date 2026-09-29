# Permission system: auto-mode fix + session grant set

> Status: **IMPLEMENTED** (2026-08-07). Originally a design doc; the build
> landed simpler than first drafted — see §4 for what changed and why.
> Spec authority: `docs/spec/AGENT-CONTRACT.md` §3 (updated).

## 1. The bug that was reported

"Why is the permission system still broken? Even with auto on, it keeps asking for permissions again and again!"

With `authority: 'auto'`, the Agent still popped an approval card on nearly every
tool call (bash, subagent spawn). Auto mode was cosmetic.

## 2. Root cause — three holes in the design (wiring was fine)

Mode propagation was **not** broken: `useAgentTurn` binds every turn with the
current authority and `loadPermissionSnapshot` (agent-runtime.ts) rebuilds
system rules from `systemRulesForMode(authority)`. The breakage was in the
permission model itself.

1. **`ALWAYS_ASK_ACTIONS` defeated auto.** `permissionResolver.ts` listed
   `shell.exec` (which gates **both bash and MCP**) and `subagent.spawn` as
   always-ask in every mode. One Agent turn is overwhelmingly bash calls, so
   auto asked on almost every call. Subagents re-asked too, even though the
   registry binds children with `authority:'auto'`.
2. **No "remember this decision."** The card exposed only Allow-once / Deny;
   `NodeApprovalCoordinator.resolve()` settled the promise and forgot. Same
   action, every turn, every session: asked again. The codebase's own
   `allowsSessionGrant()` rule (registry.ts) existed but had no plumbing
   behind it.
3. **Mode not persisted.** `permissionMode` was a hardcoded `ref('ask')` in
   `useAgentTurn.ts`; the settings store had no such field. Restart → ask.

## 3. What was built (three coordinated changes)

### 3.1 `auto` asks only on the irreversible

`shell.exec` and `subagent.spawn` moved from `ALWAYS_ASK_ACTIONS` to
`WRITE_ACTIONS` (`permissionResolver.ts`). Effect: in `auto`, bash and
subagent spawn run without asking (they resolve to `allow`); in `ask`, they
ask once (then 3.2's grant set remembers). **The security boundary does not
change** — `permission-gateway.ts` still contains every bash cwd to the
Workspace root and still runs the destructive-command blacklist preflight;
those checks hold regardless of the allow/deny decision (the gateway's own
comments say so). Letting auto skip the prompt does not weaken it.

`subagent.cancel`, `run.cancel`, `run.overwrite`, `run.trash`,
`overwrite.conflict`, `workflow.cancel` **stayed** in `ALWAYS_ASK_ACTIONS` —
these are genuinely irreversible. They still ask first, but the grant set
(3.2) means they ask only once per session.

### 3.2 Session grant set — runtime state, NOT a new decision value

The cleanest realization: a session grant is **runtime state** (like a sudo
timestamp), not a declarative decision. So `AgentPermissionDecision` stays a
closed `allow | ask | deny` vocabulary — no spec churn to the decision model.

- **Storage:** `NodeApprovalCoordinator` (`approval-coordinator.ts`) gained a
  `sessionGrants: Map<sessionId, Set<action>>`. The `PendingEntry` already
  carried `sessionId` and `action`, so the grant is a natural sibling — no
  new architecture layer (AGENTS.md iron rule 3).
- **API:** `resolve(approvalId, 'allow' | 'allow_session' | 'deny')` records
  the grant on `'allow_session'`; `hasSessionGrant(sessionId, action)` queries
  it; `cancelSession(sessionId)` clears it on dispose.
- **Query:** the `tool_call` hook (`tdease-extension.ts`) consults
  `hasSessionGrant` *before* prompting — a hit skips the prompt and emits an
  `approval.resolved` event with `by: 'session-grant'` so the replayed
  transcript still shows the call was consented. The grant never enters the
  permission snapshot and never persists.
- **UI gate:** the card offers the button only when `allowsSessionGrant(stakes)`
  is true — i.e. the `inline` tier, never `document`.

### 3.3 `allow_session` crosses IPC as a resolve choice (not a decision)

`ResolveApprovalInput.decision` (`contracts/agent-runtime.ts`) widened from
`'allow' | 'deny'` to `'allow' | 'allow_session' | 'deny'`, with the validator
updated. The renderer store (`agent.ts`) carries `ApprovalDecision` end to
end: `resolveApproval(id, decision)` → `ApprovalRequest.resolve(decision)` →
the IPC `decision` field. `PermissionCard.vue` gained a third button
"Allow for this session" (`agent.approval.allowSession`); `PermissionCardDock`
Esc-to-deny now resolves `'deny'`.

### 3.4 Mode persisted

`permissionMode: 'ask' | 'auto'` lives in the settings store (`settings.ts`),
persisted to localStorage like the other settings, and returned on the store.
`useAgentTurn` initializes its `permissionMode` ref from the store and watches
it back, so UI changes persist across restart.

## 4. How the build diverged from the first draft (and why it's better)

The first draft of this doc proposed adding a **fourth decision value**
`allow_session` to `AgentPermissionDecision`, with a `rank` between `allow`
and `ask`. That would have reopened a closed vocabulary and forced every
consumer of the decision type to understand a new value. First-principle
thinking (iron rule 4): a grant is not a *decision* about an action's safety, it is
a *fact about the user's prior choice*. Modeling it as runtime state (a Map)
keeps the decision vocabulary closed, requires zero changes to the resolver's
rank math or the snapshot type, and the grant dies with the session by
construction — no expiry logic, no persistence to revoke. The only contract
surface that widens is the IPC resolve choice, which is exactly where the user
expresses intent. This is strictly less code and less surface area. The spec
(AGENT-CONTRACT.md §3) was updated to describe the grant as runtime state,
not as a decision value.

## 5. Acceptance criteria (all met)

| # | Scenario | Result |
|---|---|---|
| 1 | `auto` mode, one turn with bash + write + subagent.spawn | Zero approval cards (shell.exec/subagent.spawn now WRITE). |
| 2 | `ask` mode, same action second time in the session | No card (grant set remembers via the `tool_call` hook). |
| 3 | `ask` mode, irreversible action (run.trash) second time | No card after the first allow_session grant (button offered — run.cancel is `inline`). |
| 4 | Restart the app | Mode restored from settings store. |
| 5 | Switch Workspace / dispose session | Grant set cleared (`cancelSession`). |
| 6 | `.tdease/permissions.json` `deny` for shell.exec | Still denied — `deny` rank > grant; the grant only beats `ask`. |

## 6. Tests added / updated

- `src/contracts/agent-runtime.test.ts`: `allow_session` accepted; rejection
  message updated.
- `electron/agent/tdease-extension.test.ts`: the `tool_call` hook skips the
  prompt when `hasSessionGrant` returns true (new test).
- `src/components/agent/PermissionCard.test.ts`: the grant button renders at
  `inline` and not at `document`; clicking it resolves `allow_session`
  (replaces the old "offers no standing session grant" test that asserted the
  absence of the feature).

## 7. Explicitly NOT done (scope fence)

- **Cross-session grant persistence** (remember across restarts). Out of
  scope — §4 isolation forbids inheriting authorization, and "ask once per
  session" is already a big win. Cross-session needs a real trust model.
- **Per-arg grants** ("allow `shell.exec` only for `git status`"). The grant
  set is per-action. Per-args is an allowlist and lives in
  `.tdease/permissions.json`, which already exists.
- **Auto-allowing `run.trash`/`run.overwrite`.** No — these stay
  always-ask-first. Auto is not destructive-license.
