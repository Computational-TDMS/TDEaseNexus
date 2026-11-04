# TDEase node: toppic
# TopPIC suite — top-down proteomics identification.
# Binaries resolve to absolute paths inside the Run's own node snapshot.
# Parameters live in rules.smk itself (Snakemake-native `params:`); see README.md for prose docs.
#
# Authority: calibrated against `topfd.exe -h` / `toppic.exe -h` v1.8.0 (2026-07-27)
# and the upstream manual at https://www.toppic.org/software/toppic/manual.html.
# The binary `-h` output is the source of truth; the manual is corroboration.
#
# Path convention: FLAT. Inputs and outputs sit at the run-folder root.
# topfd writes its artifacts next to the input mzML, which is exactly right
# for a flat run folder — no staging, no subdirectories.
#
# ──────────────────────────────────────────────────────────────────────────────
# topfd flag reference (topfd.exe -h, v1.8.0). Defaults shown are the BINARY's
# defaults; rules.smk mirrors them unless noted. Only a subset is wired here;
# the rest pass through `config.topfd.extra`.
#   -a activation                       FILE | CID | ETD | HCD | MPD | UVPD   [FILE]
#   -c max-charge                       <int>                                [30]
#   -m max-mass                         <number> Dalton                      [50000]
#   -e mz-error                         <number> m/z                         [0.02]   ← was 0.01 in docs
#   -r ms-one-sn-ratio                  <number>                             [3]
#   -s ms-two-sn-ratio                  <number>                             [1]
#   -o missing-level-one                flag (MS1 spectra absent)
#   -w precursor-window                 <number> m/z                         [3.0]
#   -n msdeconv                         flag (use MS-Deconv instead of EnvCNN)
#   -v env-cnn-cutoff                   <number in [0,1]>                    [0]
#   -d disable-frag-num-filtering       flag
#   -t ecscore-cutoff                   <number in [0,1]>                    [0.1]
#   -b min-scan-number                  <1|2|3>                              [1]      ← manual says 3; binary says 1
#   -i single-scan-noise                flag
#   -f disable-additional-feature-search  flag
#   -l split-intensity-ratio            <number>                             [2.5]
#   -u thread-number                    <int>                                [1]      ← rule requests up to 28 via threads:
#   -g skip-html-folder                 flag
# ──────────────────────────────────────────────────────────────────────────────
# toppic flag reference (toppic.exe -h, v1.8.0). Only a subset is wired here;
# the rest pass through `config.toppic.extra`.
#   -a activation                       FILE | CID | ETD | HCD | UVPD        [FILE]   ← NO MPD (unlike topfd)
#   -e mass-error-tolerance             <positive int> PPM                   [10]     ← INTEGER, not "10ppm"
#   -p proteoform-error-tolerance       <number> Dalton                      [1.2]
#   -s num-shift                        <0|1|2>                              [1]
#   -m min-shift                        <number> Dalton                      [-500]
#   -M max-shift                        <number> Dalton                      [500]
#   -R proteoform-type                  COMPLETE[,PREFIX][,SUFFIX][,INTERNAL] [all 4]
#   -n n-terminal-form                  NONE[,NME][,NME_ACETYLATION][,M_ACETYLATION] [all 4]
#   -f fixed-mod                        C57 | C58 | <mod-file>
#   -S variable-ptm-num                 <int>                                [3]
#   -b variable-ptm-file-name           <mod-file>
#   -d decoy                            flag
#   -t spectrum-cutoff-type             EVALUE | FDR                         [EVALUE]
#   -v spectrum-cutoff-value            <number>                             [0.01]
#   -T proteoform-cutoff-type           EVALUE | FDR                         [EVALUE]
#   -V proteoform-cutoff-value          <number>                             [0.01]
#   -A approximate-spectra              flag
#   -l lookup-table                     flag
#   -B local-ptm-file-name              <common-mod-file>
#   -H miscore-threshold                <number in [0,1]>                    [0.15]
#   -u thread-number                    <int>                                [1]      ← rule requests up to 28 via threads:
#   -r num-combined-spectra             <int>                                [1]
#   -c combined-file-name               <file>
#   -x no-topfd-feature                 flag
#   -k keep-temp-files                  flag
#   -K keep-decoy-ids                   flag
#   -g skip-html-folder                 flag
# ──────────────────────────────────────────────────────────────────────────────
# Two calibration traps this file exists to keep us out of:
#   1. `toppic -e` is a POSITIVE INTEGER in PPM. Writing "10ppm" parses as the
#      literal string "10ppm" and toppic prints "Error tolerance: 10ppm ppm" —
#      a silent nonsense value, not 10 PPM. Always write the bare integer `10`.
#   2. toppic's activation enum has NO MPD; topfd's does. The separate params
#      and comments below keep the two native contracts explicit.
# ──────────────────────────────────────────────────────────────────────────────
import sys
from pathlib import Path

