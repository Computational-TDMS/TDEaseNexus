---
type: design
title: tdeasenexus-toolbox system-level native adapter + the mass-shift analysis loop
description: Rust mass-spec kernel design rationale, decision table, packaging and distribution. Contract facts live in spec/RUST-MS-CONTRACT.md.
status: implemented
---

# tdeasenexus-toolbox: system-level native adapter + mass-shift analysis loop

> **Where the contract lives.** The binding invocation rules — CLI envelope
> and streams, output-format policy, the SELECT predicate grammar, the unified
> net-formula syntax, the ProFormA two-value model and layering, dual-source
> modifications, the Python slimming iron law, and the managedBinDir sole
> invocation surface — are owned by `docs/spec/RUST-MS-CONTRACT.md`
> §"CLI invocation contract" (distilled there 2026-10-12). This document keeps
> the design rationale, the decision table, the capability semantics and the
> packaging story. Dated revision narratives and stage logs live in
> `archive/docs-prune-2026-10-12/`.

Status: **implemented** — 24 commands (16 computational + 7 unimod
(`get/search/batch-search/solve/batch-solve/residues/add`) + `schema`),
including the MS2 measurement surface (`fragment` match/compare over
mzML, msalign or saved observations with batch scan selection,
`envelope-regions` window extraction) and batch forms
(`envelope-windows`, `refine-shift-batch`, unimod batch,
`isotopic-batch`); divergence tests frozen in;
UniMod queries + ProFormA parsing in the Rust kernel; the CLI ships as a
managedBinDir short name (D16); TS has zero unimod sqlite; the frontend Studio
commands `spectra.*`/`unimod.query`/`proforma.mass`/`skill.list` were removed
(2026-08-25) — the CLI on controlled bash is the sole chemistry/reference
surface, UniProt (`uniprot.*`) remains a Studio command family. The copied
release CLI runs schema + a TopPIC exact-mass smoke in a working directory
outside the repo and only enters Electron packaging after passing.

## 0. Decision summary

| # | Decision | Rationale |
|---|---|---|
| D1 | Layer A = one Rust kernel, one delivery surface: the `tdeasenexus-toolbox` CLI serves both the Electron agent and Python/system | Single process boundary, single JSON contract, single packageable artifact |
| D2 | The CLI lives in the same crate as lib (`src/bin/tdeasenexus-toolbox/`), doing only argument and JSON adaptation, zero new algorithms | "The CLI is not a second algorithm set" is guaranteed structurally, not by discipline |
| D3 | CLI command surface = 24 commands (16 computational + 7 unimod + schema); computational commands only project existing core capabilities | No new algorithms invented |
| D4 | Each invocation: one JSON envelope on stdout; errors as stderr JSON `code/message`; `--help` is the interface doc; one-shot process | Same shape as the skill contract (interaction contract in AGENT-CONTRACT §5) |
| D5 | `refine-shift` supports `--observed` to reuse an extraction result | The exhaustive mass-shift loop extracts the envelope once and does only theory+fit for N hypotheses |
| D6 | `refine-shift` outputs a **boundary verdict**: when two candidates are inseparable it reports `ambiguity` instead of forcing a pick | Floor rule (AGENT-CONTRACT §2): when evidence is insufficient, output the floor, not first place |
| D7 | Unified net-formula syntax (a superset): both `Br-H` and UNIMOD's `Br H -1` parse directly | UNIMOD → proforma bridging with zero normalization |
| D8 | The single chemical truth = Rust `parse_proforma`; name resolution converges in Rust `proforma_unimod.rs` | Two parsers with different semantics is a defect |
| D9 | UNIMOD mass-shift search = the existing by-mass + `--contains/--excludes` composition constraints; both consumers share one rule + cross tests | Δ → composition constraint → hypothesis |
| D10 | Binaries ship with the package, copied into the managed bin at startup; only the bash subprocess PATH is modified | The app carries its own environment, never touching the user's machine |
| D11 | Consistency frozen by tests: CLI vs core contract tests + real TopPIC fixture regressions + syntax-corpus tests | The CLI projection and the kernel invariants must be executably verified |
| D12-R | **Reference-data queries move into Rust**: unimod retrieval/ranking/combination in the Rust kernel (`src/unimod.rs`); the CLI exposes `unimod-search/get/solve/residues/add` + `parse-proforma --db` | Queries must serve the CLI (the sole external surface); a single kernel outranks business agility; kills the dual implementation |
| D14 | ProFormA format normalization: every tag → exact composition, or mass offset + warning; `@site` positions supported; `[UNIMOD:n]` resolved by the reference layer then injected, the core embeds no database | Multi-format compatibility unified into two values; traceable positions; don't reimplement what can be looked up |
| D15 | **The sole native delivery surface = the `tdeasenexus-toolbox` CLI** | Narrows the open surface: one kernel, one native artifact |
| D16 | **CLI physical location = `agentRoot/tools/` (managedBinDir), short name via a bash PATH prefix** | Zero absolute-path invocations; the app carries its own environment |
| D17 | **Dual-source modifications**: `UNIMOD` (official, read-only) + `USER:n` (writable). Search returns all sources, no override priority; same-name ProFormA parse = hard error (`PROFORMA_MODIFICATION_AMBIGUOUS`) | Asset provenance visible; on insufficient evidence output the floor, never silently adjudicate |
| D18 | **UniProt stays in TS (final)**: network/snapshot/projection remain a TS read-through store | UniMod moved for chemical coupling; UniProt has none, the ROI is low, the contract is mature |
| D20 | **Three-tier asset system + the CLI short name is not an asset**: the official UniMod data belongs to the CLI binary itself; a Workspace must not provide a same-name binary | Official chemical truth ships with the sole native artifact; the managed short name is the identity truth |
| D21 | **`uniprot.note/revise` deprecated, moved to Workspace Evidence** | User judgment is not a reference feature; duties returned to their right places |
| D22 | **Search tools rg/fd ship with the package + managedBinDir short names** (rg 15.2.0 / fd 10.4.2, pinned, dual sha256; `PI_OFFLINE=1` forbids runtime download) | On a clean machine/offline, the first grep/find does not depend on runtime network; versions deterministic across machines |

