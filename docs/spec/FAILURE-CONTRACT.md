---
type: contract
title: Failure contract
description: The one Backend error shape on the wire — envelope, closed code enumeration, domain→HTTP mapping, redaction.
status: accepted
---

# Failure contract

> The single authority for every Backend error response on the wire. One envelope,
> one closed `code` enumeration, one `domain`/`http_status` derived from `code`.
> The code half is `TDEaseError` in the Backend error module; a raise site never
> picks a `domain` or an `http_status`.

## 1. The envelope

Every error response body is exactly one object:

```json
{
  "error": {
    "code": "RUN_NOT_FOUND",
    "domain": "run",
    "message": "Run abc was not found.",
    "remedy": "Check the run_id, or list Runs with GET /api/v2/runs.",
    "retryable": false,
    "details": { "run_id": "abc" },
    "cause": { "error": { "code": "..." } }
  }
}
```

- `code` — one member of the closed `ErrorCode` enumeration (§3).
- `domain` — derived from `code`, never chosen at a raise site (§1.1).
- `message` — human text; never a program branch basis.
- `remedy` — an action the caller can take.
- `retryable` — a real boolean from domain semantics, not inferred from `http_status`.
- `details` — machine-readable extras; redacted (§5); omitted when absent (§1.2).
- `cause` — a nested prior error, redacted on the same terms; omitted when absent.

### 1.1 `domain` is derived, never chosen

`domain` comes from `code` through one fixed map (`CODE_DOMAIN`). A raise site
cannot cause a `code` to disagree with its registered `domain`.

### 1.2 Absent fields are omitted

`details` and `cause` are omitted from the envelope when absent — never emitted
as `null` or an empty object.

## 2. Domains

Six closed domains:

| Domain | Owns |
|---|---|
| `workspace` | Workspace identity, roots, files, digests, quota |
| `run` | Run identity, lifecycle, plan, results |
| `engine` | Workflow execution, tasks, resources |
| `agent` | Agent tool/identity/prompt contract |
| `backend` | Backend-internal and package/upload mechanics |
| `environment` | Auth bootstrap and process environment |

New members of the enumeration never add a new domain.

## 3. The closed `code` enumeration

New members are additive. An existing member's `domain` and meaning never change.
The mapping from `code` to `domain` is exhaustive over the enumeration and is
asserted so in the code; a forgotten mapping fails CI rather than surfacing as a
runtime `KeyError`.

### 3.1 `workspace`

`WORKSPACE_NOT_FOUND`, `WORKSPACE_IDENTITY_INVALID`, `WORKSPACE_PATH_ESCAPE`,
`WORKSPACE_FILE_NOT_FOUND`, `WORKSPACE_DIGEST_MISMATCH`, `WORKSPACE_BLOB_NOT_FOUND`,
`WORKSPACE_QUOTA_EXCEEDED`.

### 3.2 `run`

`RUN_NOT_FOUND`, `RUN_NOT_QUEUED`, `RUN_NOT_TERMINAL`, `RUN_IDEMPOTENCY_CONFLICT`,
`RUN_PLAN_INVALID`, `RUN_PLAN_STALE`, `RUN_MODE_MISMATCH`, `RUN_DRY_RUN_UNAVAILABLE`,
`RUN_FILE_NOT_FOUND`, `RUN_TRASH_NOT_FOUND`, `RUN_NODE_NOT_FOUND`,
`RUN_TEMPLATE_NOT_FOUND`, `RUN_TEMPLATE_ID_INVALID`.

### 3.3 `engine`

`ENGINE_INVALID_WORKFLOW`, `ENGINE_MISSING_INPUT`, `ENGINE_AMBIGUOUS_RULE`,
`ENGINE_CYCLE_DETECTED`, `ENGINE_TOOL_NOT_FOUND`, `ENGINE_RESOURCE_EXHAUSTED`,
`ENGINE_TASK_FAILED`, `ENGINE_INCOMPLETE_OUTPUT`, `ENGINE_CANCELLED`,
`ENGINE_RUNTIME_INTERNAL`.

### 3.4 `agent`

`AGENT_TOOL_NOT_REGISTERED`, `AGENT_OUTPUT_CONTRACT_VIOLATION`,
`AGENT_IDENTITY_FORGED`, `AGENT_PROMPT_SNAPSHOT_MISSING`.

### 3.5 `backend`

`BACKEND_INTERNAL`, `BACKEND_PACKAGE_NOT_FOUND`,
`BACKEND_PACKAGE_DIGEST_UNRESOLVABLE`, `BACKEND_UPLOAD_INCOMPLETE`,
`BACKEND_PRESIGNED_EXPIRED`.

### 3.6 `environment` (auth is environment, not backend)

