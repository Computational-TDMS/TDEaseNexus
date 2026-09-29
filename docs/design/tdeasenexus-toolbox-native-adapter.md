---
type: design
title: tdeasenexus-toolbox system-level native adapter + the mass-shift analysis loop
description: Rust mass-spec kernel + tdeasenexus-toolbox CLI contract, UniMod dual-source queries, packaged distribution with short names.
status: implemented
---

# tdeasenexus-toolbox: system-level native adapter + mass-shift analysis loop

> Status update (2026-08-25): the frontend Studio commands `spectra.*`,
> `unimod.query`, `proforma.mass` and `skill.list` were removed — the CLI on
> controlled bash is the sole chemistry/reference surface, and the TS reference
> adapters went with them. UniProt (`uniprot.*`) remains a Studio command family.
> Decision-history rows (D12-R/D19 etc.) keep their original 2026-08-02 wording.
>
> Status: **implemented (2026-08-02)**: 16 commands (10 computational + 5 unimod
> (`get/search/solve/residues/add`) + `schema`), all divergence tests frozen in;
> UniMod queries + ProFormA parsing in the Rust kernel; the CLI lands as a managedBinDir
> short name (D16); TS has zero unimod sqlite; dual-source modifications implemented
> (D17); UniProt stays in TS (D18, final), `note/revise` moved to Workspace Evidence
> (D21). The copied release CLI runs schema + a TopPIC exact-mass smoke in a working
> directory outside the repo and only enters Electron packaging after passing. Contract
> boundaries: `docs/spec/AGENT-CONTRACT.md`.

> **Revision (2026-08-04): the nodejs-wasm delivery surface is removed.** D1/D15's "wasm
> for the Electron renderer" no longer holds — the renderer has zero wasm references
> (checked src/, no queryMzml/wasm consumption points), and the agent's `spectra.*` tools
> likewise all go through the `tdeasenexus-toolbox` CLI subprocess (`electron/mass-spec/client.ts`:
> kind→CLI mapping, stripping the wrapper to get the kernel `MassSpecQueryResult`). The
> CLI gained `spectrum --peak-order` and `envelope --model` to carry the former wasm
> capabilities. Fix: a missing scan id no longer defaults to index 0 (reports
> `SPECTRA_NEEDS_SCAN_ID`), eliminating the "agent 45 vs review 78" dual-exit divergence
> seen in the histone48 review.

> **Revision (2026-08-12): the official UniMod SQLite is compiled into `tdeasenexus-toolbox`.**
> Production queries and ProFormA name resolution no longer depend on the Product System
> path or `TDEASE_SYSTEM_ASSETS`; on first use the CLI releases it by content digest
> into a system temp cache and opens it read-only. `--db` remains only as a
> development/contract-test coverage entry. The user's `user-mods.sqlite` still lives in
> the User System and merges via `--user-db`. The TS port does not pass the official
> database path.

## 0. Decision summary

