# Node packages (`data/backend/nodes/`)

Operational note — not authority. Node **binaries** are git-ignored by design
(`.gitignore: data/backend/*`): large, licensed or redistributable trees that
never enter git. The practice-built **definition layer** (per-node
`rules.smk`/`README.md`/wrappers, the definition-only `pride`/`topindex`
nodes) **is git-tracked** since 2026-08-31 via explicit
`.gitignore` exceptions. This document is the durable inventory; `STATUS.md`
records what is deployed today. If the tree is lost, restore the definition
layer with `git checkout -- data/backend/nodes/` and redeploy the binaries
from the sources below; re-verify against this file.

## Inventory

Paths are relative to `data/backend/`. `nodes/` is the Backend compute-software
root —
the only tree the catalog scans; `archive/` holds non-node installs that
must stay outside it (see the note below the table).

| Directory | What it is | Version | Source it was recovered from | Who uses it |
|---|---|---|---|---|
| `nodes/toppic/` | TopPIC Suite runtime: `topfd.exe`, `toppic.exe`, `topmg.exe`, `topdiff.exe`, `topindex.exe`, `topdia.exe` + GUIs + Qt/boost runtime DLLs | 1.8.1 (authoritative; the rules.smk parameter contract was calibrated against 1.8.0 — CLI unchanged between the two) | Official `toppic-windows-1.8.1.zip` (downloaded 2026-08-29; zip kept next to it, deletable once extracted) | Run Snakefiles resolve `<tools-root>/toppic/topfd.exe` (see below) |
| `nodes/msconvert/` | ProteoWizard (RAW → mzML conversion) | 3.0.26139 (per provenance sidecar, below) | `C:\msconvert\` | Standalone RAW→mzML conversion; deliberately **not** part of the toppic Run workflow (see the Run Snakefile scope note) |
| `nodes/informed-proteomics/` | MSPathFinderT toolchain: `MSPathFinderT.exe`, `ProMex.exe`, `PbfGen.exe`, `ProMexAlign.exe` + .NET deps | — | `C:\InformedProteomics_Program\` | Cross-tool comparison (EXPLORATION-LOG E13) and the sequence-graph porting reference (E49) |
| `archive/unidec/` | Raw UniDec install: `GUI_UniDec.exe` + `_internal` (PyInstaller bundle) | — | `C:\UniDec_Windows\` | UniDec node was E2E-accepted 2026-08-20; excluded from desktop packaging by decision |
| `pride/` | Definition-only node: `rules.smk` + `fetch.py` (PRIDE archive download) + `README.md` | — | `%APPDATA%\TDEase\backend\nodes\` (2026-07-28 desktop deployment, recovered 2026-08-31) | Workflow-era rule definitions; no binaries, nothing resolves them today |
| `topindex/` | Definition-only node: `rules.smk` + `README.md` (TopPIC `topindex.exe` lives in `toppic/`) | — | `%APPDATA%\TDEase\backend\nodes\` (2026-07-28 desktop deployment, recovered 2026-08-31) | Workflow-era rule definitions; no binaries, nothing resolves them today |
| `_template/` | Copyable node template: `rules.smk` + `README.md`, binds a host-installed tool by install directory (Run config `<id>.bin_dir` first, `DEFAULT_BIN_DIR` second) | — | Authored 2026-09-08 | Users/agents copying a node for a tool that must not be bundled. `_`-prefixed names are templates/drafts and are skipped by the catalog scanner |

Note: `unidec/` is **not a node** — no `rules.smk`, no node id — which is
why it lives in `archive/`, outside the node root. The catalog scanner
(`src/services/node_catalog.py`) treats every directory under the node root
as a node package, except names starting with `_` (templates/drafts, e.g.
`_template/`); a rules-less directory there shows in the catalog
`errors[]` and fails only Runs that bind it (`resolve_bindings` no longer
rejects the whole catalog). `toppic-1.8.0/` was deleted 2026-09-01 by
decision — 1.8.1 is authoritative and CLI-identical; its recovery source
was `C:\toppic-windows-1.8.0\` if a version-faithful re-run is ever needed.

## Node definition layer (`rules.smk`, per-node `README.md`)

Lost in the 2026-08-28 over-deletion incident and recovered 2026-08-31 from
the 2026-07-28
desktop deployment at `%APPDATA%\TDEase\backend\nodes\` (checksum-verified
copies; the deployment inventory record of that recovery was
`.deploy-stamp.json`, retired 2026-09-09 when the digest-snapshot binding
layer went away): `toppic/rules.smk` + `toppic/README.md`,
`msconvert/rules.smk` + `msconvert/README.md`,
`informed-proteomics/rules.smk` + `informed-proteomics/README.md` (recovered
under its deployment-era name `informedproteomics`). These are live Snakemake
rule definitions — Snakemake is the current workflow orchestrator (see
`STATUS.md` Backend). All of the above is git-tracked, so a data/ wipe can
never lose it again.
The unidec node's README/rules were never part of that deployment and remain
lost. The toppic node's built-in variable-PTM library
(`toppic/resources/common_variable_ptms.txt`) was likewise lost in the
over-deletion (absent from both the zip redeploy and the desktop-deployment
recovery) and was rebuilt 2026-09-01 as the **basic routine set** — Acetyl
(K), Phospho (STY), Methyl (KRH), Dimethyl (KRH), Oxidation (M) —
deliberately minimal: a large variable-PTM space makes TopPIC searches
explosively slow (the official tutorial's example `var_mods.txt` ships just
Met oxidation). The file is plain text (TopPIC readModTxt
`Name,Mass,Residues,Position,UnimodID`) with masses and UniMod ids derived
from the system reference `unimod.sqlite`, git-tracked via an explicit
ignore exception so it cannot be lost silently again. The
informed-proteomics node's tracked surface grew 2026-09-02 by the same
logic: the suite-authored `Example_Files/*.txt` (mods/param examples — the
source artifacts a mods library must be derived from) and the TDEase-curated
default targeted library `resources/mspf_targeted_mods.txt` (the Note-15
histone set, bare mods-file syntax, provenance in its header).

## How a node declares compute (threads / resources)

Nodes are portable artifacts; machines are not. The contract
(`docs/spec/WORKFLOW-RUN.md` §1 "Compute envelope") maps the two:

- `threads:` declares the tool's **peak appetite** — what it can usefully
  consume. The engine clamps every job to the Run's core budget at DAG build
  time (`min(declared, budget)`); toppic's `threads: 28` and topindex's `30`
  are appetites, not reservations, and a small machine runs them degraded but
  correct. The resolved value lands in the dry-run projection, so the
  degradation is observable. Never write a machine assumption into a node.
- `resources: mem_mb=` declares a **hard floor** the tool genuinely needs. It
  is never clamped: a floor above the Run budget fails the dry-run with the
  rule name and both values, before any job starts.
- Custom resources capped by the Backend (e.g. `toppic_slots = 1`, which
  serializes TopPIC jobs) behave like `mem_mb`: hard floors against a fixed
  ceiling.

The `_template` node carries this guidance in its header and a
`threads`/`resources` example on its rule.

## How workflows resolve node binaries

A node's `rules.smk` resolves its package directory from **`config["nodes"][<id>]`** —
the absolute catalog path the Backend injects into the engine config at dry-run and
execution. Nothing node-related is written under the Run directory. There is no
candidate-root search and no environment override (the engine strips `TDEASE_*` in
`backend_child_env`): a Run resolves its nodes through the injected binding map, and
the digest a definition records documents the catalog content it was authored against
(the catalog is deployment state; executions follow its current bytes).

One key relocates any node's executables, bundled or not: **`<config-block>.bin_dir`**
in the Run's `config.yaml` (absolute directory; the node owns the executable
names). Unset means the node's own catalog package — the `toppic` package for the
`toppic` node's `topfd`/`toppic` blocks and also for `topindex`
(its executable ships in the toppic suite), the `informed-proteomics` package for the
`informed-proteomics` block, `nodes/msconvert` for `msconvert` (which additionally
discovers a host ProteoWizard when the package has no binary). The active
development root is `data/backend/nodes/`. Packaged desktop installation does
not copy compute software into `resources/backend`; the Backend-owned catalog is
kept in `TDEaseNexus-Data/backend/nodes/`, separate from `TDEaseNexus-Data/system/`, and
is shared by all Backend revisions and Runs.

The Backend node root defaults to `<dataRoot>/nodes`
(`src/backend_settings.py`): with `dataRoot = TDEaseNexus-Data/backend`, it is
`TDEaseNexus-Data/backend/nodes`. An explicit `nodeRoot` must remain under the
Backend data root; the desktop writes the relative value `nodes`. The catalog
is user-manageable: drop in a package, edit a rule, or point a rule at a
host-installed tool, and the next Run binds that content (digest-pinned at bind
time).

For a tool that is installed on the machine and must not be bundled (vendor
installer, site licence, size), `nodes/_template/` is the copyable starting
point: copy it to a normal node id, set `NODE_ID`/`EXE_NAME`/`DEFAULT_BIN_DIR`
and the rule's contract, and the node calls the installed binary from that
directory — the Run config's `<node-id>.bin_dir` overrides the directory per Run,
and the executed command line lands in the Run log. Verified 2026-09-08 by a real
Snakemake run of a copy against host ProteoWizard (42 KB indexedmzML).

## Usage notes

- **TopFD / TopPIC** — parameters are documented where they are used: the Run's
  `Snakefile` (rule contract) and `config.yaml` (original-run parameter
  reproduction comments). Do not duplicate parameter tables here.
- **msconvert** — every converted mzML must ship a provenance sidecar
  (`<name>.mzML.source.json`) next to it; it records the exact invocation.
  The histone48 canonical conversion: `msconvert --mzML --filter
  "peakPicking true 1-" --64 -z` (zlib, 64-bit float mz and intensity,
  centroided), ProteoWizard 3.0.26139.
- **InformedProteomics** — `PbfGen` → `ProMex` → `MSPathFinderT`. RawThermoReader
  requires the Thermo DLLs shipped alongside; run in-place or keep the
  directory intact. Output-name contract is empirical (v1.1.8305, verified
  on the histone48 dataset 2026-09-02): every tool names outputs from the
  INPUT STEM next to its input — `{prefix}.pbf`, `{prefix}.ms1ft` (NOT
  `_ms1.ms1ft`), `{prefix}_IcTarget.tsv` + `_IcDecoy.tsv` + `_IcTda.tsv` +
  `{prefix}.mzid` (with `-tda 1`). Respect the stale-reuse traps: PbfGen
  silently reuses a found `.pbf`; MSPathFinderT with `-overwrite false`
  silently reuses existing `_IcTarget/_IcDecoy` — the node rule passes
  `-overwrite true` by default. Pipeline knowledge (selection, node
  manuals, template walkthroughs) lives in the `tdp-execution` skill.
- **UniDec** — raw upstream install, kept intact (`_internal` must stay next
  to the exe). The originally deployed node was a trimmed package whose
  README documented two calibration traps; that knowledge was lost in the
  2026-08-28 demolition. It lived solely in that README — pre-processing
  knowledge is outside EXPLORATION-LOG's scope by constitution (post-analysis
  only) — so no other record ever held it. If calibration anomalies appear,
  treat them as rediscovery work.

## Provenance & redeploy

Redeployed 2026-08-29 via `robocopy /E` from the machine-root install
directories above, verified by file-count equality per directory. To redeploy
after a loss: recreate `data/backend/nodes/<id>/` (or `data/backend/archive/<id>/`
for the non-node installs) from the source path, verify file counts and key
executables (`topfd.exe`, `msconvert.exe`, `MSPathFinderT.exe`,
`GUI_UniDec.exe`), then update `STATUS.md`.

Never force-add the binaries (`git add -f`); the tracked surface is exactly
the definition layer plus the tracked text artifacts listed above (toppic
variable-PTM library, informed-proteomics `Example_Files/*.txt` +
`resources/*.txt`) — for binaries the durable record is this document plus
`STATUS.md`.
