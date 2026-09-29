"""Tests for the toppic-raw-pipeline template (raw -> msconvert -> topfd -> toppic).

Core chain under test: the SAME static Snakefile must dry-run both standard
LCMS data and MS2-only data — the MS2-only case previously died at execution
("No spectrum to read in mzML file!") because the shared topfd rule declares
MS1 outputs unconditionally. The template's inline topfd rule declares only
{sample}_ms2.msalign (produced in both modes); data-dependent flags (-o / -x)
travel through config.yaml `extra`, which the agent sets after inspecting the
data.

Dry-run only — no tool execution, fake inputs suffice.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "tdease-ai-capability" / "system" / "templates" / "toppic-raw-pipeline"
NODES = ROOT / "data" / "backend" / "nodes"

SAMPLES = ["alpha", "beta"]

STANDARD_CONFIG = """\
samples:
  - alpha
  - beta
fasta: database.fasta
msconvert:
  raw_extension: .raw
topfd:
  activation: FILE
toppic:
  activation: FILE
"""

MS2_ONLY_CONFIG = """\
samples:
  - alpha
  - beta
fasta: database.fasta
msconvert:
  raw_extension: .raw
# MS2-only acquisition (probe the mzML first: no MS1 scans -> both flags):
topfd:
  activation: FILE
  extra: "-o"
toppic:
  activation: FILE
  extra: "-x"
"""

PTM_CONFIG = """\
samples:
  - alpha
  - beta
fasta: database.fasta
msconvert:
  raw_extension: .raw
topfd:
  activation: FILE
toppic:
  activation: FILE
  variable_ptm_file: histone_mods.txt
  variable_ptm_num: 4
  local_ptm_file: histone_common_mods.txt
"""


def _stage_run(tmp_path: Path, config_text: str) -> Path:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    shutil.copy(TEMPLATE / "Snakefile", run_dir / "Snakefile")
    (run_dir / "config.yaml").write_text(config_text, encoding="utf-8")
    (run_dir / "database.fasta").write_text(">p1\nMPEPTIDE\n", encoding="utf-8")
    for s in SAMPLES:
        (run_dir / f"{s}.raw").touch()
    (run_dir / "histone_mods.txt").touch()
    (run_dir / "histone_common_mods.txt").touch()
    for node_id in ("msconvert", "toppic"):
        shutil.copytree(
            NODES / node_id,
            run_dir / "nodes" / node_id,
            copy_function=lambda src, dst: os.link(src, dst),
        )
    return run_dir


def _dry_run(run_dir: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "snakemake", "-n", "-p",
         "--cores", "28", "--configfile", "config.yaml"],
        cwd=run_dir, capture_output=True, text=True, timeout=180,
    )


def _dry_run_ok(run_dir: Path) -> str:
    proc = _dry_run(run_dir)
    assert proc.returncode == 0, (
        f"dry-run failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
    )
    return proc.stdout + proc.stderr


# ── Core chain ────────────────────────────────────────────────────────────────

def test_template_dry_run_standard_data(tmp_path: Path) -> None:
    """Standard config: full 3-step DAG for every sample, no -o/-x flags."""
    out = _dry_run_ok(_stage_run(tmp_path, STANDARD_CONFIG))
    for rule in ("msconvert", "topfd", "toppic"):
        assert rule in out, f"rule {rule} missing from dry-run DAG"
    assert "-o -u" not in out and " -x " not in out
    assert 'common_variable_ptms.txt" -S 3' in out


def test_template_dry_run_ms2_only_data(tmp_path: Path) -> None:
    """MS2-only config: same DAG topology, and the -o/-x flags the agent
    derived from probing the data actually reach the command lines."""
    out = _dry_run_ok(_stage_run(tmp_path, MS2_ONLY_CONFIG))
    assert "topfd" in out and "toppic" in out
    assert " -o " in out, "topfd -o (missing-level-one) not on command line"
    assert " -x " in out, "toppic -x (no-topfd-feature) not on command line"


def test_template_wires_known_and_local_ptm_files(tmp_path: Path) -> None:
    out = _dry_run_ok(_stage_run(tmp_path, PTM_CONFIG))
    assert '-b "histone_mods.txt" -S 4' in out
    assert '-B "histone_common_mods.txt"' in out


# ── Profile compliance (frontend DAG parity, §4.3) ────────────────────────────

def test_template_snakefile_passes_profile() -> None:
    from src.execution_runtime.profile_validator import validate_snakefile_profile

    report = validate_snakefile_profile(
        (TEMPLATE / "Snakefile").read_text(encoding="utf-8")
    )
    assert report.valid, (
        "template Snakefile failed Profile:\n  - " + "\n  - ".join(report.errors())
    )


def test_builtin_ptm_library_is_valid_and_synced() -> None:
    """The Node's built-in variable-PTM file must stay parseable by TopPIC.
    One deployment copy (data/backend/nodes — Backend owns compute software;
    Desktop/System data remains separate from it).
    Format (TopPIC mod_util readModTxt): Name,Mass,Residues,Position,
    UnimodID with Position in {any, N-term, C-term} and a numeric mass/UnimodID.
    Only locks file shape — no TopPIC run."""
    library = (
        ROOT / "data" / "backend" / "nodes" / "toppic" / "resources" / "common_variable_ptms.txt"
    )
    positions = {"any", "N-term", "C-term"}
    mods = set()
    for line in library.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        fields = [f.strip() for f in line.split(",")]
        assert len(fields) == 5, f"bad PTM line (need 5 fields): {line!r}"
        name, mass, residues, position, unimod_id = fields
        float(mass)                    # TopPIC parses this as double
        int(unimod_id)                 # TopPIC parses this as int
        assert residues, f"empty residues: {line!r}"
        assert position in positions, f"bad position {position!r}: {line!r}"
        mods.add(name)
    # The basic routine set, deliberately minimal: a large variable-PTM space
    # makes TopPIC searches explosively slow (the official tutorial's example
    # var_mods.txt ships just Met oxidation). Grow this set only by conscious
    # decision together with this assertion.
    assert mods == {"Acetyl", "Phospho", "Methyl", "Dimethyl", "Oxidation"}, (
        "built-in variable-PTM library must be exactly the basic routine set"
    )