| # | Decision | Rationale |
|---|---|---|
| D1 | Layer A = one Rust kernel, one delivery surface: the `tdeasenexus-toolbox` CLI serves both the Electron agent and Python/system | Single process boundary, single JSON contract, single packageable artifact; no more maintaining a WASM fork |
| D2 | The CLI lives in the same crate as lib (`src/bin/tdeasenexus-toolbox/`), doing only argument and JSON adaptation, zero new algorithms | "The CLI is not a second algorithm set" is guaranteed structurally, not by discipline |
| D3 | CLI command surface = 16 commands (10 computational + 5 unimod + schema); computational commands only project existing core capabilities | No new algorithms invented; `MassSpecQuery` and the pure-computation core cover data access, chemistry, and fragmentation |
| D4 | Each invocation: one JSON `{metadata, result}` on stdout; errors as stderr JSON `code/message`; `--help` is the interface doc; one-shot process | Same shape as the skill contract (interaction contract in AGENT-CONTRACT §5) |
| D5 | `refine-shift` supports `--observed` to reuse an extraction result | The exhaustive mass-shift loop extracts the envelope once and does only theory+fit for N hypotheses |
| D6 | `refine-shift` outputs a **boundary verdict**: when two candidates are inseparable it reports `ambiguity` instead of forcing a pick | Floor rule (AGENT-CONTRACT §2): when evidence is insufficient, output the floor, not first place |
| D7 | Unified net-formula syntax (a superset): both `Br-H` and UNIMOD's `Br H -1` parse directly | UNIMOD → proforma bridging with zero normalization; the current parser errors on `Br H -1` |
| D8 | The single chemical truth = Rust `parse_proforma`; name resolution converges (initially a Node `proforma-mass.ts`, superseded by D12-R: all moved into Rust `proforma_unimod.rs`) | Two parsers with different semantics (UNIMOD parsing vs Formula/net change) is a defect |
| D9 | UNIMOD mass-shift search = the existing by-mass + `--contains/--excludes` composition constraints; both consumers share one rule + cross tests | "unimod search carries mass-shift settings": Δ → composition constraint → hypothesis |
| D10 | Binaries ship with the package (`.scratch/native` → `resources/native/`), copied into the managed bin at startup; only the bash subprocess PATH is modified | The app carries its own environment, never touching the user's machine |
| D11 | Consistency frozen by tests: CLI vs core contract tests + real TopPIC fixture regressions + syntax-corpus tests | The CLI projection and the mzcore/mzannotate kernel invariants must be executably verified |
| D12-R | **Reference-data queries move into Rust, TS only references (implemented 2026-08-02)**: unimod retrieval/ranking/combination in the Rust kernel (`src/unimod.rs`); the CLI exposes `unimod-search/get/solve/residues/add` + `parse-proforma --db`; TS (`tdease.unimod.query`/`tdease.proforma.mass`) is demoted to a thin CLI-subprocess adapter with **zero unimod sqlite reads**; proforma name resolution moved into Rust (`src/proforma_unimod.rs`, reusing `parse_proforma`) | Queries must serve the CLI (the sole external surface); a unified kernel outranks business agility; TS only references, never implements; kills the dual implementation |
| D15 | **The sole native delivery surface = the `tdeasenexus-toolbox` CLI**: the Electron agent, Python, batch processing, and third parties all call the same CLI shipped with the package | Narrows the open surface: one kernel, one native artifact; queries open with the CLI, dual sources labeled |
| D16 | **CLI physical location = `agentRoot/tools/` (managedBinDir), short name exposed via a bash PATH prefix (implemented 2026-08-02)**: the CLI is copied/linked into managedBinDir, in the same directory as uv; the bash sandbox PATH already prefixes that directory → the `tdeasenexus-toolbox` short name is directly executable; the Python shim's PATH fallback hits it; the user machine's PATH untouched | The app carries its own environment; one unified system-side bin; zero absolute-path invocations |
| D17 | **Dual-source modifications (implemented 2026-08-02)**: `UNIMOD` (official, read-only) + `USER:n` (User System `user-mods.sqlite`, writable). **Search returns all sources, no override priority**; hits carry `source: 'unimod' \| 'user'` + `custom`; **ProFormA parsing hitting a same-name dual source = hard error**, requiring explicit `[UNIMOD:n]`/`[USER:n]`, never silently picking one (floor rule, AGENT-CONTRACT §2); the official file is never written. CLI `unimod-add` writes `USER:n` (id offset `USER_OFFSET=1_000_000` to avoid the official space) | Asset provenance visible; on insufficient evidence output the floor, never silently adjudicate |
| D18 | **UniProt stays in TS (final, 2026-08-02)**: network/snapshot/projection remain a TS read-through store, not migrated to Rust. UniMod went into Rust because of **chemical coupling** (bound to element masses/compositions/ProFormA); UniProt has no such coupling, the ROI is low, and the existing contract is mature | Don't extrapolate UniMod's success into moving all reference knowledge into the mass-spec crate; `note/revise` is not a reference duty (see D21) |
| D20 | **Three-tier asset system + the CLI short name is not an asset (revised 2026-08-12)**: the official UniMod data belongs to the `tdeasenexus-toolbox` binary itself; the User System holds `agent/tools`, cache/uniprot, `user-mods.sqlite`; the Workspace holds `.tdease/skills` and runs analysis/evidence. **The `tdeasenexus-toolbox` short name is a runtime capability, not part of the asset-coverage system** — a Workspace must not provide a same-name binary shadowing the System; the managed PATH short name is the identity truth | Official chemical truth ships with the sole native artifact; user extensions and workspace facts stay layered |
| D21 | **`uniprot.note/revise` deprecated, moved to Workspace Evidence (decided 2026-08-02)**: user judgment is not a reference feature — whether this sample supports a protein function/PTM uses the existing `evidence.write` (Workspace Evidence); cross-project stable knowledge enters the System Wiki through human acceptance | note/revise is an Evidence/Wiki duty, not reference data; duties returned to their right places |
| D22 | **Search tools rg/fd ship with the package + managedBinDir short names (implemented 2026-08-13)**: `fetch:search-tools` downloads pinned versions at build time (rg 15.2.0 / fd 10.4.2, zip+exe dual sha256) into the repo root `.scratch/vendor/search-tools/` → extraResources `vendor/search-tools/` → startup idempotently prestages them into managedBinDir (bash short names `rg`/`fd`); the main-process PATH prefixes the same directory, so pi grep/find's `ensureTool` hits our copies; `PI_OFFLINE=1` completely forbids pi's runtime GitHub download (missing = fast, clear error, not a network hang); the user's global `~/.pi/agent/bin` is never written. Fixed in the same pipeline: `build:native:cli`'s output root moved from `TDEase-FrontEnd/.scratch` back to the repo root `.scratch` (consistent with electron-builder `../.scratch/*` and build-desktop.ps1 staging — previously the native packaging mapping silently failed) | The app carries its own environment (same principle as D10/D16): on a clean machine/offline/restricted network, the first grep/find does not depend on runtime network; versions deterministic across machines; rg/fd are the kernels of pi grep/find, runtime necessities on par with tdeasenexus-toolbox |
| D14 | ProFormA format normalization: every tag → the **two-value model of exact composition, or mass offset + warning**; `@site` positions supported; `[UNIMOD:n]` is resolved by the reference-layer resolver then injected, the core embeds no database | Multi-format compatibility unified into two values; traceable positions; layering: don't reimplement what can be looked up (§5.0) |

## 1. Current inventory (design input)

### Existing (all reused, nothing rewritten)

| Layer | Existing | Notes |
|---|---|---|
| A core | `MassSpecQuery` 12 variants (Index/Scan/Scans/Sum/Window/Xic/Product/Precursor/FragmentMatch/CandidateComparison/IsotopeEnvelope/Select) → the various `query_*_mzml` | Byte input, one sequential read on open |
| A core | `parse_proforma` / `fit_envelope` / `calibrate_mass_shift` (post-atomization) | The three P0 fixes landed |
| A core | `theory::{theoretical_envelope, anchored_envelope}` unified BRAIN kernel | Anchored absolute coordinates |
| C | `skill_runtime.cjs` (uv run --script, injecting `TDEASE_ENV`/`TDEASE_SYSTEM_ASSETS`/`UV_*`; `ensureNativeCli` prestages the CLI) | After D12-R the query kernel is fully in Rust; TS has zero sqlite |
| Packaging | `electron-builder.json` extraResources (`.scratch/runtime` → `backend/runtime` precedent) | The CLI binary follows the same `.scratch` pattern |

### Gaps (what this design fills)

1. Python cannot call layer A (no CLI); the agent-side wasm never reaches Python
2. `split_net_formula` does not support the UNIMOD composition syntax (`Br H -1` errors with "digit before element")
3. `proforma.rs`' element table has only 10 elements (C H N O S P Br I Cl F); the UNIMOD corpus is wider
4. `ParsedModification` has no position (nTerm/cTerm/residue) — the site-feasibility cross-check for exhaustive mass-shift cannot be done
5. `refine-shift` has no boundary verdict (hard-picks on offset ties) and no `--observed` reuse
6. UNIMOD search has no composition constraints (contains/excludes)
7. Two old dev bins (`aggregate_envelope.rs`/`extract_envelope.rs`) were a second mzML reader + hardcoded constants — deleted

## 2. Architecture

```text
┌─ Layer C orchestration ──────────────────────────────────┐
│  Python skills (AI-writable): free statistics/plotting/interpretation   │
│   Calls A: tdease_ms.py shim → subprocess tdeasenexus-toolbox (JSON)              │
│   Never touches the database — queries go through the CLI (unimod-search etc.) │
└───────────────┬─────────────────────────────────────────┘
                │ stable JSON contract
        ┌───────┴────────┐
        │ Layer A kernel (Rust, sole implementation)  rust/mass-spec core      │
        │  ├─ computation: proforma/theory/envelope/refine                    │
        │  ├─ reference queries: unimod retrieval/ranking/combination/dual-source + name resolution │
        │  │   (unimod.sqlite trusted read-only + user-mods.sqlite writable)  │
        │  └─ tdeasenexus-toolbox CLI → the sole native delivery surface (computation + queries) │
        └───────┬────────┘
        ┌───────┴────────┐
        │ Layer B reference (TS, references only, never implements)                │
        │   tdease.uniprot.* (D18: network+cache+projection, stays in TS)           │
        │   chemistry reaches Layer A through the CLI on controlled bash            │
        │   (thin TS adapters tdease.unimod.query/tdease.proforma.mass were removed │
        │    2026-08-25 together with the spectra.* family)                         │
```

