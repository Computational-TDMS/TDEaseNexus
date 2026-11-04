# TDEase node: informed-proteomics
# PNNL Informed Proteomics — top-down proteomics suite (.NET).
# Three-stage pipeline: PbfGen → ProMex → MSPathFinderT (+ optional ProMexAlign).
#
# Authority: calibrated against `PbfGen.exe -?`, `ProMex.exe -?`,
# `MSPathFinderT.exe -?` (Informed Proteomics v1.1.8305) and the upstream
# README.md in this directory. The binary `-?` output is authoritative.
#
# NOTE: .NET binaries on non-Windows hosts require Mono; on Windows they run natively.
#
# ──────────────────────────────────────────────────────────────────────────────
# OUTPUT-NAME CONTRACT (empirically verified, v1.1.8305, histone48 workspace
# runs 2026-09-02 — every tool names outputs from the INPUT STEM, written next
# to the input because `-o` is a DIRECTORY and is omitted):
#   PbfGen        {prefix}.pbf
#   ProMex        {prefix}.ms1ft          ← NOT {prefix}_ms1.ms1ft (the name the
#                   recovered deployment declared; a run built on that name
#                   never resolved its DAG — runs/histone48-inp-mspf, rev-1)
#   MSPathFinderT {prefix}_IcTarget.tsv + {prefix}_IcDecoy.tsv
#                 + {prefix}_IcTda.tsv (merged, decoys included when -tda 1)
#                 + {prefix}.mzid
#                 ← NOT {prefix}_IcTda.mzid; with -tda 1 all four appear
#                 (histone48-mouse 2026-09-02 completed run). The -overwrite
#                 flag itself documents "looks for files _IcTarget.tsv and
#                 _IcDecoy.tsv" — the Target/Decoy pair is real.
# ──────────────────────────────────────────────────────────────────────────────
# FLAG CALIBRATION HISTORY (why this file looks the way it does):
#   The previous wiring used flags the binaries reject:
#     • MSPathFinderT `-f "<fasta>"`  — `-f`/`-FragTolerance` is a Double (PPM);
#       the database is `-d`/`-Database`. `-f nofile.fasta` → parse failure.
#     • MSPathFinderT `-m "<ms1ft>"`  — `-m` is not a flag here; the feature
#       file is `-feature`/`-FeatureFile`. `-m nofile.ms1ft` → parse failure.
#     • MSPathFinderT `-tda on`       — `-tda` is an Int32 (-1|0|1);
#       `on` is not castable.
#     • `-o "<file>"` on all three tools — `-o`/`-OutputDirectory` is a DIRECTORY,
#       not a filename. We OMIT `-o` so each tool writes next to its input
#       (flat layout), which is what the output: declarations name.
#   DAG composition (2026-09-02): the interim config-driven input lambdas
#     (`spectrum_extension`, `fasta_name`) violated the static Profile
#     (inputs must be literal patterns; frontend DAG parity) — see
#     tests/test_profile_validator.py. Inputs are now literal
#     {sample}.mzML / {sample}.pbf / config `fasta:` (toppic-node convention,
#     run-root database). Composition flexibility lives in the pipeline
#     template, not in this node.
#   Stale-reuse trap (2026-09-02): `-overwrite` defaults to false and
#     MSPathFinderT then silently REUSES existing _IcTarget/_IcDecoy files.
#     A re-run after a partial failure would report stale partials as fresh
#     results. This rule passes `-overwrite true` (config overridable) —
#     a TDEase Run dir is isolated, so overwrite only guards snakemake reruns.
# ──────────────────────────────────────────────────────────────────────────────
# PbfGen flag reference (PbfGen.exe -?, v1.1.8305):
#   -i/-s/-InputFile arg#1   <.raw | .mzML | dir>  REQUIRED  spectrum/input
#   -o/-OutputDirectory      <dir>               [dir of input]   ← DIRECTORY
#   -start                   <int>               [-1]
#   -end                     <int>               [-1]
#   PbfGen is idempotent: "will do nothing if it has previously been run and
#   can find the file" — a stale .pbf is silently reused (upstream README).
# ProMex flag reference (ProMex.exe -?, v1.1.8305):
#   -i/-s/-InputFile arg#1   <.pbf|.mzML|dir>    REQUIRED
#   -o/-OutputDirectory      <dir>               [dir of input]   ← DIRECTORY
#   -MinCharge               <int> 1..60         [1]
#   -MaxCharge               <int> 1..60         [60]
#   -MinMass                 <Da> 600..100000    [2000]
#   -MaxMass                 <Da> 600..100000    [50000]
#   -FeatureMap              bool                [true]
#   -Score                   bool                [false]
#   -MaxThreads              <int>               [0 = auto]
#   -csv                     bool                [false]
#   -BinResPPM               1|2|4|8|16|32|64|128 [16]
#   -ScoreTh/-ScoreThreshold <number>            [-10]
#   -ms1ft                   <file|"." inferred>
# MSPathFinderT flag reference (MSPathFinderT.exe -?, v1.1.8305). Only a subset
# is wired; the rest pass through `config.informed-proteomics.extra`.
#   -i/-s/-InputFile/SpecFile arg#1   <.raw|.pbf>      REQUIRED
#   -d/-Database                      <.fasta|.fa|.faa> REQUIRED  ← NOT -f
#   -o/-OutputDirectory/-OutputDir    <dir>            [dir of input]   ← DIRECTORY
#   -feature/-FeatureFile             <.ms1ft|_isos.csv|.msalign>      ← NOT -m
#   -ic                               0|1|2 / NoInternalCleavage|SingleInternalCleavage|MultipleInternalCleavages  [1]
#   -TagSearch                        bool             [true]  (+5-10% matches, +30-50% runtime)
#   -MemMatches                       <int>            [3]
#   -n/-NumMatchesPerSpec             <int>            [1]
#   -IncludeDecoys/-IncludeDecoy      bool             [false]
#   -mod/-ModificationFile            <file>
#   -tda                              -1|0|1           [0]   ← Int32, not "on"
#   -overwrite                        bool             [false]
#   -t/-PMTolerance/-precursorTol     <PPM>            [10]
#   -f/-FragTolerance/-fragmentTol    <PPM>            [10]   ← NOT the fasta flag
#   -MinLength / -MaxLength           <int>            [21] / [500]
#   -MinCharge / -MaxCharge           <int>            [2] / [50]
#   -MinFragCharge / -MaxFragCharge   <int>            [1] / [20]
#   -MinMass / -MaxMass               <Da>             [3000] / [50000]
#   -ThreadCount/-threads             <int>            [0 = auto]
#   -act/-ActivationMethod            0..6             [6 = Unknown]
#   -ScansFile/-ScansFilePath         <file>
#   -flip/-UseFlipScoring             bool             [false]
#   -ParamFile / -CreateParamFile     <file>
# ──────────────────────────────────────────────────────────────────────────────
import sys
from pathlib import Path

