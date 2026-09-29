# Status — what is actually built

> Snapshot only: what is true today, verifiable against code and tests.
> No history, no comparisons, no process narrative — the record lives in git
> history alone. Feature descriptions live in their owning `spec/`/`design/`
> documents; each line here is a status verdict plus the pointer and the
> pinning test. Status vocabulary: `docs/README.md`. Last rewrite:
> 2026-09-29 (version axis to 0.10.0-beta, repo org to Computational-TDMS,
> quality baseline re-measured, chlamy record statuses reconciled).

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
  gate/rung test is outcome-unstable (input-state drift undiagnosed — red,
  and its recorded counts are benchmark records, not contract).
  (`test_focused_skills_do_not_embed_acceptance_case_answers` was resolved
  2026-09-19: the acceptance-case structure had slipped into
  structure-evidence's reference data as untracked files — deleted; the
  governance test now also scans that skill and `.json` data files.)

## Shape

- **TDEaseNexus (desktop, 0.10.0-beta)**: AI-first TD-MS analysis desktop workbench.
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
  per-section Settings entries), the Settings document (nine sections, incl.
  the permissions overrides editor, remote-backend auth, network proxy,
  diagnostics), the Agent page (composer, prompt queue, transcript, outcome
  rendering, context gauge, conversation export, streaming render pipeline,
  citation/artifact rendering, the right-docked sidebar as a second view of
  the same conversation), and the Workbench documents (file viewers incl. the
  16 visualization viewers with cross-viewer selection linking, wiki, welcome
  guide). Status: **implemented**. Pinned by the desktop Playwright suite
  (5/5 green, one merged journey) and the vitest suite below.
- **Studio business core** — `design/STUDIO-FRONTEND-BUSINESS-LOGIC.md`:
  module boundary, twelve command families (exposure metadata fail-closed;
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
  job-object process ownership. Status: **implemented** (1.0.2); verified by
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

- vitest 189 test files / 1519 tests green (re-measured 2026-09-29 on the
  0.10.0-beta tree, incl. the agent-transparency work); desktop e2e 5/5 (one merged
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
  `spec/FAILURE-CONTRACT.md`. Root suite 327 passed / 1 skipped; `ruff check`
  + `ruff format --check` clean (rule set pinned; import-order-sensitive
  snakemake imports documented in pyproject).
- **Engine semantics** — `spec/WORKFLOW-RUN.md` §1 (+ its subsections) is the
  live contract and the feature description: serial execution slot, compute
  envelope (Backend-owned; threads clamped observably, memory hard floors),
  node binding by config injection with shared immutable inputs, no status
  locks a definition, execution-scoped queue/cancel/identity, results belong
  to the revision that produced them, worker supervision + stage-tagged
  visibility, `<pid>:<create_time>` process identity, verbatim (CRLF) text
  comparison, `rules.smk`-as-contract node packages with `bin_dir` override.
  Status: **implemented**; pinned by `test_run_shared_tree_revisions_e2e.py`,
  `test_worker_failure_visibility.py`, `test_run_snakefile_text.py`,
  `test_run_revision_policy.py`,
  `test_package_digest_memo_invalidates_on_content_change`.
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
  Status: **implemented** (residual risks are declared acceptances there).
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

- **Rust kernel `tdeasenexus-toolbox`**: 22 subcommands; the evidence lattice
  `mass ⊂ composition ⊂ identity` enforced by CLI gates. Contract:
  `spec/RUST-MS-CONTRACT.md` (incl. `resolve-shift` scoring, site-scoped
  neutral losses, 10 ppm fragment tolerance, raw-MS2 error-map matching with
  explicit `fragmentStatuses`, `unimod solve --fixed-mod` semantics);
  designs: `RUST-KERNEL-ARCHITECTURE.md`, `hypothesis-evidence-lattice.md`.
  Status: **implemented**; suites green (lib 122, cli_contract 71; raw
  error-map and msalign E2E); clippy `-D warnings` (4 waived categories) +
  fmt + 201 tests wired as the CI `rust-kernel` job.
- **IsoForma** — `design/ISOFORMA-ARCHITECTURE.md` is the feature
  description (selection/pooling/estimation boundaries, `--feature-scan-map`,
  isotope gate, beta-vs-least-squares, declared category models). Status:
  **implemented** as designed. Chlamydomonas record statuses: the archived
  attempt-56 rerun outcome is a closed benchmark record (its counts are not
  contract); the certified basis for the paper's Chlamydomonas figures is the
  five-sample rerun (`results/data/certified-cases/chlamy-five-sample-rerun/`,
  runtime-validated 2026-09-05; 19 fits / 80 fractions retained). The
  gate/rung test instability stays in Open defects.
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

- **Desktop process ownership**: a forced-kill desktop E2E asserting the
  whole child tree is still missing
  (`design/AGENT-LIFECYCLE.md` §Crash residue; the Job Object shim itself is
  shipped and verified on-machine — `design/DESKTOP-PACKAGING.md`).
- **Hardening follow-ups**: host-side whitelist editor (policy is
  hand-authored); child-approval round-trip E2E; real-LLM no-polling
  trajectory audit; SMK sandbox isolation; web-sharing control tier,
  per-guest identities, LAN TLS (list owned by `design/WEB-SHARING.md`).
- **Skill-side debt**: checklist v3 split; ledger schema convergence;
  unimod.sqlite builder HTML unescaping; repoint the paper's
  `make_census_marks.py` to the rebuilt ledger; identity-layer magic
  numbers await statistical grounding.
- **Strategy** (set 2026-08-18): rendering optimization, skill
  optimization, mass-spec knowledge system, evidence lifecycle
  management, skill-library communityization.
