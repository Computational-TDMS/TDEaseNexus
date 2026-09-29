---
title: "Integrating toppic-py into a system skill + end-to-end soybean data validation"
date: 2026-08-04
module: toppic-alignment
problem_type: tooling_decision
component: domain_proteomics
severity: high
applies_when:
  - Using toppic-py as a TDEase system-layer skill
  - Deciding the skill's built-in shape, dependency strategy, and UniMod data source for toppic-py
  - Reproducing the TopPIC downstream analysis of the soybean (Zhou 2022) dataset
related_components: [domain_proteomics, reference_commands, native_capabilities]
tags: [toppic, toppic-py, skill, soybean, skill-integration, unimod]
---

# Integrating toppic-py into a system skill + end-to-end soybean data validation

> Move toppic-py (a standalone repo) directly into TDEase's capability tree as a
> built-in skill (then `data/system/skills/`, since 2026-08-26 the deployed layout is
> `tdease-ai-capability/system/skills/`), validate end-to-end with the already-prepared soybean (Zhou et al. 2022)
> TopPIC data, and fix a few bugs in the standalone repo along the way.

## Context

toppic-py is a Python rewrite of TopPICR v0.0.7 with 4 R-alignment differences already
fixed (see `toppicr-toppicpy-alignment.md`). The user's request: move the entire repo
into the system layer as a built-in skill (rather than depending on external paths), and
retire the standalone comparison scripts.

## Guidance

### Skill shape (`tdease-ai-capability/system/skills/toppicr-py/`)

- `SKILL.md` — frontmatter name/description + workflow instructions, aligned with the
  toppic-interpret style.
- `scripts/toppic_run.py` — analysis CLI (PrSM + FASTA + optional MS1 -> expression
  matrix). The `run` subcommand is auto-filled (`toppic_run.py --project-dir ...` needs no
  manual `run`).
- `scripts/toppic_plot.py` — plotting CLI: `fragments` (coverage plot) / `ptm` (PTM
  annotation plot).
- `scripts/toppic/` — **the entire `src/toppic` core library moved in, keeping the
  `toppic` package name** (not toppic_pkg, otherwise the 9 `from toppic...` imports
  inside the library would all need changing).
  Trimmed `frontend/` (the streamlit UI) and the standalone scripts
  (`compare_table1.py`/`compare_with_paper.py`/`app.py`).

**Key decision: keep the package name `toppic`.** The library has 9 absolute imports like
`from toppic.pipeline import ...`; renaming to `toppic_pkg` would require changing all of
them. At runtime the scripts do `sys.path.insert(0, scripts_dir)` so `import toppic`
resolves to the skill's copy.

### UniMod data source: stdlib parsing, no rust CLI / pyteomics dependency

- **pyteomics cannot read the standard `umod:unimod` XML** (measured: `Unimod`/`load()`
  only recognizes the flat `unimod_tables.xml` and returns 0 entries for the standard
  XML). Excluded.
- **The rust CLI's unimod stays for interactive single-point agent queries**
  (unimod-search/solve); same data source, complementary roles.
- Inside toppic-py, parse `data/system/reference/unimod.xml` with **stdlib
  `xml.etree`** (262 approved, Acetyl 42.010565), consistent with toppic-interpret's
  `load_unimod`.
- Path resolution: `TDEASE_UNIMOD_XML` -> `TDEASE_SYSTEM_ASSETS/reference/unimod.xml` ->
  the skill's own copy at `parents[5]/reference/unimod.xml` (works standalone).

### Dependency strategy: wheelhouse expansion

- toppic-py's core is pandas (24 files depend on it); cannot be trimmed.
- The wheelhouse grew from 4 to **17 packages (93MB)**: +pandas/numpy/scipy/matplotlib
  and dependencies, all cp312-win matching the bundled python (3.12.13).
- Skill scripts declare dependencies via PEP 723; `uv run --script --offline` +
  UV_FIND_LINKS=wheelhouse resolves offline.

