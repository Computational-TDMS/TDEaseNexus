"""Job-event relay end-to-end: the byte-cursor discipline against a writer
that appends frames incrementally (the half-line loss the Snakemake
integration reproduced).

Drives the real ``SnakemakeAdapter._relay_job_events`` thread against the
real ``StorageLayout`` + ``EventEmitter`` and asserts on events.jsonl and
logs/runtime.jsonl -- no mocks on the forwarding path.
"""
from __future__ import annotations

import json
import threading
import time
from typing import Callable

from src.execution_runtime.events import EventEmitter
from src.execution_runtime.snakemake_adapter import SnakemakeAdapter
from src.execution_runtime.storage import StorageLayout, set_storage


def _adapter(tmp_path) -> SnakemakeAdapter:
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)
    run_id = "run-relay-e2e"
    run_root = storage.allocate_run(run_id)
    return SnakemakeAdapter(run_id, run_root, storage, EventEmitter(run_id))


def _start_relay(adapter: SnakemakeAdapter) -> tuple[threading.Event, threading.Thread]:
    stop = threading.Event()
    thread = threading.Thread(
        target=adapter._relay_job_events,
        args=(adapter.run_root / SnakemakeAdapter.JOB_EVENT_PATH, stop),
        daemon=True,
    )
    thread.start()
    return stop, thread


def _frame(event_type: str, job_id: int, rule: str) -> str:
    return json.dumps(
        {"type": event_type, "job_id": job_id, "rule": rule, "wildcards": {}}
    )


def _append_frames(path, *frames: str) -> None:
    """Write like the engine does: plain append of whole frames."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("ab") as stream:
        stream.write("".join(frame + "\n" for frame in frames).encode("utf-8"))
        stream.flush()


def _count(events: list[dict], event_type: str, job_id: int) -> int:
    return sum(
        1
        for event in events
        if event.get("type") == event_type
        and event.get("data", {}).get("job_id") == job_id
    )


def _wait_until(
    storage: StorageLayout,
    run_id: str,
    predicate: Callable[[list[dict]], bool],
    timeout: float = 5.0,
) -> list[dict]:
    deadline = time.monotonic() + timeout
    events = storage.read_events(run_id)
    while time.monotonic() < deadline and not predicate(events):
        time.sleep(0.05)
        events = storage.read_events(run_id)
    return events


def test_half_written_line_is_relayed_once_writer_finishes(tmp_path) -> None:
    adapter = _adapter(tmp_path)
    path = adapter.run_root / SnakemakeAdapter.JOB_EVENT_PATH
    stop, thread = _start_relay(adapter)
    try:
        frame = _frame("job.started", 7, "align")
        cut = len(frame) // 2
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("ab") as stream:
            stream.write(frame[:cut].encode("utf-8"))
            stream.flush()
        # The relay must poll over the half-written line (interval 0.1s):
        # the old text-mode cursor jumped past it and the event was lost.
        time.sleep(0.3)
        with path.open("ab") as stream:
            stream.write(frame[cut:].encode("utf-8") + b"\n")
            stream.flush()

        events = _wait_until(
            adapter.storage,
            adapter.run_id,
            lambda events: _count(events, "job.started", 7) >= 1,
        )

        assert _count(events, "job.started", 7) == 1  # delivered, never duplicated
    finally:
        stop.set()
        thread.join(timeout=2)
    assert not thread.is_alive()
    assert _count(adapter.storage.read_events(adapter.run_id), "job.started", 7) == 1


def test_tail_events_are_drained_after_engine_exit(tmp_path) -> None:
    adapter = _adapter(tmp_path)
    path = adapter.run_root / SnakemakeAdapter.JOB_EVENT_PATH
    stop, thread = _start_relay(adapter)
    try:
        _append_frames(path, _frame("job.started", 1, "prep"))
        # Back right after the relay consumed frame 1, so frames 2-3 are still
        # unread when the engine "exits" (execute()'s finally sets stop).
        _wait_until(
            adapter.storage,
            adapter.run_id,
            lambda events: _count(events, "job.started", 1) == 1,
        )
        _append_frames(
            path, _frame("job.succeeded", 1, "prep"), _frame("job.failed", 2, "align")
        )
        stop.set()
        thread.join(timeout=2)

        events = adapter.storage.read_events(adapter.run_id)
        assert _count(events, "job.succeeded", 1) == 1
        assert _count(events, "job.failed", 2) == 1
        assert not thread.is_alive()
    finally:
        stop.set()


def test_corrupt_frame_is_reported_without_blocking_following_frames(tmp_path) -> None:
    adapter = _adapter(tmp_path)
    path = adapter.run_root / SnakemakeAdapter.JOB_EVENT_PATH
    stop, thread = _start_relay(adapter)
    try:
        _append_frames(
            path,
            '{"type": "job.started", "job_id": 3',  # complete line, broken JSON
            '{"type": "job.started", "job_id": 4}',  # complete JSON, missing rule
            _frame("job.started", 5, "align"),
        )
        events = _wait_until(
            adapter.storage,
            adapter.run_id,
            lambda events: _count(events, "job.started", 5) == 1,
        )
        stop.set()
        thread.join(timeout=2)

        # Each broken frame produced a loud runtime record and a visible
        # warning on the event stream...
        records = [
            json.loads(line)
            for line in adapter.storage
            .resolve(adapter.run_id, "logs", "runtime.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
            if line.strip()
        ]
        malformed = [
            record
            for record in records
            if record["level"] == "error"
            and "malformed job-event frame" in record["message"]
        ]
        assert len(malformed) == 2
        warnings = [
            event
            for event in events
            if event["type"] == "runtime.message" and event["level"] == "warning"
        ]
        assert len(warnings) == 2
        # ...while the healthy frames around them were all relayed, and the
        # broken ones produced no job event at all.
        assert _count(events, "job.started", 5) == 1
        assert _count(events, "job.started", 3) == 0
        assert _count(events, "job.started", 4) == 0
    finally:
        stop.set()


def test_workflow_graph_frame_maps_to_graph_event(tmp_path) -> None:
    adapter = _adapter(tmp_path)
    path = adapter.run_root / SnakemakeAdapter.JOB_EVENT_PATH
    stop, thread = _start_relay(adapter)
    try:
        projection = {"nodes": [{"id": "n1"}], "edges": [{"from": "n1", "to": "n2"}]}
        _append_frames(path, json.dumps({"type": "workflow.graph", **projection}))

        events = _wait_until(
            adapter.storage,
            adapter.run_id,
            lambda events: any(e["type"] == "workflow.graph" for e in events),
        )

        graphs = [event for event in events if event["type"] == "workflow.graph"]
        assert len(graphs) == 1
        assert graphs[0]["data"]["nodes"] == projection["nodes"]
        assert graphs[0]["data"]["edges"] == projection["edges"]
    finally:
        stop.set()
        thread.join(timeout=2)
