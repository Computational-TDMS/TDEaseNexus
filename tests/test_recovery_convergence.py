"""Crash recovery converges the canonical Journal without mutating Run definition state."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from src.execution_runtime import set_storage
from src.execution_runtime.events import EventEmitter
from src.execution_runtime.storage import StorageLayout
from src.services.run_commands import get_run_commands


REVISION = "rev-test"


def _prepare(storage: StorageLayout, run_id: str) -> EventEmitter:
    storage.allocate_run(run_id)
    storage.atomic_write_json(
        storage.resolve(run_id, "run.json"),
        {"run_id": run_id, "current_revision": REVISION},
    )
    emitter = EventEmitter(run_id)
    emitter.run_submitted(REVISION)
    emitter.run_queue_requested(REVISION, "execute")
    return emitter


def _running(storage: StorageLayout, run_id: str) -> EventEmitter:
    emitter = _prepare(storage, run_id)
    emitter.run_started(REVISION, "execute", 42, "test-worker")
    return emitter


def _write_events_raw(storage: StorageLayout, run_id: str, raw: bytes) -> None:
    storage.events_path(run_id).write_bytes(raw)


def _raw_event(seq: int, event_type: str, data: dict) -> str:
    return json.dumps({"schema_version": 3, "seq": seq, "type": event_type, "data": data}) + "\n"


def test_terminal_journal_survives_crash_without_run_json_projection(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path)
    storage.bootstrap()
    set_storage(storage)
    emitter = _running(storage, "run-crash-a")
    emitter.run_failed(REVISION, 1, 1.0, "expected failure")

    definition_before = storage.read_json(storage.resolve("run-crash-a", "run.json"))
    recovered = get_run_commands().reconcile()
    projection, _metadata = storage.project_run_snapshot("run-crash-a")

    assert projection.status == "FAILED"
    assert recovered == []
    assert storage.read_json(storage.resolve("run-crash-a", "run.json")) == definition_before
    assert len(storage.read_events("run-crash-a")) == 4


def test_open_range_with_dead_worker_is_closed_by_terminal_event(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path)
    storage.bootstrap()
    set_storage(storage)
    _running(storage, "run-crash-open")

    assert get_run_commands().reconcile() == ["run-crash-open"]
    events = storage.read_events("run-crash-open")
    assert events[-1]["type"] == "run.failed"
    assert events[-1]["data"]["revision_id"] == REVISION
    assert storage.project_run_snapshot("run-crash-open")[0].status == "FAILED"
    assert "status" not in storage.read_json(storage.resolve("run-crash-open", "run.json"))


def test_terminal_run_releases_stale_claim_without_rewriting_history(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path)
    storage.bootstrap()
    set_storage(storage)
    emitter = _running(storage, "run-crash-claim")
    emitter.run_succeeded(REVISION, 1.0)
    assert storage.claim_run("run-crash-claim")
    events_before = storage.read_events("run-crash-claim")

    assert get_run_commands().reconcile() == []
    assert not storage.is_claimed("run-crash-claim")
    assert storage.read_events("run-crash-claim") == events_before
    assert storage.claim_run("run-crash-claim")


def test_queued_stale_claim_is_released_with_audit_event(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path)
    storage.bootstrap()
    set_storage(storage)
    _prepare(storage, "run-queued-claim")
    assert storage.claim_run("run-queued-claim")

    assert get_run_commands().reconcile() == ["run-queued-claim"]
    assert not storage.is_claimed("run-queued-claim")
    events = storage.read_events("run-queued-claim")
    assert events[-1]["type"] == "run.action"
    assert events[-1]["data"]["action"] == "orphan_reclaimed"
    assert storage.project_run_snapshot("run-queued-claim")[0].status == "QUEUED"


def test_repair_events_file_drops_only_partial_trailing_line(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path)
    storage.bootstrap()
    set_storage(storage)
    storage.allocate_run("run-partial")
    good = (
        _raw_event(1, "run.submitted", {"revision_id": REVISION})
        + _raw_event(2, "run.queue_requested", {"revision_id": REVISION, "mode": "execute"})
    )
    partial = '{"schema_version": 3, "seq": 3, "type": "run.start'
    _write_events_raw(storage, "run-partial", (good + partial).encode())

    assert storage.repair_events_file("run-partial") == len(partial.encode())
    assert storage.events_path("run-partial").read_text(encoding="utf-8") == good
    assert [event["type"] for event in storage.read_events("run-partial")] == [
        "run.submitted", "run.queue_requested",
    ]


def test_partial_terminal_append_recovers_open_range_in_one_pass(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path)
    storage.bootstrap()
    set_storage(storage)
    run_id = "run-partial-reconcile"
    storage.allocate_run(run_id)
    storage.atomic_write_json(storage.resolve(run_id, "run.json"), {"run_id": run_id})
    good = (
        _raw_event(1, "run.submitted", {"revision_id": REVISION})
        + _raw_event(2, "run.queue_requested", {"revision_id": REVISION, "mode": "execute"})
        + _raw_event(3, "run.started", {"revision_id": REVISION, "mode": "execute"})
    )
    _write_events_raw(storage, run_id, (good + '{"seq":4,"type":"run.fail').encode())

    assert get_run_commands().reconcile() == [run_id]
    events = storage.read_events(run_id)
    assert events[-1]["type"] == "run.failed"
    assert storage.project_run_snapshot(run_id)[0].status == "FAILED"


def test_repair_events_file_is_idempotent_on_clean_journal(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path)
    storage.bootstrap()
    set_storage(storage)
    emitter = _running(storage, "run-clean")
    emitter.run_succeeded(REVISION, 1.0)
    before = storage.events_path("run-clean").read_bytes()

    assert storage.repair_events_file("run-clean") == 0
    assert storage.events_path("run-clean").read_bytes() == before


def test_cancelled_projection_ignores_late_task_event(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path)
    storage.bootstrap()
    set_storage(storage)
    emitter = _running(storage, "run-cancelled")
    emitter.run_cancelled(REVISION)
    emitter.task_failed("job-1", 1, 0.1, "late result")

    projection, _metadata = storage.project_run_snapshot("run-cancelled")
    assert projection.status == "CANCELLED"
    assert projection.projected_at_seq == 5


def test_reconcile_is_idempotent_for_terminal_journal(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path)
    storage.bootstrap()
    set_storage(storage)
    emitter = _running(storage, "run-converged")
    emitter.run_succeeded(REVISION, 1.0)
    events_before = storage.read_events("run-converged")
    definition_before = storage.read_json(storage.resolve("run-converged", "run.json"))

    assert get_run_commands().reconcile() == []
    assert storage.read_events("run-converged") == events_before
    assert storage.read_json(storage.resolve("run-converged", "run.json")) == definition_before


def test_recovery_finalizes_manifest_published_before_success_event(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path)
    storage.bootstrap()
    set_storage(storage)
    _running(storage, "run-published-before-terminal")
    storage.atomic_write_json(
        storage.resolve("run-published-before-terminal", "results.manifest.json"),
        {
            "schema_version": 2,
            "run_id": "run-published-before-terminal",
            "revision_id": "rev-00000003",
            "definition_revision_id": REVISION,
            "journal_seq": 3,
            "files": [],
            "workflow_files": [],
        },
    )

    assert get_run_commands().reconcile() == ["run-published-before-terminal"]
    events = storage.read_events("run-published-before-terminal")
    assert events[-1]["type"] == "run.succeeded"
    assert storage.project_run_snapshot("run-published-before-terminal")[0].status == "SUCCEEDED"


def test_old_manifest_cannot_finalize_a_new_continue_range(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path)
    storage.bootstrap()
    set_storage(storage)
    emitter = _running(storage, "run-old-manifest")
    storage.atomic_write_json(
        storage.resolve("run-old-manifest", "results.manifest.json"),
        {
            "schema_version": 2,
            "run_id": "run-old-manifest",
            "revision_id": "rev-00000003",
            "definition_revision_id": REVISION,
            "journal_seq": 3,
            "files": [],
            "workflow_files": [],
        },
    )
    emitter.run_succeeded(REVISION, 1.0)
    emitter.run_queue_requested(REVISION, "continue")
    emitter.run_started(REVISION, "continue", 42, "test-worker")

    assert get_run_commands().reconcile() == ["run-old-manifest"]
    events = storage.read_events("run-old-manifest")
    assert events[-1]["type"] == "run.failed"
    assert "orphaned" in events[-1]["data"]["error_message"]


def test_unprojectable_run_does_not_block_startup_reconciliation(
    tmp_path: Path,
    caplog,
) -> None:
    storage = StorageLayout(tmp_path)
    storage.bootstrap()
    set_storage(storage)
    storage.allocate_run("bad-journal")
    _write_events_raw(
        storage,
        "bad-journal",
        _raw_event(1, "run.started", {"revision_id": REVISION, "mode": "execute"}).encode(),
    )
    assert storage.claim_run("bad-journal")
    emitter = _running(storage, "healthy-run")
    emitter.run_succeeded(REVISION, 1.0)

    with caplog.at_level(logging.ERROR):
        assert get_run_commands().reconcile() == []

    assert not storage.is_claimed("bad-journal")
    assert storage.project_run_snapshot("healthy-run")[0].status == "SUCCEEDED"
    assert "bad-journal" in caplog.text


def test_alive_orphan_engine_without_slot_owner_is_killed_and_range_closed(tmp_path: Path) -> None:
    """A still-alive engine whose worker died must not wedge the Run at
    RUNNING forever.

    Ownership is the execution lease (BACKEND-RUN-SERVICE §2.5), not the
    engine's own liveness: no lease on record means nobody will ever wait on
    this engine, so the orphan tree is killed and the range is closed."""
    import subprocess
    import sys

    from src.execution_runtime.storage import process_identity

    storage = StorageLayout(tmp_path)
    storage.bootstrap()
    set_storage(storage)
    _running(storage, "run-orphan-alive")

    # Mirror production: the engine owns its session, so the reconciler's tree
    # kill targets the engine's group rather than the test runner's.
    orphan = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(120)"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=os.name != "nt",
    )
    try:
        _, created = process_identity(orphan.pid).split(":", 1)
        storage.atomic_write_json(
            storage.resolve("run-orphan-alive", ".runtime", "process.json"),
            {"engine_pid": orphan.pid, "engine_create_time": created},
        )

        recovered = get_run_commands().reconcile()

        assert recovered == ["run-orphan-alive"]
        assert orphan.wait(timeout=10) != 0, "the orphan engine tree was not killed"
        projection, _snapshot = storage.project_run_snapshot("run-orphan-alive")
        assert projection.status == "FAILED"
    finally:
        if orphan.poll() is None:
            orphan.kill()


def test_alive_engine_with_live_lease_owner_is_left_alone(tmp_path: Path) -> None:
    """The API process also reconciles at lifespan; a worker mid-run owns its
    engine through the execution lease, and reconciliation in another process
    must neither kill the engine nor terminalize the run -- ownership is the
    lease, never engine liveness (the D4 defect)."""
    import os
    import subprocess
    import sys

    from src.execution_runtime.storage import process_identity

    storage = StorageLayout(tmp_path)
    storage.bootstrap()
    set_storage(storage)
    _running(storage, "run-owned-engine")

    engine = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(120)"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=os.name != "nt",
    )
    try:
        _, created = process_identity(engine.pid).split(":", 1)
        storage.atomic_write_json(
            storage.resolve("run-owned-engine", ".runtime", "process.json"),
            {"engine_pid": engine.pid, "engine_create_time": created},
        )
        # The lease names THIS process: a live worker, engine alive or not.
        storage.write_lease(
            "run-owned-engine",
            worker_identity=process_identity(os.getpid()),
            queue_seq=2,
            revision_id=REVISION,
            stage="engine",
        )

        assert get_run_commands().reconcile() == []
        assert engine.poll() is None, "an engine owned by a live lease holder was killed"
        assert storage.read_lease("run-owned-engine") is not None, (
            "a live lease was released by reconciliation"
        )
        projection, _snapshot = storage.project_run_snapshot("run-owned-engine")
        assert projection.status == "RUNNING"
    finally:
        if engine.poll() is None:
            engine.kill()
