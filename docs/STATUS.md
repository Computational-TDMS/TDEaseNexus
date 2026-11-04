# Status — what is actually built

> Snapshot only: what is true today, verifiable against code and tests.
> No history, no comparisons, no process narrative — the record lives in git
> history alone. Feature descriptions live in their owning `spec/`/`design/`
> documents; each line here is a status verdict plus the pointer and the
> pinning test. Status vocabulary: `docs/README.md`. Last rewrite:
> 2026-10-14 (backend result-attribution semantics, job-event relay
> discipline and engine-integration convergence recorded; the 2026-10-13
> backend Run-service Phase 1 and earlier items below unchanged),
> preceded by 2026-10-13.

## Open defects

- **Large-context close stability stays pinned, not explained**: a failed
  turn over a >100 KB message once delayed window close by ~25 s. The
  minimal repro no longer reproduces; the quit path is hard-capped at
  15 s (`SWEEP_DEADLINE_MS`), and `tests/desktop/large-context-survival.spec.ts`
  seeds ~250 KB of uncompacted bloat (incl. one >100 KB single message),
  reloads, settles a failed turn and asserts every death channel (page
  close/crash, app exit) stays silent for 45 s. Reopen the defect with
  that spec if it resurfaces.
- **Red/unstable tests** (must not be cited as passing): the chlamy
  gate/rung test is outcome-unstable (input-state drift undiagnosed — red).
  Record statuses: the archived attempt-56 rerun counts are closed benchmark
  records, and the certified basis for the paper's Chlamydomonas figures is
  the five-sample rerun (see IsoForma below); neither changes this test's
  status.
  (2026-10-12 settings red tests, resolved 2026-10-13: code authoritative
  since `9838195` moved Settings into the centered modal — the three
  CommandPalette/DocumentHost tests were stale, still asserting the
  pre-modal document contract. Rewritten to the modal contract
  (`settingsModalOpen` + one-shot `requestedSettingsSection`; DocumentHost
  covers the retained `settings` dispatch that keeps legacy tabs
  rendering), the stale "settings document" spec passages in
  FRONTEND-INTERACTION-MAP.md corrected, full suite green.)
  (`test_focused_skills_do_not_embed_acceptance_case_answers` was resolved
  2026-09-19: the acceptance-case structure had slipped into
  structure-evidence's reference data as untracked files — deleted; the
  governance test now also scans that skill and `.json` data files.)

## Shape

- **TDEaseNexus (desktop, 0.11.0-beta)**: AI-first TD-MS analysis desktop workbench.
  The installed artifact keeps the name `TDEaseNexus` (installer/exe/data
  directory); every user-visible surface reads **TDEaseNexus · TD通**.
  Desktop = main repo (`Computational-TDMS/TDEaseNexus`; Electron shell + Vue3)
  + two submodules: `tdease-backend` 0.2.0 (Python/FastAPI, independently
  deployable) and `tdease-ai-capability` (Rust kernel 0.1.0 + `system/`
  assets). `data/` simulates a real client install; never a source of truth.
  Packaging posture: `design/DESKTOP-PACKAGING.md`.
- Code size (2026-09-06 measure): frontend src 519 files / 94k lines;
  electron main+agent 59 files / 17k lines (`electron/agent/` 40 modules);
  backend 48 py files / 9.6k lines; rust kernel src 22k lines.

## Frontend (TDEase-FrontEnd)

- **Interaction reference** — `design/FRONTEND-INTERACTION-MAP.md` is the
  feature description for the whole frontend surface: global shell (page
  handle, docks, editor groups, panel, StatusBar), command palette (incl.
  per-section Settings entries), the Settings modal (nine sections, incl.
  the permissions overrides editor, remote-backend auth, network proxy,
  diagnostics), the Agent page (composer, prompt queue, transcript, outcome
  rendering, context gauge, conversation export, streaming render pipeline,
  citation/artifact rendering, the right-docked sidebar as a second view of
  the same conversation), and the Workbench documents (file viewers incl. the
  16 visualization viewers with cross-viewer selection linking, wiki, welcome
  guide). Status: **implemented**. Pinned by the desktop Playwright suite
  (5/5 green, one merged journey) and the vitest suite below.
