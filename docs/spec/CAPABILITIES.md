# TDEase Backend Capability Contract

> Accepted contract. Sole authority for the `/api/capabilities` response shape, its
> evolution rule, and its authentication posture.
>
> Verified against the repository. Closes `docs/STATUS.md`
> ("`/api/capabilities` field-level contract") and unblocks the caller-declared
> deployment mode. Failure shapes are governed by
> `FAILURE-CONTRACT.md`. The illustrative response body formerly in the deployment
> design (deleted 2026-08-09; retrievable in git history) is superseded by the
> field list below.

## 1. What this document is for

`GET /api/capabilities` is the only thing a Client is allowed to use to decide how to
talk to a given Backend instance. It replaces every place the Client or the Backend
today infers behaviour from a caller-declared `mode`, a hardcoded URL, or an IP
address.

Two rules govern everything below:

1. **The Client feature-detects on presence, never on version.** A Client checks
   whether a field or nested object exists and what it contains; it never branches on
   `protocol_version` to infer whether a feature exists. `protocol_version` exists
   only to refuse an incompatible major version — the only thing a version number can
   honestly tell a Client.
2. **Capabilities select a transport adapter, never file ownership.** Client always
   submits a Workspace Run manifest. Backend advertises how missing bytes can be
   satisfied; Desktop links/direct reads and Server uploads implement the same
   contract. The caller never declares a product edition.

## 2. Frozen at startup

The document is resolved **exactly once**, at process startup, into an immutable
structure. Every request returns that same cached object. Resolution has three
explicit inputs, all owned by `src/backend_settings.py`:

- `BackendSettings`: the sole `data/backend/config.json` parsing result;
- `RuntimeInventory`: the frozen host and Snakemake installation snapshot;
- `CapabilityRegistry`: an explicit list of public behaviours implemented by this
  release.

`ResourceBudget` is derived from the same `BackendSettings` and
`RuntimeInventory`. Consequently the limits advertised to the Client and the CPU
affinity/memory budget enforced by the Worker cannot independently interpret the
machine or its reserve policy.

- No request handler, authentication module, resource-budget module, or capability
  module reads configuration independently. The public CLI freezes the JSON document
  before importing the application. Environment overrides exist only when a development
  or test caller explicitly supplies `--allow-env-overrides`.
- A capability that depends on runtime state (installed engine version, configured
  deployment mode, disk layout) is captured as **the configured capacity of this
  process**, not as a live "is it working right now" probe. For example
  `engine.version` is the version of Snakemake resolved once at startup; it is not
  re-checked per request, and it does not change without a process restart.
- Restarting the process is the only way the document changes. There is no mutation
  path, no admin endpoint, and no per-request override.
- A test asserts the document is byte-identical across two calls and cannot change until
  the Backend process restarts (see `tests/test_capabilities.py`).
- Feature support is never inferred through Pydantic field reflection or incidental
  imports. Adding a contract field does not enable a feature. The implementation,
  `CapabilityRegistry`, public route, and capability test must change together.

## 3. Authentication posture: unauthenticated

`GET /api/capabilities` is a **public, unauthenticated** route, added to the same
public-path allowlist as `/api/auth/bootstrap` and `/health` in `app/auth.py`.

Reasoning:

- Local Desktop and development Backends advertise `auth.scheme: "none"` and use
  the `local-owner` principal without an application-level handshake. Remote Server
  deployments advertise `auth.scheme: "bearer"`.
- If `/api/capabilities` required a Bearer token, the Client would need to already
  know the auth scheme to obtain a token for a request whose only purpose is to tell
  the Client the auth scheme. That is a bootstrap deadlock: the document that
  describes how to authenticate cannot itself require authentication.
- The document carries no secret and no user data — only static process
  configuration (protocol version, transfer strategy names, numeric limits,
  engine name/version, feature flags). Exposing it to an unauthenticated loopback
  caller adds no disclosure risk beyond what a port scan already reveals (the process
  is listening on loopback at all).
- This does not weaken remote Server authentication: in bearer mode every other route still
  authenticates. Adding one named, reviewed, no-side-effect GET route to the public
  allowlist is a deliberate exception, not a regression of the auth default.

Out of scope for this document (owned elsewhere): adding the route path to
`app/auth.py::PUBLIC_PATHS` and to `app/main.py`'s router registration. This
module only exports the `APIRouter`; wiring is a separate agent's responsibility per
this change's task split.

## 4. Field list

Every field below is **always present** in the response — the object graph itself
never varies. "Required" describes whether the Client can assume the field's
presence in *this* protocol major version; "additive" fields may still gain new
enum members or sibling fields over time (see §5). The dotted path is the exact
JSON key path in the response body.

