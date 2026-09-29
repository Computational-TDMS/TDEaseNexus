from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from src.services.node_catalog import scan_nodes


ROOT = Path(__file__).resolve().parent.parent
NODES = ROOT / "data" / "backend" / "nodes"


def test_topindex_is_a_discoverable_backend_node() -> None:
    nodes, errors = scan_nodes(NODES)
    assert not errors
    projected = {node["id"]: node for node in nodes}
    assert "topindex" in projected
    assert [capability["name"] for capability in projected["topindex"]["capabilities"]] == ["topindex"]


def test_topindex_smk_is_the_complete_node_contract() -> None:
    rules = (NODES / "topindex" / "rules.smk").read_text(encoding="utf-8")
    assert not (NODES / "topindex" / "node.json").exists()
    assert 'rule topindex:' in rules
    assert 'n_terminal_form = lambda' in rules
    assert 'mass_error = lambda' in rules
    assert 'topindex.exe' in rules


def test_toppic_uses_backend_serialization_slot_without_topindex_dependency() -> None:
    rules = (NODES / "toppic" / "rules.smk").read_text(encoding="utf-8")
    assert "toppic_slots = 1" in rules
    assert "_INDEX_COMPLETE" not in rules


def _nodes_config(*node_ids: str) -> list[str]:
    """The binding the Backend injects: absolute catalog paths in config."""
    mapping = {node_id: (NODES / node_id).resolve().as_posix() for node_id in node_ids}
    return ["--config", f"nodes={json.dumps(mapping)}"]


@pytest.mark.skipif(not (NODES / "toppic" / "topindex.exe").is_file(), reason="topindex.exe not deployed")
def test_real_topindex_node_builds_once_and_then_is_up_to_date(tmp_path: Path) -> None:
    fasta = tmp_path / "database.fasta"
    fasta.write_text(">protein_a\nMPEPTIDEKPEPTIDE\n>protein_b\nMACDEFGHIK\n", encoding="ascii")
    snakefile = tmp_path / "Snakefile"
    rules = (NODES / "topindex" / "rules.smk").resolve().as_posix()
    snakefile.write_text(
        f'include: "{rules}"\n\n'
        'rule all:\n'
        '    input:\n'
        '        ".tdease/topindex/database.fasta.complete"\n',
        encoding="utf-8",
    )
    command = [
        sys.executable, "-m", "snakemake", "--snakefile", str(snakefile),
        "--directory", str(tmp_path), "--cores", "2", "--printshellcmds",
        *_nodes_config("toppic"),
    ]

    stale_index = tmp_path / "database.fasta_idx"
    stale_index.mkdir()
    (stale_index / "partial-index").write_text("interrupted", encoding="ascii")

    first = subprocess.run(command, capture_output=True, text=True, timeout=120)
    assert first.returncode == 0, first.stdout + first.stderr
    assert not (stale_index / "partial-index").exists()
    assert (tmp_path / ".tdease" / "topindex" / "database.fasta.complete").is_file()
    assert any((tmp_path / "database.fasta_idx").iterdir())

    second = subprocess.run(command, capture_output=True, text=True, timeout=60)
    assert second.returncode == 0, second.stdout + second.stderr
    assert "Nothing to be done" in second.stdout + second.stderr


def test_two_sample_dag_uses_two_serialized_toppic_jobs_without_topindex(tmp_path: Path) -> None:
    (tmp_path / "database.fasta").write_text(">protein\nMPEPTIDE\n", encoding="ascii")
    for sample in ("a", "b"):
        (tmp_path / f"{sample}_ms2.msalign").write_text("", encoding="ascii")
    toppic_rules = (NODES / "toppic" / "rules.smk").resolve().as_posix()
    snakefile = tmp_path / "Snakefile"
    snakefile.write_text(
        f'include: "{toppic_rules}"\n\n'
        'SAMPLES = ["a", "b"]\n\n'
        'rule all:\n'
        '    input:\n'
        '        expand("{sample}_ms2_toppic_proteoform.tsv", sample=SAMPLES)\n',
        encoding="utf-8",
    )
    result = subprocess.run(
        [sys.executable, "-m", "snakemake", "--snakefile", str(snakefile),
         "--directory", str(tmp_path), "--cores", "4",
         "--resources", "toppic_slots=1", "--dry-run", *_nodes_config("toppic")],
        capture_output=True, text=True, timeout=60,
    )
    output = result.stdout + result.stderr
    assert result.returncode == 0, output
    assert "topindex" not in output
    assert "toppic" in output
    assert re.search(r"^toppic\s+2$", output, re.MULTILINE)
