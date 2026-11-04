"""Mass-spec workflow integration test — end-to-end through Execution Runtime.

Converted from a standalone `check()`/`sys.exit()` script (see git history).
The original always called ``sys.exit(0)`` regardless of how many checks
failed, so a green run was not trustworthy, and the module-scope ``sys.exit``
aborted the whole pytest session on collection
(docs/STATUS.md). This module lets pytest report real
per-assertion results instead.

Note on `rule all`: the engine only builds the DAG for the default target
(the first rule) when no explicit target is requested
(src/execution_runtime/engine_runner.py, ``DAGSettings(targets=...)``), so an
aggregating `rule all` is required to exercise the full 3-step chain.

Note on task/event granularity: the current engine wraps an entire Snakemake
invocation in a single "engine" task (WORKFLOW-RUN.md — per-rule
`snakemake.job_*` events are listed as "planned", not yet emitted), so
`total_tasks` is 1 and there are exactly 4 events for any successful run,
independent of how many Snakemake rules executed internally.
"""
from __future__ import annotations

import pytest

from src.contracts import RunCommit, TreeManifest, WorkspaceIdentity
from src.execution_runtime import StorageLayout, execute, set_storage

SNAKEFILE = r'''
rule all:
    input:
        "results/qc_summary.txt"
    shell:
        "echo done"

rule msconvert:
    output:
        "data/sample.mzML"
    shell:
        "echo Converting raw to mzML && echo mzML_DATA > data/sample.mzML"

rule feature_detect:
    input:
        "data/sample.mzML"
    output:
        "results/sample_features.csv"
    shell:
        "echo mass,rt,intensity > results/sample_features.csv && echo 500.2,30.5,10000 >> results/sample_features.csv"

rule qc_summary:
    input:
        "results/sample_features.csv"
    output:
        "results/qc_summary.txt"
    shell:
        "echo QC report && echo QC_PASSED > results/qc_summary.txt"
'''


@pytest.fixture()
def storage(tmp_path) -> StorageLayout:
    st = StorageLayout(tmp_path / "server-data")
    st.bootstrap()
    set_storage(st)
    return st


@pytest.fixture()
def commit() -> RunCommit:
    ws = WorkspaceIdentity(name="test-ms")
    tree = TreeManifest(workspace_id=ws.workspace_id, entries=[])
    tree.freeze()
    return RunCommit(
        run_id="ms-001", idempotency_key="ik-ms",
        workspace_id=ws.workspace_id, workspace_tree_hash=tree.tree_hash,
        snakefile=SNAKEFILE, cores=1, user_id="test",
    )


def test_execute_runs_the_full_chain_as_a_single_engine_task(storage: StorageLayout, commit: RunCommit, queue_run) -> None:
    queue_run("ms-001", "def-ms-001")
    result = execute(commit, revision_id="def-ms-001", execution_mode="execute")
    assert result.success, str(result.error)
    assert result.total_tasks == 1
    assert result.succeeded_tasks == 1
    assert result.failed_tasks == 0
    assert result.run_time_seconds < 30


def test_events_are_well_formed_and_monotonic(storage: StorageLayout, commit: RunCommit, queue_run) -> None:
    queue_run("ms-001", "def-ms-001")
    execute(commit, revision_id="def-ms-001", execution_mode="execute")

    evts = storage.read_events("ms-001")
    assert len(evts) >= 4
    assert all(e["seq"] == i + 1 for i, e in enumerate(evts))
    # The journal opens with the queued revision (submit + queue_request),
    # then the engine emits run.started -- matching the real worker path.
    assert evts[0]["type"] == "run.submitted"
    assert "run.started" in {e["type"] for e in evts}
    assert evts[-1]["type"] == "task.succeeded"
    assert any(e["type"] == "workflow.graph" for e in evts)
    assert any(e["type"] == "job.started" for e in evts)
    assert any(e["type"] == "job.succeeded" for e in evts)
    assert any(e["type"] == "task.succeeded" for e in evts)


def test_results_and_storage_layout_are_populated(storage: StorageLayout, commit: RunCommit, queue_run) -> None:
    queue_run("ms-001", "def-ms-001")
    result = execute(commit, revision_id="def-ms-001", execution_mode="execute")
    assert result.success, str(result.error)

    results = sorted((storage.resolve("ms-001", "results")).rglob("*"))
    assert len(results) >= 1

    qc = storage.resolve("ms-001", "results", "qc_summary.txt")
    assert qc.exists()
    assert "QC_PASSED" in qc.read_text()

    run_dir = storage.resolve("ms-001")
    for entry in ["Snakefile", "events.jsonl", "results", "logs"]:
        assert (run_dir / entry).exists(), f"missing {entry}"


def test_events_are_recoverable_after_the_run(storage: StorageLayout, commit: RunCommit, queue_run) -> None:
    queue_run("ms-001", "def-ms-001")
    execute(commit, revision_id="def-ms-001", execution_mode="execute")
    events = storage.read_events("ms-001")
    assert events[-1]["type"] == "task.succeeded"
    assert [event["seq"] for event in events] == list(range(1, len(events) + 1))