### Upstream repo bugs fixed along the way (synced back to toppic-py-main)

| File | Problem | Fix |
|---|---|---|
| `annotation/filter.py` | `groupby(...).apply` drops group keys in pandas 2.x -> merge complains about missing columns | Switch to `transform("min")`, preserving tie semantics |
| `utils/fasta.py` | Depends on biopython (not in wheelhouse) | Parse FASTA with the stdlib |
| `features/match.py` | Depends on joblib (not in wheelhouse) | `concurrent.futures.ThreadPoolExecutor` |
| `pipeline/service.py` | `importlib.metadata.version("toppic-py")` — no metadata in the skill | Use `toppic.__version__` |
| `mod/annotate.py` | Removing sqlite accidentally deleted the `Optional` import | Restored |

## Why This Matters

- **Bringing the whole standalone repo in** avoids maintaining two copies of the logic:
  the skill's built-in copy IS toppic-py itself, so later changes to toppic-py need to be
  synced only once.
- **Stdlib UniMod** removes the process-level coupling to the rust CLI while keeping the
  CLI for interactive queries.
- **Wheelhouse expansion** lets the packaged skill run offline, matching TDEase's
  pre-provisioned-assets value.

## When to Apply

- When making a Python analysis library into a TDEase skill, prefer "move the whole repo
  in + keep the package name + PEP 723 dependencies + wheelhouse expansion" over writing
  a compatibility wrapper layer.
- When `unimod.xml` already exists on the system, parse UniMod with the stdlib; do not
  introduce pyteomics/sqlite dependencies.

## Examples

Soybean (Zhou 2022) end-to-end validation:

```bash
# Data: data/backend/runs/soybean-all-v5-20260728 (already-prepared TopPIC outputs)
# Moved into the standard workspace layout: fasta/ toppic/ topfd/
# Analysis (21 stages, with MS1):
toppic_run.py --project-dir <ws>/soybean-toppic-py --output-dir <out> \
  --occurrence-threshold 1
# -> 2235 features x 6 samples, 0 warnings

# Plots:
toppic_plot.py fragments --features <out>/features.csv --accession C6TMX6 --out cov.svg
toppic_plot.py ptm --features <out>/features.csv --accession C6TMX6 --out ptm.svg
```

**Performance note**: the ptm subcommand must **filter to the accession subset BEFORE
`add_mods`** — running add_mods + gaussian_kde centroid clustering on the full table
(2000+ rows) exceeds 120s; after filtering it is seconds.

## Fixes after the second review round (2026-08-04)

After a **second module-by-module comparison** against the TopPICR R sources, 7 more
differences were located and fixed beyond the original 4 — the core ones being the
**N-Acetyl rename never firing** and the **Turbo colormap not wired up**:

