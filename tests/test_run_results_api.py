"""Tests for `GET /api/v2/runs/{run_id}/results` -- the Published Result
projection (docs/spec/WORKFLOW-RUN.md, docs/design/CORE-ARCHITECTURE.md 3).

The projection is a join of `RunCommit.result_specs` (frozen on the Run) against
what actually materialized under `results/`:

- a declared spec whose `output` is not yet on disk must be reported with
  `status="declared"`, never silently dropped;
- a declared spec whose `output` exists on disk must be reported with
  `status="ready"` and carry the current digest/size;
- a file under `results/` that no spec declares must never appear in this
  projection at all -- it stays a Technical Artifact, reachable only through
  `GET /api/v2/runs/{run_id}/files`.

This module stages an immutable Run definition plus canonical Journal events
rather than submitting a real commit through `POST /api/v2/runs`, because the
join logic under test depends only on `result_specs` and on-disk files.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.api.runs_v2 import router
from app.errors import register_error_handlers
from src.execution_runtime import EventEmitter, set_storage
from src.execution_runtime.storage import StorageLayout


def _client(user_id: str = "local-owner") -> TestClient:
    app = FastAPI()

    @app.middleware("http")
    async def principal(request: Request, call_next):
        request.state.principal = SimpleNamespace(user_id=user_id)
        return await call_next(request)

    app.include_router(router)
    register_error_handlers(app)
    return TestClient(app)


def _seed_run(storage: StorageLayout, run_id: str, *, workspace_id: str, result_specs: list[dict]) -> None:
    storage.allocate_run(run_id)
    revision_id = f"def-{run_id}"
    storage.atomic_write_json(storage.resolve(run_id, "run.json"), {
        "run_id": run_id,
        "workspace_id": workspace_id,
        "definition_revision_id": revision_id,
        "user_id": "local-owner",
        "materialization_strategy": "local_workspace_hardlink",
        "cores": 1,
        "created_at": "2026-07-26T00:00:00+00:00",
        "labels": {},
        "result_specs": result_specs,
    })
    emitter = EventEmitter(run_id)
    emitter.run_submitted(revision_id)
    emitter.run_queue_requested(revision_id, "execute")
    emitter.run_started(revision_id, "execute", pid=123, worker_id="test-worker")


def test_declared_result_that_never_materialized_is_reported_as_absent(tmp_path: Path) -> None:
    """A declared spec whose output never appears on disk must still show up in
    the projection with status "declared" -- it must not be silently omitted."""
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)

    _seed_run(storage, "run-declared-only", workspace_id="ws-1", result_specs=[
        {
            "result_id": "feature-table:sample-a",
            "name": "Features -- sample-a",
            "kind": "feature_table",
            "dimensions": {"sample": "sample-a"},
            "output": "results/sample-a/features.tsv",
        }
    ])
    # Deliberately no file written under results/: the declared output never
    # materialized (e.g. the Run is still RUNNING or failed before this step).

    with _client() as client:
        response = client.get("/api/v2/runs/run-declared-only/results")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["run_id"] == "run-declared-only"
        assert len(body["results"]) == 1
        entry = body["results"][0]
        assert entry["result_id"] == "feature-table:sample-a"
        assert entry["status"] == "declared"
        assert entry["digest"] is None
        assert entry["size"] is None
        assert entry["ref"] == {
            "workspace_id": "ws-1", "run_id": "run-declared-only",
            "result_id": "feature-table:sample-a", "digest": None,
        }


def test_undeclared_file_never_appears_in_results_but_stays_reachable_as_a_file(tmp_path: Path) -> None:
    """A file under results/ that no spec declares is a Technical Artifact: it
    must never be promoted into the Published Result projection, but it must
    remain reachable through the existing /files routes."""
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)

    _seed_run(storage, "run-undeclared-file", workspace_id="ws-1", result_specs=[])

    undeclared = storage.resolve("run-undeclared-file", "results", "intermediate", "scratch.tsv")
    undeclared.parent.mkdir(parents=True, exist_ok=True)
    undeclared.write_text("not a Published Result\n", encoding="utf-8")

    with _client() as client:
        results = client.get("/api/v2/runs/run-undeclared-file/results")
        assert results.status_code == 200, results.text
        assert results.json()["results"] == []

        files = client.get("/api/v2/runs/run-undeclared-file/files")
        assert files.status_code == 200, files.text
        paths = [f["path"] for f in files.json()["files"]]
        assert "results/intermediate/scratch.tsv" in paths


def test_ready_result_carries_the_current_digest_and_size(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)

    _seed_run(storage, "run-ready", workspace_id="ws-2", result_specs=[
        {
            "result_id": "feature-table:sample-a",
            "name": "Features -- sample-a",
            "kind": "feature_table",
            "dimensions": {"sample": "sample-a"},
            "output": "results/sample-a/features.tsv",
        }
    ])
    output = storage.resolve("run-ready", "results", "sample-a", "features.tsv")
    output.parent.mkdir(parents=True, exist_ok=True)
    content = b"mass\trt\n500.2\t30.5\n"
    output.write_bytes(content)
    expected_digest = hashlib.sha256(content).hexdigest()

    with _client() as client:
        response = client.get("/api/v2/runs/run-ready/results")
        assert response.status_code == 200, response.text
        entry = response.json()["results"][0]
        assert entry["status"] == "ready"
        assert entry["digest"] == expected_digest
        assert entry["size"] == len(content)
        assert entry["ref"]["digest"] == expected_digest


def test_current_download_uses_published_blob_after_shared_path_changes(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)

    run_id = "run-published-blob"
    revision_id = "def-" + "1" * 24
    snakefile = "rule all:\n    input: \"results/out.tsv\"\n"
    storage.allocate_run(run_id)
    specs = [{
        "result_id": "out", "name": "out", "kind": "table",
        "dimensions": {}, "output": "results/out.tsv",
    }]
    storage.atomic_write_json(storage.resolve(run_id, "run.json"), {
        "run_id": run_id, "workspace_id": "workspace-output",
        "definition_revision_id": revision_id, "user_id": "local-owner",
        "materialization_strategy": "local_workspace_hardlink", "cores": 1,
        "created_at": "2026-07-26T00:00:00+00:00", "labels": {},
        "snakefile": snakefile, "config": {}, "workspace_files": [],
        "result_specs": specs,
    })
    storage.write_definition_snapshot(run_id, {
        "run_id": run_id, "definition_revision_id": revision_id,
        "snakefile": snakefile, "config": {}, "result_specs": specs,
        "workspace_files": [],
    })
    emitter = EventEmitter(run_id)
    emitter.run_submitted(revision_id)
    emitter.run_queue_requested(revision_id, "execute")
    emitter.run_started(revision_id, "execute", pid=123, worker_id="test-worker")
    output = storage.resolve(run_id, "results", "out.tsv")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"published bytes")
    manifest = storage.read_json(storage.write_results_manifest(run_id, revision_id))
    assert manifest["files"][0]["sha256"] == hashlib.sha256(b"published bytes").hexdigest()

    # A later revision reuses the shared physical path and changes its bytes.
    output.write_bytes(b"new revision bytes")
    emitter.run_succeeded(revision_id, run_time_seconds=0.1, total_tasks=1)

    with _client() as client:
        response = client.get(f"/api/v2/runs/{run_id}/files/results/out.tsv")
        assert response.status_code == 200, response.text
        assert response.content == b"published bytes"


def test_published_result_stays_ready_when_shared_path_is_removed(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)
    run_id = "run-published-path-removed"
    revision_id = "def-" + "4" * 24
    specs = [{
        "result_id": "out", "name": "out", "kind": "table",
        "dimensions": {}, "output": "results/out.tsv",
    }]
    storage.allocate_run(run_id)
    definition = {
        "run_id": run_id, "definition_revision_id": revision_id,
        "workspace_id": "workspace-output", "user_id": "local-owner",
        "snakefile": "rule all:\n    input: \"results/out.tsv\"\n",
        "config": {}, "workspace_files": [], "result_specs": specs,
    }
    storage.atomic_write_json(storage.resolve(run_id, "run.json"), definition)
    storage.write_definition_snapshot(run_id, definition)
    emitter = EventEmitter(run_id)
    emitter.run_submitted(revision_id)
    emitter.run_queue_requested(revision_id, "execute")
    emitter.run_started(revision_id, "execute", pid=123, worker_id="test-worker")
    output = storage.resolve(run_id, "results", "out.tsv")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"published bytes")
    storage.write_results_manifest(run_id, revision_id)
    emitter.run_succeeded(revision_id, run_time_seconds=0.1, total_tasks=1)
    output.unlink()

    with _client() as client:
        body = client.get(f"/api/v2/runs/{run_id}/results").json()
        entry = body["results"][0]
        assert entry["status"] == "ready"
        assert entry["digest"] == hashlib.sha256(b"published bytes").hexdigest()


def test_partial_success_reports_both_declared_and_ready_results(tmp_path: Path) -> None:
    """CORE-ARCHITECTURE.md 3.1: "A Run that failed after producing three of
    five declared results projects three ready and two declared" -- partial
    success needs no special handling because readiness is a join, not a
    state machine."""
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)

    _seed_run(storage, "run-partial", workspace_id="ws-3", result_specs=[
        {"result_id": "a", "name": "A", "kind": "k", "dimensions": {}, "output": "results/a.tsv"},
        {"result_id": "b", "name": "B", "kind": "k", "dimensions": {}, "output": "results/b.tsv"},
    ])
    ready_path = storage.resolve("run-partial", "results", "a.tsv")
    ready_path.parent.mkdir(parents=True, exist_ok=True)
    ready_path.write_text("ok\n", encoding="utf-8")

    with _client() as client:
        body = client.get("/api/v2/runs/run-partial/results").json()
        by_id = {entry["result_id"]: entry for entry in body["results"]}
        assert by_id["a"]["status"] == "ready"
        assert by_id["b"]["status"] == "declared"
        assert by_id["b"]["digest"] is None


def test_results_route_is_gated_by_run_ownership(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)

    _seed_run(storage, "run-owned", workspace_id="ws-1", result_specs=[])

    with _client(user_id="owner-b") as other:
        response = other.get("/api/v2/runs/run-owned/results")
        assert response.status_code == 404

    with _client(user_id="local-owner") as owner:
        response = owner.get("/api/v2/runs/run-owned/results")
        assert response.status_code == 200


def test_results_route_404s_like_every_other_run_id_route_for_a_missing_run(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)

    with _client() as client:
        response = client.get("/api/v2/runs/no-such-run/results")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "RUN_NOT_FOUND"