<!-- FIELD-TABLE:START -->
| Field | Type | Required | Client behaviour when absent |
|---|---|---|---|
| `protocol_version` | integer | required | Never actually absent (see §5). A Client that cannot find this field at all treats the response as malformed and refuses to proceed with an actionable "Backend response is not a valid capability document" error. |
| `auth.scheme` | string (`"none"` or `"bearer"`) | required | Client cannot determine the authentication posture and refuses to proceed. |
| `auth.bootstrap` | string (`"desktop"`) or `null` | required (nullable) | `null` means no interactive bootstrap flow is offered (e.g. a future Server expecting a pre-issued personal access token). The Client skips the Desktop bootstrap exchange and prompts for a credential instead. |
| `materialization.strategies` | array of string enum (`"local_workspace_hardlink"`, `"blob_store"`) | required (array; may be empty) | Empty means Backend cannot currently receive Run inputs; Client disables Submit and surfaces an environment error. |
| `limits.max_cores` | integer | required | Client falls back to `1` and disables the cores input above that value. |
| `limits.max_memory_mb` | integer | required | Client clamps requested Run memory to this Backend-enforced process-tree limit. |
| `limits.total_logical_cpus` | integer | required | Diagnostic only; Client does not schedule from host topology. |
| `limits.reserved_service_cpus` | integer | required | Diagnostic only; these CPUs remain outside the workflow-engine affinity set. |
| `limits.total_memory_mb` | integer | required | Diagnostic only; the startup-resolved host memory visible to this Backend. |
| `limits.reserved_service_memory_mb` | integer | required | Diagnostic only; workflow process trees cannot consume this service reserve. |
| `limits.max_concurrent_runs` | integer (`1`) | required | Client treats all submitted Runs as one global FIFO and never promises parallel execution. |
| `limits.dry_run_timeout_seconds` | integer | required | Client uses its own default advisory timeout for the dry-run spinner only; the Backend enforces the real timeout regardless. |
| `limits.log_tail_default_lines` | integer | required | Client requests `200` lines. |
| `limits.log_tail_max_lines` | integer | required | Client clamps any tail request to `10000`. |
| `engine.name` | string | required | Client displays "unknown engine" in any diagnostic surface; nothing else depends on it. |
| `engine.version` | string | required | Client omits the version string from diagnostics; behaviour is otherwise unaffected. |
| `engine.execution_profile` | string | required | Client assumes the Backend's default profile and does not offer profile selection UI. |
| `features.run_definition` | boolean | required | Absent whole `features` object (or missing key within it, from an older major) is read as `false`. Client hides the native dry-run DAG view and falls back to the legacy textual dry-run output. |
| `features.published_results` | boolean | required | `false`/absent: Client hides the Published Results panel; results are only reachable as raw run files. |
| `features.native_dry_run_projection` | boolean | required | `false`/absent: Client renders the dry-run response as preformatted text instead of a structured DAG projection. |
| `features.mutable_run_title` | boolean | required | `false`/absent: Client hides the run-title rename affordance. |
| `features.cursor_logs` | boolean | required | `false`/absent: Client uses the bounded tail contract (`limits.log_tail_*`) exclusively and never sends a log cursor/offset parameter. |
| `multi_user` | boolean | required | Absent: Client assumes `false` (single local owner) and hides any member/invite UI. |
<!-- FIELD-TABLE:END -->

Notes on specific fields:

- Resource limits are frozen once at Backend startup. By default the workflow
  engine is excluded from up to four logical CPUs and from `max(2048 MB, 1/8 of
  visible memory)`, while always leaving at least 512 MB of compute memory on
  small hosts. Deployments may raise or lower the reserves with
  `TDEASE_RESERVED_LOGICAL_CPUS` and `TDEASE_RESERVED_MEMORY_MB`; the resolved
  values, not the environment variables, are the public truth.
- `limits.max_memory_mb` is the memory budget the Backend admits for a Run. It is
  declared to Snakemake as the workflow's `mem_mb` scheduling resource, not a
  process-level kill wall; the operating system owns memory reclamation. A missing
  `commit.memory_mb` is resolved to this budget when the Backend accepts the
  commit, so `null` never means unlimited execution.

- `materialization.strategies` is preference ordered.
  `local_workspace_hardlink` lets Desktop satisfy verified manifest bytes through a
  contained read and one shared Backend-CAS seal; the Run hardlinks those blobs.
  `blob_store` transfers missing digests. Both materialize private Backend execution
  inputs and leave the Workspace Run Client-owned.
- `features.*` corresponds one-to-one with the Client's current
  `BackendCapabilities` port (`TDEase-FrontEnd/src/studio/ports/backend-gateway.ts`),
  minus `discovery`. `discovery` is **not a Backend field** — it is a value the
  Client derives itself from whether the `GET /api/capabilities` call succeeded at
  all (`'available'` on 2xx, `'unavailable'` on network failure, non-2xx, or a
  document that fails the malformed-document check in this table). A field cannot
  describe the reachability of the request that returns it.