- **Studio business core** — `design/STUDIO-FRONTEND-BUSINESS-LOGIC.md`:
  module boundary, thirteen command families (exposure metadata fail-closed;
  `evidence.*` registered but stripped from session profiles; `nodes.install`
  withheld under a remote backend connection), planRef lifecycle, and the
  Backend link contract (authFetch single re-handshake, SSE keepalives,
  Backend-owned compute envelope). Status: **implemented**; family/partition
  invariants asserted in `src/architecture.test.ts`.
- **Agent runtime** — `electron/agent/**`; contracts `spec/AGENT-CONTRACT.md`
  (tool surface, two-tier permissions frozen at bind plus the approval-card
  whitelist (`allow_always` → priority -1 rule: session overlay + persisted
  workspace policy entry) and the shipped ask-mode default review policy
  (priority -2: dangerous isolated, risky asks, innocuous shell runs; auto
  unchanged), delegation monotonicity,
  OS sandbox, credential denial, prompt/skill assembly over the 15 frozen
  artifacts) and `spec/AGENT-EVENTS.md` (13-atom event vocabulary, dual-log
  contract, projections). Designs: `AGENT-LIFECYCLE.md` (ownership matrix),
  `AGENT-LOOP.md`, `SUBAGENT/PTC/ORCHESTRATE/PTY-RUNTIME.md`. Status:
  **implemented**; pinned by prompt assembly tests (7) +
  `mcp-provider.test.ts` behavioral pins.
