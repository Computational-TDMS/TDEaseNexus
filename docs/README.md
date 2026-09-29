# TDEase docs

How humans and AI read `docs/`. The development rules are in
[`../AGENTS.md`](../AGENTS.md); the developer cheat-sheet (architecture mental model +
project structure) is in [`../CLAUDE.md`](../CLAUDE.md).

## What this product is

TDEase is an AI-first scientific analysis workspace for mass-spectrometry and proteomics
researchers who want to run and interpret analyses without becoming workflow engineers.
A user describes an analysis goal; the Agent selects a template and managed capabilities,
configures and validates the native workflow, submits a Run, supervises execution and
helps inspect the results.

It is calm, precise and forgiving — a dependable scientific workbench, quiet during
routine work and explicit when decisions or failures require attention. It **refuses to
be**: a node-editor that requires visual workflow construction; a parameter-wizard maze
exposing engine config before user intent; a card-grid dashboard competing with the real
results; opaque AI that hides its template, dry-run or execution facts; or anything that
forces advanced users to abandon it to reach ordinary files and scripts.

The primary path is intent → Agent → verified Run → inspectable result. The Run is the
primary operational object. Workspace files stay user-owned and native.

## Authority order

1. `../AGENTS.md` — development rules (binding).
2. `spec/` — accepted contracts (binding; one authority per fact).
3. `design/` — accepted designs; may be partially built.
4. `STATUS.md` — what is actually implemented today.
5. Code and tests — implementation evidence; they reveal status but do not silently
   replace an accepted contract.

When code contradicts a tier 2-4 document, one of them is wrong: either the document is
`stale` (fix it) or the code has a defect. Record which in `STATUS.md`. Never leave it
unresolved.

## Contract document format

A `spec/` document records a decision, and a decision is only readable together with what
it defeated. Every new contract, and every substantive revision of an existing one, must
carry an `## Alternatives considered` section: each real alternative that lost, and the one
line on why it lost. A contract without this section invites re-litigating a settled
decision — the section is the antidote, for humans and for AI maintainers alike.

Alternatives are recorded, not invented. When the history of a pre-existing contract
cannot be honestly reconstructed, say exactly that in the section and let the next
substantive revision fill it in; never fabricate a plausible loser. `design/` documents
follow the same rule when they record a rejected alternative.

## Documents