# The Backend injects this node's deployed catalog directory as an absolute
# path in config["nodes"] at execution time. Neither a binding nor a bin_dir
# means a named parse-time failure — not a relative-path "command not found"
# mid-run. (The `or` chain stays on strings: a Path is always truthy, so
# `Path(x) or Path(y)` can never fall back.)
_TOPPIC_BINDING = (config.get("nodes") or {}).get("toppic") or ""
_TOPF_D_BIN = (config.get("topfd") or {}).get("bin_dir") or ""
_TOPPIC_BIN = (config.get("toppic") or {}).get("bin_dir") or ""
if not _TOPPIC_BINDING and not _TOPF_D_BIN and not _TOPPIC_BIN:
    raise FileNotFoundError(
        "toppic node is not usable: bind it (config['nodes']['toppic']) "
        "or set topfd.bin_dir / toppic.bin_dir"
    )
# `<tool>.bin_dir` in the Run's config.yaml replaces the directory a tool is
# resolved from (a host TopPIC suite install); the package's own directory is
# the default. One key per tool block, so topfd and toppic can point at
# different installs without editing this node.
#
# The deployed package layout is flat on both platforms: executables sit next
# to resources/ (the suite resolves `<exe_dir>/resources`) and, on Linux,
# lib/toppic/ holds libonnxruntime.so. A bin_dir override names the directory
# that holds the tool binary (e.g. a host suite's bin/).
_ON_WINDOWS = sys.platform.startswith("win")
_EXE = ".exe" if _ON_WINDOWS else ""


def _bin_dir(override: str, binding: str) -> Path:
    return Path(override) if override else Path(binding)


def _lib_dir(override: str, binding: str) -> Path:
    # A host suite keeps bin/ and lib/ as siblings; the deployed package keeps
    # lib/ inside its root.
    if override:
        return Path(override).parent / "lib" / "toppic"
    return Path(binding) / "lib" / "toppic"


def _env_prefix(override: str, binding: str) -> str:
    """The Linux binaries link libonnxruntime through lib/toppic, but the
    RUNPATH recorded in them is the build machine's absolute path. Point the
    Run at the package's own library directory instead of trusting it.
    Windows needs no prefix: the DLLs sit next to the executables."""
    if _ON_WINDOWS:
        return ""
    return f'LD_LIBRARY_PATH="{_lib_dir(override, binding)}" '


_TOPF_D_BIN_DIR = _bin_dir(_TOPF_D_BIN, _TOPPIC_BINDING)
_TOPPIC_BIN_DIR = _bin_dir(_TOPPIC_BIN, _TOPPIC_BINDING)
_FASTA = config.get("fasta", "database.fasta")