The `AUTH_*` codes are environment-domain: a Desktop launch that cannot
authenticate is a broken environment, not a malformed request and not a Backend
fault. `AUTH_BOOTSTRAP_SECRET_MISSING`, `AUTH_BOOTSTRAP_SECRET_INVALID`,
`AUTH_BOOTSTRAP_UNAVAILABLE`, `AUTH_TOKEN_INVALID`, `AUTH_ORIGIN_FORBIDDEN`,
`AUTH_SCOPE_DENIED`, `ENVIRONMENT_BOOTSTRAP_UNAVAILABLE`,
`ENVIRONMENT_UNAUTHORIZED`, `ENVIRONMENT_DEPENDENCY_MISSING`,
`ENVIRONMENT_PORT_UNAVAILABLE`, `ENVIRONMENT_DISK_UNAVAILABLE`.

### 3.7 Raise-site migration

Legacy raise sites use the retired generic vocabulary (`AppError` /
`ExecutionError` with codes such as `INTERNAL`, `NOT_FOUND`, `INVALID_REQUEST`,
`PATH_TRAVERSAL`, `EXECUTION_*`, `PACKAGE_*`). They translate to `TDEaseError` by
a mechanical rename plus a few per-call-site judgments:

| Legacy | Contract |
|---|---|
| `EXECUTION_*` | `ENGINE_*` (same suffix) |
| `PACKAGE_NOT_FOUND` / `PACKAGE_DIGEST_UNRESOLVABLE` | `BACKEND_PACKAGE_NOT_FOUND` / `BACKEND_PACKAGE_DIGEST_UNRESOLVABLE` |
| `PATH_TRAVERSAL` | `WORKSPACE_PATH_ESCAPE` |
| `DIGEST_MISMATCH` | `WORKSPACE_DIGEST_MISMATCH` |
| `QUOTA_EXCEEDED` | `WORKSPACE_QUOTA_EXCEEDED` |
| `BLOB_NOT_FOUND` | `WORKSPACE_BLOB_NOT_FOUND` |
| `UPLOAD_INCOMPLETE` / `PRESIGNED_EXPIRED` | `BACKEND_UPLOAD_INCOMPLETE` / `BACKEND_PRESIGNED_EXPIRED` |
| `INTERNAL` | `BACKEND_INTERNAL` or `ENGINE_RUNTIME_INTERNAL` (per site) |
| `NOT_FOUND` / `INVALID_REQUEST` | the specific `RUN_*` / `WORKSPACE_*` / `RUN_PLAN_INVALID` the site means |

## 4. `http_status`

Derived from `code`, never chosen per raise site. One per-domain default plus a
closed per-code override table; `http_status_for(code)` is the one place a status
is resolved (per-code override, else domain default).

| Domain | Default |
|---|---|
| `workspace` | 400 |
| `run` | 409 |
| `engine` | 200 (§6) |
| `agent` | 422 |
| `backend` | 500 |
| `environment` | 503 |

Per-code overrides (the status a client actually branches on):

| Code | Status | Why the domain default is wrong here |
|---|---|---|
| `AUTH_BOOTSTRAP_SECRET_MISSING` / `AUTH_BOOTSTRAP_SECRET_INVALID` / `AUTH_TOKEN_INVALID` | 401 | a bad Bearer token is a token challenge, not a 503; the client's auth-retry path fires on 401 |
| `AUTH_BOOTSTRAP_UNAVAILABLE` | 410 | a consumed one-shot bootstrap secret will genuinely not come back |
| `AUTH_ORIGIN_FORBIDDEN` | 403 | a cross-site browser origin is an attack on a tokenless local server, not a client bug |
| `AUTH_SCOPE_DENIED` | 403 | the token is valid but the principal lacks the scope (e.g. the agent token on `run:purge`); forbidden, not a token challenge |
| `RUN_NOT_FOUND` / `RUN_FILE_NOT_FOUND` / `RUN_TRASH_NOT_FOUND` / `RUN_NODE_NOT_FOUND` / `RUN_TEMPLATE_NOT_FOUND` | 404 | absence must be indistinguishable from another Principal's Run (information-hiding) |
| `WORKSPACE_NOT_FOUND` / `WORKSPACE_FILE_NOT_FOUND` / `WORKSPACE_BLOB_NOT_FOUND` | 404 | absent, not conflicting |
| `WORKSPACE_PATH_ESCAPE` | 403 | forbidden, not correctable by editing the request |

Every other code takes its domain's default. Adding a code never lets a raise
site choose — it only joins the override table or the domain default.

## 5. Redaction

Applied at construction, before any other code can observe the value. Two
independent rules, recursive over dicts and lists:

1. **Key-based** — a mapping key containing (case-insensitively) `token`, `secret`,
   `key`, `password`, or `authorization` has its value replaced with `"[redacted]"`,
   regardless of the value's shape.
2. **Shape-based** — a string that looks like an absolute filesystem path is
   replaced with `"[redacted-path]"` unless it falls inside the given
   `workspace_root`. With no `workspace_root`, every absolute-path-shaped string
   is redacted — a `details` object should only ever carry Workspace-relative paths.

## 6. `engine` maps to 200

A workflow failure is a successful observation of a Run, never a product error.
The `engine` domain therefore maps to the 200 family: the Run is the thing that
succeeded in *being observed*, while the envelope body carries the engine error.
This is why `DOMAIN_HTTP_STATUS[engine] = 200` and not 500.
