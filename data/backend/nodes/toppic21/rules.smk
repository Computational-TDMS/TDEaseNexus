# TDEase node: toppic21
#
# TopPIC Suite 2.1 — the version-pinned sibling of the `toppic` node (1.8).
# Both nodes coexist so a Run can bind the old contract or the new one; they
# never share a workflow.
#
# What changed against `toppic` (1.8) — verified against the binaries, not the
# release notes:
#   * topfd splits deconvolution into --ms1-deconv / --ms2-deconv (default
#     `greedy`); the old `-n` (MS-Deconv toggle) no longer exists.
#   * topfd `-g` is now --ms2-envcnn-cutoff (takes a value); there is no
#     skip-HTML flag because 2.1 no longer writes HTML.
#   * topfd writes <sample>.sqlite (deconvoluted spectra). It is REQUIRED:
#     toppic's post mass matching (on by default) reads it, and refuses to run
#     without it unless --disable-post-match is passed.
#   * toppic splits the old `-e` into -e/--frag-error-tolerance and
#     -E/--prec-error-tolerance; `-p` is now --cluster-error-tolerance
#     (same 1.2 Da default as the old proteoform tolerance).
#   * toppic names results after the post-match step:
#     <sample>_post_ms2_toppic_prsm.tsv / _proteoform.tsv / _protein.tsv.
#     With --no-sql (-z) no toppic SQLite database is written; the TSV tables
#     are still produced.
#
# Authority: `topfd -h`, `toppic -h`, `topindex -h` of 2.1.0 (2026-10-23) and
# docs/manual/ of the suite. The binary help output wins over prose.
from pathlib import Path

_TOPPIC_BINDING = (config.get("nodes") or {}).get("toppic21") or ""
_TOPF_D_BIN = (config.get("topfd") or {}).get("bin_dir") or ""
_TOPPIC_BIN = (config.get("toppic") or {}).get("bin_dir") or ""
_TOPDINDEX_BIN = (config.get("topindex") or {}).get("bin_dir") or ""
if not _TOPPIC_BINDING and not _TOPF_D_BIN and not _TOPPIC_BIN:
    raise FileNotFoundError(
        "toppic21 node is not usable: bind it (config['nodes']['toppic21']) "
        "or set topfd.bin_dir / toppic.bin_dir"
    )

# Package layout is flat: executables, res/ (the suite's resource dir name in
# 2.1), and lib/libonnxruntime.so.1 next to each other. A bin_dir override
# names a host suite's bin/ directory instead.
def _bin_dir(override: str, binding: str) -> Path:
    return Path(override) if override else Path(binding)


def _env_prefix(override: str, binding: str) -> str:
    """2.1 links libonnxruntime.so.1; the package carries it under lib/ and the
    binary's RUNPATH is the build machine's absolute path, so the Run points
    the loader at the package copy. A host install manages its own libraries."""
    if override or not binding:
        return ""
    return f'LD_LIBRARY_PATH="{Path(binding) / "lib"}" '


_TOPF_D_BIN_DIR = _bin_dir(_TOPF_D_BIN, _TOPPIC_BINDING)
_TOPPIC_BIN_DIR = _bin_dir(_TOPPIC_BIN, _TOPPIC_BINDING)
_TOPDINDEX_BIN_DIR = _bin_dir(_TOPDINDEX_BIN, _TOPPIC_BINDING)
_FASTA = config.get("fasta", "database.fasta")