- **Agent transparency surfaces** — task-tree cards, `view.*` viewports
  (subagent tool narrowing gains the `viewTools` slot: untested `view.*`
  commands are hard-excluded from the agent's visible surface), native
  mass-shift ledger and MS2 discrimination views. Status: **implemented**
  (0.10.0-beta, `664e9ac` + `966f5fc`); included in the vitest baseline
  below.
- **Conversation render & rail rework (0.11.0-beta)** —
  `design/FRONTEND-INTERACTION-MAP.md` §2/§4/§6: the transcript render walk
  lives in one place (`fold-items.ts` single ordered walk +
  `ContentBlockView.vue` single block→renderer dispatch; text interleaves
  in place between per-run collapse panels); `TaskTreeCard` is the turn's
  `bubble-plan` block; the right rail is a drag-resizable split
  (persisted `agentTabsWidth`) hosting nine tab kinds incl. the new
  selection-flow `agent-side-chat`; `/export` embeds workspace-cited media
  as data URIs (12 MB/file · 64 MB total, sandboxed iframes). Status:
  **implemented**; pinned by `fold-items.test.ts`, `ProcessFold.test.ts`,
  `agent-live-blocks.test.ts`, `agent-side-chat.test.ts`,
  `conversation-export.test.ts`.
- **Model/provider seam & usage accounting** —
  `design/MODEL-PROVIDER-SEAM.md`: capability resolution precedence with
  ceiling semantics, the atomic-write seam, custom providers + endpoint
  validation + typed connection verdicts, per-model pricing, the 20k-entry
  FIFO ledger, and main-process aggregation for StatisticsPanel and
  ContextUsagePanel. Status: **implemented**.
- **Web sharing** — `design/WEB-SHARING.md`: invitation-based collab mirror +
  read-only files with hot revocation. Status: **implemented**; auth/
  containment/collab/invites unit-tested (12) + desktop e2e; the not-built
  list (control tier, per-guest identities, LAN TLS, subagent share opt-in)
  lives in that document.
- **Desktop packaging & install lifecycle** — `design/DESKTOP-PACKAGING.md`:
  per-user installer with interactive force-reinstall, data-root selection
  (writable + space-free), bundled CPython with online `uv sync`, relocated-
  install venv rebuild, self-sufficient packaged bash, splash-to-painted-UI
  boot reveal, license surface, update channel, node-catalog seed, Windows
  job-object process ownership. Status: **implemented** (0.10.0-beta); verified by
  `scripts/release/verify-install.ps1` (incl. `-EngineSmoke`),
  `verify-data-root.cjs`, and `backend_manager.test.cjs`.
- **Wiki** — `design/KNOWLEDGE-WIKI.md`: workspace `wiki/` + System wiki
  behind the virtual `system-wiki/` prefix, wikilinks, backlinks. Status:
  **implemented**.
- **Removed features** (so their absence is not read as a gap): experience
  genes (field-note injection, `gene.*` commands — shipped dark without
  demonstrated benefit; full implementation + design docs archived on branch
  `archive/experience-gene`) and Canvas (`components/blocks/**`,
  `CanvasDocument`, `@canvas` mentions, `canvases/` seeding — the knowledge
  wiki is the one remaining authored surface; Navigator is runs/wiki/files).

### Quality baseline (verification snapshot)

- vitest 195 test files / 1558 tests: 1555 green, 3 red
  (re-measured 2026-10-12 on the 0.11.0-beta working tree; the red trio is
  the settings-routing failure recorded under Open defects); desktop e2e 5/5 (one merged
  Electron journey: sliding door, group toggles, real Agent chain,
  permissions, manual /compact, runs reload, failure trio, prompt queue +
  stop-keeps, blocked one-tap, /export HTML+PDF, cost guard, log-agreement).
  Spec-side conventions: the /export `<title>` assertion expects the session's
  FIRST user message; blocked-card steps anchor to the last VISIBLE card (the
  transcript is virtualized).
- vue-tsc + typecheck:electron 0 errors; `check:i18n` 1151 leaf keys ×3
  locales, zero dead keys; `check:reachability` 361/361 modules;
  prompt assembly 7 green; `check:contrast`
  rides the build chain; `pnpm run lint` clean outside two recorded in-flight
  files; zero-dependency pre-commit gate (`githooks/pre-commit`).
- Bundle: first-load 505.1 KB / 700 KB budget; entry chunk statically imports
  only vendor-vue + vendor-element-plus; plotly/mermaid/ag-grid/xlsx/katex and
  document surfaces are dynamic chunks; locales split (en-US static fallback,
  zh-CN lazy pre-mount). Cold-load: FCP/LCP ≈0.17s, 4×CPU-throttled ≈0.66s,
  CLS 0.001, TBT 15–25ms, 941KB/10 requests.
- `scripts/scan-dead-exports.mjs` companions the reachability gate at
  export/i18n-key granularity (the ~300 dead exports it lists are pre-existing
  type-export documentation debt, not runtime).

## Backend (tdease-backend)

- FastAPI + SQLite + SSE. API: runs_v2, files, nodes, capabilities, uploads,
  workspace_roots. Contracts: `spec/WORKFLOW-RUN.md`,
  `spec/FAILURE-CONTRACT.md`. Root suite 333 passed / 1 skipped at the
  2026-10-12 measure (`uv run --project tdease-backend pytest tests/`); the
  Run-service Phase-1 and engine-integration tests named below were added
  after that measure (the full-suite re-measure rides the run script);
  the four engine/result contract+E2E files re-ran green 2026-10-14
  (15 passed). `ruff check`
  + `ruff format --check` clean (rule set pinned; import-order-sensitive
  snakemake imports documented in pyproject).
- **Run service Phase 1 — trusted execution loop** —
  `design/BACKEND-RUN-SERVICE.md` §2 (Phase 1): one lifecycle interpreter
  (`LifecycleState`; SQLite projector keeps derived tables only, status cache
  written by the command module), Run Command Module `submit`/`queue`
  (journal-first commit order, journal-keyed idempotency) with the global
  queue ticket (mint log + `queued_ticket`, schema v5; one ordering across
  index and filesystem fallback), execution lease
  (`runs/<id>/.runtime/lease.json`, worker identity + stage) replacing the
  bare `claimed` flag with `begin_execution` (run.started + lease as one
  step, under the run command lock), `finish` as the only terminalizer
  (re-fold + manifest-coverage rescue inside the lock; command-locked
  `cancel` for the QUEUED branch), `reconcile()` as the single recovery pass
  (API lifespan + worker loop, global lock; live lease → untouched, dead
  lease → kill tree + exactly one terminal; §2.3 pointer completion; legacy
  `claimed` one-pass migration), read-only CAS sealing with store-walk
  migration, and upload staging markers protecting in-flight digests from
  GC. Status: **implemented**; pinned by `test_run_status_cache.py`,
  `test_run_submit_crash_safety.py`, `test_execution_lease_reconcile.py`,
  `test_cas_sealing_and_staging.py`, `test_recovery_convergence.py`.
- **Engine semantics** — `spec/WORKFLOW-RUN.md` §1 (+ its subsections) is the
  live contract and the feature description: serial execution slot, compute
  envelope (Backend-owned; threads clamped observably, memory hard floors),
  node binding by config injection with shared immutable **read-only** inputs,
  no status locks a definition, journal-first submission semantics
  (same-key/different-content = new revision queued), global-ticket
  execution-scoped queue/cancel/identity, execution-lease ownership +
  recovery, worker supervision + stage-tagged visibility,
  `<pid>:<create_time>` process identity, verbatim
  (CRLF) text comparison, `rules.smk`-as-contract node packages with
  `bin_dir` override. Status: **implemented**; pinned by
  `test_run_shared_tree_revisions_e2e.py`,
  `test_worker_failure_visibility.py`, `test_run_snakefile_text.py`,
  `test_run_revision_policy.py`,
  `test_package_digest_memo_invalidates_on_content_change`.
- **Result publication is attribution, not discovery** —
  `spec/WORKFLOW-RUN.md` §"Results belong to the revision that produced
  them": the manifest publish set is the ran definition's explicit
  `result_specs` + the engine's execution record
  (`.tdease/execution-outputs.json`, written by `engine_runner.py` from its
  own DAG at the end of a successful execute-mode run; up-to-date resume
  jobs excluded) + previously claimed manifest entries kept verbatim (dead
  rules' outputs stay published; after a rerun clears the live manifest, the
  newest retained revision anchors continuity). No rule-all parsing
  (`declared_outputs.py` deleted), no `results/**` sweep, no run-tree scan;
  `provenance_source` records `engine_execution` vs
  `execution_record_missing`. Status: **implemented**; pinned by
  `test_result_attribution_e2e.py`,
  `test_run_shared_tree_revisions_e2e.py`.
- **Job-event relay discipline** — the adapter forwards engine job-event
  frames over a byte cursor that moves only past complete lines
  (`read_complete_lines_from`): a half-written line is polled over until the
  writer finishes it, the tail is drained after engine exit, and a malformed
  frame is reported loudly (runtime error record + warning event) without
  blocking the frames behind it. Engine output is relayed verbatim (the
  output-branding rewriter is deleted); lifecycle `run.*` events belong to
  the command module alone — the adapter keeps job/task/graph events and
  refuses an attempt whose open journal range does not name its revision and
  mode. Status: **implemented**; pinned by `test_job_event_relay_e2e.py`.
- **Engine integration convergence** — the embedded Snakemake integration
  lives behind exactly one file (`src/execution_runtime/engine_runner.py`):
  one DAG build per engine process (the private `_prepare_dag`/`_build_dag`
  run with `Workflow.execute()`'s own arguments, mirrored off the single
  `ExecutionSettings` instance, then pinned to no-ops so the projection, the
  resource assertion and the executor consume this one graph), engine state
  redirected at the `FilePersistence` seam + the `.snakemake` junction
  alias, and the version contract test locks every internal touchpoint
  (import paths, persistence seam, single-build surface, job-level DAG
  members, LogEvent names, mirrored settings fields) so a dependency upgrade
  that moves any of them turns red pointing at `engine_runner.py` — one
  integration location and one locked dependency set per upgrade. Status:
  **implemented**; pinned by `test_engine_integration_contract.py`.
- **Snakemake is the live orchestrator** (`snakemake==9.23.1`): every Run
  executes through `SnakemakeAdapter` + `engine_runner.py`; contract tests in
  the root suite.
- **Per-launch bearer authentication** — `spec/WORKFLOW-RUN.md` §2:
  bootstrap secret → token pair (owner + agent without `run:purge`),
  dual-principal exchange, fail-closed suite + backend_manager e2e (anonymous
  401 / owner-token 200). Status: **implemented**.
- **Rainy-day hardening** — `design/BACKEND-HARDENING.md` owns the record and
  the residual-risk/follow-up list (Origin gate, cancel-in-claim-window,
  orphan-tree kill, disk-full drain, keepalives, atomic projection writes).
  The 2026-10-13 execution-lease rewrite supersedes its engine-liveness
  recovery posture (follow-up #6's dead-worker case is now reconcile's lease
  rule; the hung-engine-with-live-worker case remains that follow-up's
  residual). Status: **implemented** (residual risks are declared
  acceptances there).
- **The test suite is e2e-first and backend-scoped**: skill-internal script
  layers are exercised by the skills' own tooling; the root suite guards the
  run chain end to end (submission/revision/recovery, results/manifest APIs,
  node binding, hostile-path engine e2e, zero-copy rules, auth/containment,
  docs-skill contract).
- **Node catalog**: five nodes registered, zero catalog errors: `toppic` 1.8.1
  (authoritative), `msconvert`, `informed-proteomics` (MSPathFinderT/ProMex),
  definition-only `pride`/`topindex`. Definition layer git-tracked; binaries
  never are (inventory + provenance: Run records; `docs/NODES.md` archived 2026-09-29).

## AI capability submodule (tdease-ai-capability)

- **Rust kernel `tdeasenexus-toolbox`**: 24 subcommands (batch forms
  throughout: `--scans-input`/RT-window/scan-range scan selection and
  saved spectrum-observation JSON input on `fragment`; batch forms on
  `envelope-windows`, `refine-shift-batch`, unimod and `isotopic-batch`;
  `spectrum --mode product` accepts `--scans` scoping; the fragment
  evidence artifact is the same CLI envelope as stdout — the
  discriminating-ion verdict travels in the bounded stdout, and one
  measurement written to two destinations is byte-identical); the
  evidence lattice
  `mass ⊂ composition ⊂ identity` enforced by CLI gates. Contract:
  `spec/RUST-MS-CONTRACT.md` (incl. `resolve-shift` scoring, site-scoped
  neutral losses, 10 ppm fragment tolerance, raw-MS2 error-map matching with
  explicit `fragmentStatuses`, `unimod solve --fixed-mod` semantics);
  designs: `RUST-KERNEL-ARCHITECTURE.md`; the lattice proposal is archived
  (`archive/docs-prune-2026-10-12/docs/design/hypothesis-evidence-lattice.md`)
  — the binding lattice is RUST-MS-CONTRACT's Principle.
  Status: **implemented**; suites green (lib 122, cli_contract 71; raw
  error-map and msalign E2E; 201 total, re-measured 2026-09-29); clippy `-D warnings` (4 waived categories) +
  fmt + 208 tests wired as the CI `rust-kernel` job (re-measured 2026-10-18).
- **IsoForma** — `design/ISOFORMA-ARCHITECTURE.md` is the feature
  description (selection/pooling/estimation boundaries, `--feature-scan-map`,
  isotope gate, beta-vs-least-squares, declared category models). Status:
  **implemented** as designed. Chlamydomonas record statuses: the archived
  attempt-56 rerun outcome is a closed benchmark record (its counts are not
  contract); the certified basis for the paper's Chlamydomonas figures is the
  five-sample rerun (`results/data/certified-cases/chlamy-five-sample-rerun/`,
  runtime-validated 2026-09-05; 19 fits / 80 fractions retained). The
  gate/rung test instability stays in Open defects.
- **spectral-evidence**: one entry `spectral.py`, three verbs — `annotate`
  (msalign leads view, carries no existence verdict), `measure` (the
  criterion: every model measured on one shared kernel extraction, verdict
  card as stdout — three difference kinds separated, per-model kernel
  states, full figure set written by default, `--no-figures` for
  measurement only; mixed-backbone model lists degrade loudly — independent
  per-model measurements with `sharedBackbone`/`ionComparisonAvailable`
  false, positional comparison off, never refused) and `show` (named
  isotope windows from a card; states pulled from the full evidence
  artifact, theory batched via `fragment-theoretical --models`). MS1
  numbers come from the kernel (`envelope-windows` + `fit-envelope
  --pairs`), never recomputed in Python; `_shared/kernel_io.py` reads
  theory artifacts in the kernel `read_anchored`'s three shapes (full
  envelope, batch slice, bare anchored JSON).
