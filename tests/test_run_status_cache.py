"""S1 acceptance (docs/design/BACKEND-RUN-SERVICE.md §2.1): one lifecycle
interpreter, one status cache.

The journal fold in ``run_projector`` is the only component that derives a
status; SQLite ``runs.status`` is a cache of that fold, refreshed by
``RunIndex.catch_up_run`` until the command module (§2.2) takes over the write.
Acceptance: a revision queued while Run A executes is not lost when A
terminates — journal and index both project QUEUED, never SUCCEEDED — and the
two agree after every event sequence, at any checkpoint boundary.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from src.execution_runtime.events import EventEmitter
from src.execution_runtime.run_projector import project_run
from src.execution_runtime.storage import StorageLayout, set_storage
from src.services.run_index import RunIndex
from app.database.lifecycle import migrate_database


def _backend(tmp_path: Path) -> tuple[StorageLayout, RunIndex]:
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)
    database = storage.data / "database" / "db.sqlite3"
    migrate_database(str(database))
    return storage, RunIndex(database)


def _register_run(storage: StorageLayout, index: RunIndex, run_id: str) -> dict:
    data = {
        "run_id": run_id,
        "user_id": "tenant-a",
        "workspace_id": "workspace-a",
        "created_at": "2026-01-01T00:00:00+00:00",
        "current_revision": "rev-a",
    }
    storage.allocate_run(run_id)
    storage.atomic_write_json(storage.resolve(run_id, "run.json"), data)
    index.upsert_run(data, event_seq=storage.recover_seq(run_id))
    return data


def _index_status(index: RunIndex, run_id: str) -> str | None:
    snapshot = index.run_snapshot(run_id)
    assert snapshot is not None, f"no index row for {run_id}"
    return snapshot["status"]


def _index_column(index: RunIndex, run_id: str, column: str):
    with sqlite3.connect(index.database) as connection:
        row = connection.execute(
            f"SELECT {column} FROM runs WHERE run_id = ?", (run_id,)
        ).fetchone()
    assert row is not None, f"no index row for {run_id}"
    return row[0]


def test_mid_run_revision_is_queued_in_journal_and_index_after_terminal(tmp_path: Path) -> None:
    """The D1 acceptance: revision B submitted while A executes; A terminates;
    both authorities say QUEUED — B is not lost and A is not misreported as
    SUCCEEDED."""
    storage, index = _backend(tmp_path)
    run_id = "run-midrun-revision"
    _register_run(storage, index, run_id)
    emitter = EventEmitter(run_id)
    emitter.run_submitted("rev-a")
    emitter.run_queue_requested("rev-a", "execute")
    emitter.run_started("rev-a", "execute", pid=101, worker_id="HOST")
    # Claim-time refresh: the worker's catch_up_run while the range is open.
    index.catch_up_run(storage, run_id)
    assert _index_status(index, run_id) == "RUNNING"

    emitter.run_submitted("rev-b")
    emitter.run_queue_requested("rev-b", "execute")
    emitter.run_succeeded("rev-a", run_time_seconds=1.0)

    projection = project_run(storage.read_events(run_id))
    assert projection.status == "QUEUED"
    assert projection.current_revision_id == "rev-b"

    # Post-execution refresh (the worker calls catch_up_run after its terminal).
    index.catch_up_run(storage, run_id)
    assert _index_status(index, run_id) == "QUEUED"
    assert _index_status(index, run_id) == projection.status
    assert run_id in index.queued_run_ids()

    # Transitional contract (§2.1 slice): queued_seq stays the dequeue key until
    # the global ticket (§2.4) replaces it in S2 — its write must survive the
    # loss of the per-event status writes.
    assert _index_column(index, run_id, "queued_seq") == 5
    assert _index_column(index, run_id, "definition_revision_id") == "rev-b"


def test_index_status_agrees_with_the_fold_at_every_checkpoint(tmp_path: Path) -> None:
    """Whatever the event sequence — and wherever catch_up_run happens to be
    called between events — the cached status equals the journal fold."""
    storage, index = _backend(tmp_path)

    sequences = {
        "run-failed": [
            {"type": "run.submitted", "data": {"revision_id": "rev-a"}},
            {"type": "run.queue_requested", "data": {"revision_id": "rev-a", "mode": "execute"}},
            {"type": "run.started", "data": {"revision_id": "rev-a", "mode": "execute"}},
            {"type": "run.failed", "data": {"revision_id": "rev-a"}},
        ],
        "run-continue": [
            {"type": "run.submitted", "data": {"revision_id": "rev-a"}},
            {"type": "run.queue_requested", "data": {"revision_id": "rev-a", "mode": "execute"}},
            {"type": "run.started", "data": {"revision_id": "rev-a", "mode": "execute"}},
            {"type": "run.failed", "data": {"revision_id": "rev-a"}},
            {"type": "run.queue_requested", "data": {"revision_id": "rev-a", "mode": "continue"}},
            {"type": "run.started", "data": {"revision_id": "rev-a", "mode": "continue"}},
            {"type": "run.succeeded", "data": {"revision_id": "rev-a"}},
        ],
        "run-cancelled": [
            {"type": "run.submitted", "data": {"revision_id": "rev-a"}},
            {"type": "run.queue_requested", "data": {"revision_id": "rev-a", "mode": "execute"}},
            {"type": "run.cancelled", "data": {"revision_id": "rev-a"}},
        ],
        "run-two-revisions": [
            {"type": "run.submitted", "data": {"revision_id": "rev-a"}},
            {"type": "run.queue_requested", "data": {"revision_id": "rev-a", "mode": "execute"}},
            {"type": "run.started", "data": {"revision_id": "rev-a", "mode": "execute"}},
            {"type": "run.submitted", "data": {"revision_id": "rev-b"}},
            {"type": "run.queue_requested", "data": {"revision_id": "rev-b", "mode": "execute"}},
            {"type": "run.failed", "data": {"revision_id": "rev-a"}},
            {"type": "run.started", "data": {"revision_id": "rev-b", "mode": "execute"}},
            {"type": "run.succeeded", "data": {"revision_id": "rev-b"}},
        ],
    }
    final_statuses = {
        "run-failed": "FAILED",
        "run-continue": "SUCCEEDED",
        "run-cancelled": "CANCELLED",
        "run-two-revisions": "SUCCEEDED",
    }

    for run_id, sequence in sequences.items():
        _register_run(storage, index, run_id)
        for event in sequence:
            storage.append_event(run_id, dict(event))
            index.catch_up_run(storage, run_id)
            assert _index_status(index, run_id) == project_run(
                storage.read_events(run_id)
            ).status, f"{run_id}: index disagrees with the fold mid-sequence"
        assert _index_status(index, run_id) == final_statuses[run_id]


def test_legacy_schema_v1_journal_projects_identically_into_the_cache(tmp_path: Path) -> None:
    """Legacy-event normalization lives at the replay boundary, so a schema-v1
    journal folds the same way whether read by the journal projection or the
    index refresh."""
    storage, index = _backend(tmp_path)
    run_id = "run-legacy-journal"
    _register_run(storage, index, run_id)
    storage.append_event(
        run_id, {"schema_version": 1, "type": "run.queued", "data": {}}
    )
    storage.append_event(
        run_id, {"schema_version": 1, "type": "run.started", "data": {"pid": 42}}
    )
    storage.append_event(
        run_id, {"schema_version": 1, "type": "run.failed", "data": {"exit_code": 1}}
    )

    projection = project_run(storage.read_events(run_id))
    assert projection.status == "FAILED"
    index.catch_up_run(storage, run_id)
    assert _index_status(index, run_id) == "FAILED" == projection.status
