"""S3 acceptance (docs/design/BACKEND-RUN-SERVICE.md §2.5): the execution
lease and the reconciler rewrite.

D4 was recovery judging engine liveness instead of worker ownership: an API
restart while a live worker published the results of an engine-dead Run
appended a false ``run.failed`` over it (and the worker's own terminal then
double-terminalized the range). Ownership is now the lease record naming the
worker process: a live lease owner is never touched -- the engine being dead
is finalization's normal state -- while a dead or absent lease means the
engine tree is killed and the range is closed exactly once, by ``finish()``
under the run event lock with the manifest-coverage rule folded in.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from src.execution_runtime import set_storage
from src.execution_runtime.events import EventEmitter
from src.execution_runtime.storage import (
    StorageLayout,
    process_identity,
)
from src.services.run_commands import get_run_commands
from src.services.run_worker import execute_run

REVISION = "def-a1a1a1a1a1a1a1a1a1a1a1a1"


def _layout(tmp_path: Path) -> StorageLayout:
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)
    return storage


def _started(storage: StorageLayout, run_id: str, revision_id: str = REVISION) -> None:
    """A Run mid-execution: submitted, queued, started (open range)."""
    storage.allocate_run(run_id)
    emitter = EventEmitter(run_id)
    emitter.run_submitted(revision_id)
    emitter.run_queue_requested(revision_id, "execute")
    emitter.run_started(revision_id, "execute", pid=4242, worker_id="lease-test")


def _dead_identity() -> str:
    """The identity of a process that is provably gone."""
    dead = subprocess.Popen(
        [sys.executable, "-c", "import sys; sys.exit(0)"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    dead.wait(timeout=10)
    return process_identity(dead.pid)


def _engine_stub() -> subprocess.Popen:
    # Mirror production: the engine is spawned in its own session/process group
    # (snakemake_adapter.py), which is what makes the tree kill target the
    # engine's group and never the test runner's.
    return subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(120)"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=os.name != "nt",
    )


def _record_engine(storage: StorageLayout, run_id: str, engine: subprocess.Popen) -> None:
    _, created = process_identity(engine.pid).split(":", 1)
    storage.atomic_write_json(
        storage.resolve(run_id, ".runtime", "process.json"),
        {"engine_pid": engine.pid, "engine_create_time": created},
    )


def _terminals(storage: StorageLayout, run_id: str) -> list[dict]:
    return [
        event
        for event in storage.read_events(run_id)
        if event["type"] in {"run.succeeded", "run.failed", "run.cancelled"}
    ]


def _publish_manifest(storage: StorageLayout, run_id: str, journal_seq: int) -> None:
    storage.atomic_write_json(
        storage.resolve(run_id, "results.manifest.json"),
        {
            "schema_version": 2,
            "run_id": run_id,
            "revision_id": f"rev-{journal_seq:08d}",
            "definition_revision_id": REVISION,
            "journal_seq": journal_seq,
            "files": [],
            "workflow_files": [],
        },
    )


def test_api_restart_over_a_live_worker_publishing_results_does_not_misfire(tmp_path: Path) -> None:
    """The D4 window itself: the engine already exited, the live worker is
    between manifest publication and its terminal. An API restart's reconcile
    must not touch the run -- no false run.failed, no terminal at all."""
    import os

    storage = _layout(tmp_path)
    _started(storage, "run-live-finalize")
    # The worker published the manifest covering the open range (start_seq 3).
    _publish_manifest(storage, "run-live-finalize", journal_seq=3)
    # The engine is DEAD (it finished); the worker (this process) is alive.
    storage.write_lease(
        "run-live-finalize",
        worker_identity=process_identity(os.getpid()),
        queue_seq=2,
        revision_id=REVISION,
        stage="manifest",
    )
    events_before = storage.read_events("run-live-finalize")

    assert get_run_commands().reconcile() == []
    assert storage.read_events("run-live-finalize") == events_before, (
        "reconcile appended events over a live lease owner"
    )
    assert not _terminals(storage, "run-live-finalize"), "a false terminal was appended"
    assert storage.project_run_snapshot("run-live-finalize")[0].status == "RUNNING"
    assert storage.read_lease("run-live-finalize") is not None, (
        "the live worker's lease was released"
    )

    # The worker finishes for real: exactly one terminal, and finish() is
    # idempotent afterwards -- no double terminal can exist.
    commands = get_run_commands()
    assert commands.finish("run-live-finalize", "succeeded", run_time_seconds=1.0) is True
    assert commands.finish("run-live-finalize", "succeeded", run_time_seconds=1.0) is False
    terminals = _terminals(storage, "run-live-finalize")
    assert [event["type"] for event in terminals] == ["run.succeeded"]
    assert storage.project_run_snapshot("run-live-finalize")[0].status == "SUCCEEDED"


def test_live_lease_with_a_live_engine_survives_the_restart(tmp_path: Path) -> None:
    """Same ownership rule with the engine still running: the lease owner,
    not the engine, decides the outcome."""
    import os

    storage = _layout(tmp_path)
    _started(storage, "run-live-engine")
    engine = _engine_stub()
    try:
        _record_engine(storage, "run-live-engine", engine)
        storage.write_lease(
            "run-live-engine",
            worker_identity=process_identity(os.getpid()),
            queue_seq=2,
            revision_id=REVISION,
            stage="engine",
        )

        assert get_run_commands().reconcile() == []
        assert engine.poll() is None, "an engine owned by a live lease was killed"
        assert storage.project_run_snapshot("run-live-engine")[0].status == "RUNNING"
    finally:
        if engine.poll() is None:
            engine.kill()


def test_dead_owner_orphan_is_killed_and_failed_exactly_once(tmp_path: Path) -> None:
    """A dead lease owner with a still-running engine: the tree is killed
    via process.json, exactly one run.failed 'orphaned' closes the range, the
    lease is released, and a second pass is a no-op."""
    storage = _layout(tmp_path)
    _started(storage, "run-dead-orphan")
    engine = _engine_stub()
    try:
        _record_engine(storage, "run-dead-orphan", engine)
        storage.write_lease(
            "run-dead-orphan",
            worker_identity=_dead_identity(),
            queue_seq=2,
            revision_id=REVISION,
            stage="engine",
        )

        assert get_run_commands().reconcile() == ["run-dead-orphan"]
        assert engine.wait(timeout=10) != 0, "the dead owner's engine tree was not killed"
        terminals = _terminals(storage, "run-dead-orphan")
        assert [event["type"] for event in terminals] == ["run.failed"]
        assert "orphaned" in terminals[0]["data"]["error_message"]
        assert storage.project_run_snapshot("run-dead-orphan")[0].status == "FAILED"
        assert storage.read_lease("run-dead-orphan") is None

        assert get_run_commands().reconcile() == []
        assert _terminals(storage, "run-dead-orphan") == terminals, (
            "a second pass appended another terminal"
        )
    finally:
        if engine.poll() is None:
            engine.kill()


def test_dead_owner_with_covering_manifest_is_rescued_succeeded(tmp_path: Path) -> None:
    """The rescue rule inside finish(): the engine finished and the manifest
    covering the open range was durable before the worker died -- the range
    closes as run.succeeded, exactly once."""
    storage = _layout(tmp_path)
    _started(storage, "run-dead-rescue")
    _publish_manifest(storage, "run-dead-rescue", journal_seq=3)
    storage.write_lease(
        "run-dead-rescue",
        worker_identity=_dead_identity(),
        queue_seq=2,
        revision_id=REVISION,
        stage="manifest",
    )

    assert get_run_commands().reconcile() == ["run-dead-rescue"]
    terminals = _terminals(storage, "run-dead-rescue")
    assert [event["type"] for event in terminals] == ["run.succeeded"]
    assert storage.project_run_snapshot("run-dead-rescue")[0].status == "SUCCEEDED"
    assert storage.read_lease("run-dead-rescue") is None


def test_legacy_claimed_file_migrates_away_as_a_dead_owner(tmp_path: Path) -> None:
    """A pre-lease bare `claimed` file carries no identity: it is a dead
    owner by definition, migrated away in one pass. An open range under it
    is closed as orphaned; the file itself is gone afterwards."""
    storage = _layout(tmp_path)
    _started(storage, "run-legacy-claim")
    assert storage.claim_run("run-legacy-claim")

    assert get_run_commands().reconcile() == ["run-legacy-claim"]
    assert not storage.is_claimed("run-legacy-claim"), (
        "the legacy claim file must not survive the migration pass"
    )
    terminals = _terminals(storage, "run-legacy-claim")
    assert [event["type"] for event in terminals] == ["run.failed"]
    assert storage.project_run_snapshot("run-legacy-claim")[0].status == "FAILED"


def test_cancel_inside_the_claim_window_keeps_its_behavior(tmp_path: Path) -> None:
    """The claim-window cancel contract is unchanged: the worker holds the
    lease, a cancel landed before its first projection read -- the journal
    already holds run.cancelled, and the worker must leave it terminal-clean
    instead of appending an illegal run.failed from CANCELLED."""
    storage = _layout(tmp_path)
    run_id = "run-cancel-window"
    storage.allocate_run(run_id)
    storage.atomic_write_json(
        storage.resolve(run_id, "run.json"),
        {
            "run_id": run_id,
            "user_id": "worker",
            "definition_revision_id": REVISION,
            "workspace_files": [],
            "nodes": [],
        },
    )
    emitter = EventEmitter(run_id)
    emitter.run_submitted(REVISION)
    emitter.run_queue_requested(REVISION, "execute")
    # The worker's dequeue acquired the lease; cancel lands inside the window.
    assert storage.acquire_lease(run_id)
    emitter.run_cancelled(REVISION)

    execute_run(
        json.loads(storage.resolve(run_id, "run.json").read_text(encoding="utf-8"))
    )

    assert not [event for event in storage.read_events(run_id) if event["type"] == "run.failed"], (
        "run.failed from CANCELLED is an illegal transition"
    )
    assert storage.project_run_snapshot(run_id)[0].status == "CANCELLED"
    # The worker released the lease on its way out.
    storage.release_lease(run_id)


def test_queued_run_with_a_live_dispatch_lease_is_not_reclaimed(tmp_path: Path) -> None:
    """The dequeue-to-run.started window: a QUEUED run whose lease names a
    live worker is mid-dispatch, not orphaned. Only a dead lease (or a
    legacy claim) is reclaimed with the audit event."""
    import os

    storage = _layout(tmp_path)
    run_id = "run-dispatch-window"
    _started(storage, "other-run")  # noise: reconcile walks every run dir
    storage.allocate_run(run_id)
    emitter = EventEmitter(run_id)
    emitter.run_submitted(REVISION)
    emitter.run_queue_requested(REVISION, "execute")
    storage.write_lease(
        run_id,
        worker_identity=process_identity(os.getpid()),
        queue_seq=2,
        revision_id=REVISION,
        stage="startup",
    )
    events_before = storage.read_events(run_id)

    assert get_run_commands().reconcile() == ["other-run"]
    assert storage.read_events(run_id) == events_before
    assert storage.read_lease(run_id) is not None, "a live dispatch lease was released"
    assert storage.project_run_snapshot(run_id)[0].status == "QUEUED"


def test_queued_run_with_a_dead_lease_is_reclaimed_and_requeueable(tmp_path: Path) -> None:
    """The pre-start death: the dead lease is released with the audit event
    and the run stays QUEUED -- the next dequeue can take it again."""
    storage = _layout(tmp_path)
    run_id = "run-requeue"
    storage.allocate_run(run_id)
    emitter = EventEmitter(run_id)
    emitter.run_submitted(REVISION)
    emitter.run_queue_requested(REVISION, "execute")
    storage.write_lease(
        run_id,
        worker_identity=_dead_identity(),
        queue_seq=2,
        revision_id=REVISION,
        stage="startup",
    )

    assert get_run_commands().reconcile() == [run_id]
    events = storage.read_events(run_id)
    assert events[-1]["type"] == "run.action"
    assert events[-1]["data"]["action"] == "orphan_reclaimed"
    assert storage.project_run_snapshot(run_id)[0].status == "QUEUED"
    assert storage.read_lease(run_id) is None
    # The reclaimed run dequeues again: the lease is free to re-acquire.
    storage.atomic_write_json(
        storage.resolve(run_id, "run.json"),
        {"run_id": run_id, "definition_revision_id": REVISION, "workspace_files": [], "nodes": []},
    )
    assert storage.acquire_lease(run_id) is True


def test_queued_cancel_through_the_api_cannot_poison_the_journal(tmp_path: Path) -> None:
    """The D4-class window on the cancel side: the endpoint's QUEUED branch
    once appended run.cancelled on the bare event lock, so a worker's
    begin_execution could fold QUEUED and land run.started AFTER the cancel
    -- a journal that folds as "run.started is invalid from status
    CANCELLED" and is permanently unprojectable. The terminal now lands
    through RunCommands.cancel under the same command lock, so after a
    cancel the dispatch command refuses to start anything."""
    from types import SimpleNamespace

    from fastapi import FastAPI, Request
    from fastapi.testclient import TestClient

    from app.api.runs_v2 import router as runs_router
    from app.errors import register_error_handlers

    storage = _layout(tmp_path)
    run_id = "run-cancel-poison"
    storage.allocate_run(run_id)
    storage.atomic_write_json(
        storage.resolve(run_id, "run.json"),
        {
            "run_id": run_id,
            "user_id": "worker",
            "definition_revision_id": REVISION,
            "workspace_files": [],
            "nodes": [],
        },
    )
    emitter = EventEmitter(run_id)
    emitter.run_submitted(REVISION)
    emitter.run_queue_requested(REVISION, "execute")

    app = FastAPI()

    @app.middleware("http")
    async def principal(request: Request, call_next):
        request.state.principal = SimpleNamespace(user_id="worker")
        return await call_next(request)

    app.include_router(runs_router)
    register_error_handlers(app)
    with TestClient(app) as client:
        response = client.post(f"/api/v2/runs/{run_id}/cancel")
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "CANCELLED"

    events = storage.read_events(run_id)
    assert events[-1]["type"] == "run.cancelled"
    assert storage.project_run_snapshot(run_id)[0].status == "CANCELLED"

    # The dispatch window is closed atomically: no run.started can land after
    # the cancel, and the journal stays projectable.
    assert get_run_commands().begin_execution(run_id) is None
    assert not [event for event in storage.read_events(run_id) if event["type"] == "run.started"]
    assert storage.project_run_snapshot(run_id)[0].status == "CANCELLED"


def test_cancel_command_targets_the_pending_arrivals_ticket(tmp_path: Path) -> None:
    """§2.2's queue_ticket argument: a cancel naming an arrival that is no
    longer pending is stale and lands nothing; the ticket that names the
    live pending arrival terminalizes it."""
    storage = _layout(tmp_path)
    run_id = "run-cancel-ticket"
    storage.allocate_run(run_id)
    emitter = EventEmitter(run_id)
    emitter.run_submitted(REVISION)
    emitter.run_queue_requested(REVISION, "execute", queue_ticket=42)

    commands = get_run_commands()
    assert commands.cancel(run_id, queue_ticket=43) is False
    assert storage.project_run_snapshot(run_id)[0].status == "QUEUED"
    assert commands.cancel(run_id, queue_ticket=42) is True
    assert storage.project_run_snapshot(run_id)[0].status == "CANCELLED"


def test_cancel_command_leaves_a_running_run_to_the_engine_path(tmp_path: Path) -> None:
    """A RUNNING run is closed by the cancel marker plus the engine's own
    cancelled result; the QUEUED terminalizer must not touch it."""
    storage = _layout(tmp_path)
    _started(storage, "run-cancel-running")
    events_before = storage.read_events("run-cancel-running")

    assert get_run_commands().cancel("run-cancel-running") is False
    assert storage.read_events("run-cancel-running") == events_before
    assert storage.project_run_snapshot("run-cancel-running")[0].status == "RUNNING"


def test_reconcile_completes_a_crashed_submit_pointer(tmp_path: Path) -> None:
    """§2.3 close-out through reconcile: the journal durably holds
    run.submitted (+ queue request) but the run.json pointer never landed --
    reconcile rewrites it from the definition snapshot, so the Run is visible
    and queueable instead of a ghost."""
    storage = _layout(tmp_path)
    run_id = "run-pointer-crash"
    storage.allocate_run(run_id)
    definition = {
        "run_id": run_id,
        "definition_revision_id": REVISION,
        "idempotency_key": "ik-pointer",
        "user_id": "local-owner",
        "created_at": "2026-10-13T00:00:00+00:00",
        "workspace_files": [],
        "nodes": [],
    }
    storage.write_definition_snapshot(run_id, definition)
    emitter = EventEmitter(run_id)
    emitter.run_submitted(REVISION)
    emitter.run_queue_requested(REVISION, "execute")
    # Crash window: events durable, run.json pointer never written.

    get_run_commands().reconcile()

    pointer = storage.read_json(storage.resolve(run_id, "run.json"))
    assert pointer == definition, "the pointer must be rebuilt from the snapshot"
    assert storage.project_run_snapshot(run_id)[0].status == "QUEUED"