- **Skill library (16)**: chart-forge (runtime figure compiler —
  `design/SKILL-D3-RENDERING-ARCHITECTURE.md`), evolution (the one gate for
  every accumulation tier), isoforma, massql, ptm-database, spectral-evidence,
  structure-evidence, packages (`design/PACKAGE-DISTRIBUTION.md`),
  tdeasenexus-docs (system doctor + read-only `scripts/doctor.py`),
  tdp-copilot (unknown-shift controller ending in the star-rated human-verdict
  summary — the agent never adjudicates; `design/MASS-SHIFT-LOOP.md`),
  tdp-opensearch (first-pass census + families; compact batch profile in
  `design/MASS-SHIFT-ASSIGNMENT.md`), tdp-execution, toppic-suite, toppicr-py,
  unidec (headless), workflow. Skill-layer E2E anchors run in the parent-repo
  suite on git-tracked real-data fixtures.
- **Scientific Skill routing: partial** — Copilot owns discovery-to-measurement
  continuation and completion; OpenSearch returns a bounded attention set;
  Spectral Evidence owns measurement gates and standard figures. Shared prompts
  own language and inline presentation; conditional model/command/decision detail
  lives in referenced files. The former automatic batch-adjudication descriptions
  in `MASS-SHIFT-LOOP.md` and `MASS-SHIFT-ASSIGNMENT.md` were stale as runtime
  instructions and are explicitly historical. Autonomous continuation under the
  consolidated instructions still needs a fresh production AgentRuntime trajectory;
  renderer E2E alone does not validate model adherence.