# ----------------------------------------------------------------------------
# rule topfd — deconvolute MS1/MS/MS spectra (TopPIC 2.1)
# Input : {sample}.mzML (flat run-folder root)
# Output: per-sample msalign/feature files + feature.xml + <sample>.sqlite
#         The SQLite database is an output, not a side effect: toppic's post
#         mass matching consumes it (and fails without it).
# Params: activation (-a), max_charge (-c), max_mass (-m), mz_error (-e),
#         ms1_sn_ratio (-r), ms2_sn_ratio (-s), precursor_window (-w),
#         ms1_deconv (-p), ms2_deconv (-q), ms1_envcnn_cutoff (-f),
#         ms2_envcnn_cutoff (-g), frag_num_filtering (-j), threads (-u).
#         `msdeconv: true` is kept as a shorthand for `-p msdeconv -q msdeconv`.
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
        sqlite = "{sample}.sqlite",
    threads:
        28
    resources:
        mem_mb = 4096,
    params:
        activation   = lambda wc, cfg=config: cfg.get("topfd", {}).get("activation", "FILE"),
        max_charge   = lambda wc, cfg=config: cfg.get("topfd", {}).get("max_charge", 30),
        max_mass     = lambda wc, cfg=config: cfg.get("topfd", {}).get("max_mass", 50000),
        mz_error     = lambda wc, cfg=config: cfg.get("topfd", {}).get("mz_error", 0.02),
        ms1_sn_ratio = lambda wc, cfg=config: cfg.get("topfd", {}).get("ms1_sn_ratio", 3),
        ms2_sn_ratio = lambda wc, cfg=config: cfg.get("topfd", {}).get("ms2_sn_ratio", 1),
        precursor_window = lambda wc, cfg=config: cfg.get("topfd", {}).get("precursor_window", 3.0),
        deconv = lambda wc, cfg=config: (
            "-p msdeconv -q msdeconv" if cfg.get("topfd", {}).get("msdeconv") else ""
        ),
        envcnn = lambda wc, cfg=config: " ".join(
            flag
            for flag, key in (
                (f'-f {cfg.get("topfd", {}).get("ms1_envcnn_cutoff")}', "ms1_envcnn_cutoff"),
                (f'-g {cfg.get("topfd", {}).get("ms2_envcnn_cutoff")}', "ms2_envcnn_cutoff"),
            )
            if cfg.get("topfd", {}).get(key) is not None
        ),
        frag_num_filtering = lambda wc, cfg=config: (
            "" if cfg.get("topfd", {}).get("disable_frag", False) else "-j"
        ),
        extra        = lambda wc, cfg=config: cfg.get("topfd", {}).get("extra", ""),
        env_prefix   = _env_prefix(_TOPF_D_BIN, _TOPPIC_BINDING),
        topfd_bin    = str(_TOPF_D_BIN_DIR / "topfd"),
    message:
        "topfd (2.1): deconvoluting {input.mzml}"
    shell:
        '({params.env_prefix}"{params.topfd_bin}" -a {params.activation} -c {params.max_charge} '
        '-m {params.max_mass} -e {params.mz_error} -r {params.ms1_sn_ratio} '
        '-s {params.ms2_sn_ratio} -w {params.precursor_window} '
        '{params.deconv} {params.envcnn} {params.frag_num_filtering} '
        '{params.extra} -u {threads} "{input.mzml}")'


# ----------------------------------------------------------------------------
# rule toppic — identify proteoforms (TopPIC 2.1, post mass matching)
# Input : {sample}_ms2.msalign + {sample}.sqlite (from topfd) + database.fasta
# Output: <sample>_post_ms2_toppic_{prsm,proteoform,protein}.tsv
# `-z` keeps toppic's own SQLite database out of the run folder: the TSV
# tables are what TDEase reads, and the post-match step only needs topfd's DB.
# Params: activation (-a), frag_error_tolerance (-e), prec_error_tolerance
#         (-E), cluster_error_tolerance (-p), num_shift (-s), shifts (-m/-M),
#         proteoform_type (-R), cutoffs (-t/-v/-T/-V), fixed_mod (-f),
#         n_terminal_form (-n), decoy (-d), rescore (-q), threads (-u).
# ----------------------------------------------------------------------------
rule toppic:
    input:
        msalign = "{sample}_ms2.msalign",
        sqlite  = "{sample}.sqlite",
        fasta   = _FASTA,
    output:
        prsm       = "{sample}_post_ms2_toppic_prsm.tsv",
        proteoform = "{sample}_post_ms2_toppic_proteoform.tsv",
        protein    = "{sample}_post_ms2_toppic_protein.tsv",
    threads:
        28
    resources:
        mem_mb = 4096,
        toppic_slots = 1,
    params:
        activation      = lambda wc, cfg=config: cfg.get("toppic", {}).get("activation", "FILE"),
        frag_error      = lambda wc, cfg=config: cfg.get("toppic", {}).get(
            "mass_error_tolerance", 10
        ),
        prec_error      = lambda wc, cfg=config: cfg.get("toppic", {}).get(
            "precursor_error_tolerance", cfg.get("toppic", {}).get("mass_error_tolerance", 10)
        ),
        cluster_error   = lambda wc, cfg=config: cfg.get("toppic", {}).get(
            "proteoform_error_tolerance", 1.2
        ),
        num_shift       = lambda wc, cfg=config: cfg.get("toppic", {}).get("num_shift", 1),
        min_shift       = lambda wc, cfg=config: cfg.get("toppic", {}).get("min_shift", -500),
        max_shift       = lambda wc, cfg=config: cfg.get("toppic", {}).get("max_shift", 500),
        proteoform_type = lambda wc, cfg=config: cfg.get("toppic", {}).get(
            "proteoform_type", "COMPLETE,PREFIX,SUFFIX,INTERNAL"
        ),
        fixed_mod       = lambda wc, cfg=config: (
            f'-f "{cfg.get("toppic", {}).get("fixed_mod")}"'
            if cfg.get("toppic", {}).get("fixed_mod") else ""
        ),
        n_terminal_form = lambda wc, cfg=config: cfg.get("toppic", {}).get(
            "n_terminal_form", "NONE,NME,NME_ACETYLATION,M_ACETYLATION"
        ),
        decoy           = lambda wc, cfg=config: "-d" if cfg.get("toppic", {}).get("decoy", False) else "",
        rescore         = lambda wc, cfg=config: "-q" if cfg.get("toppic", {}).get("rescore", False) else "",
        spectrum_cutoff_type = lambda wc, cfg=config: cfg.get("toppic", {}).get("spectrum_cutoff_type", "EVALUE"),
        spectrum_cutoff_value = lambda wc, cfg=config: cfg.get("toppic", {}).get("spectrum_cutoff_value", 0.01),
        proteoform_cutoff_type = lambda wc, cfg=config: cfg.get("toppic", {}).get("proteoform_cutoff_type", "EVALUE"),
        proteoform_cutoff_value = lambda wc, cfg=config: cfg.get("toppic", {}).get("proteoform_cutoff_value", 0.01),
        extra           = lambda wc, cfg=config: cfg.get("toppic", {}).get("extra", ""),
        env_prefix      = _env_prefix(_TOPPIC_BIN, _TOPPIC_BINDING),
        toppic_bin      = str(_TOPPIC_BIN_DIR / "toppic"),
    message:
        "toppic (2.1): identifying proteoforms from {input.msalign}"
    shell:
        '({params.env_prefix}"{params.toppic_bin}" -z -a {params.activation} '
        '-e {params.frag_error} -E {params.prec_error} -p {params.cluster_error} '
        '-s {params.num_shift} -m {params.min_shift} -M {params.max_shift} '
        '-t {params.spectrum_cutoff_type} -v {params.spectrum_cutoff_value} '
        '-T {params.proteoform_cutoff_type} -V {params.proteoform_cutoff_value} '
        '-R {params.proteoform_type} {params.fixed_mod} '
        '-n {params.n_terminal_form} {params.decoy} {params.rescore} '
        '{params.extra} -u {threads} "{input.fasta}" "{input.msalign}")'


