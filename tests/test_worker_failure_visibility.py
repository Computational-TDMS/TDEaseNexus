"""No silent worker deaths.

A Run that the worker cannot even START (no journal, corrupted projection,
missing queue event) must still end in a visible terminal event and a worker
log naming the stage -- never as an escaped exception that crash-loops the
claim invisibly.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.execution_runtime import set_storage
from src.execution_runtime.events import EventEmitter
from src.execution_runtime.storage import StorageLayout
from src.services.run_worker import execute_run

RUN_ID = "run_worker_visibility"


@pytest.fixture()
def storage(tmp_path: Path) -> StorageLayout:
    layout = StorageLayout(tmp_path / "backend")
    layout.bootstrap()
    set_storage(layout)
    yield layout
    set_storage(StorageLayout(tmp_path / "unused"))


def _write_run_json(storage: StorageLayout) -> None:
    storage.atomic_write_json(storage.resolve(RUN_ID, "run.json"), {
        "run_id": RUN_ID,
        "user_id": "worker",
        "definition_revision_id": "def-nojournal0000000000000000ff",
        "workspace_files": [],
        "nodes": [],
    })


def test_pre_engine_death_is_terminal_and_logged(storage: StorageLayout) -> None:
    """A run.json with no journal events is not a queued Run; the worker must
    record the failure instead of raising out of the execution path."""
    _write_run_json(storage)

    # Must not raise -- an escape would requeue the claim and crash-loop.
    execute_run(json.loads(storage.resolve(RUN_ID, "run.json").read_text(encoding="utf-8")))

    events = storage.read_events(RUN_ID)
    terminal = [event for event in events if event["type"] == "run.failed"]
    assert terminal, "pre-engine death emitted no terminal event"
    message = terminal[-1]["data"]["error_message"]
    assert "worker aborted at" in message

    worker_log = storage.resolve(RUN_ID, "logs", "tasks", "worker.log")
    assert worker_log.is_file(), "worker log missing for a pre-engine death"
    log_text = worker_log.read_text(encoding="utf-8")
    assert "FATAL at" in log_text
    assert "Traceback" in log_text, "the log must carry the actual traceback"


def test_pre_engine_death_is_visible_through_the_log_endpoint(storage: StorageLayout) -> None:
    """The public log tail includes the worker section, so an Agent that reads
    the log of a run which never reached the engine still sees the stage."""
    from app.api.runs_v2 import _run_file  # noqa: F401  (surface check only)
    from fastapi import FastAPI, Request
    from fastapi.testclient import TestClient
    from types import SimpleNamespace

    from app.api.runs_v2 import router
    from app.errors import register_error_handlers

    _write_run_json(storage)
    execute_run(json.loads(storage.resolve(RUN_ID, "run.json").read_text(encoding="utf-8")))

    app = FastAPI()

    @app.middleware("http")
    async def principal(request: Request, call_next):
        request.state.principal = SimpleNamespace(user_id="worker")
        return await call_next(request)

    app.include_router(router)
    register_error_handlers(app)
    with TestClient(app) as client:
        response = client.get(f"/api/v2/runs/{RUN_ID}/log?tail=50")
    assert response.status_code == 200
    assert "FATAL at" in response.text, "log tail hides the worker section"


def test_cancel_inside_claim_window_does_not_poison_the_journal(storage: StorageLayout) -> None:
    """Cancel racing the worker's claim is a journal poison, not a no-op.

    The worker claims a QUEUED run, then reads the projection. A cancel
    landing in that window appends run.cancelled (terminal). The worker's
    generic failure handler then appended run.failed -- an illegal
    CANCELLED->FAILED transition that makes EVERY future projection of the
    Run raise, permanently unreadable. The claim-window branch must treat
    CANCELLED as terminal-no-op instead."""
    REVISION = "def-cancelrace0000000000000000000ff"
    storage.allocate_run(RUN_ID)
    storage.atomic_write_json(storage.resolve(RUN_ID, "run.json"), {
        "run_id": RUN_ID,
        "user_id": "worker",
        "definition_revision_id": REVISION,
        "workspace_files": [],
        "nodes": [],
    })
    emitter = EventEmitter(RUN_ID)
    emitter.run_submitted(REVISION)
    emitter.run_queue_requested(REVISION, "execute")
    # The race: cancel lands after the claim, before the worker's projection
    # read -- the journal holds the terminal fact before execute_run starts.
    emitter.run_cancelled(REVISION)

    execute_run(json.loads(storage.resolve(RUN_ID, "run.json").read_text(encoding="utf-8")))

    events = storage.read_events(RUN_ID)
    assert not [event for event in events if event["type"] == "run.failed"], (
        "run.failed from CANCELLED is an illegal transition"
    )
    projection, _metadata = storage.project_run_snapshot(RUN_ID)
    assert projection.status == "CANCELLED"
