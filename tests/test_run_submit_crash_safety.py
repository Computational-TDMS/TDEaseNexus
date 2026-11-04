"""S2 acceptance (docs/design/BACKEND-RUN-SERVICE.md §2.2/§2.3/§2.4): crash-safe
submit through the Run Command Module, and one global queue ordering.

Every fault window below kills one durable write of the submit sequence
(snapshot / submitted event / queue event / ticket mint / run.json pointer) by
making the storage call raise; the same-content retry must converge to exactly
one submission and one queue request, and must never take the D3 branch where a
run.json pointer exists over an empty journal and every retry 404s. FIFO: a
resubmitted old Run with a long journal must dequeue before a newer Run's
first submission -- the global ticket orders arrivals; per-Run journal seqs
cannot (D5).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.api.runs_v2 import router as runs_router
from app.database.lifecycle import migrate_database
from app.errors import register_error_handlers
from src.execution_runtime import EventEmitter, set_storage
from src.execution_runtime.storage import StorageLayout
from src.services.run_worker import _dequeue
from src.services.workspace_roots import get_workspace_root_registry

RUN_PATH = "runs/crash-safety"
SNAKEFILE = (
    "rule all:\n"
    "    input:\n"
    "        'out.txt'\n"
    "\n"
    "rule read_input:\n"
    "    input:\n"
    "        'input.dat'\n"
    "    output:\n"
    "        'out.txt'\n"
    "    run:\n"
    "        open('out.txt', 'wb').write(open('input.dat', 'rb').read())\n"
)


@pytest.fixture(autouse=True)
def _layout(tmp_path: Path):
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    db_path = str(storage.data / "database" / "db.sqlite3")
    migrate_database(db_path)
    get_workspace_root_registry().configure(db_path)

    workspace = tmp_path / "workspace"
    run_folder = workspace / RUN_PATH
    run_folder.mkdir(parents=True)
    (run_folder / "Snakefile").write_text(SNAKEFILE, encoding="utf-8")
    (run_folder / "input.dat").write_bytes(b"crash-safety input\n")

    from src.execution_runtime.workspace_containment import (
        reset_approved_roots_checker,
        set_approved_roots_checker,
    )

    set_approved_roots_checker(
        lambda user_id, path: get_workspace_root_registry().is_within_approved_root(user_id, path)
    )
    set_storage(storage)
    root_id, _ = get_workspace_root_registry().register("local-owner", str(workspace))
    yield storage, workspace, root_id
    reset_approved_roots_checker()


def _client() -> TestClient:
    app = FastAPI()

    @app.middleware("http")
    async def principal(request: Request, call_next):
        request.state.principal = SimpleNamespace(user_id="local-owner")
        return await call_next(request)

    app.include_router(runs_router)
    register_error_handlers(app)
    # The injected crash windows are raw OSErrors; assert on the 500 instead
    # of letting TestClient re-raise them out of the response.
    return TestClient(app, raise_server_exceptions=False)


def _body(root_id: str, workspace: Path, key: str, run_id: str) -> dict:
    import hashlib

    files = []
    for name in ("Snakefile", "input.dat"):
        raw = (workspace / RUN_PATH / name).read_bytes()
        files.append({
            "path": name, "blob_hash": hashlib.sha256(raw).hexdigest(),
            "size": len(raw), "mode": "file", "executable": False,
        })
    return {
        "commit": {
            "run_id": run_id,
            "idempotency_key": key,
            "workspace_id": "workspace-crash",
            "workspace_run_path": RUN_PATH,
            "local_root_id": root_id,
            "local_run_path": RUN_PATH,
            "workspace_tree_hash": "0" * 64,
            "workspace_files": files,
            "snakefile": (workspace / RUN_PATH / "Snakefile").read_bytes().decode("utf-8"),
            "config": {},
            "nodes": [],
            "targets": [],
            "user_id": "local-owner",
        },
        "inline_blobs": {},
    }


def _arm(storage: StorageLayout, case: str):
    """Arm one crash window in the submit sequence; returns the disarm call.

    The breaker fires while armed, at the named storage write -- the same
    effect as the process dying between that write and the next one.
    """
    state = {"armed": True, "appends": 0}

    def raise_if_armed() -> None:
        if state["armed"]:
            raise OSError(f"injected crash: {case}")

    def wrap(name: str, breaker) -> None:
        original = getattr(storage, name)

        def wrapped(*args, **kwargs):
            breaker(*args, **kwargs)
            return original(*args, **kwargs)

        setattr(storage, name, wrapped)

    if case == "snapshot":
        wrap("write_definition_snapshot", lambda *a, **k: raise_if_armed())
    elif case == "before-events":
        wrap("append_event", lambda *a, **k: raise_if_armed())
    elif case == "after-submitted":
        def count_then_raise(*args, **kwargs):
            state["appends"] += 1
            if state["armed"] and state["appends"] >= 2:
                raise OSError("injected crash: after-submitted")
        wrap("append_event", count_then_raise)
    elif case == "mint":
        wrap("mint_queue_ticket", lambda *a, **k: raise_if_armed())
    elif case == "pointer":
        def pointer_only(target, *args, **kwargs):
            if state["armed"] and Path(target).name == "run.json":
                raise OSError("injected crash: pointer")
        wrap("atomic_write_json", pointer_only)
    else:
        raise AssertionError(f"unknown injection case: {case}")

    def disarm() -> None:
        state["armed"] = False

    return disarm


def _revision_of(storage: StorageLayout, run_id: str) -> str:
    return str(json.loads(
        storage.resolve(run_id, "run.json").read_text(encoding="utf-8")
    )["definition_revision_id"])


def _revision_events(storage: StorageLayout, run_id: str, revision_id: str, event_type: str):
    return [
        event for event in storage.read_events(run_id)
        if event.get("type") == event_type
        and isinstance(event.get("data"), dict)
        and event["data"].get("revision_id") == revision_id
    ]


@pytest.mark.parametrize(
    "case,expected_second_idempotent",
    [
        ("snapshot", False),
        ("before-events", False),
        ("after-submitted", False),
        ("mint", False),
        ("pointer", True),
    ],
)
def test_same_key_retry_converges_in_every_crash_window(
    _layout, case: str, expected_second_idempotent: bool
) -> None:
    storage, workspace, root_id = _layout
    run_id = "run-crash"
    body = _body(root_id, workspace, "ik-crash", run_id)
    disarm = _arm(storage, case)

    with _client() as client:
        crashed = client.post("/api/v2/runs", json=body)
        assert crashed.status_code >= 500, "the injected window must fail the attempt"
        disarm()

        # Same idempotency key, same content: converge, never 404.
        converged = client.post("/api/v2/runs", json=body)
        assert converged.status_code == 201, converged.text
        assert converged.json()["idempotent"] is expected_second_idempotent
        payload = converged.json()
        assert payload["status"] == "QUEUED"
        assert isinstance(payload["queue_ticket"], int)

        revision_id = _revision_of(storage, run_id)
        submitted = _revision_events(storage, run_id, revision_id, "run.submitted")
        queued = _revision_events(storage, run_id, revision_id, "run.queue_requested")
        assert len(submitted) == 1, "a retry must not duplicate the submission event"
        assert len(queued) == 1, "a retry must not duplicate the queue request"
        assert queued[0]["data"]["queue_ticket"] == payload["queue_ticket"]

        # Once fully durable, a further replay appends nothing.
        replay = client.post("/api/v2/runs", json=body)
        assert replay.status_code == 201, replay.text
        assert replay.json()["idempotent"] is True
        assert len(_revision_events(storage, run_id, revision_id, "run.submitted")) == 1
        assert len(_revision_events(storage, run_id, revision_id, "run.queue_requested")) == 1

        # The status surface answers with the same arrival ticket.
        status = client.get(f"/api/v2/runs/{run_id}")
        assert status.status_code == 200, status.text
        assert status.json()["status"] == "QUEUED"
        assert status.json()["queue_ticket"] == payload["queue_ticket"]


def test_legacy_zombie_pointer_without_journal_converges(_layout) -> None:
    """The D3 window itself: run.json durable, journal empty. The idempotency
    decision folds the journal, so the retry completes the submission instead
    of folding an empty journal into a permanent 404."""
    storage, workspace, root_id = _layout
    run_id = "run-zombie"
    storage.allocate_run(run_id)
    storage.atomic_write_json(storage.resolve(run_id, "run.json"), {
        "run_id": run_id,
        "idempotency_key": "zombie-key",
        "workspace_id": "workspace-crash",
        "workspace_run_path": RUN_PATH,
        "definition_revision_id": "def-legacy-zombie-state",
        "created_at": "2026-01-01T00:00:00+00:00",
        "labels": {"name": "zombie"},
    })

    with _client() as client:
        response = client.post("/api/v2/runs", json=_body(root_id, workspace, "ik-crash", run_id))
        assert response.status_code == 201, response.text
        assert response.json()["status"] == "QUEUED"
        assert response.json()["created_at"][:4] == "2026"  # durable Run identity kept

    revision_id = _revision_of(storage, run_id)
    assert revision_id != "def-legacy-zombie-state"
    assert len(_revision_events(storage, run_id, revision_id, "run.submitted")) == 1
    assert len(_revision_events(storage, run_id, revision_id, "run.queue_requested")) == 1


def test_submit_releases_staging_markers_once_the_queue_event_is_durable(_layout) -> None:
    """§2.7 close-out: the local-input seal marks every digest in flight; the
    durable queue request makes them referenced, so submit drops the markers."""
    import hashlib

    storage, workspace, root_id = _layout
    with _client() as client:
        created = client.post("/api/v2/runs", json=_body(root_id, workspace, "ik-markers", "run-markers"))
        assert created.status_code == 201, created.text

    for name in ("Snakefile", "input.dat"):
        digest = hashlib.sha256((workspace / RUN_PATH / name).read_bytes()).hexdigest()
        assert storage.blob_exists(digest), "the sealed input stays in CAS"
        assert not storage.staging_marker_path(digest).exists(), (
            "a referenced digest no longer needs GC protection"
        )


def test_resubmitted_old_run_precedes_a_newer_first_submission(_layout, monkeypatch) -> None:
    """FIFO by global ticket (D5): the old Run's rerun arrives before the new
    Run's first submission, so it must dequeue first -- even though its queue
    event sits at a far larger per-Run journal seq than the new Run's."""
    storage, workspace, root_id = _layout

    with _client() as client:
        old = client.post("/api/v2/runs", json=_body(root_id, workspace, "ik-old", "run-old"))
        assert old.status_code == 201, old.text

    # Drive the old Run through one execution with a long journal: the new
    # Run's whole journal will be 2 events, the old Run's rerun queue event
    # will sit far past that -- the per-Run seqs that once ordered the queue.
    revision_id = _revision_of(storage, "run-old")
    emitter = EventEmitter("run-old")
    emitter.run_started(revision_id, "execute", pid=os.getpid(), worker_id="test")
    for index in range(60):
        emitter.runtime_message("info", f"long journal noise {index}")
    emitter.run_succeeded(revision_id, run_time_seconds=1.0, total_tasks=1)

    with _client() as client:
        # Arrival order under test: the old Run re-requests FIRST...
        rerun = client.post("/api/v2/runs/run-old/rerun", json={})
        assert rerun.status_code == 200, rerun.text
        # ...and the new Run's first submission arrives SECOND.
        new = client.post("/api/v2/runs", json=_body(root_id, workspace, "ik-new", "run-new"))
        assert new.status_code == 201, new.text

    old_queue = _revision_events(storage, "run-old", revision_id, "run.queue_requested")[-1]
    new_revision = _revision_of(storage, "run-new")
    new_queue = _revision_events(storage, "run-new", new_revision, "run.queue_requested")[-1]
    assert int(old_queue["seq"]) > int(new_queue["seq"]), (
        "the hazard must be real: per-Run seqs order the new Run first"
    )
    assert int(old_queue["data"]["queue_ticket"]) < int(new_queue["data"]["queue_ticket"])

    # Index path: one ordering, by ticket.
    first = _dequeue()
    second = _dequeue()
    assert first["run_id"] == "run-old"
    assert second["run_id"] == "run-new"

    # Filesystem fallback path: the same ordering, read from the mint log.
    storage.release_lease("run-old")
    storage.release_lease("run-new")

    def _no_index():
        raise RuntimeError("index unavailable")

    monkeypatch.setattr("src.services.run_index.get_run_index", _no_index)
    assert _dequeue()["run_id"] == "run-old"
    assert _dequeue()["run_id"] == "run-new"