# The Backend injects this node's deployed catalog directory as an absolute
# path in config["nodes"] at execution time. Neither a binding nor a bin_dir
# means a named parse-time failure — not a relative-path "command not found"
# mid-run. (The `or` chain stays on strings: a Path is always truthy.)
_IP_BINDING = (config.get("nodes") or {}).get("informed-proteomics") or ""
_IP_BIN = (config.get("informed-proteomics") or {}).get("bin_dir") or ""
if not _IP_BINDING and not _IP_BIN:
    raise FileNotFoundError(
        "informed-proteomics node is not usable: bind it "
        "(config['nodes']['informed-proteomics']) or set "
        "informed-proteomics.bin_dir"
    )
# `<node-id>.bin_dir` in the Run's config.yaml replaces the directory this
# node resolves its executables from (a host Informed Proteomics install).
# `resources/` stays with the package: the default `-mod` library is node data,
# not an executable.
_IP_DIR = Path(_IP_BINDING)
_IP_BIN_DIR = Path(_IP_BIN or _IP_BINDING)

# The suite is .NET Framework: on Windows the .exe runs natively, on Linux the
# same assemblies run under Mono. The node ships one package; only the runner
# prefix differs by host.
_ON_WINDOWS = sys.platform.startswith("win")
_NET_RUNNER = "" if _ON_WINDOWS else "mono "
# Fasta convention = the toppic node's: ONE protein database per run, staged at
# the run root (literal so the rule stays Profile-compliant). Overridable via
# config `fasta:` at parse time.
_FASTA = config.get("fasta", "database.fasta")
# Targeted modification library (-mod). Absent/null: the node's bundled
# suite-authored targeted set (resources/mspf_targeted_mods.txt — provenance
# in its header). Explicit "" (quoted empty): unmodified-only search (the
# upstream `-mod` default). Any other value: a path (a source artifact).
# The is-not-None check is load-bearing: it distinguishes "unset" from
# "explicitly empty", which YAML folds to the same falsy value.
_cfg_mods = config.get("informed-proteomics", {}).get("mods")
_MODS = str(_IP_DIR / "resources" / "mspf_targeted_mods.txt") if _cfg_mods is None else _cfg_mods


# ----------------------------------------------------------------------------
# rule pbngen — convert raw/mzML to optimized .pbf binary
# Input : {sample}.mzML    (TDEase canonical form; vendor raw is converted by
#                           the msconvert node first — same as toppic-raw-pipeline)
# Output: {sample}.pbf     — PbfGen names its output from the input stem.
# `-o` is a DIRECTORY; we omit it so PbfGen writes next to its input, which is
# exactly the flat-layout location the output: declaration names.
# ----------------------------------------------------------------------------
rule pbngen:
    input:
        mzml = "{sample}.mzML",
    output:
        pbf = "{sample}.pbf",
    threads:
        1
    params:
        runner = _NET_RUNNER,
        pbngen = str(_IP_BIN_DIR / "PbfGen.exe"),
    message:
        "PbfGen: {input.mzml} -> {output.pbf}"
    shell:
        '({params.runner}"{params.pbngen}" -s "{input.mzml}")'


