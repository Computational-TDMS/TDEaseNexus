"""Result attribution across revisions — end to end.

The audit reproduced: a dynamic run-root output vanished from the manifest
after the second revision update, and the old directory sweep could promote a
materialized input into a later manifest. The contract under test: the
manifest's publish set is the engine's own execution record plus explicit
result_specs plus previously claimed entries kept verbatim — never Snakefile
text parsing, never a scan of the shared tree.

The Snakefile below computes its output path through an f-string, so the old
static `rule all` parser resolves nothing for it: only the engine DAG knows
what this execution actually produced.
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

RUN_PATH = "runs/attribution"
RUN_ID = "run_e2e_attribution"

SNAKEFILE = (
    "from pathlib import Path\n"
    "\n"
    'TAG = config.get("tag") or "v1"\n'
    'OUT = f"report-{TAG}.txt"\n'
    "\n"
    "rule all:\n"
    "    input:\n"
    "        OUT\n"
    "\n"
    "rule build:\n"
    "    output:\n"
    "        OUT\n"
    "    run:\n"
    '        Path(OUT).write_text(f"payload:{TAG}\\n", encoding="utf-8")\n'
    '        Path("sidecar.txt").write_text("side\\n", encoding="utf-8")\n'
)


@pytest.fixture()
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
    (run_folder / "seed.tsv").write_text("seed row\n", encoding="utf-8")

    from src.execution_runtime.workspace_containment import (
        set_approved_roots_checker,
    )

    set_approved_roots_checker(
        lambda user_id, path: get_workspace_root_registry().is_within_approved_root(user_id, path)
    )
    set_storage(storage)
    root_id, _ = get_workspace_root_registry().register("local-owner", str(workspace))
    yield storage, run_folder, root_id
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


def _commit_body(run_folder: Path, root_id: str, tag: str, key: str, with_seed: bool) -> dict:
    raw = (run_folder / "Snakefile").read_bytes()
    files = [{
        "path": "Snakefile", "blob_hash": hashlib.sha256(raw).hexdigest(),
        "size": len(raw), "mode": "file", "executable": False,
    }]
    if with_seed:
        seed = (run_folder / "seed.tsv").read_bytes()
        files.append({
            "path": "seed.tsv", "blob_hash": hashlib.sha256(seed).hexdigest(),
            "size": len(seed), "mode": "file", "executable": False,
        })
    return {
        "commit": {
            "run_id": RUN_ID,
            "idempotency_key": key,
            "workspace_id": "workspace-attribution",
            "workspace_run_path": RUN_PATH,
            "local_root_id": root_id,
            "local_run_path": RUN_PATH,
            "workspace_tree_hash": "0" * 64,
            "workspace_files": files,
            "snakefile": raw.decode("utf-8"),
            "config": {"tag": tag},
            "nodes": [],
            "targets": [],
            "user_id": "local-owner",
            "result_specs": [],
        },
        "inline_blobs": {},
    }


def _run_definitions(storage: StorageLayout) -> str:
    return str(storage.resolve(RUN_ID, "run.json"))


def _manifest(storage: StorageLayout) -> dict:
    return json.loads(
        (storage.resolve(RUN_ID) / "results.manifest.json").read_text(encoding="utf-8")
    )


def _files_by_path(manifest: dict) -> dict:
    return {entry["path"]: entry for entry in manifest["files"]}


def test_dynamic_root_outputs_survive_two_revision_updates_with_fixed_digests(_layout) -> None:
    storage, run_folder, root_id = _layout

    with _client() as client:
        created = client.post(
            "/api/v2/runs", json=_commit_body(run_folder, root_id, "v1", "ik-a", with_seed=True)
        )
        assert created.status_code == 201, created.text
        definition_a = created.json()["current_revision"]
        execute_run(json.loads(Path(_run_definitions(storage)).read_text(encoding="utf-8")))

        # The engine's own record names exactly its rule outputs -- the
        # f-string target and nothing else (no sidecar, no materialized input).
        record = storage.read_json(
            storage.resolve(RUN_ID, ".tdease", "execution-outputs.json")
        )
        assert record["outputs"] == ["report-v1.txt"]

        manifest_a = _manifest(storage)
        assert manifest_a["definition_revision_id"] == definition_a
        assert manifest_a["provenance_source"] == "engine_execution"
        assert set(_files_by_path(manifest_a)) == {"report-v1.txt"}

        # Two revision updates: v2, then v3. Revision C also drops the
        # materialized seed input -- the stale file stays in the shared tree.
        definitions = {}
        for tag, key, seed in (("v2", "ik-b", True), ("v3", "ik-c", False)):
            resubmitted = client.post(
                "/api/v2/runs", json=_commit_body(run_folder, root_id, tag, key, with_seed=seed)
            )
            assert resubmitted.status_code == 201, resubmitted.text
            definitions[tag] = resubmitted.json()["current_revision"]
            execute_run(json.loads(Path(_run_definitions(storage)).read_text(encoding="utf-8")))

        final = _manifest(storage)
        assert final["definition_revision_id"] == definitions["v3"]
        assert final["parent_revision_id"] != manifest_a["revision_id"]
        files = _files_by_path(final)
        # The dynamic run-root outputs of every past revision are still
        # published, the older ones verbatim as first published (digest
        # included) -- a revision that stops declaring an output does not
        # un-publish it.
        assert set(files) == {"report-v1.txt", "report-v2.txt", "report-v3.txt"}
        assert files["report-v1.txt"] == _files_by_path(manifest_a)["report-v1.txt"]

        # A materialized input -- current or stale -- is never a product.
        for document in (manifest_a, final):
            assert "seed.tsv" not in _files_by_path(document)
        assert "sidecar.txt" not in files  # rule-body side file, not a rule output
        assert (storage.resolve(RUN_ID) / "seed.tsv").is_file()

        # The no-specs Published Result projection is manifest/record driven:
        # every retained output is ready, nothing undeclared appears.
        body = client.get(f"/api/v2/runs/{RUN_ID}/results").json()
        assert [(item["output"], item["status"]) for item in body["results"]] == [
            ("report-v1.txt", "ready"),
            ("report-v2.txt", "ready"),
            ("report-v3.txt", "ready"),
        ]
        listed = client.get(f"/api/v2/runs/{RUN_ID}/files").json()
        assert {"report-v1.txt", "report-v2.txt", "report-v3.txt"} <= {
            entry["path"] for entry in listed["files"]
        }

        # ── Resume (continue): nothing reruns, nothing is re-attributed. ──
        rerun = client.post(f"/api/v2/runs/{RUN_ID}/rerun", json={"mode": "resume"})
        assert rerun.status_code == 200, rerun.text
        assert not (storage.resolve(RUN_ID) / "results.manifest.json").exists()
        execute_run(json.loads(Path(_run_definitions(storage)).read_text(encoding="utf-8")))

        record_after_resume = storage.read_json(
            storage.resolve(RUN_ID, ".tdease", "execution-outputs.json")
        )
        assert record_after_resume["outputs"] == []  # everything was up to date

        resumed = _manifest(storage)
        assert resumed["definition_revision_id"] == definitions["v3"]
        assert resumed["provenance_source"] == "engine_execution"
        # The rerun cleared the live manifest; the rebuilt one kept every
        # claimed digest through the retained-revision anchor.
        assert _files_by_path(resumed) == files
        body_after = client.get(f"/api/v2/runs/{RUN_ID}/results").json()
        assert [(item["output"], item["status"]) for item in body_after["results"]] == [
            ("report-v1.txt", "ready"),
            ("report-v2.txt", "ready"),
            ("report-v3.txt", "ready"),
        ]
