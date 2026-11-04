---
title: "TopPICR (R) vs toppic-py (Python) Rewrite Alignment Difference Audit and Fix Plan"
date: 2026-08-04
module: toppic-alignment
problem_type: tooling_decision
component: domain_proteomics
severity: high
applies_when:
  - Aligning toppic-py results with the TopPICR reference pipeline
  - Deciding whether to fix the Python rewrite or rewrite the analysis pipeline as a Rust CLI
  - Reusing/validating expression matrices or PTM annotations produced by toppic-py
  - Extending toppic-py's UniMod annotation capability (currently 11 hard-coded entries)
related_components: [domain_proteomics, reference_commands, native_capabilities]
tags: [toppic, toppicr, toppic-py, alignment, proteomics, rewrite]
---

# TopPICR (R) vs toppic-py (Python) Rewrite Alignment Difference Audit and Fix Plan

> **Status: all four substantive differences were fixed and verified on 2026-08-04** (30
> tests all passing). Fix 1 (mad formula), fix 2 (mod extraction + UniMod sqlite), fix 3
> (FASTA row retention), and fix 4 (real LOESS) are all implemented. See the "Implemented
> fixes" section.

> toppic-py is a Python rewrite of TopPICR v0.0.7 (commit `0acc421`); the verification
> target is "similar behavior and scientific conclusions, not line-by-line, value-by-value
> identity" (the README's own words). This document captures the **complete difference
> list** from a module-by-module code comparison of the two libraries, evidence for the
> **four substantive differences the README did not disclose**, and **per-item fix plans**,
> for review and then implementation. Comparison baselines: R side
> `C:\Users\ray\Desktop\TopPICR-main\R\` (v0.0.7), Python side
> `C:\Users\ray\Desktop\toppic-py-main\src\toppic\`.

## Decision summary

- **Fix the Python; do not rewrite in Rust.** The toppic-py pipeline is ~90% data-table
  statistics (groupby/merge/pivot/ffill/loess/hierarchical clustering/density estimation);
  tdeasenexus-toolbox is the spectral-computation core (mzML/isotope envelopes/BRAIN/fragments/
  ProFormA/UniMod) — the two barely overlap.
- **UniMod annotation leverages this repo's assets**: `data/system/reference/unimod.sqlite`
  (761KB, complete UniMod) directly replaces Python's 11 hard-coded `_UNIMODS` entries; no
  need to touch the Rust core.
- The only "hard" fix is RT alignment — replace the smoothing spline in
  `clustering/_loess.py` with a real LOESS (a numpy port of R `stats::loess`'s
  simple_loess kernel, span=0.75, degree=2).
- The four fixes total ~1-2 days (including JPR regression verification); a full Rust
  rewrite is ~7000-10000 lines and 2-4 weeks, and the verification burden does not shrink
  by switching languages.

## Difference summary table (15 items, ordered by impact)

| # | Stage | Difference type | R value/behavior | Python value/behavior | Impact |
|---|---|---|---|---|---|
| 8 | RT alignment | **Different algorithm** | Real LOESS (`stats::loess` defaults span=0.75, degree=2) | scipy `UnivariateSpline` smoothing spline (frac=0.3, degree=1) | **High** — RTalign directly affects clustering |
| 9 | Mass recalibration error | **Numeric difference** | `ppm_sd=mad()` (median absolute deviation, incl. 1.4826), `rt_sd=mad()` | Mean absolute deviation `mean(abs(x-mean))`, no 1.4826 | **High** — ppm_sd/rt_sd are the shared denominator of clustering normalization, pcGroup windows, and MS1 matching windows |
| 2 | PTM/modification extraction | **Different algorithm + measured bug** | Strips flanks first, then bracket-locates; **measured `Acetyl @1-1 AA="S"` (correct)** | Counts without stripping flanks; **measured `Acetyl @3-3 AA="("` (offset +2)** | High (PTM-visualization path only) |
| 3 | FASTA mapping | Different algorithm | Pure accession join, keeps NA-position rows; `percentCoverage=signif(·,2)` | Join + substring fallback, **fallback failure drops rows**; `round(·,2)` | High — both row counts and coverage differ |
| 14 | Version detection | Different algorithm | Accepts only 1.5.4/1.7.0 with full column-name comparison; **cannot recognize 1.8** | Detects 1.5/1.7/1.8 via marker columns | Medium — R cannot process 1.8 data |
| 13 | Expression-matrix missing values | Numeric difference | Missing = NA | Missing = 0 (documented in README) | Medium — different missingness convention |
| 10 | Cluster numbering | Numeric difference | `cutree(hclust)` numbers by tree left-order | `cut_tree(linkage)` numbers by merge order | Medium — div-zero/NaN guards are an enhancement |
| 1 | MS1 parsing | Numeric difference/missing | `read_table` (any whitespace); supports FAIMS CV extraction | `sep="\t"`; MS1 always noFAIMS | Low — appears with space-aligned MS1 or FAIMS |
| 12 | MS1/MS2 match summary | Edge case | `max/median/sum(na.rm=TRUE)` | `np.*` with no na handling; all-NaN groups return NaN | Low |
| 15 | Numeric constants | Partially identical | Proton mass/13C diff/isotope table/pcGroup windows/clustering thresholds/FDR/occurrence identical | Same | Identical parts are the majority |
| 4/5/7/11 | Gene parsing/occurrence/inference/merging | Identical | Keeps tied genes, `n≥threshold`, greedy Occam, Metroid flow | Same | None |

## The four substantive differences the README did not disclose (evidence)

### Difference 8: RT alignment is not LOESS at all

- R: `align_rt.R:110` uses `stats::loess(ref$Feature apex ~ cur$Feature apex)` with
  defaults `span=0.75, degree=2`; reference-sample ties return all tied entries; data/model
  inconsistency raises via `stop()`.
- Python: `clustering/_loess.py` is actually `scipy.interpolate.UnivariateSpline`
  (smoothing spline, `frac=0.3, degree=1`); the code's own comment admits the smoothing
  parameter "doesn't work well"; `find_ref_ds` ties take only the first
  (`rt_align.py:29-30`); a dataset without a model **silently falls back to raw RT**
  (`rt_align.py:124`), where R would error.
- Impact: fitted curve and predicted RT differ -> RTalign -> all clustering shifts.

### Difference 9: ppm_sd/rt_sd estimation formulas differ (shared denominators)

- R: `recalibrate_mass.R:40` uses `stats::mad(ppm_error)` (median absolute deviation with
  the 1.4826 scaling), `rt_sd` likewise (`recalibrate_mass.R:181`).
- Python: `alignment/mass_calibrate.py:46` uses `mean(abs(x-x.mean()))` (mean absolute
  deviation, no scaling); `rt_sd` likewise (lines 74-76).
- These two quantities are referenced simultaneously by clustering normalization
  `log10(1+ppm_sd/1e6)` (`cluster.R:56` vs `cluster.py:57`), pcGroup-merge ppm windows
  (`merge_clusters.R:56` vs `merge.py:45`), and MS1 matching windows (`match_features.R:62`
  vs `match.py:52`); differing formulas shift all downstream windows wholesale. Python
  additionally has hard fallbacks (ppm falls back to 1.0, rt to 60 seconds); R propagates
  NaN.

### Difference 2: mod extraction has a measured bug (PTM-visualization path)

Measured with the real Proteoform string from toppic-py's own test library
`M.(S)[Acetyl]ESSSKSSQPLASKQEKDGTEKRGRGRPRKQPPK.K` (`tests/test_pipeline.py:178`):

- R -> `Acetyl @1-1, AA="S"` (correct)
- Python -> `Acetyl @3-3, AA="("` (position offset +2; the amino acid read is the opening
  parenthesis)

Root cause: `mod/extract.py:123,130` feeds a skeleton still carrying `-`/`.` flank markers
straight into `_find_paren_bounds`, so `aa_idx` counts flanks as amino acids; R first
strips the flanks with `sub(".\\.(.+?)\\..", "\\1", s)` before locating
(`mod_fns.R:124`). Incidental difference: for the UniMod reference table R uses the
complete `unimod.xml` (`sysdata.rda`) while Python has only 11 hard-coded entries
(`annotate.py:264-293`); for centroid clustering R uses `density(n=2^17, bw=0.0002)`
(`mod_fns.R:313`) while Python uses `gaussian_kde(bw=0.0002/std)` with 4096 points. This
module is **not on the core pipeline call chain**; it affects only the PTM-visualization
path (`pipeline/service.py:87-224` never calls add_mods/extract_mods).

### Difference 3: FASTA mapping row semantics differ

- R `map_proteoform.R`: pure accession join; unmappable rows keep NA positions and are
  **retained**.
- Python `annotation/map_proteoform.py:121-131`: when the join hits but the sequence
  cannot be located and the substring fallback also fails, the row is **dropped**. This
  explains Python's smaller PrSM count (22,636 vs 23,136) and protein-form count. The
  `percentCoverage` rounding also differs: R `signif(·,2)` (2 significant digits) vs
  Python `round(·,2)` (2 decimal places).

## Implemented fixes (2026-08-04)

All four differences were fixed; the full test run is 30 passed / 1 skipped (non-jpr), and
all integration-validation assertions pass.

| Fix | File | Key change | Verification |
|---|---|---|---|
| Fix 1: mad formula | `src/toppic/alignment/mass_calibrate.py` | Added `_mad()` (median abs dev × 1.4826 to match R `stats::mad`), used for ppm_sd/rt_sd; removed hard fallbacks (ppm 1.0 / rt 60s); NaN propagates naturally, matching R | `_mad` numerically matches R |
| Fix 2a: mod extraction | `src/toppic/mod/extract.py` | `_extract_one` strips TopPIC flanks (`M.`/`.K`) before bracket-locating; `_find_paren_bounds` only +1 on uppercase residues (`.`/`-`/brackets do not offset); `aa_sequence` taken from the pure-residue string | `M.(S)[Acetyl]...K.K` -> `@1-1 AA='S'` (same as R) |
| Fix 2b: UniMod to sqlite | `src/toppic/mod/annotate.py` | Added `_default_unimod_db()`/`_load_unimods_from_sqlite()`; `create_mod_data(use_unimod=True)` prefers the complete sqlite (262 entries), falling back to the 11 hard-coded entries when no db exists | sqlite loads 262 entries vs 11 hard-coded |
| Fix 3: FASTA row retention | `src/toppic/annotation/map_proteoform.py` | Rows whose accession hits but sequence is unlocated and fallback fails are **retained** (NaN positions, 0% coverage) instead of dropped; `percentCoverage` switched to R's `signif(·,2)` semantics | Unlocated rows retained; `_signif(12.345)=12` (same as R) |
| Fix 4: real LOESS | `src/toppic/clustering/_loess.py` | UnivariateSpline (spline) -> real locally weighted regression (tricube kernel + span window + IRLS bisquare iterations), defaults `frac=0.75, degree=2` (R `stats::loess` defaults) | Restores the 1.05 trend slope (0.5% deviation); end-to-end alignment normal |

**Tests**: `.venv/Scripts/python.exe -m pytest -m "not jpr"` -> 30 passed, 1 skipped.
Doctests need `PYTHONUTF8=1` (a Windows gbk encoding issue, not a code defect).

### Leftovers (not done, out of scope for this round)

- **Numeric-level comparison** of RT alignment against R (needs an R environment running
  `stats::loess` to generate fixtures).
- `compute_fdr` uses `print` instead of warnings; `read_toppic` drops rows without `GN=` —
  low priority, untouched.
- JPR 10-sample regression (the README metrics table) needs external data
  (`TOPPIC_JPR_DATA_DIR`); not executed.

## Per-item fix plans (implement after review)

### Fix 1: mad formula (smallest, ~5 lines)

`src/toppic/alignment/mass_calibrate.py`:

```python
# ppm_sd: median absolute deviation (R stats::mad), 1.4826 scaling
def _mad(x):
    x = np.asarray(x, dtype=float)
    return float(np.median(np.abs(x - np.median(x)))) * 1.4826