| Document | Owns |
|---|---|
| `spec/FILE-LAYOUT.md` | Directory layout, roots, ownership, path rules |
| `spec/WORKFLOW-RUN.md` | Backend HTTP surface (incl. `/api/capabilities` §2.1), Run lifecycle, events, Published Results; §1/§3–6 are the live Snakemake engine contract (Snakemake is the current orchestrator — see STATUS Backend) |
| `spec/AGENT-CONTRACT.md` | Agent tool surface, authority/permission model, prompt/skill assembly |
| `spec/AGENT-EVENTS.md` | Canonical session event vocabulary, log invariants, dual-log contract with the Pi SDK, projection family |
| `spec/CAPABILITIES.md` | `/api/capabilities` response contract |
| `spec/FAILURE-CONTRACT.md` | The one Backend error shape on the wire: envelope, closed code enumeration, domain→HTTP mapping, redaction |
| `spec/RUST-MS-CONTRACT.md` | Rust mass-spec CLI tool contract (contract tier of `design/tdeasenexus-toolbox-native-adapter.md`) |
| `design/THREE-REPOSITORY-ARCHITECTURE.md` | Desktop / Backend / Scientific-System boundary, dependency direction, data separation |
| `design/CORE-ARCHITECTURE.md` | Event/projection model, Result identity, dimensions, concurrency |
| `design/AGENT-LOOP.md` | Turn lifecycle: settlement outcomes (§2-3), budget display (§5), suspension clock (§6), derived status-line phase (§7) |
| `design/AGENT-LIFECYCLE.md` | Lifecycle & ownership matrix for every runtime entity (Session, PTY, job, subagent, Run, Backend, Web share): creation, permission source, wait surface, stop/quit/crash; delegation monotonicity |
| `design/tdeasenexus-toolbox-native-adapter.md` | Rust mass-spec kernel + `tdeasenexus-toolbox` CLI contract, UniMod dual-source, packaging |
| `design/RUST-KERNEL-ARCHITECTURE.md` | Rust kernel layered architecture diagram (single-truth anchors, lattice gates, guard tests; the CLI contract is `spec/RUST-MS-CONTRACT.md`) |
| `design/hypothesis-evidence-lattice.md` | Evidence lattice `mass ⊂ composition ⊂ identity`: which kernel operations reject mass-only tags and which accept them labeled `massDelta` |
| `design/ISOFORMA-ARCHITECTURE.md` | IsoForma positional-isomer quantification: one-intent runner, `proformaBaseClosure` gate, quantifier (durable design record) |
| `design/MASS-SHIFT-ASSIGNMENT.md` | Authoritative design for single-sample OpenSearch screening and mass-shift assignment |
| `design/ORCHESTRATE-RUNTIME.md` | Orchestration runtime: scripts as workflows + journal replay by call-index |
| `design/PTC-RUNTIME.md` | PTC runtime: programmatic tool calling — scripted tool execution with fewer agent round-trips |
| `design/SUBAGENT-RUNTIME.md` | Subagent runtime: delegation interface, roles, parallelism/persistence/discovery, floating panel |
| `design/VISUAL-ROLLOUT-PLAN.md` | Visual-system rollout plan (execution edition; strategy `TDEase-FrontEnd/PRODUCT.md`, rules `TDEase-FrontEnd/DESIGN.md`) |
| `design/STUDIO-FRONTEND-BUSINESS-LOGIC.md` | `src/studio/` module boundary and delivery slices |
| `design/skill-runtime.md` | Skill runtime: env vars, script resolution, PEP 723 execution |
| `design/FRONTEND-INTERACTION-MAP.md` | Frontend interaction reference (buttons, states, shortcuts); code is authority |
| `design/KNOWLEDGE-WIKI.md` | Knowledge Wiki design (two scopes, plain files, wikilinks) |
| `design/PERMISSION-AUTO-FIX.md` | Permission auto-fix flow |
| `design/PACKAGE-DISTRIBUTION.md` | Package distribution & update policy: static index marketplace, agent-as-package-manager, three-channel ownership/update matrix |
| `design/PTC-RELIABILITY.md` | PTC vs deepseek-harness reliability comparison + optimization list (O1 bash structured results) |
| `design/PTY-RUNTIME.md` | Persistent PTY bash (upgrade of the existing bash tool; three-layer port of dsh-terminal) |
| `design/MOTIF-PRIOR.md` | Homologous protein motif knowledge for PTM exploration (partial) |
| `design/MASS-SHIFT-LOOP.md` | Mass-shift attribution methodology: three-step LOOP, four-destination triage, three deep-dive archetypes (each in its place) |
| `design/SKILL-D3-RENDERING-ARCHITECTURE.md` | Runtime scientific-figure ownership, contract, compiler and browser acceptance gate |
| `design/BACKEND-HARDENING.md` | Backend hardening passes (event sourcing, Origin gate, dual principal) |
| `design/DESKTOP-PACKAGING.md` | Installer posture, data-root selection, bundled Python/bash, boot reveal, license surface, update channel, node-catalog seed, process ownership, install verification |
| `design/MODEL-PROVIDER-SEAM.md` | Model capability resolution, credential/atomic-write seam, custom providers, usage ledger & aggregates |
| `design/WEB-SHARING.md` | Invitation-based LAN sharing (collab mirror + read-only files), hot revocation |
| `STATUS.md` | Current implementation snapshot |

## Quick entry points

Don't read everything. Start by task:

| You want to… | Read |
|---|---|
| Know what is built today | `STATUS.md` |
| Know where files live / who owns them | `spec/FILE-LAYOUT.md` |
| Understand the three-repo boundary | `design/THREE-REPOSITORY-ARCHITECTURE.md` |
| Call the Backend / understand a Run | `spec/WORKFLOW-RUN.md` |
| Build or use an Agent tool | `spec/AGENT-CONTRACT.md` |
| Understand the event/projection model | `design/CORE-ARCHITECTURE.md` |
| Check a Backend error code / envelope | `spec/FAILURE-CONTRACT.md` |
| Run or extend the test suite | `../CLAUDE.md` (Commands) + `STATUS.md` (baseline) |
| Check whether a scientific path was already explored | `EXPLORATION-LOG.md` (read before starting a new round) |
| Check a past operational fix | `solutions/` |

