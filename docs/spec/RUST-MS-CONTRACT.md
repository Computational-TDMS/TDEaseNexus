---
type: contract
title: Rust mass spectrometry contract
status: accepted
---

# Rust Mass Spectrometry Contract

## Principle

The Rust kernel is the only chemistry authority. The input contract follows
the output's claim — the evidence lattice `mass ⊂ composition ⊂ identity`
(accepted 2026-08-27, `archive/docs-prune-2026-10-12/docs/design/hypothesis-evidence-lattice.md`): a naked
mass delta is a measurable positional hypothesis, never a chemical identity.

## Public analysis operations

| Operation | Minimum input | Purpose |
|---|---|---|
| `theory` | complete `--proforma` (composition+) | exact mass, formula and theoretical envelope |
| `envelope` | mzML + mass + charge + RT window | one observed MS1 isotope envelope, aggregated across the window |
| `envelope-windows` | mzML + `--windows` JSON array (label/mass/charge/rtMin/rtMax) | several observed MS1 envelopes in one mzML traversal (multiplicity ladder); per-window results identical to repeated `envelope` runs |
| `fit-envelope` | observed envelope + anchored ProForma theory | one fixed-frame MS1 comparison with no offset parameter |
| `fragment-theoretical` | massDelta; envelopes degrade to the declared averagine model; `--sequence` scopes fragment generation to one sequence instead of a ProForma file | theoretical fragment ions |
| `fragment --mode match` | raw mzML or TopFD msalign or a saved spectrum-observation JSON + scan + complete ProForma + ion series + `--evidence-out` (`--mode` derives from which model argument is present) | one-model MS2 measurement; full matches are file-backed |
| `fragment --mode compare` | raw mzML or a saved pooled observation + scans (comma list, `--scans-input` JSON, RT window or scan range; `--sum-scans` pools) + at least two complete ProFormas + ion series + `--evidence-out` | symmetric raw-MS2 comparison: one shared extraction, every model measured on it, batchable across scans |
| `resolve-shift` | TopFD `_ms2.msalign` + complete TopPIC ProForma + explicit library when decomposing chemistry | sequence-graph candidate generation; compact ranked candidates on stdout |
| calibration adapter | complete candidate plus explicit calibration request | calibration only, never identity |