- `engine.execution_profile` is a deployment-adapter identifier (Desktop's packaged
  local profile today: `"desktop-local"`), unrelated to the static Snakefile "Profile"
  validated by `src/execution_runtime/profile_validator.py` (§4.3 of the workflow
  contract). The name collision is coincidental; do not conflate the two.

## 5. Additive evolution

- **Additive and safe, without a `protocol_version` bump:** a new top-level field; a
  new field inside `auth`, `materialization`, `limits`, `engine`, or `features`; a new
  member appended to `materialization.strategies`; a new `features.*` flag; widening
  `limits.*` upward (a bigger `max_cores`, a bigger `log_tail_max_lines`).
- **Breaking, and requires a `protocol_version` bump:** removing a field; renaming a
  field; changing a field's JSON type; changing the meaning of an existing value
  (e.g. redefining what `"local_workspace_hardlink"` transfers); narrowing a limit
  below a value a live Client could already be relying on; changing `auth.scheme` to
  a value existing Clients do not recognize.
- `protocol_version` is a plain integer, not semver. It increments by exactly 1 for
  each breaking change, never for an additive one. There is no minor number to bump,
  because "which fields exist" is answered by presence, not by version, per §1.
- The Client supports exactly protocol `3`. A Backend returning any other
  `protocol_version` is incompatible. Protocol `3` remains compatible regardless of
  which additive fields the document also carries.

## 6. Mismatch behaviour

The Backend has no concept of a "compatible" or "incompatible" Client — it does not
receive a Client-declared version anywhere in this contract, and it must not start
accepting one (that would reintroduce the caller-declared-mode defect this document
exists to remove, applied to versions instead of modes). `GET /api/capabilities`
**always returns its true, unconditional document.** There is no rejection response
from the Backend for this route.

All mismatch handling is Client-side:

1. The Client reads `protocol_version` from the response.
2. If it is not `3`, the Client refuses to open the
   Workspace/session against this Backend and surfaces a **local, Client-constructed**
   error using the `FAILURE-CONTRACT.md` §1 envelope shape:

   ```json
   {
     "error": {
       "code": "PROTOCOL_VERSION_UNSUPPORTED",
       "domain": "environment",
       "message": "This Backend speaks capability protocol 2; this Client supports 3.",
       "remedy": "Update the Backend to protocol 3, or use a Client that supports protocol 2.",
       "retryable": false,
       "details": { "backend_protocol_version": 2, "supported_protocol_versions": [3] }
     }
   }
   ```

3. `domain: "environment"` is deliberate: per `FAILURE-CONTRACT.md` §2 this is the
   one class the user can typically fix themselves (upgrade one side), and the
   correct Agent/Client behaviour is "ask the user; surface the remedy" rather than
   retry.
4. The Client never attempts partial feature negotiation below a major mismatch. It
   either proceeds fully (version recognized) or refuses fully (version not
  recognized); there is no degraded-but-connected state for a `protocol_version` the
  Client does not know.

Protocol `3` is the current contract. It removes protocol-2 lifecycle ambiguity:
Run lifecycle events use the same schema version declared by
`src/contracts/run_lifecycle.json`, and the Client intentionally carries no protocol-2
compatibility branch.

## 7. Materialization selection rule

Client and Backend select a mutually supported way to satisfy the exact manifest;
the caller never declares Desktop or Server mode. Concretely:

- The submission surface has no caller-supplied `mode` field.
- `POST /runs` and `POST /runs/dry-run` stop reading `TDEASE_DEPLOYMENT_MODE` (or any
  environment variable) at request time. The deployment's allowed strategy list is
  resolved once at startup — the same resolution that produces
  `materialization.strategies` in this document — and reused for every request.
  This is also required independently by the top-level M0 grep gate ("no request
  handler reads an environment variable at request time").
- For `local_workspace_hardlink`, Desktop attaches an existing Workspace directory
  once. Backend persists a per-principal grant and returns an opaque `root_id`.
  Dry-run and submit carry only `local_root_id` plus the Run-relative path; a request
  never carries or authorizes its own absolute path. Removing the Workspace revokes
  the grant. Backend restart preserves it.
- For `blob_store`, Client asks which manifest digests are missing, uploads those
  bytes, and submits no Client-local path or root capability.
- Client submits one path/digest manifest. Backend selects and records the adapter;
  both adapters materialize the same immutable Run snapshot.
- Client records the adapter and Backend execution reference in the Workspace Run's
  metadata so later observation never depends on Backend absolute paths.

This rule is stated here, once, so the runs surface (`app/api/runs_v2.py`) can cite it
instead of re-deriving deployment-mode logic locally.
