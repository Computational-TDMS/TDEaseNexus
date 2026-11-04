"""Read-only CAS sealing and upload staging protection, end to end.

BACKEND-RUN-SERVICE.md §2.6/§2.7: CAS blobs are sealed read-only at write, so
an in-place input rewrite fails at the write itself instead of corrupting the
shared bytes every sibling Run links; uploads carry a per-digest staging
marker that keeps a worker-restart GC from collecting a finished-but-not-yet-
referenced blob.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.api.runs_v2 import router as runs_router
from app.api.uploads import router as uploads_router
from app.database.lifecycle import migrate_database
from app.errors import register_error_handlers
from src.execution_runtime import set_storage
from src.execution_runtime.storage import StorageLayout
from src.services.run_worker import execute_run
from src.services.workspace_roots import get_workspace_root_registry

RUN_PATH = "runs/sealing"
DATA = b"original input bytes\n"

# The rule rewrites the shared input in place -- contractually broken
# (WORKFLOW-RUN §1: inputs are sealed and shared), and now loud.
SNAKEFILE_REWRITER = (
    "rule all:\n"
    "    input:\n"
    "        'touched.txt'\n"
    "\n"
    "rule rewrite_input:\n"
    "    input:\n"
    "        'input.dat'\n"
    "    output:\n"
    "        'touched.txt'\n"
    "    run:\n"
    "        with open('input.dat', 'ab') as handle:\n"
    "            handle.write(b'clobbered')\n"
    "        open('touched.txt', 'w').write('done')\n"
)

SNAKEFILE_READER = (
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
    "        open('out.txt', 'wb').write(b'processed: ' + open('input.dat', 'rb').read())\n"
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
    (run_folder / "input.dat").write_bytes(DATA)

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
    app.include_router(uploads_router)
    register_error_handlers(app)
    return TestClient(app)


def _commit_body(workspace: Path, root_id: str, key: str, run_id: str) -> dict:
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
            "workspace_id": "workspace-sealing",
            "workspace_run_path": RUN_PATH,
            "local_root_id": root_id,
            "local_run_path": RUN_PATH,
            "workspace_tree_hash": "0" * 64,
            "workspace_files": files,
            # Verbatim-freeze doctrine: the embedded text must be the file's
            # raw bytes (Windows write_text produced CRLF), not a
            # universal-newline translation of it.
            "snakefile": (workspace / RUN_PATH / "Snakefile").read_bytes().decode("utf-8"),
            "config": {},
            "nodes": [],
            "targets": [],
            "user_id": "local-owner",
            "result_specs": [{
                "result_id": "out", "name": "out", "kind": "table",
                "dimensions": {}, "output": "out.txt",
            }],
        },
        "inline_blobs": {},
    }


def _submit(client: TestClient, workspace: Path, root_id: str, key: str, run_id: str) -> None:
    created = client.post("/api/v2/runs", json=_commit_body(workspace, root_id, key, run_id))
    assert created.status_code == 201, created.text


def _execute(storage: StorageLayout, run_id: str) -> None:
    execute_run(json.loads(storage.resolve(run_id, "run.json").read_text(encoding="utf-8")))


def test_in_place_input_rewrite_fails_and_the_shared_bytes_survive(_layout) -> None:
    storage, workspace, root_id = _layout
    digest = hashlib.sha256(DATA).hexdigest()

    with _client() as client:
        # The sibling Run links the same input bytes first and succeeds.
        (workspace / RUN_PATH / "Snakefile").write_text(SNAKEFILE_READER, encoding="utf-8")
        _submit(client, workspace, root_id, "ik-reader", "run-reader")
        _execute(storage, "run-reader")

        # Its published result is sealed into CAS read-only, while the run
        # tree's own copy stays writable, and both still download.
        output = storage.resolve("run-reader", "out.txt")
        assert output.read_bytes() == b"processed: " + DATA
        assert output.stat().st_mode & 0o222, "run-tree outputs stay writable"
        manifest = json.loads(
            storage.resolve("run-reader", "results.manifest.json").read_text(encoding="utf-8")
        )
        out_digest = next(e["sha256"] for e in manifest["files"] if e["path"] == "out.txt")
        assert not storage.blob_path(out_digest).stat().st_mode & 0o222, "CAS copies are sealed"

        listed = client.get("/api/v2/runs/run-reader/files")
        assert listed.status_code == 200, listed.text
        assert "out.txt" in {f["path"] for f in listed.json()["files"]}
        downloaded = client.get("/api/v2/runs/run-reader/files/out.txt")
        assert downloaded.status_code == 200, downloaded.text
        assert downloaded.content == b"processed: " + DATA

        # The Run whose rule rewrites the input in place fails at the write.
        (workspace / RUN_PATH / "Snakefile").write_text(SNAKEFILE_REWRITER, encoding="utf-8")
        _submit(client, workspace, root_id, "ik-rewrite", "run-rewrite")
    _execute(storage, "run-rewrite")

    projection, _snapshot = storage.project_run_snapshot("run-rewrite")
    assert projection.status == "FAILED"
    failed = next(e for e in storage.read_events("run-rewrite") if e["type"] == "run.failed")
    assert "engine" in str((failed.get("data") or {}).get("error_message", ""))

    # The failure is the write denial itself, not a downstream digest check:
    # the engine stderr records the PermissionError from the in-place rewrite.
    log_text = "\n".join(
        path.read_text(encoding="utf-8", errors="replace")
        for path in storage.resolve("run-rewrite", "logs").rglob("*.log")
    )
    assert "PermissionError" in log_text, "the rule must fail at the write, loudly"

    # The CAS blob and the sibling Run's linked input are the frozen bytes.
    assert storage.blob_get(digest) == DATA
    assert storage.file_digest(storage.resolve("run-reader", "input.dat")) == digest


def test_staging_markers_decide_upload_survival_across_a_worker_restart(_layout) -> None:
    storage, _workspace, _root_id = _layout

    with _client() as client:
        payload = b"one part of a multi-file upload"
        digest = hashlib.sha256(payload).hexdigest()
        response = client.put(
            f"/api/v2/uploads/{digest}", files={"file": ("part.bin", payload)}
        )
        assert response.status_code == 200, response.text

    blob = storage.blob_path(digest)
    marker = storage.staging_marker_path(digest)
    assert blob.is_file() and marker.is_file()

    # Aged past the 300 s GC grace: only the marker can protect it now.
    aged = time.time() - 3600
    os.utime(blob, (aged, aged))

    # Simulated worker restart: GC with production defaults.
    assert storage.gc_unreferenced_blobs() == []
    assert blob.is_file(), "a fresh marker must hold off the GC"

    # An expired marker no longer protects; blob and marker both go.
    expired = time.time() - 25 * 3600
    os.utime(marker, (expired, expired))
    assert digest in storage.gc_unreferenced_blobs()
    assert not blob.exists()
    assert not marker.exists()

    # A marker whose blob never landed is an orphan and is swept.
    ghost = storage.staging_marker_path(hashlib.sha256(b"ghost").hexdigest())
    ghost.parent.mkdir(parents=True, exist_ok=True)
    ghost.touch()
    storage.gc_unreferenced_blobs()
    assert not ghost.exists()


def test_gc_walk_seals_a_legacy_store_blob_idempotently(_layout) -> None:
    storage, _workspace, _root_id = _layout

    keep_digest = hashlib.sha256(b"keep").hexdigest()
    keep = storage.blob_path(keep_digest)
    keep.parent.mkdir(parents=True, exist_ok=True)
    keep.write_bytes(b"keep")  # pre-sealing era: a writable store blob
    storage.allocate_run("run-seal")
    storage.write_definition_snapshot("run-seal", {
        "run_id": "run-seal", "definition_revision_id": "def-" + "7" * 24,
        "workspace_files": [{"path": "keep.bin", "blob_hash": keep_digest}],
    })

    assert keep_digest not in storage.gc_unreferenced_blobs(min_age_seconds=0)
    assert keep.is_file()
    assert not keep.stat().st_mode & 0o222
    assert keep_digest not in storage.gc_unreferenced_blobs(min_age_seconds=0)
