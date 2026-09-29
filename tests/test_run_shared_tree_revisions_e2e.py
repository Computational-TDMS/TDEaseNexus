"""One shared Run tree across definition revisions — end to end.

The Run directory is ONE reusable physical workspace. This drives the real
surface the product uses: `POST /api/v2/runs` freezes a definition, the
worker's `execute_run` materializes and executes it through the real engine,
and a second definition submitted into the same tree must neither steal the
results projection before it runs nor publish the first revision's files as
its own results afterwards.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.api.runs_v2 import router
from app.database.lifecycle import migrate_database
from app.errors import register_error_handlers
from src.execution_runtime import set_storage
from src.execution_runtime.storage import StorageLayout
from src.services.run_worker import execute_run
from src.services.workspace_roots import get_workspace_root_registry

RUN_PATH = "runs/shared-tree"
RUN_ID = "run_e2e_shared_tree"

SNAKEFILE_A = (
    "from pathlib import Path\n"
    "\n"
    "rule all:\n"
    "    input:\n"
    "        'out-a.txt'\n"
    "\n"
    "rule make_a:\n"
    "    output:\n"
    "        'out-a.txt'\n"
    "    run:\n"
    "        Path('out-a.txt').write_text('A payload\\n', encoding='utf-8')\n"
    "        Path('side-a.txt').write_text('A sidecar\\n', encoding='utf-8')\n"
)
SNAKEFILE_B = (
    "from pathlib import Path\n"
    "\n"
    "rule all:\n"
    "    input:\n"
    "        'out-b.txt'\n"
    "\n"
    "rule make_b:\n"
    "    output:\n"
    "        'out-b.txt'\n"
    "    run:\n"
    "        Path('out-b.txt').write_text('B payload\\n', encoding='utf-8')\n"
)


@pytest.fixture(autouse=True)
def _shared_layout(tmp_path: Path):
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    db_path = str(storage.data / "database" / "db.sqlite3")
    migrate_database(db_path)
    get_workspace_root_registry().configure(db_path)

    workspace = tmp_path / "workspace"
    run_folder = workspace / RUN_PATH
    run_folder.mkdir(parents=True)
    (run_folder / "Snakefile").write_text(SNAKEFILE_A, encoding="utf-8")

    from src.execution_runtime.workspace_containment import (
        set_approved_roots_checker,
    )

    set_approved_roots_checker(
        lambda user_id, path: get_workspace_root_registry().is_within_approved_root(user_id, path)
    )
    set_storage(storage)
    root_id, _ = get_workspace_root_registry().register("local-owner", str(workspace))
    yield storage, workspace, root_id
    from src.execution_runtime.workspace_containment import reset_approved_roots_checker

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


def _commit_body(workspace: Path, root_id: str, result_specs: list[dict], key: str) -> dict:
    raw = (workspace / RUN_PATH / "Snakefile").read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    return {
        "commit": {
            "run_id": RUN_ID,
            "idempotency_key": key,
            "workspace_id": "workspace-shared-tree",
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
            "result_specs": result_specs,
        },
        "inline_blobs": {},
    }


def _spec(result_id: str, output: str) -> dict:
    return {
        "result_id": result_id,
        "name": output,
        "kind": "workflow_output",
        "dimensions": {},
        "output": output,
    }


def _run_definitions(storage: StorageLayout) -> str:
    return str(storage.resolve(RUN_ID, "run.json"))


def test_second_revision_keeps_provenance_pure(_shared_layout) -> None:
    storage, workspace, root_id = _shared_layout

    # ── Definition A: submits, executes for real, publishes its manifest. ──
    with _client() as client:
        created = client.post(
            "/api/v2/runs", json=_commit_body(workspace, root_id, [_spec("result-a", "out-a.txt")], "ik-a")
        )
        assert created.status_code == 201, created.text
        definition_a = created.json()["current_revision"]

        # Submission seals the local mapping in shared CAS. The Workspace may
        # change before the global worker reaches this queue item; that must
        # not mutate definition A or recreate the old root-capability race.
        (workspace / RUN_PATH / "Snakefile").write_text(SNAKEFILE_B, encoding="utf-8")
        execute_run(json.loads(Path(_run_definitions(storage)).read_text(encoding="utf-8")))

        run_dir = storage.resolve(RUN_ID)
        assert (run_dir / "out-a.txt").read_text(encoding="utf-8") == "A payload\n"
        manifest_a = json.loads((run_dir / "results.manifest.json").read_text(encoding="utf-8"))
        assert manifest_a["definition_revision_id"] == definition_a
        published_a = {entry["path"] for entry in manifest_a["files"]}
        # The undeclared sidecar is swept in as an execution artifact; the
        # declared result is there too.
        assert {"out-a.txt", "side-a.txt"} <= published_a

        results_a = client.get(f"/api/v2/runs/{RUN_ID}/results")
        assert results_a.status_code == 200, results_a.text
        body_a = results_a.json()
        assert body_a["definition_revision_id"] == definition_a
        assert [(item["output"], item["status"]) for item in body_a["results"]] == [("out-a.txt", "ready")]

        # ── Definition B submits into the SAME tree while it is idle. ──────
        (workspace / RUN_PATH / "Snakefile").write_text(SNAKEFILE_B, encoding="utf-8")
        resubmitted = client.post(
            "/api/v2/runs", json=_commit_body(workspace, root_id, [_spec("result-b", "out-b.txt")], "ik-b")
        )
        assert resubmitted.status_code == 201, resubmitted.text
        definition_b = resubmitted.json()["current_revision"]
        assert definition_b != definition_a

        # Masquerade guard: run.json now names B, but no B execution exists
        # yet — the results projection must still be A's (specs AND revision).
        results_before = client.get(f"/api/v2/runs/{RUN_ID}/results").json()
        assert results_before["definition_revision_id"] == definition_a
        assert [(item["output"], item["status"]) for item in results_before["results"]] == [
            ("out-a.txt", "ready")
        ]

        # ── B executes in the same physical tree. ──────────────────────────
        execute_run(json.loads(Path(_run_definitions(storage)).read_text(encoding="utf-8")))
        assert (run_dir / "out-b.txt").read_text(encoding="utf-8") == "B payload\n"

        manifest_b = json.loads((run_dir / "results.manifest.json").read_text(encoding="utf-8"))
        assert manifest_b["definition_revision_id"] == definition_b
        assert manifest_b["parent_revision_id"] == manifest_a["revision_id"]
        published_b = {entry["path"] for entry in manifest_b["files"]}
        # Provenance purity: A's declared result and A's swept sidecar are NOT
        # republished as B's results; B publishes exactly its own product.
        assert published_b == {"out-b.txt"}

        results_b = client.get(f"/api/v2/runs/{RUN_ID}/results").json()
        assert results_b["definition_revision_id"] == definition_b
        assert [(item["output"], item["status"]) for item in results_b["results"]] == [
            ("out-b.txt", "ready")
        ]

        # ── Both definitions stay listed with their outcomes. ──────────────
        listed = client.get(f"/api/v2/runs/{RUN_ID}/definitions").json()["definitions"]
        by_id = {item["definition_revision_id"]: item for item in listed}
        assert set(by_id) == {definition_a, definition_b}
        assert by_id[definition_a]["status"] == "SUCCEEDED"
        assert by_id[definition_b]["status"] == "SUCCEEDED"
        assert by_id[definition_a]["result_revision_id"] == manifest_a["revision_id"]
        assert by_id[definition_b]["result_revision_id"] == manifest_b["revision_id"]

        # ── Self-correction channel: read one frozen definition in full. ──
        content_a = client.get(f"/api/v2/runs/{RUN_ID}/definitions/{definition_a}")
        assert content_a.status_code == 200, content_a.text
        body_a = content_a.json()
        # The freeze pins the file's RAW bytes -- on Windows write_text produced
        # CRLF, so the frozen text carries CRLF (verbatim-freeze doctrine).
        assert body_a["snakefile"] == SNAKEFILE_A.replace(chr(10), chr(13) + chr(10)),             "frozen text must be the exact bytes revision A ran"
        assert body_a["result_specs"] == [_spec("result-a", "out-a.txt")]
        missing = client.get(f"/api/v2/runs/{RUN_ID}/definitions/def-{'0' * 24}")
        assert missing.status_code == 404
