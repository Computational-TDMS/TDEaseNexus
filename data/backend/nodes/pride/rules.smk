# TDEase node: pride
# Fetch raw files from the PRIDE Archive (ProteomeXchange) by accession.
#
# ============================================================================
# WHAT AN AGENT NEEDS TO KNOW BEFORE USING THIS NODE
# ============================================================================
#
# This is a *source* rule: it has no input and produces a file that did not
# exist locally. In a filesystem-as-truth pipeline that makes it the one rule
# that can reach outside the Workspace, so it is deliberately narrow.
#
# The wildcard is constrained to exactly the names listed in
# `config["pride"]["files"]`. Without that constraint Snakemake would offer to
# satisfy *any* missing file under the output directory by asking PRIDE for it,
# and a typo in a downstream rule would become a download attempt instead of an
# error. Declaring the files is what keeps a missing-file error a missing-file
# error.
#
# `fetch.py` verifies the byte count PRIDE records for the file and writes to a
# temporary path first, so a interrupted transfer never lands at the output
# path. This matters more here than elsewhere: a truncated raw file is still a
# file, and every rule downstream would treat the step as complete.
#
# Alongside each file it writes `<name>.source.json` — accession, source URL,
# byte count, SHA-256 and retrieval time. That sidecar is what lets a later
# conclusion cite the origin of the measurement without anyone having to
# remember it. Keep it next to the file; it is cheap and it is the only record
# that the bytes came from a public archive rather than from this machine.
#
# PRIDE serves ~1 GB raw files at a few MB/s. A project can be tens of GB in
# total, so list the files the analysis actually needs rather than the project.
# The v2 file API answers 200 with an empty body; `fetch.py` uses v3.
# Checked 2026-07-26.
#
# Related public archives that are NOT this node: MassIVE (MSV…), jPOST,
# iProX. They have different APIs; add a sibling node rather than widening
# this one, so each keeps one host and one failure mode.
# ============================================================================
#
# Example config.yaml
# -------------------
#   pride:
#     accession: PXD014660
#     dest: raw
#     files:
#       - Sorghum-Histone0810162L01.raw
#       - Sorghum-Histone0810162L01_IcTsv.zip
#
# Then depend on `raw/Sorghum-Histone0810162L01.raw` from any downstream rule.
# ----------------------------------------------------------------------------
import re
import sys
from pathlib import Path

# The Backend injects this node's deployed catalog directory as an absolute
# path in config["nodes"] at execution time; failing loudly when the Run did
# not bind the node beats silently pointing nowhere.
_PRIDE_DIR = Path((config.get("nodes") or {}).get("pride") or "")

_PRIDE_CFG = config.get("pride", {}) if "config" in dir() else {}
_PRIDE_FILES = list(_PRIDE_CFG.get("files", []))
_PRIDE_DEST = _PRIDE_CFG.get("dest", "raw")

# "$^" matches nothing, so with no declared files the rule is inert rather than
# greedy. This is the difference between an unused node and a node that hijacks
# every missing file in the DAG.
_PRIDE_PATTERN = "|".join(re.escape(name) for name in _PRIDE_FILES) or "$^"


# ----------------------------------------------------------------------------
# rule pride_fetch — download one declared file from a PRIDE project
# Inputs : none (source rule; reaches the network)
# Outputs: <dest>/<filename> plus <dest>/<filename>.source.json
# ----------------------------------------------------------------------------
rule pride_fetch:
    output:
        path = f"{_PRIDE_DEST}/{{pride_file}}",
    wildcard_constraints:
        pride_file = _PRIDE_PATTERN,
    threads:
        1
    resources:
        mem_mb = 256,
    retries:
        2
    params:
        accession  = _PRIDE_CFG.get("accession", ""),
        # Advanced knobs (see README.md "Parameters"): defaults match fetch.py's
        # argparse defaults (timeout 120s, page_size 500, sidecar on). They were
        # These are wired here, in the executable SMK contract, so setting
        # them in config changes the actual fetch command.
        timeout    = _PRIDE_CFG.get("timeout", 120),
        page_size  = _PRIDE_CFG.get("page_size", 500),
        no_sidecar = "--no-sidecar" if _PRIDE_CFG.get("no_sidecar", False) else "",
        script     = str(_PRIDE_DIR / "fetch.py"),
        python     = sys.executable,
    message:
        "pride: {params.accession}/{wildcards.pride_file} -> {output.path}"
    shell:
        '"{params.python}" "{params.script}" '
        '--accession "{params.accession}" '
        '--file "{wildcards.pride_file}" '
        '--out "{output.path}" '
        '--timeout {params.timeout} '
        '--page-size {params.page_size} '
        '{params.no_sidecar}'