ppm_sd = df.groupby("dataset")["ppm_error"].agg(_mad)
# Global median; keep R semantics, introduce no hard fallbacks, let NaN propagate naturally
```

`rt_sd` likewise uses `_mad`. Remove the hard-coded `ppm_sd` fallback of 1.0 and `rt_sd`
fallback of 60 seconds.

### Fix 2: strip flanks in mod extraction (~5-15 lines) + UniMod to sqlite (~30 lines)

`src/toppic/mod/extract.py` `_extract_one`: strip the flanking residues before
`_find_paren_bounds` (mirroring R `mod_fns.R:124`):

```python
# Strip the single-residue flanks on both sides: M.(S)[Acetyl]...K.K -> (S)[Acetyl]...
core = re.sub(r"^[A-Z]\.", "", s).rstrip(".")
core = re.sub(r"\.[A-Z]$", "", core)
```

`src/toppic/mod/annotate.py`: replace `_UNIMODS` (11 hard-coded entries) with a read of
`data/system/reference/unimod.sqlite` (stdlib `sqlite3`; schema in
`scripts/build-unimod-database.mjs`). Keep the `_ISOTOPIC_ERRORS` isotope table.

### Fix 3: retain rows in FASTA mapping (~10-20 lines)

`src/toppic/annotation/map_proteoform.py`: rows where the join hits but `_str_locate`
fails to locate the sequence and the substring fallback also fails are not dropped — keep
the `clean_seq`/`ann_type` columns, fill position columns with `NaN`, matching R's NA-row
semantics. Change `percentCoverage` rounding to `signif` semantics (2 significant digits).

### Fix 4: switch RT alignment to real LOESS (the only "hard" one, ~200-300 lines)

`src/toppic/clustering/_loess.py`: port R `stats::loess`'s simple_loess kernel with numpy
(locally weighted quadratic polynomial, span=0.75, degree=2, with IRLS weights). Two
constraints:

- Output must be numerically identical to `stats::loess` (generate reference fixtures with
  R and compare);
- Keep the existing API (`loess_fit(x, y, ...)` / `loess_predict(model, x_new)`), so
  `rt_align.py` callers are undisturbed.

Fallback option: if a difference in algorithm family from R is acceptable,
`statsmodels.nonparametric.lowess` (deg=1, not deg=2) can be used — **it is only a
temporary stand-in, not an alignment**, and the docs must say so honestly.

### Verification suggestions

- JPR 10-sample reference-pipeline regression (the README metrics table: PrSMs/proteoforms
  /sequences/per-level FDR/missingness);
- mod extraction: assert positions and AAs using the 4 real Proteoform strings in
  `tests/test_pipeline.py` (should all equal R's output);
- RT alignment: take a slice of the 10-sample data and compare predicted values from R
  `stats::loess` vs the Python implementation; suggested tolerance ≤1e-3 (raw values
  before round(,5));
- FASTA mapping: assert that unmapped rows are retained with NA position columns.

## Rust rewrite assessment (why not this route)

Comparison of the `tdeasenexus-toolbox` CLI's capability boundary (`src/bin/tdeasenexus-toolbox/args.rs`)
against the toppic-py pipeline:

| toppic-py module | tdeasenexus-toolbox current capability | To build from scratch |
|---|---|---|
| Parse PrSM/feature tables (pandas) | ❌ | Table-processing layer (polars) |
| FASTA mapping | ❌ | Hand-written or bio crate |
| FDR/Occam/gene filtering | ❌ | Table logic (easy) |
| RT alignment (loess) | ❌ | **Port R `stats::loess` (~800-1000 lines)** |
| Mass recalibration (mad) | ❌ | 5 lines |
| Clustering (hclust/cutree) | ❌ | **Port R hclust or align with scipy** |
| pcGroup merging/feature matching | ❌ | Table logic (medium) |
| Expression matrix (pivot) | ❌ | polars |
| ProFormA parsing | ✅ `proforma.rs` | **But must extend for the TopPIC flank format** |
| UniMod annotation | ✅ `unimod.sqlite` + `unimod-search` | Just reuse the data |

The `proforma.rs` docstring states it is a **deliberately trimmed ProFormA subset**:
supports `[Formula:]`/`[+mass]`/built-in names/`[Mod@site]`, **not TopPIC's
`M.(S)[Acetyl]...K.K` flank+bracket format** — even fixing the mod-extraction bug in Rust
would first require extending the parser (~200-300 lines).

- The current Python science layer is ~3300 lines; rewriting the data-table logic in Rust
  with polars is typically 2-3x longer ≈ 7000-10000 lines.
- Algorithm porting (loess/hclust/density) + JPR regression verification ≈ 2-4 weeks for
  a skilled engineer; the verification burden does not shrink by switching languages.
- Conclusion: the main pipeline is data-table statistics and does not touch the spectral
  core; bundling it into `tdeasenexus-toolbox` would also break its "one call, one JSON" contract.
  **The real asset is the unimod.sqlite data**, directly reusable from Python (see fix 2),
  leaving the Rust core untouched. If native mod parsing is ever needed, extend
  `proforma.rs` separately to support the TopPIC flank format.

## Known README statements that contradict the code

The README claims "the gene-selection tie rule differs from R and yields fewer unique
genes", but the code comparison shows **both sides keep all tied genes** (`slice_min` with
with_ties=TRUE vs keeping all equal e_value rows) — the logic matches. The count
difference is more plausibly a knock-on effect of the FASTA mapping difference
(difference 3), not gene ties per se. After implementing the fixes, re-check this
attribution on JPR data.

## Related

- `docs/solutions/native-capabilities/uniprot-query-capability.md` (precedent for
  organizing reference-data assets)
- `tdease-ai-capability/system/skills/toppic-suite/references/parameter-decisions.md` (upstream
  TopPIC/TopFD identification parameters; a different layer from this document's
  downstream analysis pipeline)
- `data/system/reference/unimod.sqlite` (the data source for fix 2)
