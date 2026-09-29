# TDEase node: topindex
# Build the shared TopPIC protein-database index exactly once per Run.
# The executable ships in the deployed toppic suite; this node owns the DAG
# boundary and completion marker that prevent concurrent batch toppic jobs
# from racing over the same <fasta>_idx directory. Single-sample workflows do
# not need this Node and leave config.topindex.enabled false.

import sys
from pathlib import Path

# topindex.exe ships inside the toppic suite package, so the default directory
# is the bound toppic node's catalog path injected in config["nodes"]["toppic"]
# (binding this node without the toppic node leaves the path empty — the rule
# fails loudly rather than silently). `<tool>.bin_dir` in the Run's config.yaml
# replaces the directory, e.g. a host TopPIC install.
_TOPINDEX_BIN_DIR = Path((config.get("topindex") or {}).get("bin_dir")
                         or (config.get("nodes") or {}).get("toppic") or "")
_TOPINDEX_BIN = _TOPINDEX_BIN_DIR / "topindex.exe"
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
        topindex_bin = str(_TOPINDEX_BIN),
        python_bin = sys.executable,
    message:
        "topindex: indexing {input.fasta}"
    shell:
        '"{params.python_bin}" -c "import shutil; shutil.rmtree(r\'{params.index_dir}\', ignore_errors=True)" '
        '&& ("{params.topindex_bin}" {params.fixed_mod} -n {params.n_terminal_form} '
        '{params.decoy} -e {params.mass_error} {params.extra} -u {threads} "{input.fasta}") '
        '&& "{params.python_bin}" -c "from pathlib import Path; Path(r\'{output.complete}\').touch()"'