**Reference-data queries moved into Rust** (D12-R, implemented 2026-08-02): unimod
retrieval/ranking/combination/resolution live in the A kernel; the CLI exposes the query
commands (§6.4); **UniProt stays in TS** (D18 — no chemical coupling, mature contract),
`note/revise` moved to Workspace Evidence (D21). TS once carried **reference-only**
thin CLI-subprocess adapters (D19); since 2026-08-25 even those are gone — the
Agent runs the CLI itself on controlled bash, and Python/skills read no database
and query the CLI directly.
**The sole native delivery surface = the `tdeasenexus-toolbox` CLI** (D15): the Electron agent and
external callers share the CLI — computation commands + query commands, exposed via
managedBinDir short names (D16, §17). The CLI contract keeps the same shape (JSON stdout /
code:message / --help / one-shot process).

## 3. CLI contract

### 3.1 Computational command surface (all mapped to core)

```text
tdeasenexus-toolbox <command> [options] [<file>]

inspect <file>                       → query_index_mzml (Index summary + file provenance)
spectrum <file> --mode <mode>        → window|sum|xic|scans|precursor|product
select <file> --statement <SQL>      → query_select_mzml (SELECT predicate query, see 3.1.1)
envelope <file> --mz <F> --charge <Z> [--rt-min --rt-max --tolerance-ppm --isotopes]
                                      → aggregate_window_inner (observed-envelope extraction, P0-c anchored semantics)
theory --proforma <s> [--mods <f>] --charge <Z> [--anchor <F> --truncate-after --ignore-below]
                                      → theoretical_envelope + anchored_envelope (no file);
                                        anchored defaults to the proforma's exact
                                        monoisotopicMass; only complete, formula-bearing
                                        ProFormA is accepted
fit-envelope --observed <f> --theoretical <f> [--match-window-ppm]
                                      → fit_envelope (charge comes from the theoretical JSON)
refine-shift <file> [--observed <f>]  → calibrate_mass_shift (--observed skips extraction, reuses the envelope)
fragment <file> --mode match|compare --evidence-out <f>
                                      → query_fragment_match_mzml / query_candidate_comparison_mzml;
                                        full match tables are written to the evidence artifact,
                                        stdout returns only a bounded summary and reference
parse-proforma --proforma <s> [--mods <f>]
                                      → parse_proforma (exact composition + mass + per-modification trace)
fragment-theoretical --proforma <s> [--out-format json|mztab|mzpaf]
                                      → mzannotate theoretical fragmentation + HUPO-PSI standard output
resolve-shift <msalign> --scan <scans> [--proforma <p> | --sequence <s> --shift <Da>]
                                      [--library builtin|<json>] [--no-free-shift]
                                      → graph_search_msalign (sequence-graph engine, the
                                        Informed-Proteomics core: one DP over position ×
                                        combination decomposes the observed shift over the
                                        modification library and localizes every component
                                        plus an optional free residual SHIFT; an empty
                                        library localizes the free SHIFT alone)
isotopic-batch <file>                 → batch BRAIN theoretical isotope envelopes
```

- `fragment --mode match` tests one complete `--proforma`; `--mode compare` tests two or
  more complete `--candidate-proformas` under identical settings. Both modes require
  `--evidence-out`: full match tables are file-backed and stdout is bounded. `--scan`
  accepts a scan number or a full nativeID.

#### 3.1.1 The SELECT predicate query surface