- **System assets**: `reference/` (unimod.sqlite, psimod.sqlite, knowledge.db,
  PSI-MOD.obo), wiki seed corpus; `prompts/internal/` = the 15 frozen prompt
  artifacts (per-mode output styles; `terminology.md` is the canonical
  vocabulary contract read by BOTH mindsets) — assembly contract in
  `spec/AGENT-CONTRACT.md` §5.

## Open items (live)

- **Desktop↔Backend version handshake** (audit 2026-10-12, resolved
  2026-10-13): `/ready` carries the backend version (`app/version.py`
  single constant; a test pins it to pyproject). The Client connect path
  checks `>=0.2.0 <0.3.0` after the protocol gate and fails closed into the
  existing `incompatible` phase with an error naming both versions
  (missing version = backend too old to handshake); local and remote
  backends flow through the same probe. Range moves only with a desktop
  release.
- **Orchestrate scripts run in the Electron main process** (audit
  2026-10-12, resolved 2026-10-13): `workflow-runtime.ts` executes
  model-authored scripts inside a `node:vm` realm (PTC's pattern — one
  host bridge key, self-deleting bootstrap, JSON-only boundary): no
  `process`/`require`/constructor-chain escape, so backend bootstrap
  secret and provider keys are unreachable; `agent`/`parallel`/`pipeline`/
  `phase`/`log` stay host-side closures and `args`/`cwd`/`budget.total`
  cross as JSON. No wall-clock timeout (runs legitimately await
  sub-agents); maxAgents + AbortController remain the levers.
