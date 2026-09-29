# Mass-Shift Assignment Methodology: One LOOP, Everything in Its Place

> Status: current controller design below; the earlier batch-pipeline proposal is
> retained separately as historical design, not executable workflow or current status.

## Current investigation ownership

`tdp-copilot` owns the scientific loop: anchor scope -> construct complete/open
hypotheses -> measure and present evidence -> interpret -> continue or finish.
`tdp-opensearch` supplies a bounded, source-linked attention set, and
`spectral-evidence` supplies symmetric measurements and standard evidence figures.
A discovery step ending does not end an authorized investigation: Copilot advances
the selected groups without a routine tool-selection question. An explicitly
batch-only request ends with the discovery report. Selection never assigns chemistry.

Each rule has one operational owner: workflow/completion in the Copilot entrypoint;
model inheritance in its model-continuity reference; measurement gates in Spectral
Evidence; commands in tool recipes; figure mapping in the visualization reference;
inline presentation and language in session prompts; report layout in the summary
template. Scientific honesty remains the shared claim boundary. References are read
at the relevant action boundary rather than preloaded as a second workflow.

The completion condition is a measured requested comparison or a named evidence
limit, not chemical certainty. Available useful measurements run before declaring
that limit. Every standard evidence figure is presented with its interpretation;
rendering failure is distinct from measurement failure. Only the human assigns the
final chemistry verdict. Current implementation and validation are in `STATUS.md`.

## Historical batch-pipeline proposal

The remainder before Alternatives considered preserves the earlier methodology,
including proposed L1-L10 batch automation, legacy file names and automatic state
transitions. These are not requirements to run retired scripts, generate legacy
ledgers, or assign `explained`. Current skill contracts above supersede those
operational instructions; this history records their original motivation.

> Original methodology (2026-08-20, revised 2026-08-21). The goal in one sentence:
> **mine out every mass shift** — the routine ones are consumed cleanly by batch
> mechanisms; only what batch cannot consume reaches single-event deep dives. Nothing
> may silently vanish, and nothing may be upgraded without evidence.

## Core goal

Every mass shift TopPIC open search emits (clustered or singleton, MS2 or MS1-only)
must ultimately land in one of three chemical states, consistent with its evidence:

1. **explained** — a known composition closes (component sum = shift, within
   tolerance) and the evidence supports that composition;
2. **candidate** — there is a candidate, but composition, site, or competing
   explanations remain unresolved;
3. **unexplained** — no reliable composition; the precise mass, PrSM count, RT,
   protein origin, and next-evidence needs are retained.

Between states there is exactly one upgrade path: **new evidence**. Mass closure, top
score, or having a name in the library — none of these alone constitutes an upgrade.

**The three-axis scale
reference runs parallel to the three
states; they do not substitute for each other**:

- **Smith proteoform level** — identification completeness (four ambiguity classes:
  gene/sequence/ptm_identity/ptm_localization). **Changes with the mining**: new
  evidence removes an ambiguity class, and only then does the level rise.
- **Evidence confidence** — the sufficiency of a single candidate's evidence (identity
  + localization + margin). **Decides whether to go deeper**: 5/4 mean information is
  insufficient and depth is waste; 1/2 mean further discrimination is possible.
- **E-value zone** — spectrum-match quality (Gold/Silver/Trash); describes only the
  match itself.

## The funnel: from high to low volume, from shallow to deep

All mass shifts enter through **shallow batch mechanisms**; only what batch cannot
consume flows toward **deep single events**. Every layer must be a batch tool, reducing
entry counts layer by layer:

