# Skill script runtime

Skill execution has one path:

```bash
uv run --script "$TDEASE_SYSTEM_ASSETS/skills/<skill>/scripts/<script>.py" <args>
```

The Agent invokes this through the controlled Workspace bash tool. Tests invoke the same
PEP 723 script through `uv`; there is no second product-specific script executor.

## Sandbox environment

The bash child receives an environment constructed from an empty object. It does not
inherit the Electron process environment.

| Entry | Purpose |
|---|---|
| `PATH` | Managed `tdeasenexus-toolbox`, provisioned `rg`/`fd`, `uv`, and minimum OS command directories |
| `TDEASE_SYSTEM_ASSETS` | Read-only installed Skills/prompts/reference root |
| `TDEASE_WORKSPACE` | The bound Workspace root anchor — stable across per-call `cwd` changes, so the `bash` tool and background jobs expand the same variables |
| `UV_CACHE_DIR` | Product-owned PEP 723 cache in packaged mode |
| `UV_FIND_LINKS` | Packaged offline wheelhouse |
| `UV_PYTHON` | Packaged Python interpreter |
| `TEMP`, `TMP` | Workspace-local `.tdease/tmp` |
| OS bootstrap fields | Only `SystemRoot`, `WINDIR`, `ComSpec`, `PATHEXT`, locale and timezone when present |

Forbidden in the bash child:

- Desktop provider/API secrets.
- Backend configuration or data paths.
- Any other inherited variable — the child env is built fresh, and exactly two
  `TDEASE_*` pointers are set by design (`TDEASE_SYSTEM_ASSETS`,
  `TDEASE_WORKSPACE`). `TDEASE_SYSTEM_ROOT`, `TDEASENEXUS_TOOLBOX_BIN`, `TDEASE_ENV`
  and arbitrary inheritance never cross.

`TDEASE_SYSTEM_ASSETS` is intentionally retained. It is a sandbox capability pointer,
not product configuration: it exposes the installed read-only Skill tree without
exposing Desktop or Backend roots. `TDEASE_WORKSPACE` likewise anchors the bound
Workspace (jobs/bash parity), not a discovery affordance — the analysis convention
still speaks Workspace-relative paths.

## Tool discovery

- `tdeasenexus-toolbox` and `uv` resolve through the controlled PATH.
- Skill scripts may accept explicit CLI path arguments for development, but do not read
  product-location environment variables.
- A standalone Scientific System checkout resolves reference assets relative to the
  selected script; Desktop sandbox execution may use `TDEASE_SYSTEM_ASSETS`.

## File boundary

- Every bash call starts in the bound Workspace.
- The command cwd is containment-checked against the Workspace.
- No absolute Workspace path is injected.
- Temporary files default to Workspace `.tdease/tmp`.
- System assets are read-only; mutable outputs use Workspace-relative paths.

This reduces accidental discovery, but it is not an operating-system filesystem sandbox:
an arbitrary shell program can still address an absolute host path. Permission policy,
command preflight and deployment isolation remain required for untrusted shell workloads.

## Python dependencies

Each script owns its dependencies in its PEP 723 header. Release automation collects those
headers into the offline wheelhouse. No shared Skill virtualenv is maintained.