## 1. Architecture

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
        │  │   (unimod.sqlite compiled in + user-mods.sqlite writable)  │
        │  └─ tdeasenexus-toolbox CLI → the sole native delivery surface (computation + queries) │
        └───────┬────────┘
        ┌───────┴────────┐
        │ Layer B reference (TS, references only, never implements)                │
        │   tdease.uniprot.* (D18: network+cache+projection, stays in TS)           │
        │   chemistry reaches Layer A through the CLI on controlled bash            │
```

The Agent runs the CLI itself on controlled bash (the TS thin adapters went
away 2026-08-25); Python/skills read no database and query the CLI directly.

## 2. Capability semantics (refine-shift)

- Hypothesis sources: `--proforma` (preferred, exact composition) /
  `--sequence-mass + --mod-mass` (legacy calibration-only path, average
  approximation, outputs a warning; chemistry adjudication never sees it).
- The three P0 fixes are in core: `--mz` locates the extraction anchor, the
  theoretical side anchors absolute coordinates, `--match-window-ppm`
  independent.
- `--observed` reuse (D5): N hypotheses = 1 extraction + N pure computations —
  the extraction anchor `window_center` depends only on `mz`/`prior_shift`, not
  on the hypothesis, so the reuse is valid.
- **Boundary verdict**: `RefineMassShiftResult.ambiguity` is `"not separated"`
  when runner-up and best have equal `matched_peaks` and
  `|refined_mass_runner − refined_mass_best| < 0.5 Da` (half a neutron). Aligned
  with the floor rule (AGENT-CONTRACT §2): `best` is still given, but
  `ambiguity` declares it untrustworthy.
  Experience: `fitted_da` is **not** a separation criterion — it is a shared
  sub-Da calibration offset, nearly constant across integer offsets; the real
  criterion is `refined_mass` (adjacent offsets differ by 1.003 Da). The
  half-neutron threshold triggers only for truly degenerate fits; clean data
  does not false-positive.

### The exhaustive mass-shift loop (layer C orchestration, contract)

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

Step 2's search = the CLI (Rust kernel; Python calls it via the PATH short
name); steps 3/4's verification, ranking, thresholds and conclusions are layer C
skill duties — the CLI only produces evidence (§4). The skill can also accept a
candidate JSON passed by the agent (`--candidates`); both entrances share the
same semantics.

## 3. Python integration

### 3.1 shim: `tdease_ms.py` (pure stdlib, zero PEP 723 dependencies)

`data/system/skills/ms-reference/scripts/tdease_ms.py`: `run(command, *args,
**flags)`; dict/list flag values (observed/mods) are automatically written to
temp JSON files and passed as paths; located via the managed PATH, raising
`TdeaseMsError(code)` on failure; forced UTF-8 decoding on Windows;
schemaVersion validation. Temp JSONs go to the system temp directory and are
deleted when the call ends — an inter-process envelope for a single call, not
durable scratch; durable intermediate artifacts are written by the skill
explicitly via `--out` into `runs/<run>/analysis/<slug>/` (contract:
`FILE-LAYOUT.md` §4.2). Pure stdlib → takes no wheelhouse space, works offline,
importable by any skill.

`skill_runtime.cjs` puts the managed bin first on the bash subprocess PATH;
Python scripts use the same short command via `shutil.which`, never guessing
the binary location.

## 4. Packaging

| Deployment | Distribution | Injection |
|---|---|---|
| Desktop | build → `.scratch/native/<platform>/tdeasenexus-toolbox(.exe)` → extraResources → `resources/native/` → startup prestaging copies into `agentRoot/tools/` | a bash PATH prefix (managedBinDir) exposes the short name |
| Server | the binary ships with the backend package (same version, same JSON contract) | the deploy script puts the binary into the controlled process PATH, never touching the system PATH |

- Windows: Rust statically linked, no DLL dependencies (verified at build time);
  the `.exe` suffix is appended by the build script per platform.
- No PATH writes, no touching the user environment.
- Versioning: CLI `--version` = `env!("CARGO_PKG_VERSION")`; the release
  packaging gate executes the copied binary directly.

## 5. Boundaries (what the CLI does not do)

- PTM candidate ranking, UniProt motif biology judgment, workflow orchestration,
  paper-style conclusions, case-specific thresholds — layer C duties. The CLI
  only produces **evidence** (calibrated m/z, residuals, pearson/coverage,
  ambiguity).
- Plotting — skills (Python matplotlib), with data self-contained via
  `--plot-data`-style JSON.

## 6. Consistency assurance (tests)

1. **Divergence tests** (tests/cli_contract.rs): the same fixture, the core
   function called directly vs a `CARGO_BIN_EXE` subprocess; the result JSON is
   byte-identical (except elapsedMs). The executable proof that "the CLI is not
   a second algorithm set".
2. **Fixture regressions**: histone48-scan1157-z14 (Br, 11393.33, offset 0),
   chlamy-h4-scan4113-z11 (11411.315).
3. **Syntax corpus tests**: the built-in table + real UNIMOD composition
   strings (incl. `Br H -1`, `H -1 N -1 O 1`, Se/I/Cl).
4. Every native module gets a regression, otherwise "built-in" degrades back
   into "rewrite".

## 7. Why reference-data queries went into Rust (D12-R)

**The database is a file, not a layer.** `unimod.sqlite` / `user-mods.sqlite`
are shared data files; the real question is **where the code that queries them
lives**, and the answer is Rust (the CLI).

- **Queries must serve the CLI**: the first step of the mass-shift loop is an
  external script calling `tdeasenexus-toolbox unimod-search` directly — the
  query kernel is part of the CLI, locked into Rust; another retrieval
  implementation in TS would be a dual implementation.
- **The open surface demands unified source labeling**: with dual-source
  merging + `source`/`custom` labeling, a single kernel lets the CLI and any
  consumer share the rule.
- **The UniProt exception (D18)**: it lacks UniMod's chemical coupling and
  stays in TS.

## Appendix A: unified net-formula syntax ambiguity analysis

The only surface conflict between the two syntaxes is "a symbol followed by
`-N` vs `-1`":
- `-1` (a digit) can only be a **negative count of the current symbol** (a digit
  is not an element name)
- `-N` (a letter) can only be a **new term N with the symbol -1** (N is not a
  digit)

`H -1` (UNIMOD) = H×-1; `H-N` (net) = H×+1, N×-1; `H-2` (extended) = H×-2. The
three are mutually unambiguous. `+`/`-` followed by neither symbol nor digit →
syntax error. Corpus tests lock this invariant.

## Alternatives considered

- **wasm as a second delivery surface (D1's original wording)**: lost — the
  renderer had zero wasm consumption points and every caller converged on the
  CLI subprocess; the wasm target still builds lib only, unaffected.
- **TS reference adapters (`tdease.unimod.query`/`tdease.proforma.mass`)**:
  lost — after the query kernel moved into Rust they were dual
  implementations; removed 2026-08-25 together with the `spectra.*` family.
- **Keeping the official sqlite as a referenced file** (resolved via
  `TDEASE_SYSTEM_ASSETS`): lost — production queries now release a
  digest-verified copy compiled into the CLI (2026-08-12), removing the System
  path dependency; `--db` remains a dev/contract-test entry.