`select` is the single "look at the data" query surface: TIC, XIC, MS2 survey, and
fragment/neutral-loss evidence are all condition+range statements; no separate mode is
added per concept. Syntax (authoritative implementation = the hand-written lexer +
recursive-descent parser in `mass-spec/src/select.rs`; operating doc = the `massql`
skill's SKILL.md):

```sql
SELECT spectra FROM mzml
  [WHERE <pred> [AND <pred>...]] [LIMIT n];
-- pred: ms_level = N | rt BETWEEN a AND b | precursor_mz WITHIN c PPM|DA t
--       | charge = N | activation = 'HCD' | product_mz WITHIN ... | neutral_loss BETWEEN ...
```

Projections include `totalIonCurrent` (header MS:1000285, falling back to peak-intensity
summation when absent) and `matchedProducts` (peaks satisfying product_mz/neutral_loss).
Peak decoding is on demand: peaks are decoded only when the statement contains a
peak-level predicate or the header lacks TIC (otherwise `peakCount` is null; TIC over a
whole 130MB mzML takes ~2.6s). The Agent reaches the same statement through the
CLI on controlled bash (since 2026-08-25, via `tdeasenexus-toolbox query`).

- External modification injection `--mods <file.json>`:
  `[{"name": "...", "formula": "<net formula>"}]`, matching the `ExternalModification`
  serde shape.
- **Output format contract (decided 2026-08-23)**: kernel stdout carries only the
  standard JSON envelope — one unified format, lower complexity. Exceptions are only
  **external tool exchange formats**: `spectrum --mode scans --out-format mgf` (consumed
  by isoforma; TITLE is `scan=N` plus `activation=...` when the precursor records it —
  freeform MGF practice, so viewers such as chart-forge `mgf-accumulated` can keep ETD
  and HCD series separate) and `fragment-theoretical --out-format mztab|mzpaf` (HUPO-PSI standards).
  Tabular intermediate artifacts are written directly by the consuming tool or
  skill script from the JSON envelope (the former frontend `spectra.export`
  adapter was removed with the `spectra.*` family on 2026-08-25); the kernel
  `--out-format csv` is deleted, and passing it is a stable error
  `MASS_SPEC_INVALID_QUERY`.
- All input files are read-only; output defaults to stdout; `--out <path>` is
  caller-specified.

### 3.2 Success output

```json
{
  "schemaVersion": 1,
  "tool": "tdeasenexus-toolbox",
  "version": "0.1.0",
  "command": "refine-shift",
  "params": { "...": "echoes all inputs" },
  "source": [{ "path": "...", "size": 123, "digest": {"algo": "sha256:head1MiB", "value": "..."} }],
  "elapsedMs": 12,
  "warnings": [],
  "result": { "...": "command-specific result structure" }
}
```

- The absence of `source` means the command reads no files (theory/parse-proforma).
- The default digest = the file's first 1 MiB + size (fast, tagged `sha256:head1MiB`);
  `--digest full` gives a full-file sha256. The algorithm is honestly labeled, not
  pretending to be full.
- Every command carries `schemaVersion`; a contract change → bump the version, verified
  by the Python shim.
- `--schema <command>` outputs a JSON schema (landed in stage 2, see §10).

### 3.3 Errors

- Runtime errors → **stderr** JSON, exit 1: `{"error": {"code": "...", "message": "...", "details": {...}}}`
- Usage errors → stderr JSON, exit 2 (code `USAGE`)
- Code sources: `MassSpecError::code()`'s existing 4 codes + CLI-layer codes
  (`USAGE`/`FILE_NOT_FOUND`/`FILE_READ`/`JSON_PARSE`/`SCHEMA_MISMATCH`). Layer A's
  internal error codes are too coarse (ProFormA parsing returns only
  `MASS_SPEC_INVALID_QUERY`); stage 1 adds fine codes at the CLI layer:
  `PROFORMA_PARSE`/`ENVELOPE_EMPTY`/`NO_MATCH`.
- stdout is empty on error: results and errors never mix streams.

### 3.4 Implementation shape

- `src/bin/tdeasenexus-toolbox/main.rs` + submodules (same crate; the `pub(crate)`
  `aggregate_window_inner` is usable directly).
- New dependencies: clap (derive, `--help` as doc), serde_json, sha2. The wasm target
  builds only lib, unaffected.
- v1 reads whole files (`fs::read`) → semantics byte-identical with wasm, so divergence
  tests hold naturally; the memory-ceiling issue (large mzML) is recorded as a v2
  optimization item: core gains a path-streaming read variant — a mechanical refactor,
  not a new algorithm.

## 4. Capability 1: mass-shift calibration (refine-shift)

### 4.1 Semantics (based on the landed atomization)

- Hypothesis sources: `--proforma` (preferred, exact composition) /
  `--sequence-mass + --mod-mass` (legacy calibration-only path, average approximation,
  outputs a warning; chemistry adjudication never sees it — that is `fit-envelope`
  territory with complete ProForma only)
- The three P0 fixes are in core: `--mz` locates the extraction anchor, the theoretical
  side anchors absolute coordinates, `--match-window-ppm` independent
- Output: `refine-shift` returns all fixed internal C13-index evaluations
  (`offset/refined_mass/fitted_da/residuals/pearson/coverage/matched_peaks`) plus
  the selected calibration result. The separate `fit-envelope` command returns
  one fixed-frame evaluation (`residuals/pearson/coverage/matched_peaks`) and has
  no isotope offset or fitted-mass field.

### 4.2 New: `--observed` reuse (the key to the exhaustive loop)

```text
env = tdeasenexus-toolbox envelope <file> --mz ... --charge ...      # one extraction (the only mzML read)
ev  = tdeasenexus-toolbox refine-shift <file> --observed env.json --proforma "[Bromo]-SEQ" ...
```

N hypotheses = 1 extraction + N pure computations. The extraction anchor `window_center`
depends only on `mz`/`prior_shift`, not on the hypothesis, so the reuse is valid.

### 4.3 New: boundary verdict (ambiguity)

The calibration workflow returns all internal C13-index candidates and adds a
deterministic boundary verdict. `RefineMassShiftResult.ambiguity` is set to `"not separated"` when the
runner-up and best satisfy:

- equal `matched_peaks`, and
- `|refined_mass_runner − refined_mass_best| < 0.5 Da` (half a neutron)

> **Implementation experience (2026-08-01 stage 2): `fitted_da` is not a separation
> criterion.** It is a shared sub-Da calibration offset, nearly constant across integer
> offsets (empirically 0.0376 vs 0.0385 Da) — the residual model absorbs the integer
> offset. The real criterion is `refined_mass` (contains the integer offset; adjacent
> offsets differ by 1.003 Da). The half-neutron threshold triggers only for truly
> degenerate fits (e.g., too few envelope peaks, the residual absorbing the offset);
> clean data does not false-positive.

Aligned with the floor rule (AGENT-CONTRACT §2): on insufficient evidence, output the
floor instead of quietly picking first place. `best` is still given (incl.
offset/refined_mass), but `ambiguity` declares it untrustworthy.

### 4.4 The exhaustive mass-shift loop (layer C orchestration, contract)

```text
1  Δ     = refine-shift --observed env.json --proforma <unmodified sequence>     # calibrate to get the mass shift
2  hits  = tdeasenexus-toolbox unimod-search --mass Δ --tolerance ...              # query UNIMOD via the CLI
                                    --contains/--excludes/--residues
3  for hit in hits:
     proforma_i = "[<title>]-SEQ" (or a position marker), mods injected as {name, formula: hit.composition}
     ev_i      = refine-shift --observed env.json --proforma proforma_i
4  rank by evidence (pearson/coverage/residuals RMS);
   inseparable → report the floor, no ranking
```

Step 2's search = **CLI `unimod-search`** (Rust kernel; Python calls it directly via the
PATH short name; D12-R implemented); steps 3/4's verification, ranking, thresholds, and
conclusions are layer C skill duties — the CLI only produces evidence (see §9). The
skill can also accept a candidate JSON passed by the agent (`--candidates`); both
entrances share the same semantics.

## 5. Capability 2: correct proforma formula parsing

### 5.0 Format normalization: every tag → composition or mass offset

ProFormA allows many spellings; all normalize to the two-value model (exact / mass-only):

| Spelling | Parse result | Type |
|---|---|---|
| `[Formula:Br-H]` | net-change composition, exact | exact |
| `[Acetyl]` / `[Bromo]` | built-in table composition, exact | exact |
| `[MyMod]` (injected via `--mods`) | external composition, exact | exact |
| `[UNIMOD:7]` (resolved by the reference-layer Rust resolver) | composition, exact | exact |
| `[+42.0106]` / `[-18.0106]` | no composition, exact mass | mass-only (warning) |
| Combination, e.g. `M[+15.9949][Acetyl]` | accumulated per tag; mixed types each traced | exact + mass-only |