- **Node-catalog seed provenance** (pack-side and ownership-side, both
  resolved 2026-10-13): the shipped zip is pinned by the committed
  `scripts/release/node-seed.manifest.json` — `pack-node-seed.ps1` packs
  exactly the manifest entry list (explicit include, `localOnly` never ships)
  and fails on catalog residue, so the shipped SET is a function of the
  commit, not of `data/`. Reseed ownership is class-based
  (`electron/node_catalog_seed.cjs`, manifest schemaVersion 2): packages
  (dir + `rules.smk`, non-`_` name) replace on fingerprint change;
  `_template`/`README.md` are digest-guarded — user-modified entries skip
  with `nodes.seed-skip-modified` and are never overwritten (skip-forever
  until the user removes their copy); v1 manifests migrate in memory without
  wiping.
- **Drive-root data root survives uninstall** (audit 2026-10-12, resolved
  2026-10-13): provider keys no longer live in `settings.json` —
  `electron/credential-store.ts` keeps them safeStorage-encrypted (DPAPI) in
  `credentials.json` beside settings.json, fail-closed when encryption is
  unavailable (no plaintext fallback exists), with transparent legacy
  migration on first access; settings.json keeps only an `apiKeyStored`
  marker and the key never crosses IPC. The uninstaller shows a
  non-destructive note naming the possible `<drive>:\TDEaseNexus-Data`
  residue (the folder holds workspace data, not plaintext secrets).