| Layer | Question | Batch mechanism | Outflow |
|---|---|---|---|
| L1 data ingestion | What is the raw data? | Entity-layer construction (`entities.py`): parses the TopPIC three tables into objects in one pass; **full ProForma parsing** (fixed modifications, `(RES)[+mass]` unknown-modification segments); **cross-observation integration**: multiple proformas of the same modification event deduplicated + site-interval cross-narrowing (no intersection marked ambiguous; evidence not lost) | full observation chain + integrated events |
| L2 feature dedup | Duplicate observations? | physical-verification merging (merge only when mass/RT/charge/protein origin agree); **the same mass shift across proteins is never merged** — mass clusters are just numeric indexes | deduplicated observation chain |
| L3 extraction + calibration | What is the mass shift? | extract mass offsets from proteoform/PrSM, auto-calibration (raw/calibrated dual values coexist; after calibration, no re-clustering by mass) | observation chain with dual masses |
| L4 ladder collection | High-frequency signals? | MS1 ladder/family: same RT window, same carrier, N×single-modification spacing ladders (families are the first source of high-frequency modifications) | ladder/family members |
| L5 UniMod initial assignment | Routine modifications? | gated batch initial assignment: **a single strong candidate with all others far away → directly resolved**; multiple candidates → competition retained, no forced naming (initial assignment is not necessarily reliable; only a strong single candidate is trusted) | resolved / competing candidates |
| L6 library induction | Which library to decompose with? | induce a sample-level modification library from evidence: modifications with **very high prsm, simply high-frequency, or family-based (also high-frequency)** enter the library | induced library |
| L7 prsm decomposition | Can it close? | `batch_prsm_refine.py` decomposes in batch with the induced library (TopPIC localization intervals as priors, fixed modifications pinned) | explained / residual recursion |
| L8 recursion | What is the residual? | `residual_recursion.py` decomposes the residual again | closed / reproduced core |
| L9 core reproduction | Is the reproduced mass real? Where? | `core_verify.py` batch peak existence + localization | true localization / unlocalized / fragment-absent |
| L10 degeneracy | Both candidates close — which one? | `dispatch/execute_discriminators.py`, `envelope_batch.py` batch discrimination | winner / still ambiguous |
| L11 single events | the few batch cannot consume | `tdp-copilot` explores one source-linked proteoform, proposes complete/open hypotheses, and delegates only explicit measurement questions to `spectral-evidence` | hypothesis ledger + evidence/knowledge summary for human verdict |

**Rules**: batch first at every layer, never skip layers; every item reaching L11 must
carry the complete L1-L10 ledger state. The point of batch mechanisms is to **reduce
complexity and remove duplication, pressing the items needing deep analysis to a
minimum** — the L11 entry count is the measure of process quality.

Why this order (why calibration precedes interpretation, library induction precedes
decomposition):
- **Calibration precedes all chemical interpretation** — interpretation must stand on
  corrected masses, otherwise everything stands on drift; calibration corrects only the
  mass axis and creates no new clusters.
- **Ladder collection precedes initial assignment** — families are one prior source for
  initial assignment (a ladder with the same carrier and RT is itself a decomposition
  hypothesis) and are evidence of "high frequency".
- **Initial assignment precedes library induction** — initial-assignment results
  (which candidates have high prsm / appear frequently) are the evidence for library
  entries; strong-single-candidate results go straight into the library.
- **Library induction precedes prsm decomposition** — decomposition uses the library
  induced from evidence, not one dictated a priori; the library is a mid-process
  artifact, rebuildable at any time.

## The LOOP (three steps per cycle; each cycle must complete)

### 1. Explore and adjust the scientific understanding (change code/process)

- The idea is unchanged: **generic + atomic**. Each component does one commonly needed
  TDP thing (census, cluster, solve, localize, envelope, fragment compare); no
  special-purpose branches grow for individual cases.
- Optimization targets: the flow and component details of the python orchestration
  scripts, and the scoring semantics of the Rust kernel.
- Each change's verdict terms and reasons went into `docs/EXPLORATION-LOG.md`
  (archived 2026-09-29 to `archive/docs-cleanup-2026-09-29/`; new verdicts go to
git history and case RECORD files); read
  before changing; excluded paths are not re-run.

### 2. dryrun

- Run the full chain on real workspace data (not unit tests, not toy fixtures).
- Authoritative artifacts land in `data/backend/runs/<sample>-annotated/`
  (histone48-annotated, chlamy-annotated, soybean-annotated); the ledger =
  assignment-checklist.csv + evidence-ledger.jsonl + the residual queue; measurement
  artifacts in the same directory.

### 3. Analyze the data changes (three questions per cycle, all mandatory)

1. **Coverage**: are all mass shifts covered? Any shift silently vanishing = a defect.
2. **Convergence**: is the L11 deep-dive queue shrinking? Does every item have a clear
   "why it is its turn"? An entry count that won't drop = a batch-mechanism defect.
3. **unexpected inventory**: are shift-specific vs shared unexpecteds separated? Shared
   ones point to systemic problems (calibration/clustering parameters); unique ones are
   the scientific-discovery candidates.

The three answers are written back to that cycle's EXPLORATION-LOG record. **Forbidden**
to run without analyzing.

## Routing rules (who goes to which layer)