The output is always `composition + monoisotopic_mass`; when mass-only is present,
`warnings` labels it, and `refine-shift` defaults to `EXACT_COMPOSITION_REQUIRED` for
such a hypothesis (§5.5). "Simple chemical formula plus mass offset" = exact composition
+ an independent mass offset coexisting: the exact part parses as usual, the offset is
traced independently as a mass-only term, never mixed into the composition.

### 5.1 Unified net-formula syntax (the core change)

Status quo: `split_net_formula` recognizes only `Br-H`/`O-N`/`SO3`; UNIMOD compositions
are `Br H -1` (space-separated, a signed count after the symbol) → currently errors with
"digit before element".

Change to a superset tokenizer accepting both syntaxes:

| Input | Parse result | Source |
|---|---|---|
| `C2H2O` | C2 H2 O1 | both agree |
| `Br-H` / `O-N` | Br1 H-1 / O1 N-1 | net syntax |
| `-H+Br` | H-1 Br1 | net syntax (a common user/plan spelling) |
| `Br H -1` | Br1 H-1 | UNIMOD |
| `H -1 N -1 O 1` | H-1 N-1 O1 | UNIMOD (Deamidation) |
| `H(-1) Br` / `S(1) O(3)` | H-1 Br1 / S1 O3 | UNIMOD composition (parenthesized signed count) |
| `2H(8)` / `13C(3)` | 2H8 / 13C3 | UNIMOD stable-isotope labels → `ElementCount.isotope`, masses use isotope masses (2.0141 not 1.0078); UNIMOD `delta_mono` == the sum of element masses (empirical, not net replacement) |
| `dHex` / `HexNAc` | empty (no elements) | UNIMOD sugar abbreviations, not elemental compositions; treated as empty by contains/excludes |

Implemented (2026-08-01 stage 3): Rust `split_net_formula` and TS
`unimod-search.parseComposition` share one rule, locked by corpus tests;
`unimod_lookup.py` (the Python side) was deleted along with the layer B TS-ification.

Rules: element symbols (start uppercase), `+`/`-`, digits; a sign followed by a symbol =
a new term (whether the sign is the current symbol's count or a new term's sign depends
on what follows: `-1` → a negative count of the current symbol; `-N` → the new term N
-1); spaces allowed between any tokens. Ambiguity analysis in Appendix A: the two
syntaxes have zero conflicts on real corpora.

Verification: corpus tests = 20 entries from the built-in table + real UNIMOD
composition strings (20 sampled, incl. Se/I/Cl/negative counts). **UNIMOD → external
mods bridging with zero normalization**: `{name, formula: "Br H -1"}` works directly.

### 5.2 Element table expansion

`element_monoisotopic_mass` has only 10 elements. Switch to the element mass table in
`chemical_elements` (covering all ~40 UNIMOD elements), keeping the local table only for
C H N O S P plus explicit overrides where UNIMOD deviates; unknown element → explicit
error `UNSUPPORTED_ELEMENT`, never a silent approximation.

### 5.3 Position tracing

`ParsedModification` gains `position`: `"nTerm" | "cTerm" | "residue:<1-based>"`. The
feasibility cross-check between mass-shift hypotheses and UNIMOD specificity
(site/position) is done by layer C; the position field is its input. Backward
compatible: the wasm output gains one field, breaking no old parses.

Syntax: `@site` forms such as `[Acetyl@K4]` (residue position) and `[UNIMOD:7@K]`
(residue-level, any position) parse the position directly; `@` accepts a residue letter
(recording `residue:<N>` with the actual letter + N) or a position number only. The
residue letter serves layer C's cross-check against specificity.site.

### 5.4 Parser convergence: a single chemistry kernel + a UniMod-aware wrapper

| | Rust `parse_proforma` (core) | Rust `proforma_unimod.rs` (non-wasm) |
|---|---|---|
| Duty | **chemical truth**: composition, mass, net change, elements | **reference resolution**: `[UNIMOD:n]`/`[USER:n]`, names → records, average mass, rewriting |
| Dependencies | no UniMod data (wasm-usable) | in-memory UniMod records + `parse_proforma` |

