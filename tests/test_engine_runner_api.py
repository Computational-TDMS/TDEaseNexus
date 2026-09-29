from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def test_engine_runner_executes_internal_request_without_cli_contract(tmp_path: Path) -> None:
    (tmp_path / "Snakefile").write_text(
        """
rule all:
    input:
        "results/done.txt"

rule produce:
    output:
        "results/done.txt"
    run:
        from pathlib import Path
        Path(output[0]).parent.mkdir(parents=True, exist_ok=True)
        Path(output[0]).write_text("ok", encoding="utf-8")
""".strip()
        + "\n",
        encoding="utf-8",
    )
    request_dir = tmp_path / ".tdease"
    request_dir.mkdir()
    legacy_engine_dir = tmp_path / ".snakemake"
    legacy_engine_dir.mkdir()
    (legacy_engine_dir / "legacy-marker.txt").write_text("keep", encoding="utf-8")
    (request_dir / "engine-request.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "mode": "execute",
                "snakefile": "Snakefile",
                "config": {},
                "cores": 1,
                "targets": [],
                "rerun_incomplete": True,
                "retries": 0,
            }
        ),
        encoding="utf-8",
    )

    completed = subprocess.run(
        [sys.executable, "-m", "src.execution_runtime.engine_runner"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=120,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert (tmp_path / "results" / "done.txt").read_text(encoding="utf-8") == "ok"
    assert not (tmp_path / ".snakemake").exists()
    assert (tmp_path / ".tdease" / "engine" / "legacy-marker.txt").read_text(encoding="utf-8") == "keep"


CHAIN_SNAKEFILE = """
rule all:
    input:
        "results/final.txt"

rule produce:
    output:
        "results/final.txt"
    run:
        from pathlib import Path
        Path(output[0]).parent.mkdir(parents=True, exist_ok=True)
        Path(output[0]).write_text("ok", encoding="utf-8")
""".strip() + "\n"


def _execute(tmp_path: Path, projection_path: str) -> dict:
    (tmp_path / ".tdease").mkdir(exist_ok=True)
    (tmp_path / ".tdease" / "engine-request.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "mode": "execute",
                "snakefile": "Snakefile",
                "config": {},
                "cores": 1,
                "targets": [],
                "rerun_incomplete": True,
                "retries": 0,
                "projection_path": projection_path,
            }
        ),
        encoding="utf-8",
    )
    completed = subprocess.run(
        [sys.executable, "-m", "src.execution_runtime.engine_runner"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    return json.loads((tmp_path / projection_path).read_text(encoding="utf-8"))


def test_engine_runner_resume_projection_keeps_completed_edges(tmp_path: Path) -> None:
    """A resumed Run must not orphan its completed jobs.

    The projection keeps every DAG job as a node (completed ones as
    `up_to_date`), so it must also keep their edges. Filtering edges by
    `needrun(dependency)` severed completed nodes from the graph, and since
    each execution's graph event replaces the stored one, a reopened Run
    showed them permanently isolated. The second phase below has nothing
    left to run — exactly the resume shape — and must still project the
    produce→all edge.
    """
    (tmp_path / "Snakefile").write_text(CHAIN_SNAKEFILE, encoding="utf-8")

    first = _execute(tmp_path, "graph-1.json")
    assert len(first["nodes"]) == 2
    assert len(first["edges"]) == 1

    second = _execute(tmp_path, "graph-2.json")
    node_ids = {node["id"] for node in second["nodes"]}
    assert len(node_ids) == 2
    assert all(node["initial_status"] == "up_to_date" for node in second["nodes"])
    assert len(second["edges"]) == 1
    edge = second["edges"][0]
    assert edge["source"] in node_ids and edge["target"] in node_ids
    assert edge["source"] != edge["target"]


RESOURCE_SNAKEFILE = """
rule all:
    input:
        "results/out.txt"

rule heavy:
    output:
        "results/out.txt"
    threads:
        28
    resources:
        mem_mb=512
    run:
        from pathlib import Path
        Path(output[0]).parent.mkdir(parents=True, exist_ok=True)
        Path(output[0]).write_text("ok", encoding="utf-8")
""".strip() + "\n"


def _invoke_engine(tmp_path: Path, request: dict):
    (tmp_path / ".tdease").mkdir(exist_ok=True)
    (tmp_path / ".tdease" / "engine-request.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "snakefile": "Snakefile",
                "config": {},
                "targets": [],
                "rerun_incomplete": True,
                "retries": 0,
                **request,
            }
        ),
        encoding="utf-8",
    )
    return subprocess.run(
        [sys.executable, "-m", "src.execution_runtime.engine_runner"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_engine_runner_dry_run_projects_the_core_clamp(tmp_path: Path) -> None:
    """threads are peak appetite, not a reservation (spec/WORKFLOW-RUN.md §1).

    The engine clamps each job's threads to the Run's core budget at DAG
    build time; the projection must show the resolved value so the
    degradation is observable, never silent.
    """
    (tmp_path / "Snakefile").write_text(RESOURCE_SNAKEFILE, encoding="utf-8")

    completed = _invoke_engine(
        tmp_path,
        {"mode": "dry-run", "cores": 2, "projection_path": "graph.json"},
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    projection = json.loads((tmp_path / "graph.json").read_text(encoding="utf-8"))
    by_rule = {node["rule"]: node for node in projection["nodes"]}
    assert by_rule["heavy"]["threads"] == 2
    assert by_rule["heavy"]["resources"] == {"mem_mb": 512}
    assert by_rule["all"]["threads"] == 1
    assert by_rule["all"]["resources"] == {}


def test_engine_runner_rejects_infeasible_resource_floor_before_any_job(tmp_path: Path) -> None:
    """mem_mb is a hard floor, never clamped (spec/WORKFLOW-RUN.md §1).

    A floor above the Run budget fails before the first job starts, naming
    the rule and both values — never a mid-run opaque ENGINE_TASK_FAILED.
    """
    (tmp_path / "Snakefile").write_text(
        RESOURCE_SNAKEFILE.replace("mem_mb=512", "mem_mb=8192"), encoding="utf-8"
    )

    completed = _invoke_engine(
        tmp_path, {"mode": "execute", "cores": 2, "memory_mb": 1024}
    )

    assert completed.returncode == 1
    assert "rule 'heavy'" in completed.stderr
    assert "mem_mb=8192" in completed.stderr
    assert "mem_mb=1024" in completed.stderr
    assert not (tmp_path / "results").exists()
