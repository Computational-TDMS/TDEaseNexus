from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from src.execution_runtime.storage import StorageLayout, set_storage
from app.database.lifecycle import migrate_database
from src.services.run_index import RunIndex
from src.services.run_worker import _dequeue
from src.execution_runtime.events import EventEmitter


def _queued_run(storage: StorageLayout, run_id: str, user_id: str, created_at: str) -> None:
    storage.allocate_run(run_id)
    storage.atomic_write_json(storage.resolve(run_id, "run.json"), {
        "run_id": run_id,
        "user_id": user_id,
        "created_at": created_at,
        "current_revision": "rev-test",
    })
    emitter = EventEmitter(run_id)
    emitter.run_submitted("rev-test")
    emitter.run_queue_requested("rev-test", "execute")


def test_global_queue_is_fifo_across_tenants(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)
    _queued_run(storage, "run-z", "tenant-b", "2026-01-01T00:00:02+00:00")
    _queued_run(storage, "run-a", "tenant-a", "2026-01-01T00:00:01+00:00")
    database = storage.data / "database" / "db.sqlite3"
    migrate_database(str(database))
    RunIndex(database).rebuild(storage)

    claimed = _dequeue()

    assert claimed is not None
    assert claimed["run_id"] == "run-a"
    assert claimed["user_id"] == "tenant-a"


def test_execution_slot_is_exclusive_across_worker_processes(tmp_path: Path) -> None:
    data_root = tmp_path / "backend"
    marker = tmp_path / "intervals.jsonl"
    code = r'''
import json, sys, time
from pathlib import Path
from src.execution_runtime.storage import StorageLayout

storage = StorageLayout(Path(sys.argv[1]))
storage.bootstrap()
while not storage.claim_execution_slot():
    time.sleep(0.02)
start = time.time()
try:
    time.sleep(0.4)
finally:
    end = time.time()
    with Path(sys.argv[2]).open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"worker": sys.argv[3], "start": start, "end": end}) + "\n")
    storage.release_execution_slot()
'''
    root = Path(__file__).resolve().parents[1]
    workers = [
        subprocess.Popen(
            [sys.executable, "-c", code, str(data_root), str(marker), name],
            cwd=root,
        )
        for name in ("worker-a", "worker-b")
    ]
    for worker in workers:
        assert worker.wait(timeout=10) == 0

    intervals = sorted(
        (json.loads(line) for line in marker.read_text(encoding="utf-8").splitlines()),
        key=lambda item: item["start"],
    )
    assert len(intervals) == 2
    assert intervals[1]["start"] >= intervals[0]["end"]


def test_worker_dequeues_from_index_without_scanning_run_directories(tmp_path: Path, monkeypatch) -> None:
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)
    database = storage.data / "database" / "db.sqlite3"
    migrate_database(str(database))
    data = {
        "run_id": "run-indexed",
        "user_id": "tenant-a",
        "workspace_id": "workspace-a",
        "created_at": "2026-01-01T00:00:00+00:00",
        "current_revision": "rev-test",
    }
    storage.allocate_run("run-indexed")
    storage.atomic_write_json(storage.resolve("run-indexed", "run.json"), data)
    storage.append_event("run-indexed", {"type": "run.submitted", "data": {"revision_id": "rev-test"}})
    storage.append_event("run-indexed", {"type": "run.queue_requested", "data": {"revision_id": "rev-test", "mode": "execute"}})
    index = RunIndex(database)
    index.upsert_run(data, event_seq=storage.recover_seq("run-indexed"))
    index.catch_up_run(storage, "run-indexed")

    monkeypatch.setattr(Path, "iterdir", lambda _path: (_ for _ in ()).throw(AssertionError("scan")))

    assert _dequeue()["run_id"] == "run-indexed"