# ----------------------------------------------------------------------------
# rule topfd — deconvolute mass spectra (TopPIC suite)
# Input : {sample}.mzML  (at run-folder root)
# Output: {sample}_ms1.feature, {sample}_ms2.feature,
#         {sample}_ms1.msalign, {sample}_ms2.msalign, {sample}_feature.xml
#         — all at run-folder root, next to the input.
# Wired params (config-driven; see the topfd flag reference at the top of this
# file for the full set and the binary defaults each one mirrors):
#   activation   FILE | CID | ETD | HCD | MPD | UVPD   (-a)   [FILE]
#   max_charge   int                                    (-c)   [30]
#   max_mass     number Dalton                          (-m)   [50000]
#   mz_error     float m/z                              (-e)   [0.02]  ← binary default
#   ms1_sn_ratio number                                  (-r)   [3]
#   ms2_sn_ratio number                                  (-s)   [1]
#   precursor_window number m/z                          (-w)   [3.0]
#   msdeconv     bool, use MS-Deconv                    (-n)   [false]
#   skip_html    bool, skip HTML folder                 (-g)   [true in this rule]
#   disable_frag bool, disable fragment-number filter   (-d)   [false]
# The remaining topfd flags (-o/-v/-t/-b/-i/-f/-l) pass through
# `config.topfd.extra` when set; otherwise the binary defaults apply.
# ----------------------------------------------------------------------------
rule topfd:
    input:
        mzml = "{sample}.mzML",
    output:
        ms1_feature = "{sample}_ms1.feature",
        ms2_feature = "{sample}_ms2.feature",
        ms1_msalign = "{sample}_ms1.msalign",
        ms2_msalign = "{sample}_ms2.msalign",
        feature_xml = "{sample}_feature.xml",
    threads:
        28
    resources:
        mem_mb = 2048,
    params:
        activation   = lambda wc, cfg=config: cfg.get("topfd", {}).get("activation", "FILE"),
        max_charge   = lambda wc, cfg=config: cfg.get("topfd", {}).get("max_charge", 30),
        max_mass     = lambda wc, cfg=config: cfg.get("topfd", {}).get("max_mass", 50000),
        mz_error     = lambda wc, cfg=config: cfg.get("topfd", {}).get("mz_error", 0.02),
        ms1_sn_ratio = lambda wc, cfg=config: cfg.get("topfd", {}).get("ms1_sn_ratio", 3),
        ms2_sn_ratio = lambda wc, cfg=config: cfg.get("topfd", {}).get("ms2_sn_ratio", 1),
        precursor_window = lambda wc, cfg=config: cfg.get("topfd", {}).get("precursor_window", 3.0),
        msdeconv     = lambda wc, cfg=config: "-n" if cfg.get("topfd", {}).get("msdeconv") else "",
        skip_html    = lambda wc, cfg=config: "-g" if cfg.get("topfd", {}).get("skip_html", True) else "",
        disable_frag = lambda wc, cfg=config: "-d" if cfg.get("topfd", {}).get("disable_frag", False) else "",
        extra        = lambda wc, cfg=config: cfg.get("topfd", {}).get("extra", ""),
        env_prefix   = _env_prefix(_TOPF_D_BIN, _TOPPIC_BINDING),
        topfd_bin    = str(_TOPF_D_BIN_DIR / f"topfd{_EXE}"),
    message:
        "topfd: deconvoluting {input.mzml}"
    shell:
        '({params.env_prefix}"{params.topfd_bin}" -a {params.activation} -c {params.max_charge} '
        '-m {params.max_mass} -e {params.mz_error} -r {params.ms1_sn_ratio} '
        '-s {params.ms2_sn_ratio} -w {params.precursor_window} '
        '{params.msdeconv} {params.skip_html} {params.disable_frag} '
        '{params.extra} -u {threads} "{input.mzml}")'


