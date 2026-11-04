# TDEase node: topindex
# Build the shared TopPIC protein-database index exactly once per Run.
# The executable ships in the deployed toppic suite; this node owns the DAG
# boundary and completion marker that prevent concurrent batch toppic jobs
# from racing over the same <fasta>_idx directory. Single-sample workflows do
# not need this Node and leave config.topindex.enabled false.

import sys
from pathlib import Path

# The topindex executable ships inside the toppic suite package, so the default
# directory is the bound toppic node's catalog path injected in
# config["nodes"]["toppic"] (`topindex.bin_dir` in the Run's config.yaml
# replaces the directory, e.g. a host TopPIC install). Neither set = a named
# parse-time failure, not a relative-path "command not found" mid-run.
_TOPINDEX_OVERRIDE = (config.get("topindex") or {}).get("bin_dir") or ""
_TOPINDEX_BINDING = (config.get("nodes") or {}).get("toppic") or ""
if not _TOPINDEX_OVERRIDE and not _TOPINDEX_BINDING:
    raise FileNotFoundError(
        "topindex node is not usable: bind the toppic node "
        "(config['nodes']['toppic']) or set topindex.bin_dir"
    )

# The deployed package is flat on both platforms: topindex sits next to its
# DLLs (Windows) or next to lib/toppic/ (Linux). A bin_dir override names the
# directory that holds the tool binary (e.g. a host suite's bin/).
_ON_WINDOWS = sys.platform.startswith("win")
_TOPINDEX_NAME = "topindex.exe" if _ON_WINDOWS else "topindex"
_TOPINDEX_BIN_DIR = Path(_TOPINDEX_OVERRIDE) if _TOPINDEX_OVERRIDE else Path(_TOPINDEX_BINDING)
_TOPINDEX_BIN = _TOPINDEX_BIN_DIR / _TOPINDEX_NAME
_LIB_DIR = (
    _TOPINDEX_BIN_DIR.parent / "lib" / "toppic"
    if _TOPINDEX_OVERRIDE
    else Path(_TOPINDEX_BINDING) / "lib" / "toppic"
)
_ENV_PREFIX = "" if _ON_WINDOWS else f'LD_LIBRARY_PATH="{_LIB_DIR}" '
_FASTA = config.get("fasta", "database.fasta")
_INDEX_COMPLETE = f".tdease/topindex/{Path(_FASTA).name}.complete"


rule topindex:
    input:
        fasta = _FASTA,
    output:
        complete = _INDEX_COMPLETE,
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
        extra = lambda wc, cfg=config: cfg.get("topindex", {}).get("extra", ""),
        index_dir = f"{_FASTA}_idx",
        env_prefix = _ENV_PREFIX,
        topindex_bin = str(_TOPINDEX_BIN),
        python_bin = sys.executable,
    message:
        "topindex: indexing {input.fasta}"
    shell:
        '"{params.python_bin}" -c "import sys,shutil; shutil.rmtree(sys.argv[1], ignore_errors=True)" "{params.index_dir}" '
        '&& ({params.env_prefix}"{params.topindex_bin}" {params.fixed_mod} -n {params.n_terminal_form} '
        '{params.decoy} -e {params.mass_error} {params.extra} -u {threads} "{input.fasta}") '
        '&& "{params.python_bin}" -c "import sys;from pathlib import Path; Path(sys.argv[1]).touch()" "{output.complete}"'