# ----------------------------------------------------------------------------
# rule topindex — build the Run-wide FASTA index with the 2.1 binary
# 2.1 compresses the index (~half the 1.8 size); toppic still finds it as
# <fasta>_idx next to the database. The completion marker keeps concurrent
# sample jobs from racing on the same index.
# ----------------------------------------------------------------------------
rule topindex:
    input:
        fasta = _FASTA,
    output:
        complete = f".tdease/topindex/{Path(_FASTA).name}.complete",
    threads:
        30
    resources:
        mem_mb = 2048,
    params:
        fixed_mod = lambda wc, cfg=config: (
            f'-f "{cfg.get("toppic", {}).get("fixed_mod")}"'
            if cfg.get("toppic", {}).get("fixed_mod") else ""
        ),
        n_terminal_form = lambda wc, cfg=config: cfg.get("toppic", {}).get(
            "n_terminal_form", "NONE,NME,NME_ACETYLATION,M_ACETYLATION"
        ),
        decoy = lambda wc, cfg=config: "-d" if cfg.get("toppic", {}).get("decoy", False) else "",
        mass_error = lambda wc, cfg=config: cfg.get("toppic", {}).get("mass_error_tolerance", 10),
        prec_error = lambda wc, cfg=config: cfg.get("toppic", {}).get(
            "precursor_error_tolerance", cfg.get("toppic", {}).get("mass_error_tolerance", 10)
        ),
        extra = lambda wc, cfg=config: cfg.get("topindex", {}).get("extra", ""),
        index_dir = f"{_FASTA}_idx",
        env_prefix = _env_prefix(_TOPDINDEX_BIN, _TOPPIC_BINDING),
        topindex_bin = str(_TOPDINDEX_BIN_DIR / "topindex"),
        python_bin = sys.executable,
    message:
        "topindex (2.1): indexing {input.fasta}"
    shell:
        '"{params.python_bin}" -c "import sys,shutil; shutil.rmtree(sys.argv[1], ignore_errors=True)" "{params.index_dir}" '
        '&& ({params.env_prefix}"{params.topindex_bin}" {params.fixed_mod} -n {params.n_terminal_form} '
        '{params.decoy} -e {params.mass_error} -E {params.prec_error} {params.extra} '
        '-u {threads} "{input.fasta}") '
        '&& "{params.python_bin}" -c "import sys;from pathlib import Path; Path(sys.argv[1]).touch()" "{output.complete}"'