| # | Module | Problem | Fix |
|---|---|---|---|
| 5 | `mod/annotate.py` | The N-Acetyl rename **never triggers**: it checked `mod_name` (still None at that point) instead of `mod_mass`; and it scanned for the first match while R only checks the first mod | Check `mod_mass == "Acetyl"` and only `mods[0]`; `annotate_masses` no longer overwrites an existing `mod_name` on an already-named mod (preserves the N- prefix) |
| 6 | `mod/annotate.py` | `_centroiding` grid 2^12 vs R `density(n=2^17)` | Changed to 2^17 |
| 7 | `alignment/mass_calibrate.py` | Global `ppm_sd` used pandas `.median()` (skipna=True), silently ignoring NaN; R `median()` defaults to na.rm=FALSE and propagates NaN | Changed to `.median(skipna=False)` |
| 8 | `alignment/*` | Representative-row ties took only the first; R uses `slice_max(intensity) %>% slice_min(apex)` | Two-key sort `[intensity desc, apex asc]`, take first |
| 9 | `clustering/_loess.py` | IRLS recomputed on every predict (wrong timing); iterations defaulted to 2 (R `loess.control` defaults to 4) | IRLS **moved to the fit stage** to converge `rw`; predict does one local regression with fixed weights; iterations=4 |
| 10 | `plot/*` | **Turbo not wired**: fragments fixed to viridis, ptm plot used plasma; ordering `[first_aa,last_aa]` vs R `arrange(firstAA,-Length,-n)`; border 0.5 vs R 1; tick/font sizes inconsistent | Both plots wired to `turbo_cmap()`; ordering aligned; border 1; x ticks step 20 + rotate 90°; title 16; `plot_pform_sig` uses R's 5-color manual (`#E53935->#BDBDBD`); `plot_pform_sig_soft` uses jet (R jet2) |
| 11 | `features/metadata.py` | Representative row picked by `feature_intensity` (R picks by `spectral_count` subgroup `slice_max+slice_min`, keeping ties); collision detected by pc_group (R by gene+cluster); mass/rt/spectral_count statistics at wrong granularity | Statistics per `(gene,pc_group,clean_seq,mod_mass)` subgroup + `slice_max(spectral_count) %>% slice_min(e_value)` keeping ties; collision switched to gene+cluster |
| 12 | `features/match.py` | Summary used `np.max/sum/median`, which return NaN on NaN; R uses `na.rm=TRUE` | Switched to `np.nanmax/nansum/nanmedian` |

**Verification**: toppic-py tests 30 passed + 1 skipped; soybean end-to-end 21/21 stages,
**2234x6** (one row fewer than the previous 2235, from aligning create_mdata
representative-row semantics), 0 warnings; `toppic_plot.py fragments/ptm` produced plots
from real data, and the SVG contains the Turbo endpoint color `#30123b`, confirming the
wiring took effect; LOESS numeric checks on synthetic data (residuals centered, slope
recovered, IRLS weights down-weight outliers).

**Leftover (untouched, assessed)**: cluster numbering `cutree(hclust)` tree-left order vs
scipy `cut_tree` merge order — grouping relations are equivalent, only the numbering
values differ; no effect on scientific conclusions or on this round's fix targets.

## Round 3: fully built-in package + built-in unimod + paper digest (2026-08-04)

The user required the skill to be **fully self-contained**; three additions:

| Item | Approach | Result |
|---|---|---|
| Full toppic package built in | Copied toppic-py repo metadata (pyproject.toml / README / LICENSE / NOTICE / CHANGELOG / AGENTS.md) into `scripts/toppic/`, so the package origin is visible and the version traceable | Vendored package is self-describing |
| **unimod fully built in** | Copied `data/system/reference/unimod.xml` (2.5MB, 262 approved) to **`reference/unimod.xml`**; changed `_default_unimod_xml` resolution order: env override -> **skill built-in copy** (highest priority for standalone) -> `TDEASE_SYSTEM_ASSETS` -> legacy location | **Offline parsing with no system assets at all**; `Acetyl 42.010565` correct |
| **Paper digest added** | Read Martin et al. 2023 TopPICR (JPR 22:399–409, 11 pages) in full and wrote `tdease-ai-capability/system/skills/toppicr-py/references/toppicr-paper-digest.md` | Per-stage scientific motivation + key parameter defaults + the paper's Table 1 numbers + the GAPDH case + limitations |

**Verification**: tests 30 passed; the skill independently re-ran the soybean pipeline
under `env -u TDEASE_SYSTEM_ASSETS -u TDEASE_UNIMOD_XML` (to be backfilled); standalone
unimod parsing yields 262 approved, Acetyl correct.

## Related

- `toppicr-toppicpy-alignment.md` (alignment difference audit + the 4 fixes)
- `docs/solutions/native-capabilities/uniprot-query-capability.md` (reference-data asset
  precedent)
- `tdease-ai-capability/system/skills/toppicr-py/` (this integration)