Layering: the core **embeds no UNIMOD** (D14, wasm boundary — the core is compiled into
wasm and cannot depend on the non-wasm UniMod table); `proforma_unimod.rs` compiles only
non-wasm, resolves tags → injects the hit record's composition as external mods → hands
off to `parse_proforma` for mass and composition. `[UNIMOD:120]` errors directly in the
core with a hint to "resolve via the reference layer, then inject". This extends the
layering decision (don't reimplement what can be looked up) to chemical truth, and also
explains why two traversal layers exist: the core layer must stay free of UniMod
dependencies while the reference layer does name resolution on top of it; chemical truth
always stays single (`parse_proforma`).

**Implemented (2026-08-02, all moved into Rust with D12-R)**:
`src/proforma_unimod.rs::resolve` does name/UNIMOD resolution, average mass, and
rewriting; exact chemistry goes to `parse_proforma`; CLI `parse-proforma --db` is
self-sufficient; TS `proforma.mass` became a CLI subprocess; `proforma-mass.ts`/
`unimod-index.ts` deleted. **Mass precision change**: the monoisotopic mass is now the
exact sum of element masses (e.g., Oxidation 15.9949146), no longer UNIMOD's rounded
delta — convergence test tolerances aligned to 4 decimals. `reference-command-port.test.ts`
14 pass (all via the CLI), including the same-mass assertion for `[Formula:Br-H]` and
`[Bromo]` (previously Formula: threw `PROFORMA_MODIFICATION_UNSUPPORTED` in Node).

### 5.5 mass-only modifications

`[+77.9105]` / `[-18.0106]`: exact mass, no composition (warning). A numeric increment
carries no element information and cannot enter the composition — `parse_proforma` adds
its mass into `monoisotopicMass` and flags a `mass-only` warning; both `theory`
(anchored defaults to that exact monoisotopic mass) and `refine-shift` reflect the mass
into **absolute coordinates** (`anchored.centerMasses` / `refinedMass`), but the isotope
**shape** remains that of the base composition: a numeric increment cannot change
M+2/M0. Isotopic doublet discrimination (Br vs Phospho's M+2/M0) must use
composition-bearing tags: `[Bromo]` / `[Phospho]` / `[Formula:Br-H]`. Composition-first
unchanged (P0-a); mass-only is an explicit degradation of "exact mass, inexact shape"
(with a warning), not a silent approximation.

## 6. Capability 3: UNIMOD search with mass-shift settings

### 6.1 Composition constraints (one rule for both consumers)

`by-mass` gains:

```text
--contains <SYMBOL[,SYMBOL...]>   # positive count of the element ≥ 1 (e.g., Br, Se, S)
--excludes <SYMBOL[,SYMBOL...]>   # count of the element == 0
```

Composition parsing = the element-count view of the §5.1 unified syntax (a small helper
function, one each in Python/TS, the rule defined once by the syntax doc). Sorting keeps
the existing `delta_da` ascending + feasible/approved first.

Use case: Br analysis — `--contains Br --excludes P` collapses 1560 records to the
halogen cluster; at Δ=77.91, Br (77.9105) versus combinations like Chloro+Iodo becomes
immediately visible.

### 6.2 Output contract (bridging refine-shift)

Hits already carry `composition` (the raw UNIMOD string) → injected directly as the
external mods' `formula` (zero conversion after the §5.1 syntax unification). A
`net_formula` field was added (normalized, for human reading). The TS `searchByMass`
gains the same filters (`UniModFilters.contains/excludes`).

### 6.3 Data source: a single Rust kernel, dual-source labeling (decided 2026-08-01, D12-R)

**Reference-data queries moved into Rust (implemented 2026-08-02)**:
`unimod_lookup.py` (and `uniprot_fetch.py`/`psimod_lookup.py`) were long deleted; as of
2026-08-02 the TS retrieval logic (`unimod-store`/`unimod-search`/`unimod-combination`)
and proforma name resolution (`proforma-mass.ts`/`unimod-index.ts`) are all deleted; the
single query kernel is in Rust (`src/unimod.rs` + `src/proforma_unimod.rs`); the CLI
exposes the query commands; `tdease.unimod.query`/`tdease.proforma.mass` became thin
CLI-subprocess adapters; TS has zero sqlite access to unimod.

- **Single data truth**: the CLI reads `unimod.sqlite` (read-only, official; located via
  `--db` or `$TDEASE_SYSTEM_ASSETS`) + an optional `user-mods.sqlite` (`--user-db`,
  `USER:n`); `build-unimod-database.mjs` schema v2 remains the official file's builder
  (data building in JS, querying in Rust). Dual-source implemented (D17)
- **Provenance**: digest = the sqlite file's own sha256; `source` carries sourceSha256 +
  schemaVersion + release; the official file is never written
- **Composition constraints**: `contains/excludes` in the Rust kernel (reusing the §5.1
  unified net-formula syntax `split_net_formula`); stable-isotope prefixes (`2H`/`13C`)
  fold into the base element; `dHex`-style sugar abbreviations are treated as empty
  elements (same semantics as TS parseComposition)
- **Python no longer has a database channel**: skills call `tdeasenexus-toolbox unimod-search` or
  `unimod-batch-search` directly (PATH short name), read no database, and go through no
  agent relay

### 6.4 Query command surface (CLI, implemented 2026-08-02; uniprot stays TS (D18), not in the CLI)

| Command | Input | Output |
|---|---|---|
| `unimod-search` | `--text <s>` or `--mass <F> --tolerance <da\|ppm>`, `--contains/--excludes`, `--residues`, `--approved`, `--limit` | `{source, matches, massMatches}` with 8-level ranking reasons |
| `unimod-batch-search` | `--input <json>`, each item `{id,mass,tolerance}`; filter parameters shared globally | `{source, queries:[{id,mass,tolerance,massMatches}]}`; the database is loaded only once |
| `unimod-get` | `--id <n>` or `--title <s>` | `{source, record}` (incl. unimodId + specificities) |
| `unimod-solve` | `--target-mass <F> --tolerance`, `--max-modifications`, `--max-distinct`, `--no-allow-repeated`, `--fixed-mod <TITLE\|ID[:COUNT]>` (repeatable; pinned mass leaves the target, every candidate reports those members `"fixed":true`, unknown/filtered-away pins are query errors), `--limit` | `{source, candidates, ...}` absolute ppm sorting + completeness |
| `parse-proforma --db` | `--proforma <s> --db <path>` | `{source, proforma, sequence, monoisotopicMass, averageMass, modifications, reason}` (name/UNIMOD resolution, exact chemistry) |
| `unimod-residues` | — | `{source, aminoAcids}` |
| `unimod-add` | `--user-db <db> --title --formula [--mono-mass --sites]` | writes `user-mods.sqlite` (custom, `USER:n`; the official one never written) — **implemented (D17)** |
| `uniprot-get/query/map/note/revise` | same as the TS commands | the TS read-through store is kept (D18: stays TS, not in the CLI); `note/revise` deprecated, moved to Workspace Evidence (D21) |

Query commands share the same contract envelope as the computational commands (JSON
stdout / code:message / --schema).

## 7. Python integration

### 7.1 shim: `tdease_ms.py` (pure stdlib, zero PEP 723 dependencies) **[implemented 2026-08-01 stage 4]**

`data/system/skills/ms-reference/scripts/tdease_ms.py`: `run(command, *args, **flags)`;
dict/list flag values (observed/mods) are automatically written to temp JSON files and
passed as paths; located via the managed PATH, raising `TdeaseMsError(code)` on failure;
forced UTF-8 decoding on Windows; schemaVersion validation. Temp JSONs for dict/list
flags go to the system temp directory and are deleted when the call ends (an
inter-process envelope for a single call, not durable scratch — see §16 honest
labeling); durable intermediate artifacts are written by the skill explicitly via `--out`
into `runs/<run>/analysis/<slug>/`.

```python
import subprocess, json, os

def run(binary_cmd, *args, **kw): ...
# - locate: shutil.which("tdeasenexus-toolbox") → report MISSING_BINARY
# - subprocess.run([bin, cmd, ...], capture_output=True, check=False)
# - parse stdout {metadata, result}; stderr {error} → raise TdeaseMsError(code, message)
# - validate schemaVersion; unknown versions explicitly report SCHEMA_MISMATCH
```

Pure stdlib → takes no wheelhouse space, works offline, importable by any skill.

### 7.2 Runtime injection

`skill_runtime.cjs` puts the managed bin first on the bash subprocess PATH. Python
scripts use the same short command via `shutil.which("tdeasenexus-toolbox")`, never guessing the
binary location.

### 7.3 Example: the exhaustive mass-shift loop (the coded shape of §4.4)

```python
env  = ms.run("envelope", file, "--mz", mz, "--charge", z, "--out", tmp_env)
base = ms.run("refine-shift", file, "--observed", tmp_env, "--proforma", seq)
# search = CLI unimod-search (PATH short name, Rust kernel; D12-R implemented).
candidates = ms.run("unimod-search", "--mass", str(base["result"]["refinedShift"]),
                    "--tolerance", "20", "--contains", "Br")["result"]["matches"]
ev = mass_shift_analysis(file, "--observed", ..., "--candidates", json.dumps(candidates))
# the skill refines each candidate, collecting pearson/coverage/residual RMS → evidence ranking;
# ambiguity → report the floor
```

## 8. Packaging

| Deployment | Distribution | Injection |
|---|---|---|
| Desktop | build → `.scratch/native/<platform>/tdeasenexus-toolbox(.exe)` → extraResources → `resources/native/` → startup prestaging copies into `agentRoot/tools/` | a bash PATH prefix (managedBinDir) exposes the short name `tdeasenexus-toolbox` |
| Server | the binary ships with the backend package (same version, same JSON contract) | the deploy script puts the binary into the controlled process PATH, never touching the system PATH |

- Windows: Rust statically linked, no DLL dependencies (verified at build time via
  `dumpbin /dependents` or an equivalent check); the `.exe` suffix is appended by the
  build script per platform.
- No PATH writes, no touching the user environment (the app carries its own
  environment).
- Versioning: CLI `--version` = `env!("CARGO_PKG_VERSION")`; the release packaging gate
  executes the copied binary directly.

## 9. Boundaries (what the CLI does not do)

- PTM candidate ranking, UniProt motif biology judgment, workflow orchestration,
  paper-style conclusions, case-specific thresholds — layer C duties. The CLI only
  produces **evidence** (calibrated m/z, residuals, pearson/coverage, ambiguity).
- UNIMOD retrieval/name resolution belongs to the Rust core + CLI; the TS layer B only
  does subprocess referencing, reading no database.
- Plotting — skills (Python matplotlib), with data self-contained via `--plot-data`-style
  JSON.

## 10. Consistency assurance (tests)

1. **Divergence tests** (tests/cli_contract.rs): the same fixture, the core function
   called directly vs a `CARGO_BIN_EXE_tdeasenexus-toolbox` subprocess; the result JSON is
   byte-identical (except elapsedMs). This is the executable proof that "the CLI is not
   a second algorithm set".
2. **Fixture regressions**: histone48-scan1157-z14 (Br, 11393.33, offset 0),
   chlamy-h4-scan4113-z11 (11411.315) — CLI refine-shift reproduces the wasm-verified
   numbers.
3. **Syntax corpus tests**: the built-in table + real UNIMOD composition strings (incl.
   `Br H -1`, `H -1 N -1 O 1`, Se/I/Cl).
4. Every native module gets a regression, otherwise "built-in" degrades back into
   "rewrite".

## 11. Implementation status

Stages 1-6 all implemented (2026-08-02): the CLI skeleton and unified net-formula
syntax; `spectrum`/`envelope`/`fit-envelope`/`refine-shift`/`--schema`; UNIMOD
composition constraints; the `tdease_ms.py` shim and packaging wiring; the
loop-skill capability, now split into `tdp-opensearch` + `tdp-copilot`
(Br fixture validated: Δ calibration → UNIMOD search → candidate
refine-shift verification → mass-error ranking + honest floor triggering);
the old dev bins deleted and name resolution moved into
Rust. **Experience**: a candidate's verification prior_shift must equal that candidate's
Δ (0 pulls the fit toward the unmodified mass, offset biased by -3); MS1 shape is a weak
discriminator (large proteins); the floor threshold is aligned to measurement noise
(2×RMS); `fitted_da` is a shared sub-Da calibration offset, not a separation criterion
(§4.3).

## 13. Dual-source modifications (official + user, implemented 2026-08-02)

**Never write the official file.** `data/system/reference/unimod.sqlite` is a read-only
projection shipped per release (CLAUDE.md: System is a read-only source shipped with the
release); "privately controllable" is satisfied by an **independent user store**, and
search **returns all sources, with no override priority**:

| Source | ID space | Location | Writer |
|---|---|---|---|
| `UNIMOD` | `UNIMOD:n` | Product `reference/unimod.sqlite` (read-only) | official release |
| `USER` | `USER:n` | User System `system/reference/user-mods.sqlite` (writable) | personal extensions |

- **Write**: CLI `unimod-add` (`--user-db` → `--title --formula [--mono-mass --sites]`)
  appends; every entry must carry a net formula (preserving the "exact composition"
  invariant). User ids use the `USER_OFFSET=1_000_000` offset, isolated from the
  official `UNIMOD:n` space.
- **Retrieve**: hits carry `source: 'unimod' | 'user'` + `custom: true` (user); the
  official file's digest keeps the released value; the user store has its own digest.
  CLI `--user-db` names the user store (the TS port always passes
  `<writableReferenceRoot>/user-mods.sqlite`; absence is treated as an empty source).
- **Same-name rule**: a same-name dual source is **not** a priority adjudication —
  search returns all; **ProFormA parsing hitting a same-name dual source = hard error**
  (`PROFORMA_MODIFICATION_AMBIGUOUS`), requiring explicit `[UNIMOD:n]` or `[USER:n]`,
  never silently picking one (floor rule, AGENT-CONTRACT §2: on insufficient evidence,
  output the floor).
- **Consumers**: the Rust kernel merges both sources (CLI `unimod-search`/
  `parse-proforma --db`); the Agent goes to the CLI directly on controlled bash
  (the TS adapters were removed 2026-08-25), Python likewise — all consuming
  the same rule.

## 14. Why reference-data queries went into Rust (D12-R)

**The database is a file, not a layer.** `unimod.sqlite` / `user-mods.sqlite` are shared
data files; the real question is **where the code that queries them lives**, and the
answer is Rust (the CLI).

- **Queries must serve the CLI**: the first step of the mass-shift loop (candidate
  sourcing) is an external script calling `tdeasenexus-toolbox unimod-search` directly — the query
  kernel is part of the CLI, locked into Rust; keeping another retrieval implementation
  in TS would be a dual implementation.
- **The open surface demands unified source labeling**: with dual-source merging +
  `source`/`custom` labeling in TS while the consumer is the CLI, the rule would have to
  be copied; a single kernel lets the CLI and TS consume the same rule (§6.4).
- **The hot path is abandoned**: the many-and-frequent in-process query shape was
  replaced by subprocesses; even proforma name resolution moved into Rust (D19, final),
  and since 2026-08-25 the model itself runs the CLI on bash — no TS query path remains.
- **The UniProt exception (D18)**: it lacks UniMod's chemical coupling
  (network+cache+projection) and stays in TS.

**Preserved invariants**: the official file is never written (digest provenance);
`USER:n` ID isolation; no silent same-name override; the database remains a shared file
— built in JS (`build-unimod-database.mjs`), queried in Rust.

## 15. The Python slimming principle (iron law once tdeasenexus-toolbox is live, decided 2026-08-01)

> No Python skill script may contain physics constants, AA mass/composition tables, an
> isotope engine, or proforma chemistry parsing. These must go through the `tdeasenexus-toolbox`
> CLI. Scripts only orchestrate.

**Motivation: the multiple-truths disease.** `isoforma/quantify.py` contained a third AA
composition table + its own `PROTON=1.007276467`/`C13_DELTA=1.003355` + `brainpy` (a
second isotope engine) — three copies of the same physical fact with slightly different
values. envelope.rs's old CHNOSPBr convolution is already deleted; quantify.py is a
remaining lesion of the same kind.

**Absorption targets (eliminate one by one along this path):**

| Script | Physics today | Destination |
|---|---|---|
| `isoforma/quantify.py` | discrimination matrix + adjacent cumulative-ratio solving + brainpy isotopes | absorbed into kernel A (IsoForma absorbed); isotopes via Rust theory |
| All scripts | AA mass/composition tables, PROTON/NEUTRON constants | use the Rust `parse_proforma`/`fragment` residue tables; constants come from `constants.rs` |
| All scripts | isotope theory (theoretical spectra, envelopes) | via Rust `theory.rs` / `envelope` |

**Kept (not "hard to maintain so absorb", but genuinely belonging there):**
interpretation/orchestration/knowledge tables/plotting — the batch role lives in
`tdp-opensearch`, `toppic-suite` (reads TopPIC output, census),
`_plot.py` (data alongside figures, shared in `reference/scripts/`). **Deleted**:
`unimod_lookup.py`/`uniprot_fetch.py`/`psimod_lookup.py` (D12-R: the query kernel moved
into Rust; Python queries the CLI directly). The scripts Python keeps call the layer A
CLI only via `tdease_ms.py`, never reading the database.

**Criterion:** do the numbers or algorithms in a script "have to agree in many places"?
Yes → absorb into Rust; do they "change with the analysis scenario"? Yes → keep in
Python. Physics frozen in Rust, interpretation iterating in Python.

## 16. Middleware protocol: the run analysis workspace (`analysis/`)

The CLI is a one-shot process with no in-memory interaction — **files are the
Python↔Rust communication channel**. Directory conventions, scratch-until-cited, no env
injection, never into declared I/O/submissions: the sole authority is
`docs/spec/FILE-LAYOUT.md` §4.2 (`runs/<run>/analysis/<slug>/`, incl.
`SUBMISSION_EXCLUDED_PATHS`, implemented).

**Honest labeling**: the shim's (§7.1) dict/list flag temp JSONs stay in the system temp
directory and are deleted when the call ends, and do **not** enter analysis/ — they are
an inter-process envelope for a single call, not durable scratch. Only stable
intermediate artifacts like `--out` belong to `analysis/<slug>/`.

## 17. CLI placement and short-name invocation (decided 2026-08-01, D16)

**Goal**: any invocation inside a workspace (bash sandbox, Python external scripts, TS
agent tools) uses the **shortest name** `tdeasenexus-toolbox`, with no absolute paths and no
reliance on exact env paths.

**Mechanism: the managedBinDir unified bin + a bash PATH prefix.** The bash sandbox's
spawn env already puts `managedBinDir` (=`agentRoot/tools/`) as the first PATH entry
(existing; uv is executable by short name for the same reason). The CLI enters the same
directory:

```text
agentRoot/tools/              ← managedBinDir, already first on the bash PATH
├─ uv(.exe)                   ← existing: short name `uv`
├─ tdeasenexus-toolbox(.exe)            ← new: short name `tdeasenexus-toolbox`, directly executable inside the bash sandbox
├─ rg(.exe) / fd(.exe)        ← D22: packaged search tools, short names `rg`/`fd`
└─ python / python3           ← uv shim
```

- **bash**: `tdeasenexus-toolbox envelope …` works directly — zero absolute paths, zero exact env
  paths.
- **Python external scripts**: inherit bash's controlled PATH →
  `shutil.which("tdeasenexus-toolbox")` hits.
- **TS agent tools**: go through the CLI subprocess, same short name.
- **The user machine's PATH untouched** (the app carries its own environment).

**Physical flow**: source build `build:native:cli` → `.scratch/native/<platform>/tdeasenexus-toolbox(.exe)`
→ packaging `resources/native/` → runtime init copies the binary into `agentRoot/tools/`
(same mechanism as uv's placement). Windows copies (avoiding symlink permissions).

**Implemented (2026-08-02)**:
- `skill_runtime.cjs` gained `ensureNativeCli({isDev, toolsDir})` — idempotent
  prestaging (copies only when the target is missing/size changed/source updated), with
  a `source` injection parameter for tests; `resolveNativeCliSource` uses
  `resources/native/` for packaged and `.scratch/native/` for dev, returning null when
  the source is missing (does not block startup).
- `runtime_config.cjs` exposes `agentToolsRoot` (`<system>/agent/tools`) and ensures the
  directory exists; `agent-runtime.ts` `managedBinDir` accepts injection (default
  `<agentDir>/tools`).
- `main.ts` prestages `ensureNativeCli` at startup; ToolGateway puts managedBinDir first
  on the bash PATH.
- Tests: `electron/skill_runtime.test.cjs` (copy/idempotency/rebuild-represtage/
  missing-source skip/minimal env) + `tool-gateway-skill-bash` short-name end-to-end (a
  fake `tdeasenexus-toolbox` in managedBinDir is hit directly by `bash` as `tdeasenexus-toolbox`).

**Unverified**: smoke test of binary prestaging under a real packaged install (needs
`build:native:cli` + a packaging environment). Covered at the unit level: prestaging
logic, PATH-prefix short name, env pointing at the same copy.

---

## Appendix A: unified net-formula syntax ambiguity analysis

The only surface conflict between the two syntaxes is "a symbol followed by `-N` vs
`-1`":
- `-1` (a digit) can only be a **negative count of the current symbol** (a digit is not
  an element name)
- `-N` (a letter) can only be a **new term N with the symbol -1** (N is not a digit)

`H -1` (UNIMOD) = H×-1; `H-N` (net) = H×+1, N×-1; `H-2` (extended) = H×-2. The three are
mutually unambiguous. `+`/`-` followed by neither symbol nor digit → syntax error.
Corpus tests lock this invariant.