| Evidence state | Path |
|---|---|
| ≥1 qualifying PrSM (E-value ≤ 1e-3, Silver or better) | L5 initial assignment → L6 library induction → L7 decomposition → L8 recursion → L9 localization/reproduction |
| MS1-only / no qualifying PrSM | L4 ladder/family → L9 peak existence (at the MS1 level) + envelope discrimination (MS1 evidence, not impersonating sites) |
| Competing candidates remain after batch discrimination | L11 single-event deep dive, evidence chain attached |

The E-value zone decides only spectrum-match quality, never chemical assignment on its
own.

## Natural flow (physics first, corrected 2026-08-20)

Lesson: inventing a parallel "verdict layer" fabricates assignments (a non-closing
combination was once crowned while the correct decomposition had already been
computed). Nature has exactly one criterion chain:

1. **Mass closure is the only entrance to "explained"**. Only component sum = shift
   (within tolerance) counts as a completed decomposition; partial decomposition is an
   intermediate state whose residual is the next round's input — **residual recursion,
   never crowning**.
2. **Decomposition material divides physically by evidence type**: the MS1 feature is
   a first-class citizen (mass, RT, charge, envelope shape; family-ladder spacing is
   itself a family-level decomposition hypothesis); MS2 only annotates the subset that
   got fragmented; TopPIC proforma intervals are site priors and fixed modifications
   are facts; isotope shape/halogen doublets/neutral losses are element-identity
   evidence.
3. **Process order**: MS1 family mining (full space) → TopPIC inheritance → gated
   batch UniMod decomposition (a single strong candidate resolves directly) →
   closed-loop combination competition under interval constraints (MS2 fragments fix
   composition and site) → residual recursion → degeneracy with element-level
   discrimination (envelope/doublet/neutral loss) → whatever remains stays an
   explicit numeric residual; L11 hands the comparison to a human.
4. **The chemical-state vocabulary has exactly three values**: `explained` /
   `candidate` / `unexplained`. Everything else (MS1-only, single PrSM, site-interval,
   fragment-absent, near-neighbor candidates...) is an evidence field, not a state. The
   three-axis scale (Smith/confidence/E-value) is the measurement layer, separate from
   the state layer.

Automation tools serve only this chain's nodes and must not invent verdict semantics.

## The three discrimination archetypes of deep dives (canonical, anonymized)

Deep dives are not generic re-runs; each unexpected is matched to its evidence shape
(shapes named by evidence structure, not by case name):

1. **Composition puzzle** — many mutually competing combination candidates. Deep dive
   = reference-library/homologous-sequence queries (motif conservation, terminal
   patterns), followed by site fragments only when a sample measurement can change
   the comparison. The result is a retained hypothesis set, not an agent assignment.
2. **Element puzzle** — a continuous family (a modification band with progressive
   spacing). Deep dive = `tdp-copilot` proposes the repeated increment and
   `spectral-evidence` measures envelope shape/registration constancy across
   comparable rungs. The output is a family measurement, no site claim or verdict.
3. **Site puzzle** — localization converges to a few possibilities + a residual
   unknown shift. Deep dive = `tdp-copilot` hypothesizes the residual, then
   `spectral-evidence` performs the dual-hypothesis MS2 error-map comparison on
   identical observations and settings.

All three share the same base (localize/envelope/fragment compare); only the
evidence organization changes.

## Alternatives considered

- **Add stronger copies of the same rule to every Skill and prompt**: rejected
  because contradictory stop conditions and repeated constraints obscure the next
  action. Keep one rule owner and route to its details at the action boundary.
- **Always ask the user to choose a discovery candidate before measuring**: retained
  only for a discovery-only request or a genuine scope decision; it needlessly stops
  a Run-wide investigation whose bounded attention set is already authorized.

- **Write a dedicated deep-dive script per case**: fails the atomicity principle —
  cases only multiply, dedicated branches add a maintenance surface per case, and they
  cannot be reused by the Agent as a generic capability.
- **Split hypothesis generation into a peer Skill beside measurement**: rejected
  because proposing and expanding hypotheses is the controller's central reasoning
  loop, and a database lookup may answer the immediate question without a second
  workflow. Only spectral measurement is split out as a bounded subskill.
- **Mass-closed-equals-assignment (the mass_closed fast path)**: fails on defects
  exposed in real runs — closure proves conservation, not localization; the path was
  deleted (EXPLORATION-LOG E7).
- **Use TopPIC proteoform grouping for near-neighbor merging**: fails on verified fact
  — TopPIC groups proteoforms by a single shift value, with no near-neighbor
  semantics; merging belongs to the cluster-layer ledger.
- **Write case names into the process/prompts**: acceptance criteria are not a method.
  The process describes only evidence shapes and discrimination methods, referencing
  no concrete case.
