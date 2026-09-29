"""Tests for the informed-proteomics-pipeline template (mzML -> PbfGen -> ProMex -> MSPathFinderT).

Core chain under test: the template composes the deployed informed-proteomics
Node's OWN rules via `include:`, so the node's output-name contract is
load-bearing for the DAG. The recovered deployment declared names the
binaries never write ({prefix}_ms1.ms1ft, {prefix}_IcTda.mzid) and the
histone48 workspace runs (r1-r3, 2026-09) failed on exactly that — the DAG
could not resolve, then MSPathFinderT outputs were declared wrong again.
The empirical v1.1.8305 contract (see the node's output-name contract):

    ProMex         {sample}.ms1ft
    MSPathFinderT  {sample}_IcTarget.tsv + _IcDecoy.tsv + _IcTda.tsv + .mzid

The dry-run asserts the resolved COMMAND LINES carry those names and the
optimized defaults (-tda 1, -overwrite true, bundled targeted mods library).
The interim node wiring used config-driven input lambdas, which the static
Profile forbids (tests/test_profile_validator.py) — both node and template
must pass Profile.

Dry-run only — no tool execution, fake inputs suffice.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "tdease-ai-capability" / "system" / "templates" / "informed-proteomics-pipeline"
NODE = ROOT / "data" / "backend" / "nodes" / "informed-proteomics"

SAMPLES = ["alpha", "beta"]

DEFAULT_CONFIG = """\
samples:
  - alpha
  - beta
fasta: database.fasta
promex:
  min_charge: 2
  max_charge: 30
informed-proteomics:
  tda: 1
  overwrite: true
"""

OVERRIDE_MODS_CONFIG = """\
samples:
  - alpha
fasta: database.fasta
informed-proteomics:
  mods: histone_targeted_mods.txt
  tda: 1
"""

NO_MODS_CONFIG = """\
samples:
  - alpha
fasta: database.fasta
informed-proteomics:
  mods: ""
  tda: 0
"""


def _stage_run(tmp_path: Path, config_text: str) -> Path:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    shutil.copy(TEMPLATE / "Snakefile", run_dir / "Snakefile")
    (run_dir / "config.yaml").write_text(config_text, encoding="utf-8")
    (run_dir / "database.fasta").write_text(">p1\nMPEPTIDEK\n", encoding="utf-8")
    for s in SAMPLES:
        (run_dir / f"{s}.mzML").touch()
    (run_dir / "histone_targeted_mods.txt").touch()
    shutil.copytree(
        NODE,
        run_dir / "nodes" / "informed-proteomics",
        copy_function=lambda src, dst: os.link(src, dst),
    )
    return run_dir


def _dry_run(run_dir: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "snakemake", "-n", "-p",
         "--cores", "2", "--configfile", "config.yaml"],
        cwd=run_dir, capture_output=True, text=True, timeout=180,
    )


def _dry_run_ok(run_dir: Path) -> str:
    proc = _dry_run(run_dir)
    assert proc.returncode == 0, (
        f"dry-run failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
    )
    return proc.stdout + proc.stderr


# ── Core chain ────────────────────────────────────────────────────────────────

def test_template_dry_run_default_config(tmp_path: Path) -> None:
    """Default config: full 3-step DAG for every sample with the empirical
    output-name contract and the optimized defaults on the command lines."""
    out = _dry_run_ok(_stage_run(tmp_path, DEFAULT_CONFIG))
    for rule in ("pbngen", "promex", "mspathfindert"):
        assert rule in out, f"rule {rule} missing from dry-run DAG"
    assert '{input' not in out
    assert '"alpha.mzML"' in out and '"beta.mzML"' in out
    assert '-MinCharge 2 -MaxCharge 30' in out
    # MSPathFinderT flags: -d the fasta (NOT -f), -feature the ms1ft (NOT -m),
    # -tda 1, -overwrite true, -mod the node's bundled targeted library.
    assert '-d "database.fasta"' in out
    assert '-feature "alpha.ms1ft"' in out
    assert '-tda 1' in out
    assert '-overwrite true' in out
    # Path separators are OS-native (Path -> backslash on Windows); match the
    # file name only.
    assert '-mod "' in out and 'mspf_targeted_mods.txt' in out
    # The wrong names the recovered deployment declared must stay dead.
    assert "_ms1.ms1ft" not in out
    assert "_IcTda.mzid" not in out
    assert "histone48" not in out


def test_template_wires_mods_override(tmp_path: Path) -> None:
    """A run-local source-artifact mods file reaches the command line."""
    out = _dry_run_ok(_stage_run(tmp_path, OVERRIDE_MODS_CONFIG))
    assert '-mod "histone_targeted_mods.txt"' in out


def test_template_empty_mods_disables_library(tmp_path: Path) -> None:
    """Explicit mods:"" means unmodified-only: no -mod flag at all, and
    tda 0 is honored (the node rule default 1 must not leak in)."""
    out = _dry_run_ok(_stage_run(tmp_path, NO_MODS_CONFIG))
    assert "-mod" not in out
    assert "-tda 0" in out


# ── Profile compliance (frontend DAG parity, §4.3) ────────────────────────────

def test_template_snakefile_passes_profile() -> None:
    from src.execution_runtime.profile_validator import validate_snakefile_profile

    report = validate_snakefile_profile(
        (TEMPLATE / "Snakefile").read_text(encoding="utf-8")
    )
    assert report.valid, (
        "template Snakefile failed Profile:\n  - " + "\n  - ".join(report.errors())
    )


# ── Bundled targeted mods library (source artifact, tracked in git) ──────────

def test_bundled_targeted_mods_library_shape() -> None:
    """The node's default -mod library must stay parseable by MSPathFinderT
    (bare mods-file syntax) and exactly the suite-authored Note-15 targeted
    set. Only locks file shape — no MSPathFinderT run."""
    library = NODE / "resources" / "mspf_targeted_mods.txt"
    positions = {"any", "N-term", "C-term", "Prot-N-term", "Prot-C-term"}
    num_mods = None
    mods = set()
    for line in library.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        if line.upper().startswith("NUMMODS="):
            num_mods = int(line.split("=", 1)[1])
            continue
        fields = [f.strip() for f in line.split(",")]
        assert len(fields) == 5, f"bad mods line (need 5 fields): {line!r}"
        composition, residues, mode, position, name = fields
        assert composition, f"empty composition: {line!r}"
        assert residues == "*" or residues.isalpha(), f"bad residues: {line!r}"
        assert mode in ("opt", "fix"), f"bad mode: {line!r}"
        assert position in positions, f"bad position {position!r}: {line!r}"
        mods.add(name)
    assert num_mods == 4, "NumMods must stay the suite default 4"
    assert mods == {
        "Oxidation", "Phospho", "Acetyl", "Methyl", "DiMethyl", "TriMethyl",
        "Trioxidation",
    }, "bundled library must be exactly the Note-15 targeted set"