Adapters validate the lattice before calling lower kernel primitives:
operations that assert an isotope **shape** (`theory`, `validate-precursor`,
`fit-envelope`'s theory input) reject a numeric mass-only hypothesis outright;
ladder/position operations accept it and every such result carries
`hypothesisType: "massDelta"` plus `notIdentity: true`. Identity is a
skill-level conjunction (composition + localization + corroboration);
quantification is a sibling claim class — abundance, orthogonal to identity
(see `prompts/internal/scientific_honesty.md` and the Smith five-level scale
in `identification-quality.md`); no single tool output ever adjudicates it.

Fragment matching and comparison always write complete match tables to the requested evidence artifact. Stdout contains only a bounded measurement summary and a content-addressed artifact reference; full arrays do not enter the agent context. The bounded summary keeps the verdict itself: `discriminatingIons` (which ion and charge separates the models, which candidates matched it) travels on stdout, so the decision never requires opening the artifact. The evidence artifact is the same CLI envelope as stdout (one schema): comparisons live at `result.comparisons[]` with the complete measurement under `measurement` on both, differing only in the unbounded tables. The artifact records the full invocation params (models included) minus its own filing path, so one measurement written to two destinations is byte-identical.

Fragment ion series are method-dependent: ETD/ECD uses C,Z and HCD/CID uses
B,Y. The CLI resolves omitted `--ion-types` from source activation, or an
explicit `--activation`; unknown metadata requires explicit ion series.
Selection/precursor metadata preserves the source activation and exposes
`fragmentIonTypes` from this same core resolver (null when unresolved).
Adapters consume this result rather than maintaining another activation map. Fragment
tolerance defaults to 10 ppm. Source identity, scan, model and evidence path
never default.

When `--envelope-match` is enabled, a complete ProForma's exact net formulas
are carried through the `MassModification` boundary into each fragment's
isotope envelope. Matching is performed directly against centroided raw MS2:
the theoretical apex is mandatory, neighboring isotope positions are collected
with the monotone cursor used by Informed-Proteomics, missing positions enter
the full-envelope Pearson as zero, and the LCMS-Spectator default threshold is
0.7. After acceptance, the error-map cell uses the most intense observed
isotope and reports signed **isotope m/z ppm** against that same theoretical
isotope. `observedNeutralMass` is the separately retained M0 audit coordinate.
This Spectator-compatible matching path uses nominal C13-C12 isotope spacing.
The general `fragment-theoretical` output instead preserves BRAIN's centroid
mass offsets and derives its apex from those same exported peaks. A matcher
coordinate convention must not overwrite the dependency's general theory:
IsoForma consumes the accepted envelope measurement without reconstructing
isotope positions. Envelope matches expose `quantification.observedIntensity`
(sum of collected isotope intensities), `theoreticalFraction` (collected
positions' share of the retained theoretical envelope), and
`observedPeakIndices` (indices in the same filtered peak list as
`observedPeakIndex`). The existing `intensity` remains the display peak.
Legacy single-peak matches omit `quantification`. Full comparison evidence
retains each candidate's `fragmentStatuses`; compact stdout reports their count.

`validate-precursor` accepts one scan or a comma-separated batch. It reads each
MS2 scan's acquisition charge, isolation bounds, and referenced parent MS1.
Against the complete ProForma profile it reports total matches, matches inside
the isolation window, theoretical profile size, and the 40% minimum. `isValid`
requires both the caller's minimum in-window count and the 40% profile minimum.
Batch and single-scan requests use the same evaluator.

`fragment --mode compare --sum-scans` sums a declared MS2 scan list with the
shared centroid merger (`--bin-ppm`, default 10), then applies the same matcher
to every candidate. Full evidence retains `pooledScans` and `pooledPeaks`.
`--minimum-abundance-pct` filters each input peak against the strongest peak in
the complete pool before merging; IsoForma passes 0.01. The IsoForma runner
passes `--bin-ppm 5` explicitly.
The merger sorts by m/z, limits each cluster's full span to `binPpm` relative
to its lowest m/z, sums intensities and reports their intensity-weighted m/z.
It never expands a cluster by following a drifting centroid. `binPpm` is a
clustering span, distinct from the fragment-to-theory matching tolerance.
Duplicate scans, mixed/unknown activation and non-MS2 members are rejected;
fragment matching rejects profile input. All collected isotope indices count
as matched when computing unmatched-peak diagnostics.
Every theoretical charge state is emitted in `fragmentStatuses` as `matched`,
`missingEnvelope`, `unreasonableCharge`, `missingApex`, or
`correlationRejected`; grey cells are therefore evidence, not absent rows. A
mass-only numeric tag remains valid for m/z matching but cannot provide an exact
isotope-shape claim.

TopFD `_ms2.msalign` is the external deconvoluted input for OpenSearch and
candidate sequence discovery. It is not an error-map input; the kernel does not
add a second MS2 deconvolution route to the error-map surface. It supports
single-model `fragment --mode match` annotation, but not `--mode compare`:
symmetric comparison, isotope-envelope acceptance and isotope-borrowing
diagnostics require raw centroided mzML.

`resolve-shift` likewise emits a compact candidate projection by default: rank,
mass closure, score, complete candidate ProForma, and localization intervals.
`--details` restores alternative placements and full diagnostics for the
candidates selected by `--max-candidates`; it does not change search or ranking.
`--library builtin` searches the common-PTM set. A JSON file or inline JSON
replaces that set and is therefore an explicit scientific hypothesis, not a
post-hoc filter. A scan pool contains one activation method; ETD/ECD and
HCD/CID are separate searches over the same candidate question.

`unimod solve` pins fixed modifications through `--fixed-mod TITLE|ID[:COUNT]`:
the pinned mass leaves the target, every candidate reports those members
`"fixed":true`, and pinned instances occupy allowed sites but never consume
`allowRepeated`. Unknown titles or a pin filtered away by the library are query
errors, never silent drops — a fixed-mod hypothesis the library cannot place
must stop the query, not quietly change the answer.

### Alternatives considered

- **Keeping quantification inside the identity conjunction**: rejected — the
  verdict vocabulary and the Smith five-level scale treat abundance as a
  sibling claim class, not an identity component; the conjunction lost to
  that internal contradiction.

### `resolve-shift` scoring

`resolve-shift` consumes TopFD `_ms2.msalign` directly; no MGF conversion or
second deconvolution is permitted. Its default `weighted` scorer preserves the
Informed-Proteomics `CompositeScorer` structure over the available deconvoluted
peak evidence: matched-ion count, intensity normalized to the spectrum's 87.5th
percentile, absolute ppm error, prefix/suffix complementarity, and TopFD's
bounded deconvolution score as the peak-quality proxy. The proxy remains named
and reported as TopFD quality, never Pearson correlation. IP's `Dist` has no
msalign field and contributes zero. `--scorer count` remains an explicit
diagnostic/GF mode and does not use intensity.

`PRECURSOR_MASS` is header metadata used for mass closure. It is not inserted
as a fragment match. The intact graph sink contributes no cleavage score; the
kernel does not add an ad hoc precursor-peak deletion absent from the compared
IP scorer.

Component localization uses the same `LibrarySpec` residue and positional
constraints as the graph DP. A localization curve can therefore resolve a
component only within its chemically legal candidate positions; it cannot
turn a forbidden residue into a rendered ProForma placement. An independent
confirmed site may be made hard by passing a positional library constraint or
by moving the confirmed named modification into the fixed ProForma frame. An
unconstrained search keeps competing compositions in the ranking as measured
hypotheses; the ranking itself is not an identity verdict.

#### Alternatives considered

- **Convert msalign to MGF before scoring**: rejected because msalign already
  supplies neutral monoisotopic mass, intensity, charge and quality; conversion
  adds a lossy frame boundary and no evidence.
- **Keep count scoring as the default**: rejected because modification ranking
  would ignore the intensity and quality of matched deconvoluted fragments.
- **Call the TopFD score IP Corr**: rejected because the producer exposes a
  generic deconvolution score, not IP's Pearson envelope correlation; it is an
  explicit quality proxy instead.
- **Delete peaks near the precursor mass**: rejected because the compared IP
  scorer has no such deletion and internal fragment nodes already exclude the
  intact sink.
- **Use one fragment-ion default for every activation method**: rejected because
  a wrong series produces plausible but invalid matches. Product adapters infer
  from source metadata; direct CLI calls make the choice explicit.

## Atomic scientific authority

Named modification chemistry and residue masses come from mzcore; fragment
chemistry comes from mzannotate. Do not maintain parallel name-to-formula or
ion-offset tables. Explicit user-supplied formulas remain declared overrides.
Matching constructs a typed peptide once for its mass and fragment theory.

Candidate comparison reports measurements and diagnostics, not aggregate
adjudication, identity decisions or a consistent winner. Missing evidence stays
missing. Batch activation and ion series are recorded per scan; an inferred
multi-scan batch has no single resolved activation or ion-series value.

MGF export, spectrum summing and other materialized intermediate operations
remain independently callable. A one-call analysis composes these operations;
it does not replace or hide their scientific inputs and reusable artifacts.

Rejected alternatives: local chemistry overrides duplicate the dependency's
authority; aggregate winner policies mix measurement with interpretation;
removing intermediate operations prevents reproducible multi-step composition.

## Mass coordinates

Observed mass, calibrated mass, isotope index, TopPIC shift, theoretical ProForma mass and residual are separate coordinates. An isotope offset is peak indexing, not a mass correction. It is not part of `fit-envelope`; any non-zero offset is reported only by ingest calibration or isotope-assignment evidence. `fit-envelope` returns one `evaluation` with matched-peak, coverage, Pearson and residual fields; it does not return a fitted mass.

## Neutral losses (`fragment-theoretical`, `fragment --mode match`)

`--neutral-losses` takes one of two forms:

- JSON array of **site-scoped named losses**: `[{"label":"H3PO4","deltaMass":97.9769,"position":88}]`. `position` is required (1-based residue index, `"nTerm"`, `"cTerm"` — the `MassModification` convention; integer or string). A named loss is emitted **only** for fragments whose residue span contains that site: N-terminal ions (a/b/c) with `number >= position`, C-terminal ions (x/y/z, z•, z′) with `number >= length - position + 1`. A missing, zero, or out-of-range position is an error, never a silent default.
- The sentinel `engine`: emit the fragmentation engine's (mzannotate) own chemically-gated loss variants. Verified behaviour through this CLI: the series-standard H2O loss on every fragment of the selected series (labels in Hill notation, e.g. `-H2O1`). mzannotate also has a modification-specific loss channel, but no ProFormA tag in this CLI attaches loss definitions — `[Phospho]` + `engine` emits no H3PO4. A modification-defined loss therefore enters through the site-scoped named form above, never through `engine`.

A modification-defined loss does not exist on a fragment that does not carry the site (a c5 ion cannot lose H3PO4 from a phospho on residue 88). With no flag the output carries no loss variants and is unchanged — recorded runs stay reproducible.

Named losses exist for mass-only hypotheses (for example `[+79.9663]`) that
carry no formula the engine could gate on; the caller states the site, and the
kernel enforces the span. Complete named/formula ProForma candidates retain
their chemistry for envelope matching.

### Alternatives considered

- **Indiscriminate application to every fragment** (the pre-2026-08-26 behavior): rejected — it manufactures chemically impossible theoretical peaks (half of all variants on the H4 phospho case) that match noise inside the tolerance window, the dense-spectrum false-positive channel.
- **Wiring UniMod's neutral-loss specificity table in the kernel** (loss auto-bound by mass lookup): rejected — a database lookup of the mass would silently attach chemistry to a mass-only tag, the same "database hit is not identity" failure the candidate gates reject elsewhere; the caller's explicit `position` keeps the loss a declared hypothesis (`notIdentity` discipline).

## Required result metadata

```json
{"model":{"proforma":"...","mass":0.0,"formula":"..."},"observed":{"mass":0.0,"frame":"..."},"isotopeOffset":0,"measurementRole":"candidate|control|discriminator|calibration","notIdentity":true}
```

MS1 and MS2 candidates use identical settings. Controls are labelled controls and cannot replace modified candidates.

## CLI invocation contract

> Distilled from `design/tdeasenexus-toolbox-native-adapter.md` (2026-10-12
> prune): the binding invocation rules live here; that document keeps the
> design rationale and the decision table.

**Envelope and streams.** Every invocation is a one-shot process: one JSON
envelope on stdout — `schemaVersion`, `tool`, `version`, `command`, `params`
(echoes all inputs), `source` (path/size/digest; absent when the command reads
no files), `elapsedMs`, `warnings`, `result` — plus `--schema <command>` for a
self-description. The default digest is the file's first 1 MiB + size, honestly
labeled `sha256:head1MiB`; `--digest full` gives a full sha256. Runtime errors
are stderr JSON exit 1 (`{"error":{code,message,details}}`), usage errors exit 2
(`USAGE`); stdout stays empty on error — results and errors never mix streams.
A contract change bumps `schemaVersion`; the Python shim verifies it and reports
`SCHEMA_MISMATCH` on unknown versions.

**Output-format policy.** Kernel stdout carries only the standard JSON
envelope. The only exceptions are external tool exchange formats:
`spectrum --mode scans --out-format mgf` (consumed by isoforma; TITLE is
`scan=N` plus `activation=...` when recorded) and `fragment-theoretical
--out-format mztab|mzpaf` (HUPO-PSI standards). `--out-format csv` is deleted;
passing it is the stable error `MASS_SPEC_INVALID_QUERY`. Tabular intermediates
are written by the consuming skill from the JSON envelope. All input files are
read-only; output defaults to stdout; `--out <path>` is caller-specified.

**SELECT predicate surface (`select`).** The single "look at the data" query
surface: TIC, XIC, MS2 survey and fragment/neutral-loss evidence are all
condition+range statements; no per-concept mode is added. Syntax
(authoritative implementation: the hand-written lexer + recursive-descent
parser in `mass-spec/src/select.rs`; operating doc: the `massql` skill):

```sql
SELECT spectra FROM mzml
  [WHERE <pred> [AND <pred>...]] [LIMIT n];
-- pred: ms_level = N | rt BETWEEN a AND b | precursor_mz WITHIN c PPM|DA t
--       | charge = N | activation = 'HCD' | product_mz WITHIN ... | neutral_loss BETWEEN ...
```

Projections: `totalIonCurrent` (header MS:1000285, falling back to
peak-intensity summation) and `matchedProducts`. Peaks decode on demand — only
when a peak-level predicate is present or the header lacks TIC; otherwise
`peakCount` is null.

**Unified net-formula syntax.** `split_net_formula` accepts a superset: Hill
notation (`C2H2O`), net syntax (`Br-H`, `-H+Br`), UNIMOD compositions
(`Br H -1`, `H(-1) Br`, `S(1) O(3)`), stable-isotope labels (`2H(8)`, `13C(3)`
→ isotope masses), and UNIMOD sugar abbreviations (`dHex`, `HexNAc` → empty
element sets). Rules: element symbols start uppercase; `+`/`-` and digits are
tokens; a sign followed by a digit is a negative count of the current symbol, a
sign followed by a symbol starts a new term at −1; spaces allowed anywhere. The
two syntaxes have zero corpus conflicts (ambiguity analysis:
`design/tdeasenexus-toolbox-native-adapter.md` Appendix A). Rust and any other
consumer share this one rule, locked by corpus tests; UNIMOD → external-mods
bridging needs zero normalization.

**ProFormA two-value model and layering.** Every ProFormA tag normalizes to
exact composition or mass-only offset (mass-only always warns; isotope *shape*
stays the base composition's — doublet discrimination needs a
composition-bearing tag). `@site` positions parse directly
(`[Acetyl@K4]`, `[UNIMOD:7@K]`). Layering: `parse_proforma` (core) is the
single chemical truth and embeds no UniMod data (wasm boundary);
`proforma_unimod.rs` (non-wasm) does reference resolution — `[UNIMOD:n]`/
`[USER:n]`/names → records, average mass — then injects the hit's composition
as external mods and hands off to `parse_proforma`. An unresolved `[UNIMOD:n]`
in the core is an error with a hint, never a silent approximation.

**Dual-source modifications.** `UNIMOD:n` (official, read-only — compiled into
the CLI binary and released by content digest into a system temp cache on first
use; `--db` remains a dev/contract-test entry) and `USER:n` (writable
`user-mods.sqlite`, id offset `USER_OFFSET=1_000_000`). The official file is
never written. Search **returns all sources with no override priority**; hits
carry `source: 'unimod'|'user'` + `custom` for user entries. ProFormA parsing
hitting a same-name dual source is a **hard error**
(`PROFORMA_MODIFICATION_AMBIGUOUS`) requiring an explicit `[UNIMOD:n]` or
`[USER:n]` — never a silent pick (the floor rule). `unimod-add` appends user
entries; every entry must carry a net formula.

**Python slimming (iron law).** No Python skill script may contain physics
constants, AA mass/composition tables, an isotope engine, or ProFormA chemistry
parsing — all of it goes through the CLI. Scripts only orchestrate:
interpretation, batch roles, knowledge tables and plotting stay in Python
(numbers that "must agree in many places" live in Rust; numbers that "change
with the analysis scenario" stay in Python).

**Sole invocation surface.** The CLI is reached only by its managedBinDir
short name (`agentRoot/tools/`, first on the controlled bash PATH, alongside
`uv`/`rg`/`fd`) — no absolute paths, no exact env paths, the user's machine
PATH untouched. A Workspace must not provide a same-name binary: the managed
short name is the identity truth and is not part of any asset-coverage system.
The durable-intermediate convention (`runs/<run>/analysis/<slug>/`) is owned by
`FILE-LAYOUT.md` §4.2.

## Deprecated internal inputs

Rust may retain `deltaMass` for legacy search and calibration compatibility, but it is not an AI-facing identity input or standalone evidence. A massDelta result is a positional measurement of an unassigned shift; the skill layer decides which lattice rung suffices for which claim. AI must not use numeric-mass `isotopeEnvelope` as a shape claim, legacy deltaMass identity conclusions, manually assembled delta hypotheses presented as chemistry, unmodified fragment theory for a modified candidate, or unbounded final envelope offset search.
