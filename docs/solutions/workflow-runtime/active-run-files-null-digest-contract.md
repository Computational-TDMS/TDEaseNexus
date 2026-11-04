---
title: "Active-run file manifests use a nullable digest to separate observations from immutable artifacts"
date: 2026-07-28
module: workflow-runtime
problem_type: integration_issue
component: api
severity: high
symptoms:
  - The Backend's Run files request keeps returning HTTP 200, but the Client shows RUN_FILES_LIST_FAILED
  - The Run executes normally and files are already on disk, yet Files and Artifacts still cannot display
  - The Client can only show a generic backend connection message and never gets the structured Backend error
root_cause: protocol_mismatch
resolution_type: protocol_change
related_components: [frontend, workspace, testing]
tags: [run-files, sha256, active-run, manifest, protocol-contract, frontend-mapping]
---

# Active-run file manifests use a nullable digest to separate observations from immutable artifacts

## Problem

The running Run has already produced files, and `GET /api/v2/runs/{run_id}/files` keeps
returning HTTP 200, but the Client rejects the entire file list during response mapping
and finally displays the protocol error as a Backend connection failure.

The fundamental problem is neither the network nor missing files: a single `RunFileEntry`
was being forced to express two different kinds of fact at once:

- a file just observed mid-run that may still change;
- a file already frozen in a successful or retained revision, addressable by content.

## Symptoms

- The Backend access log shows `/files?pattern=results/**` continuously `200 OK`.
- The Run graph and task progress refresh normally; only Files and Artifacts goes into the
  error state.
- The active-run file entries returned by the Backend contain `sha256: ""`.
- The gateway calls `asSha256("")` and throws a plain `Error`.
- Because the error is not a `BackendFailure`, the UI falls back to the placeholder error
  `RUN_FILES_LIST_FAILED`.

These symptoms mean the HTTP request already succeeded; the failure happens after the
response body enters the Client's domain model. When troubleshooting, do not treat
`200 OK` as end-to-end success, and do not keep inspecting the connection layer to explain
a mapping exception.

## What Didn't Work

- Replacing the empty digest of active-run files with an immediate SHA-256. The file can
  still grow, the computed digest is instantly stale, and no immutability guarantee is
  provided.
- Recursively scanning and hashing the entire Run directory on every two-second poll. A
  real Run has thousands of intermediate files, some tens of MB or larger; this turns a
  lightweight observation request into repeated heavy I/O.
- Swallowing the mapping error in the UI catch branch or wrapping it as a new Backend
  error. That only hides the protocol divergence and keeps mistaking active observations
  for content-addressed artifacts.
- Relaxing the global `asSha256()`. Node digests, Published Results, and retained revisions
  must still validate strictly; weakening the global identity type would spread a local
  protocol problem into stable data.

## Solution

The public protocol explicitly distinguishes stable digests from not-yet-frozen
observations:

```json
{
  "path": "sample.tsv",
  "size": 7,
  "sha256": null
}
```

For active Run files the Backend returns only the path, the current size, and
`sha256: null`; it does not read file contents to compute a digest. Successful Runs,
Published Results, and retained revisions still return a verified 64-digit SHA-256.

The Client transport DTO accepts the nullable digest:

```ts
interface RunFileEntryDto {
  path: string
  size: number
  sha256: string | null
}
```

The gateway calls the strict domain constructor only when the value is present:

```ts
{
  path: asRelativePath(file.path),
  size: file.size,
  digest: file.sha256 ? asSha256(file.sha256) : undefined,
}
```

Workspace file-state comparison preserves the same distinction. When the remote digest is
empty:

- if the local tree lacks the file, it can be marked `cloud`;
- if the local tree has the file, do not compute a local digest, and do not guess
  `cached` or `conflict`.

Tests cover only the three core chains:

1. The active Run files HTTP response returns `sha256: null`;
2. The gateway keeps that file entry, throwing no mapping error and fabricating no digest;
3. The Workspace does not mislabel a local file without a stable remote digest as a
   conflict.

## Why This Works

The digest is not a display field; it is the claim "these bytes are frozen". For an
active file, only existence and current size are observable facts; filling a temporary
SHA-256 into the same field fabricates an immutability promise that does not exist.

The nullable digest moves the lifecycle difference back to the protocol boundary instead
of leaving it to UI guesswork. The strict `asSha256()` survives, terminal-state content
addressing stays fail-closed, and the active file list no longer fails wholesale for
lacking an identity that cannot be stable yet.

The fix also deleted wasted work: the Backend no longer repeatedly reads and hashes the
run directory, and the Client no longer does pointless local hash comparisons for unknown
digests. Less code, stronger semantics, lower running cost.

## Prevention

- For anomalies after an HTTP 200, keep tracing through JSON decoding, the DTO, the
  gateway, and domain constructors; do not go back to guessing at the network.
- Treat digest, revision, and content address as immutability claims; never fill
  placeholder values for in-progress data.
- A transport DTO may express protocol lifecycle; strict domain identities are constructed
  only when the fact holds.
- When active observation and retained manifests share a route, the stability difference
  must be explicit in the field contract.
- If an expensive performance patch exists only to satisfy a wrong schema, fix the schema
  first instead of adding caching or acceleration patches.
- Regression tests cover the public HTTP and Client adapter boundaries; do not test only
  the UI catch or a single validation function.

## Related

- [Workflow and Run contract](../../spec/WORKFLOW-RUN.md)
- [TDEase architecture and Run rules](../../../AGENTS.md)