- **Backend bootstrap secret transits spawn env** (audit 2026-10-12,
  resolved 2026-10-13): the desktop now writes the secret to the backend's
  stdin immediately after spawn (single write + EOF, EPIPE-tolerant) and no
  longer puts it in the environment; the backend reads stdin first line,
  falling back to the env var (one-release compat for a previous-generation
  desktop) and finally to the config file, so the secret never sits in any
  process env block. Channel decision is diagnosable from `backend.log`
  (`backend.secret-channel`).
- **Desktop process ownership**: a forced-kill desktop E2E asserting the
  whole child tree is still missing
  (`design/AGENT-LIFECYCLE.md` §Crash residue; the Job Object shim itself is
  shipped and verified on-machine — `design/DESKTOP-PACKAGING.md`).
- **Hardening follow-ups**: host-side whitelist editor (policy is
  hand-authored); child-approval round-trip E2E; real-LLM no-polling
  trajectory audit; a live-model PTC smoke (the one unclosed verification
  from the archived PTC reliability comparison — needs provider credentials);
  SMK sandbox isolation; web-sharing control tier,
  per-guest identities, LAN TLS (list owned by `design/WEB-SHARING.md`).
- **Deferred design**: MOTIF-PRIOR (homologous-protein motif priors for PTM
  exploration) was never frozen or implemented; archived 2026-10-12 at
  `archive/docs-prune-2026-10-12/docs/design/MOTIF-PRIOR.md` — revive from
  there if the direction returns.
- **Frontend UI gaps** (from `design/FRONTEND-INTERACTION-MAP.md` §10/§11,
  moved here 2026-10-12): `MarkdownContent.vue`'s `stream-tail-pulse` has no
  reduced-motion static substitute (covered only by the global `*` fallback —
  trailing graphemes could stop in an invisible state); ThinkingBlock /
  EvidencePanel lack explicit ARIA (`<details>` implicit semantics vs a custom
  summary); the global `Ctrl+=`/`Ctrl+-`/`Ctrl+0` zoom keys have no typing
  guard (declared tradeoff, but `Ctrl+0` resets browser zoom).
- **Skill-side debt**: checklist v3 split; ledger schema convergence;
  unimod.sqlite builder HTML unescaping; repoint the paper's
  `make_census_marks.py` to the rebuilt ledger; identity-layer magic
  numbers await statistical grounding.
- **Strategy** (set 2026-08-18): rendering optimization, skill
  optimization, mass-spec knowledge system, evidence lifecycle
  management, skill-library communityization.
