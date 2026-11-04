"""Tests for the toppic-indexed-pipeline template
(raw -> msconvert -> topfd -> topindex ONCE -> toppic per sample).

Core chain under test: many samples share ONE protein database, so the index
is built by exactly one topindex job and every toppic job consumes its
completion marker — the DAG serializes index-first, then fans out per sample.
The marker dependency is what prevents N toppic processes from racing on the
same <fasta>_idx directory.

The template's header carries the measured DISK BUDGET for the index
(≈ 2 × FASTA: two database copies + shift blocks; plan ≈ 4 × FASTA) — the
annotation is load-bearing product documentation, so these tests pin it.

Node binding follows the shipped contract (WORKFLOW-RUN.md): the template
resolves nodes only through the injected `config["nodes"]` absolute catalog
paths; the run directory never contains a nodes/ subtree.

Dry-run only — no tool execution, fake inputs suffice.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "tdease-ai-capability" / "system" / "templates" / "toppic-indexed-pipeline"
NODES = ROOT / "data" / "backend" / "nodes"

SAMPLES = ["alpha", "beta", "gamma"]

BATCH_CONFIG = """\
samples:
  - alpha
  - beta
  - gamma
fasta: database.fasta
msconvert:
  raw_extension: .raw
topfd:
  activation: FILE
toppic:
  activation: FILE
"""


def _stage_run(tmp_path: Path, config_text: str, *, bind_nodes: bool = True) -> Path:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    if bind_nodes:
        config_text += "nodes:\n" + "".join(
            f"  {node_id}: {(NODES / node_id).as_posix()}\n"
            for node_id in ("msconvert", "toppic", "topindex")
        )
    shutil.copy(TEMPLATE / "Snakefile", run_dir / "Snakefile")
    (run_dir / "config.yaml").write_text(config_text, encoding="utf-8")
    (run_dir / "database.fasta").write_text(">p1\nMPEPTIDE\n", encoding="utf-8")
    for sample in SAMPLES:
        (run_dir / f"{sample}.raw").touch()
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


# ── Node binding (WORKFLOW-RUN.md contract) ───────────────────────────────────

def test_template_without_bindings_fails_loudly(tmp_path: Path) -> None:
    """No config['nodes'] injection -> the guard names the missing binding."""
    out = _dry_run(_stage_run(tmp_path, BATCH_CONFIG, bind_nodes=False))
    assert out.returncode != 0
    combined = out.stdout + out.stderr
    assert "node is missing from this Run" in combined


def test_template_resolves_nodes_only_through_injection(tmp_path: Path) -> None:
    """The catalog stays outside the run directory: the dry-run reads every
    node's bytes through the injected absolute paths, not a local copy."""
    run_dir = _stage_run(tmp_path, BATCH_CONFIG)
    assert not (run_dir / "nodes").exists()
    out = _dry_run_ok(run_dir)
    for rule in ("msconvert", "topfd", "topindex", "toppic"):
        assert rule in out, f"rule {rule} missing from dry-run DAG"


# ── Shared-index scheduling ───────────────────────────────────────────────────

def test_index_built_once_per_run_and_fans_out_per_sample(tmp_path: Path) -> None:
    """One topindex job regardless of sample count; every toppic job waits on
    the completion marker."""
    out = _dry_run_ok(_stage_run(tmp_path, BATCH_CONFIG))
    lines = out.splitlines()
    counts = {}
    for line in lines:
        for rule in ("msconvert", "topfd", "topindex", "toppic"):
            if line.strip().startswith(rule):
                try:
                    counts[rule] = int(line.split()[-1])
                except ValueError:
                    continue
    assert counts.get("topindex") == 1, (
        f"topindex must schedule exactly one job, got: {counts} in\n{out}"
    )
    assert counts.get("toppic") == len(SAMPLES), (
        f"toppic must fan out per sample ({len(SAMPLES)}), got: {counts}"
    )
    assert counts.get("topfd") == len(SAMPLES) and counts.get("msconvert") == len(SAMPLES)


def test_toppic_jobs_depend_on_the_completion_marker(tmp_path: Path) -> None:
    """The marker path (the topindex Node's declared output contract) appears
    as a scheduled output of the single topindex job."""
    out = _dry_run_ok(_stage_run(tmp_path, BATCH_CONFIG))
    assert ".tdease/topindex/database.fasta.complete" in out


# ── The disk-budget annotation is load-bearing documentation ─────────────────

def test_disk_budget_formula_is_documented_in_the_template() -> None:
    """The header must carry the measured composition and the planning rule:
    missing them is how a 66 MB database meets a full disk mid-Run."""
    text = (TEMPLATE / "Snakefile").read_text(encoding="utf-8")
    assert "DISK BUDGET" in text
    assert "2 × S_fasta" in text          # two database copies dominate
    assert "4 × S_fasta" in text          # planning rule with margin
    assert "bytes/residue" in text        # the empirical anchor