# ----------------------------------------------------------------------------
# rule promex — deisotope MS1, determine charge states -> .ms1ft feature file
# Input : {sample}.pbf
# Output: {sample}.ms1ft — ProMex names output from the input stem (verified;
#                          NOT {sample}_ms1.ms1ft).
# Wired params (see ProMex flag reference at the top of this file):
#   min_charge   int, -MinCharge  [1]
#   max_charge   int, -MaxCharge  [60]
# Other ProMex params (-MinMass/-MaxMass/-BinResPPM/-ScoreTh/-FeatureMap/-csv)
# pass through `config.informed-proteomics.promex_extra` when set. No thread
# flag is passed: ProMex self-threads (MaxThreads 0 = auto).
# `-o` omitted: ProMex writes next to its input (flat layout).
# ----------------------------------------------------------------------------
rule promex:
    input:
        pbf = "{sample}.pbf",
    output:
        ms1ft = "{sample}.ms1ft",
    threads:
        1
    params:
        runner      = _NET_RUNNER,
        promex      = str(_IP_BIN_DIR / "ProMex.exe"),
        min_charge  = lambda wc, cfg=config: cfg.get("promex", {}).get("min_charge", 1),
        max_charge  = lambda wc, cfg=config: cfg.get("promex", {}).get("max_charge", 60),
        extra       = lambda wc, cfg=config: cfg.get("informed-proteomics", {}).get("promex_extra", ""),
    message:
        "ProMex: feature finding on {input.pbf}"
    shell:
        '({params.runner}"{params.promex}" -i "{input.pbf}" '
        '-MinCharge {params.min_charge} -MaxCharge {params.max_charge} {params.extra})'


# ----------------------------------------------------------------------------
# rule mspathfindert — search proteoforms in FASTA, produce the results quartet
# Input : {sample}.pbf + {sample}.ms1ft + fasta (config `fasta:`, run root)
# Output: {sample}_IcTarget.tsv, {sample}_IcDecoy.tsv, {sample}_IcTda.tsv,
#         {sample}.mzid — all named from the input stem (verified; see the
#         output-name contract at the top of this file).
# FLAG FIXES (see calibration history at the top of this file):
#   - database        is `-d`, NOT `-f` (which is FragTolerance).
#   - feature file    is `-feature`, NOT `-m` (not a flag here).
#   - tda             is `-tda <-1|0|1>`, NOT `-tda on`.
#   - `-o`            OMITTED — it is a directory; we write next to the pbf
#                     (flat layout), which is what the output: names expect.
#   - `-overwrite`    TRUE (default): a snakemake rerun after a partial
#                     failure must not silently reuse stale _IcTarget/_IcDecoy
#                     files (the flag's own documented behavior).
# Wired params (see MSPathFinderT flag reference):
#   mods         <mod-file>   [node's bundled targeted library; "" = none]
#   tda          -1|0|1       [1 in this rule; tool default 0] — only tda 1
#                             produces the full declared output quartet.
# Advanced (-ic/-t/-f/-MinLength/-MaxLength/-MinCharge/-MaxCharge/-MinMass/
# -MaxMass/-n/-act/-TagSearch/-threads/-flip) pass through
# `config.informed-proteomics.extra`. No thread flag is passed: the tool
# self-threads (0 = auto).
# ----------------------------------------------------------------------------
rule mspathfindert:
    input:
        pbf   = "{sample}.pbf",
        ms1ft = "{sample}.ms1ft",
        fasta = _FASTA,
    output:
        tsv_target = "{sample}_IcTarget.tsv",
        tsv_decoy  = "{sample}_IcDecoy.tsv",
        tsv_tda    = "{sample}_IcTda.tsv",
        mzid       = "{sample}.mzid",
    threads:
        1
    params:
        runner       = _NET_RUNNER,
        mspathfinder = str(_IP_BIN_DIR / "MSPathFinderT.exe"),
        mods         = lambda wc, cfg=config: f'-mod "{_MODS}"' if _MODS else "",
        # tda: 0=target-only, 1=target+shuffled-decoy (estimable FDR), -1=decoy-only.
        # Tool default is 0; this rule defaults to 1 (full quartet + FDR),
        # matching the suite's own documented example `-tda 1`.
        tda          = lambda wc, cfg=config: f"-tda {cfg.get('informed-proteomics', {}).get('tda', 1)}",
        overwrite    = lambda wc, cfg=config: "-overwrite true" if cfg.get("informed-proteomics", {}).get("overwrite", True) else "",
        extra        = lambda wc, cfg=config: cfg.get("informed-proteomics", {}).get("extra", ""),
    message:
        "MSPathFinderT: searching {input.fasta}"
    shell:
        '({params.runner}"{params.mspathfinder}" -s "{input.pbf}" -d "{input.fasta}" '
        '-feature "{input.ms1ft}" {params.mods} {params.tda} {params.overwrite} {params.extra})'
