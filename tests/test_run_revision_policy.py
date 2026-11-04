"""A Run is always editable and always continuable.

No status gates a new definition: submitting again appends a revision plus a
queue request, and the worker materializes the newest definition when it starts.
Reproducibility comes from the journal recording each revision, not from a lock.
An execution already in flight keeps its own range and results manifest; a
definition submitted while it runs is queued behind it.

These tests drive the real `POST /api/v2/runs` surface with a local Workspace
commit, so the decision under test is exercised through the same code path the
Client uses.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.api.runs_v2 import router
from app.database.lifecycle import migrate_database
from app.errors import register_error_handlers
from src.execution_runtime import EventEmitter, set_storage
from src.execution_runtime.run_projector import project_run
from src.execution_runtime.storage import StorageLayout
from src.execution_runtime.workspace_containment import (
    reset_approved_roots_checker,
    set_approved_roots_checker,
)
from src.services.workspace_roots import get_workspace_root_registry

SNAKEFILE = 'rule all:\n    input:\n        []\n'
RUN_PATH = "runs/Ubq"


@pytest.fixture(autouse=True)
def _reset_checker():
    reset_approved_roots_checker()
    yield
    reset_approved_roots_checker()


def _client() -> TestClient:
    app = FastAPI()

    @app.middleware("http")
    async def principal(request: Request, call_next):
        request.state.principal = SimpleNamespace(user_id="local-owner")
        return await call_next(request)

    app.include_router(router)
    register_error_handlers(app)
    return TestClient(app)


def _workspace(tmp_path: Path) -> tuple[StorageLayout, Path, str]:
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    db_path = str(storage.data / "database" / "db.sqlite3")
    migrate_database(db_path)
    get_workspace_root_registry().configure(db_path)

    workspace = tmp_path / "workspace"
    run_folder = workspace / RUN_PATH
    run_folder.mkdir(parents=True)
    (run_folder / "Snakefile").write_text(SNAKEFILE, encoding="utf-8")
    root_id, _ = get_workspace_root_registry().register("local-owner", str(workspace))
    set_approved_roots_checker(
        lambda user_id, path: get_workspace_root_registry().is_within_approved_root(user_id, path)
    )
    return storage, workspace, root_id


def _seed(storage: StorageLayout, run_id: str, state: str) -> str:
    """An existing Run definition of this Workspace directory, in a given state."""
    revision_id = f"def-{run_id}"
    storage.allocate_run(run_id)
    storage.atomic_write_json(storage.resolve(run_id, "run.json"), {
        "run_id": run_id,
        "idempotency_key": "first",
        "workspace_id": "workspace-revisions",
        "workspace_run_path": RUN_PATH,
        "local_run_path": RUN_PATH,
        "definition_revision_id": revision_id,
        "user_id": "local-owner",
        "materialization_strategy": "local_workspace_hardlink",
        "cores": 1,
        "created_at": "2026-09-09T00:00:00+00:00",
        "labels": {},
        "snakefile": SNAKEFILE,
        "config": {},
        "workspace_files": [],
    })
    emitter = EventEmitter(run_id)
    emitter.run_submitted(revision_id)
    emitter.run_queue_requested(revision_id, "execute")
    if state == "running":
        emitter.run_started(revision_id, "execute", pid=123, worker_id="test-worker")
    elif state == "succeeded":
        emitter.run_started(revision_id, "execute", pid=123, worker_id="test-worker")
        emitter.run_succeeded(revision_id, run_time_seconds=1.0, total_tasks=1)
    elif state == "failed":
        emitter.run_started(revision_id, "execute", pid=123, worker_id="test-worker")
        emitter.run_failed(revision_id, exit_code=1, run_time_seconds=1.0, error_message="boom")
    return revision_id


def _body(run_id: str, root_id: str, workspace: Path) -> dict:
    # Read the bytes that are actually on disk: write_text() turns LF into CRLF on
    # Windows, and the frozen mapping must name those exact bytes.
    raw = (workspace / RUN_PATH / "Snakefile").read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    return {
        "commit": {
            "run_id": run_id,
            "idempotency_key": "second",
            "workspace_id": "workspace-revisions",
            "workspace_run_path": RUN_PATH,
            "local_root_id": root_id,
            "local_run_path": RUN_PATH,
            "workspace_tree_hash": "0" * 64,
            "workspace_files": [{
                "path": "Snakefile", "blob_hash": digest, "size": len(raw),
                "mode": "file", "executable": False,
            }],
            "snakefile": raw.decode("utf-8"),
            "config": {},
            "nodes": [],
            "targets": [],
            "user_id": "local-owner",
        },
        "inline_blobs": {},
    }


def _post(tmp_path: Path, run_id: str, state: str):
    storage, workspace, root_id = _workspace(tmp_path)
    set_storage(storage)
    old_revision = _seed(storage, run_id, state)
    with _client() as client:
        response = client.post("/api/v2/runs", json=_body(run_id, root_id, workspace))
    return storage, old_revision, response


@pytest.mark.parametrize("state", ["failed", "succeeded", "running"])
def test_any_status_accepts_a_new_definition(tmp_path: Path, state: str) -> None:
    """Failed, succeeded and in-flight Runs are all editable."""
    _storage, _old_revision, response = _post(tmp_path, f"run_edit_{state}", state)
    assert response.status_code == 201, response.text
    assert response.json()["idempotent"] is False


def test_a_succeeded_run_goes_back_to_queued_for_the_new_definition(tmp_path: Path) -> None:
    storage, old_revision, response = _post(tmp_path, "run_succeeded_edit", "succeeded")
    assert response.status_code == 201, response.text
    projection = project_run(storage.read_events("run_succeeded_edit"))
    assert projection.status == "QUEUED"
    assert projection.current_revision_id not in (None, old_revision)


def test_a_definition_queued_while_running_waits_for_the_open_execution(tmp_path: Path) -> None:
    """The in-flight execution keeps its range; the new definition runs next."""
    storage, old_revision, response = _post(tmp_path, "run_running_edit", "running")
    assert response.status_code == 201, response.text

    projection = project_run(storage.read_events("run_running_edit"))
    assert projection.status == "RUNNING", "a pending definition must not hide the live execution"
    assert len(projection.ranges) == 1 and projection.ranges[0].is_open

    # The running execution finishes under its own revision, and the Run is then
    # queued for the definition submitted while it ran.
    EventEmitter("run_running_edit").run_succeeded(old_revision, run_time_seconds=1.0, total_tasks=1)
    projection = project_run(storage.read_events("run_running_edit"))
    assert projection.status == "QUEUED"
    assert len(projection.ranges) == 1 and not projection.ranges[0].is_open
    assert projection.ranges[0].revision_id == old_revision
    assert projection.current_revision_id != old_revision
