# Single-Sample Mass-Shift Assignment

> Status: compact screening design; implementation status is in `STATUS.md`.
> The source-identity invariants and Compact batch profile below describe the
> current design. Legacy ledger/checklist/finalizer and automatic-assignment
> sections record the earlier batch proposal, not the current runtime contract.
> Current investigation ownership and human-only final verdict are defined in
> `MASS-SHIFT-LOOP.md` and the shipped `tdp-*`/`spectral-evidence` Skills.

## Single source of truth

There are only three relations, all using native TopFD/TopPIC IDs:

```text
Feature ID -> (Feature ID, Proteoform ID, Protein accession) -> Prsm ID
```

- A Feature is a physical object in mass and RT space.
- A Proteoform is one MS2/ProForma interpretation of that feature; a `Proteoform ID`
  alone is not unique.
- A PrSM is a concrete scan, fragmentation method, and matched-fragment fact.

IDs are interpreted only within one sample's file set. The product does no
multi-sample merging, global IDs, cross-sample mass calibration, or RT alignment.

Mass values must always carry their coordinate frame. The following quantities must
not reuse one field: TopFD `featureMass`, the total modification mass relative to the
unmodified mature chain, TopPIC's `unexpected_shift_after_fixed_forms` after excluding
fixed forms, and the residual after dismantling candidate components. The queue and
events use:

```json
{"observedShift":{"value":121.9846,"frame":"unexpected_shift_after_fixed_forms","source":"TopPIC Unexpected modifications","rawValues":[121.9846],"calibratedValues":[],"fixedFormsExcluded":[{"position":"nTerm","name":"Acetyl"}]}}
```

A missing or unknown frame must be an error; never guess backward into
`totalMass`/`totalShift`.

## Artifacts

Emitted by the `tdp-opensearch` skill:

- `census.json` / `inspect-summary.md`: the attention projection and its
  bounded Agent summary (inspect) — ranked attention candidates with source
  references, never a chemistry claim.
- `evidence-ledger.jsonl`: append-only candidate/measurement evidence;
  proposal records carry `notIdentity`.
- `proteoform-residual-queue.json`: one routing record per `(assignmentId,
  featureId, proteoformRef)`; the typed `observedShift` and the carrier
  feature's mass/RT are stored separately.
- `modification-library.json`: the small explicit search library projected
  from first-pass UniMod hits — the input to `resolve-shift --library`.
- `modification-annotations.json` / `tdp-check.csv`: bounded annotation and
  checklist views.

The raw TopFD/TopPIC tables remain the lower-level observational source of truth; the
JSON above is typed routing and evidence carriers, not a second set of raw facts.

## Compact batch profile

`tdp-opensearch` also runs as a compact batch over one Run:

- `ingest build` writes ONE source-linked `opensearch.json` ledger. When the
  run ships no `_proteoform_single` file, representative proteoform rows are
  derived from the full PrSM table; third-party tables (e.g. Informed
  Proteomics IcTarget) are never read. Only a bounded UniMod candidate summary
  is kept by default.
- `figures report --bundle <ledger>` renders ONE self-contained statistical
  HTML: mass shifts (attributed sticks colored, attribution label in tooltip;
  curated overlays opt-in), MS1 families, and the Smith grading histogram
  (as-searched vs after direct attribution). There is no attention figure.

User-facing figure naming is "mass shifts", never "census". Automatic
annotations carry structured `assignmentIds`, so every attributed stick
traces back to its routing record.

## Scope and MS1-only admission

Before building the checklist, ask the user for scope: `all` (default) or `MS2-only`
(historical behavior, `--no-include-ms1-only`). Under `all`, MS1-only ladder rungs
anchored on an identified carrier (carrier mass + N×single-modification mass, same
RT/charge window, no PrSM at all) enter the checklist at low evidence:
`ms2_support=none`, smith fields empty, `best_evalue` sentinel 1.0 sorting last,
`evidence_confidence` starting `low`. This is the anti-false-negative floor —
combination events like multi-acetyl H4, invisible to TopPIC's single-modification
search, must enter the system; they must never silently vanish.

## The Smith five levels

