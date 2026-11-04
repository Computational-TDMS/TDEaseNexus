# toppic

TopPIC suite — top-down proteomics identification. Two sample-level rules:

- **topfd** — deconvolutes mass spectra (mzML → msalign + feature files)
- **toppic** — identifies proteoforms from msalign + FASTA database

TopPIC can either build/reuse its native on-disk FASTA index or compute E-values
with lookup-table mode (`toppic.lookup_table: true`). Large or composite FASTA
databases should use lookup-table mode when the native index would exceed the
Backend's storage budget. TopPIC jobs are serialized by the Backend resource
`toppic_slots=1`; each job may still use the full Run core budget.

> **Calibrated against `topfd.exe -h` / `toppic.exe -h` v1.8.0 (2026-07-27)** and
> the upstream manual at <https://www.toppic.org/software/toppic/manual.html>.
> The binary `-h` output is authoritative wherever it disagrees with prose.
> See [`../../msconvert/README.md`](../msconvert/README.md) for why this node
> consumes **centroided, 64-bit m/z** mzML — topfd's `mz_error` is downstream of
> that precision and cannot recover what conversion lost.

The deployed package is flat on both platforms: executable names carry `.exe`
on Windows only, `resources/` sits next to the executables (the suite resolves
`<exe_dir>/resources`), and on Linux `lib/toppic/libonnxruntime.so` is injected
through `LD_LIBRARY_PATH` by `rules.smk` (the binary's recorded RUNPATH is the
build machine's absolute path).

## Run-folder layout (FLAT)

A run folder is **flat**: data and outputs sit at the root, no subdirectories.
topfd writes its artifacts next to the input mzML — which is exactly right
for a flat layout. No staging rules, no path translation.

```
runs/<run_id>/
  Snakefile              config.yaml
  nodes/toppic/rules.smk          (materialized by the engine)
  chlamy.mzML                     (input — staged at root by the caller)
  database.fasta                  (input — the protein DB, fixed name)
  database.fasta_idx/                    (only when native indexing is used)
  chlamy_ms1.feature              (topfd output, next to input)
  chlamy_ms1.msalign
  chlamy_ms2.msalign
  chlamy_ms2_toppic_proteoform.tsv   (toppic output)
  chlamy_ms2_toppic_prsm.tsv
```

## Binary layout

This directory ships the TopPIC binaries + dependencies (Qt5, boost, ICU, …):

```
toppic/
  topfd.exe        toppic.exe       topindex.exe     topmg.exe
  topdiff.exe      topdia.exe       *_gui.exe        *.dll
  platforms/       resources/       LICENSE
  rules.smk        README.md        (this file)
```

The rules build binary paths as `nodes/toppic/<exe>` relative to the Run root —
the materialized Run layout (`<run>/nodes/<id>/`) — so a direct `snakemake`
invocation from the Run root resolves with no environment. There is no
environment override: the engine strips `TDEASE_*` (`backend_child_env`), and a
Run resolves only its own digest-pinned snapshot.

## Parameters

All parameters live in `rules.smk` as Snakemake-native `params:`.
Defaults are inline; runtime overrides come from `config.yaml` written into the run dir.
Unwired flags pass through `config.topfd.extra` / `config.toppic.extra`.

### topfd — `topfd.exe -h` (v1.8.0)

| param                       | flag | binary default | type     | description                                                                                |
|-----------------------------|------|----------------|----------|--------------------------------------------------------------------------------------------|
| activation                  | -a   | FILE           | enum     | `FILE \| CID \| ETD \| HCD \| MPD \| UVPD` — fragmentation method (FILE = read from data)  |
| max_charge                  | -c   | 30             | int      | max charge state of precursor and fragment ions                                            |
| max_mass                    | -m   | 50000          | number   | max monoisotopic mass of precursor/fragment ions (Dalton)                                  |
| mz_error                    | -e   | **0.02**       | number   | m/z error tolerance of spectral peaks (m/z)                                                |
| ms_one_sn_ratio             | -r   | 3              | number   | signal/noise ratio for MS1 spectra                                                         |
| ms_two_sn_ratio             | -s   | 1              | number   | signal/noise ratio for MS/MS spectra                                                       |
| missing_level_one           | -o   | off            | flag     | MS1 spectra are missing in the input                                                       |
| precursor_window            | -w   | 3.0            | number   | default precursor isolation window (m/z); ignored if the input carries it                  |
| msdeconv                    | -n   | off            | flag     | use MS-Deconv score instead of the default EnvCNN score                                    |
| env_cnn_cutoff              | -v   | 0              | [0,1]    | EnvCNN score cutoff for filtering MS/MS envelopes                                          |
| disable_frag_num_filtering  | -d   | off            | flag     | skip fragment-ion-count filtering in MS/MS scans                                           |
| ecscore_cutoff              | -t   | 0.1            | [0,1]    | ECScore cutoff for proteoform features                                                     |
| min_scan_number             | -b   | 1              | 1\|2\|3  | min number of MS1 scans a feature must appear in (binary default 1; manual prose says 3)   |
| single_scan_noise           | -i   | off            | flag     | use per-scan noise instead of whole-map noise for feature detection                        |
| disable_additional_feature_search | -f | off          | flag     | disable extra feature search for MS/MS scans lacking a feature in the isolation window     |
| split_intensity_ratio       | -l   | 2.5            | number   | intensity ratio to split one feature from another                                          |
| thread_number               | -u   | 1              | int      | number of threads (rule overrides to 30 via Snakemake `threads:`)                          |
| skip_html_folder            | -g   | off            | flag     | skip HTML visualization folder (rule forces on by default)                                 |

**Wired** in this node: `activation`, `max_charge`, `mz_error`, `msdeconv`,
`skip_html`, `disable_frag`. The rest pass through `config.topfd.extra`
(e.g. `"-m 49000 -t 0.15"`).

### toppic — `toppic.exe -h` (v1.8.0)

| param                       | flag | binary default | type     | description                                                                                |
|-----------------------------|------|----------------|----------|--------------------------------------------------------------------------------------------|
| activation                  | -a   | FILE           | enum     | `FILE \| CID \| ETD \| HCD \| UVPD` — **no MPD** (topfd alone accepts MPD)                 |
| mass_error_tolerance        | -e   | 10             | **int**  | error tolerance for precursor & fragment masses, in **PPM**. ⚠ Must be a bare integer (e.g. `10`); writing `"10ppm"` parses as the literal string and toppic prints `Error tolerance: 10ppm ppm` — a silent nonsense value |
| proteoform_error_tolerance  | -p   | 1.2            | number   | error tolerance for PrSM clusters (Dalton)                                                 |
| num_shift                   | -s   | 1              | 0\|1\|2  | max number of unexpected mass shifts in a PrSM                                             |
| min_shift                   | -m   | -500           | number   | min mass shift of an unexpected modification (Dalton)                                      |
| max_shift                   | -M   | 500            | number   | max mass shift of an unexpected modification (Dalton)                                      |
| proteoform_type             | -R   | COMPLETE,PREFIX,SUFFIX,INTERNAL | enum (csv) | subset of `COMPLETE,PREFIX,SUFFIX,INTERNAL`. `TERMIN`/`MULTIPLE` are NOT valid — toppic accepts them silently, matches nothing, exits 0, so an empty proteoform table is reported as SUCCEEDED |
| n_terminal_form             | -n   | NONE,NME,NME_ACETYLATION,M_ACETYLATION | enum (csv) | allowed N-terminal forms                                                                  |
| fixed_mod                   | -f   | —              | C57\|C58\|file | fixed modifications: C57 (carbamidomethylation), C58 (carboxymethylation), or a mod-file |
| variable_ptm_num            | -S   | 3              | int      | max number of variable PTMs in a PrSM                                                      |
| variable_ptm_file_name      | -b   | —              | file     | variable modification file                                                                 |
| decoy                       | -d   | off            | flag     | use a shuffled decoy DB to estimate FDR                                                    |
| spectrum_cutoff_type        | -t   | EVALUE         | EVALUE\|FDR | spectrum-level cutoff type                                                               |
| spectrum_cutoff_value       | -v   | 0.01           | number   | spectrum-level cutoff value                                                                |
| proteoform_cutoff_type      | -T   | EVALUE         | EVALUE\|FDR | proteoform-level cutoff type                                                             |
| proteoform_cutoff_value     | -V   | 0.01           | number   | proteoform-level cutoff value                                                              |
| approximate_spectra         | -A   | off            | flag     | use approximate spectra for higher sensitivity in protein filtering                        |
| lookup_table                | -l   | off            | flag     | use a lookup table for p-value/E-value computation                                         |
| local_ptm_file_name         | -B   | —              | file     | common modification file for unexpected-shift characterization                             |
| miscore_threshold           | -H   | 0.15           | [0,1]    | modification-identification score threshold                                                |
| thread_number               | -u   | 1              | int      | number of threads (rule overrides to 30 via Snakemake `threads:`)                          |
| num_combined_spectra        | -r   | 1              | int      | 2 or 3 for alternating-fragmentation spectral pairs/triplets                               |
| combined_file_name          | -c   | —              | file     | output file for combined-spectrum analysis                                                 |
| no_topfd_feature            | -x   | off            | flag     | no TopFD feature file available                                                            |
| keep_temp_files             | -k   | off            | flag     | keep intermediate files                                                                    |
| keep_decoy_ids              | -K   | off            | flag     | keep decoy identifications                                                                 |
| skip_html_folder            | -g   | off            | flag     | skip HTML folder (rule forces on by default)                                               |

**Wired** in this node: `activation`, `mass_error_tolerance`, `num_shift`,
`proteoform_type`, `skip_html`, `decoy`, `lookup_table`. The rest pass through
`config.toppic.extra` (e.g. `"-p 1.5 -t FDR -v 0.01 -T FDR -V 0.01 -n NME_ACETYLATION"`).

## Outputs

All outputs land at the run-folder root, next to the input (topfd writes there;
toppic writes next to the msalign):

- topfd: `{sample}_ms1.feature`, `{sample}_ms2.feature`, `{sample}_ms1.msalign`,
  `{sample}_ms2.msalign`, `{sample}_feature.xml`
- toppic: `{sample}_ms2_toppic_proteoform.tsv`, `{sample}_ms2_toppic_prsm.tsv`
  (also `_single.tsv` variants and `.xml` when not skipping)

## Example config.yaml

```yaml
topfd:
  activation: FILE
  max_charge: 30
  mz_error: 0.02          # binary default; m/z, not PPM
  skip_html: true
toppic:
  activation: FILE
  mass_error_tolerance: 10   # bare integer in PPM — never "10ppm"
  num_shift: 1
  proteoform_type: COMPLETE  # for intact histones, COMPLETE alone is cleanest
  skip_html: true
  lookup_table: false        # enable when native FASTA indexes exceed storage budget
```