Status is read from exactly one place: `STATUS.md`. Never infer status from
a document's presence, title or frontmatter — `design/` documents may be
partially built by design; their implemented state is whatever `STATUS.md`
says it is.

## Not authoritative

These live under `docs/` but are **not** product authority:

- `paper/` — research artifacts and manuscript drafts; never an Agent capability or prompt source.
  `paper/ref-paper/` — plain-text extracts of the reference literature (PDFs from the
  author's desktop), one `.md` per paper; reference material only.
- `solutions/` — operational playbooks; they cite owning contracts, never redefine them.
  `solutions/ai-harness/` documents the generic real-LLM CLI harness over the same
  `createAgentRuntime` as the product. It accepts the caller's raw prompt and has no
  task ids, preset scientific answers, replay scorer or ground-truth corpus.
- `RELEASE-VM.md` — operational note (Windows release VM guide).
- `design/ENGINE-*.html` — self-contained engine mechanism diagrams
  (submission→execution path, data/truth layers, worker process loop, node
  lifecycle), each carrying its own known-weakness card; rendered from the
  shipped code, reference material only.
- `HARNESS-ENGINEERING-PLAN.md` — engineering-harness transformation plan and
  problem ledger (`H<n>` ids referenced by `[harness]` commits); process
  record, never product authority.
- `PI-PARITY-PLAN.md` — one-shot comparison against the PI-Desktop reference
  tree (settings/statistics/token accounting): what was replicated, what was
  already present, what was declined and why; process record, never product
  authority.
- `NODES.md` — operational note (node package inventory, provenance and usage
  for the git-ignored `data/backend/nodes/` deployment root).
- `EXPLORATION-LOG.md` — scientific exploration log (hypothesis→run→verdict
  rounds, active fronts, ruled-out paths). Scope: **post-data-analysis
  only** — data pre-processing (conversion, deconvolution, node deployment)
  is out of scope and lives in `NODES.md`, `STATUS.md` and Run provenance.
  Process record only, never a contract or status source.

## Status vs process records

The system has exactly two kinds of time. Keeping them apart is what keeps
lookup cheap — and it is the reason `STATUS.md` stays short:

- **Status** — `STATUS.md`. Answers only "what is true today". It is a
  snapshot: **rewrite it, never append**. Every line must be verifiable
  against the code and tests right now. Process narration ("today we
  removed X", pass-by-pass histories, commit hashes as narrative) does not
  belong here; a status file that has grown them is stale and gets
  rewritten, not edited further.
- **Logs / process records** — append-only; they answer "what happened,
  when, and what was decided". Each has one declared purpose and is never a
  source of current truth:
  - **git history** — the development record. Every narrative dropped from
    a STATUS rewrite remains retrievable here; that is what makes
    rewriting safe.
  - **`EXPLORATION-LOG.md`** — the scientific loop memory
    (hypothesis → run → verdict; post-analysis scope per its constitution;
    requires reading it before starting a new exploration round).
  - **`paper/RECORD-*.md`** — adjudicated agent-session records for the
    paper cases.
  - **`HANDOFF-*.md`** — session-boundary handoffs (what is in flight,
    next steps, key paths); superseded once the work lands.

- **Migration rule**: when a log yields a conclusion that must be
  enforced, move it into the authority that owns it — a `spec/` contract,
  a `design/` document, or `STATUS.md` — never leave it only in the log.
  Conversely, a status statement cites the test that proves it today, not
  the story of when the work was done.

## Status vocabulary

- `implemented` — exercised through the intended interface, covered by a passing test.
- `partial` — a path exists but a named contract or verification is missing.
- `missing` — no implementation satisfies the contract.
- `deferred` — intentionally outside this release.
- `stale` — no longer describes the repository; fix or remove immediately.

Never infer status from a filename. Verify the active caller, the runtime path and the
relevant test. `implemented` requires a test that currently passes.