The Mass-shift Skill keeps an independent copy of the authoritative four-ambiguity
algorithm: `level = 1 + ambiguous(gene, sequence, PTM identity, PTM localization)`.
Each Proteoform first gets level/subtype/ambiguities; features and mass shifts project
only the level 1-5 distribution, best/worst, and ambiguity classes — no averaging. The
Smith scale expresses completeness of definition; E-value/fragments express spectrum
support; AI-refined evidence confidence expresses certainty of modification identity
and localization; the three must not be merged.

## Feature merging

Within a single sample only, source features are merged when all of the following
hold:

1. They share at least one identified protein;
2. Masses are identical within an explicit ppm tolerance, or differ by an allowed
   integer number of C13;
3. `Min_time/Max_time` intervals overlap, or the gap does not exceed an explicit
   `--rt-gap`;
4. The merged mass diameter must not cross a C13 family, preventing single-linkage
   chaining.

Defaults `--ppm-tol 10`, `--rt-gap 0.2 min`, `--n-max-c13 1`, all explicit on the CLI.
The ppm denominator is always the full proteoform mass, never the small mass shift.
Different RT peaks are not merged; `rt_segments` permanently keep the original
intervals.

## Read on demand

The checklist first lists single-candidate/residue-mismatch items, plus mixed clusters
with no more than two candidates and `|shift| >= 20 Da`; then unknowns; finally
wide-degeneracy/routine mixes. Within a tier, sort by PrSM count. A bounded read with
the generic `read/grep` suffices. `.feature` is likewise queried by native Feature ID.
Raw tables with TopPIC parameter headers reuse `toppic-suite/prsm_read.py rows`.
Proteoform queries must pass both `--feature-id` and `--proteoform-id`; leaf nodes may
use `--prsm-id`. The pipeline provides no second read interface and introduces no
DuckDB.

## Assignment boundaries

Rust `unimod-batch-search` remains the candidate-retrieval truth. Python only performs
mass windows, residue/terminus checks, isotope degeneracy, and reproduction bounds. A
global mass shift is work routing, not a claim that different proteins necessarily
carry the same PTM; when localization, truncation, and PrSM evidence disagree, the
interpretations must be split.

`unimod-batch-search` can batch-reuse the loaded database for mass candidate
retrieval; combination solving currently takes `unimod-solve` on single shifts as the
truth. If batch solving becomes a real bottleneck, add a same-semantics
`unimod-solve-batch` (load the database once, return independent results per item)
rather than having Python copy the queries or rewrite the combination logic. That
batching still produces only candidate combinations, not sample evidence.

Spectrum analysis does not go through whole-table batching: Python only assembles
requests for the routed residual events; Rust reads the corresponding spectrum once and
returns localization or competing-error results. Routine small modifications,
already-fixed sites, and resolved combinations generate no spectrum intermediate
artifacts. Python's duties are census/ledger routing, candidate-request assembly, and
status writeback — not reimplementing fragment matching.

Rust refine accepts only an explicit `observedShift {value,frame}`. The returned
`candidate_model_localized` means a candidate model closes and localizes under a given
hypothesis — a measurement result, not a chemical identity. `events.py` must not
auto-upgrade an event to `explained` on that basis; only explicit adjudication,
comparing discriminating evidence across complete competing hypotheses, may upgrade.
Likewise UniMod only generates candidates, with default results marked
`role=candidate_generation, notIdentity=true`.

### Automatic assignment (archived)

The batch depth-tiering, combination-solving flow and the
`assignment_finalize.py` write-back contract are archived at
`archive/docs-prune-2026-10-12/docs/design/MASS-SHIFT-ASSIGNMENT-archived-automatic-assignment.md`
— the earlier batch proposal, superseded by `MASS-SHIFT-LOOP.md`'s ownership
(Copilot owns discovery-to-verdict; the human assigns the final chemistry).
The binding invariants that survive: a deep-dive verdict requires a
significant, quantified, mechanistically plausible difference against competing
explanations — otherwise stay `ambiguous`/`insufficient_data`; without MS2
localization evidence there is no upgrade to `evidence_assigned`; the window is
the precursor-anchored absolute window, never a ppm of the shift itself.
