from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.api.runs_v2 import router
from app.auth import LOCAL_OWNER
from src.execution_runtime.events import EventEmitter
from src.execution_runtime.storage import StorageLayout, set_storage


def _client() -> TestClient:
    app = FastAPI()

    @app.middleware("http")
    async def principal(request: Request, call_next):
        request.state.principal = LOCAL_OWNER
        return await call_next(request)

    app.include_router(router)
    return TestClient(app)


def test_done_cannot_overtake_terminal_journal_events(tmp_path, monkeypatch) -> None:
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)
    run_id = "run-fast-terminal"
    storage.allocate_run(run_id)
    storage.atomic_write_json(
        storage.resolve(run_id, "run.json"),
        {"run_id": run_id, "user_id": LOCAL_OWNER.user_id},
    )
    emitter = EventEmitter(run_id)
    emitter.run_submitted("revision-fast")
    emitter.run_queue_requested("revision-fast", "execute")

    original_read = storage.read_event_lines_from
    appended_terminal = False

    def append_terminal_between_read_and_projection(current_run_id: str, offset: int):
        nonlocal appended_terminal
        result = original_read(current_run_id, offset)
        if not appended_terminal:
            appended_terminal = True
            emitter.run_started("revision-fast", "execute", 123, "worker-fast")
            emitter.run_succeeded("revision-fast", 0.01)
        return result

    monkeypatch.setattr(
        storage,
        "read_event_lines_from",
        append_terminal_between_read_and_projection,
    )

    with _client() as client:
        with client.stream("GET", f"/api/v2/runs/{run_id}/events") as response:
            assert response.status_code == 200
            body = "".join(response.iter_text())

    assert body.index("run.queue_requested") < body.index("run.started")
    assert body.index("run.started") < body.index("run.succeeded")
    assert body.index("run.succeeded") < body.index("event: done")
    assert 'data: {"status":"SUCCEEDED","last_event_id":4}' in body