# ----------------------------------------------------------------------------
# rule toppic — identify proteoforms from msalign + fasta
# Input : {sample}_ms2.msalign (from topfd) + database.fasta
# Output: {sample}_ms2_toppic_proteoform.tsv, {sample}_ms2_toppic_prsm.tsv
#         — at run-folder root.
# The fasta is a single fixed file named `database.fasta` at the run root
# (one protein database per run; multiple samples share it). Stays literal
# so the rule stays Profile-compliant and Snakemake can resolve wildcards.
# Wired params (see the toppic flag reference at the top of this file):
#   activation            FILE | CID | ETD | HCD | UVPD   (-a)            [FILE]   ← no MPD
#   mass_error_tolerance  POSITIVE INT, PPM                (-e)            [10]     ← never "10ppm"
#   proteoform_error_tolerance number Dalton                (-p)            [1.2]
#   num_shift             0 | 1 | 2                        (-s)            [1]
#   min_shift             number Dalton                    (-m)            [-500]
#   max_shift             number Dalton                    (-M)            [500]
#   proteoform_type       COMPLETE[,PREFIX][,SUFFIX][,INTERNAL]  (-R)      [all 4]
#   skip_html             bool, skip HTML folder           (-g)            [true in this rule]
#   decoy                 bool, shuffled decoy DB for FDR  (-d)            [false]
#   spectrum_cutoff_type/value       EVALUE|FDR / number    (-t/-v)         [EVALUE/0.01]
#   proteoform_cutoff_type/value     EVALUE|FDR / number    (-T/-V)         [EVALUE/0.01]
#   lookup_table          bool, compute E-values with lookup table (-l)     [false]
# Advanced flags (-n/-f/-S/-b/-A/-l/-B/-H/-r/-c/-x/-k/-K)
# pass through `config.toppic.extra` when set.
# ----------------------------------------------------------------------------
rule toppic:
    input:
        msalign = "{sample}_ms2.msalign",
        fasta   = _FASTA,
    output:
        proteoform = "{sample}_ms2_toppic_proteoform.tsv",
        prsm       = "{sample}_ms2_toppic_prsm.tsv",
    threads:
        28
    resources:
        mem_mb = 2048,
        toppic_slots = 1,
    params:
        activation      = lambda wc, cfg=config: cfg.get("toppic", {}).get("activation", "FILE"),
        mass_error      = lambda wc, cfg=config: cfg.get("toppic", {}).get("mass_error_tolerance", 10),
        proteoform_error = lambda wc, cfg=config: cfg.get("toppic", {}).get("proteoform_error_tolerance", 1.2),
        num_shift       = lambda wc, cfg=config: cfg.get("toppic", {}).get("num_shift", 1),
        min_shift       = lambda wc, cfg=config: cfg.get("toppic", {}).get("min_shift", -500),
        max_shift       = lambda wc, cfg=config: cfg.get("toppic", {}).get("max_shift", 500),
        proteoform_type = lambda wc, cfg=config: cfg.get("toppic", {}).get("proteoform_type", "COMPLETE,PREFIX,SUFFIX,INTERNAL"),
        fixed_mod       = lambda wc, cfg=config: (
            f'-f "{cfg.get("toppic", {}).get("fixed_mod")}"'
            if cfg.get("toppic", {}).get("fixed_mod") else ""
        ),
        n_terminal_form = lambda wc, cfg=config: cfg.get("toppic", {}).get(
            "n_terminal_form", "NONE,NME,NME_ACETYLATION,M_ACETYLATION"
        ),
        skip_html       = lambda wc, cfg=config: "-g" if cfg.get("toppic", {}).get("skip_html", True) else "",
        decoy           = lambda wc, cfg=config: "-d" if cfg.get("toppic", {}).get("decoy", False) else "",
        spectrum_cutoff_type = lambda wc, cfg=config: cfg.get("toppic", {}).get("spectrum_cutoff_type", "EVALUE"),
        spectrum_cutoff_value = lambda wc, cfg=config: cfg.get("toppic", {}).get("spectrum_cutoff_value", 0.01),
        proteoform_cutoff_type = lambda wc, cfg=config: cfg.get("toppic", {}).get("proteoform_cutoff_type", "EVALUE"),
        proteoform_cutoff_value = lambda wc, cfg=config: cfg.get("toppic", {}).get("proteoform_cutoff_value", 0.01),
        lookup_table    = lambda wc, cfg=config: "-l" if cfg.get("toppic", {}).get("lookup_table", False) else "",
        # advanced: fixed_mod (-f), variable_ptm_file (-b), variable_ptm_num (-S),
        # n_terminal_form (-n),
        # miscore_threshold (-H), num_combined_spectra (-r) — pass through if set
        extra           = lambda wc, cfg=config: cfg.get("toppic", {}).get("extra", ""),
        env_prefix      = _env_prefix(_TOPPIC_BIN, _TOPPIC_BINDING),
        toppic_bin      = str(_TOPPIC_BIN_DIR / f"toppic{_EXE}"),
    message:
        "toppic: identifying proteoforms from {input.msalign}"
    shell:
        '({params.env_prefix}"{params.toppic_bin}" -a {params.activation} -e {params.mass_error} '
        '-p {params.proteoform_error} -s {params.num_shift} '
        '-m {params.min_shift} -M {params.max_shift} '
        '-t {params.spectrum_cutoff_type} -v {params.spectrum_cutoff_value} '
        '-T {params.proteoform_cutoff_type} -V {params.proteoform_cutoff_value} '
        '-R {params.proteoform_type} {params.fixed_mod} '
        '-n {params.n_terminal_form} {params.skip_html} {params.decoy} {params.lookup_table} '
        '{params.extra} -u {threads} "{input.fasta}" "{input.msalign}")'
