"""The Run's frozen Snakefile text must compare byte-for-byte.

`Path.read_text()` opens in universal-newline mode and turns CRLF into LF. The
plan freezes the Client's raw read (the file's bytes decoded as UTF-8), so a
Snakefile with Windows line endings — every copy made from a CRLF template, or
saved by an editor that writes CRLF — could never equal the frozen text: every
prepare/dry-run failed with RUN_PLAN_STALE, deterministically and on every
retry. That is the blocker behind a staged Run that "cannot be registered"
(2026-09-09, `toppic-raw-pipeline` is a CRLF template). `_read_text_verbatim`
is the comparison's only reader, at both sites.

The API-level test below is the one that would have caught the whole incident:
it drives the real `POST /api/v2/runs/dry-run` with the exact frozen CRLF text a
Client sends, so a regression that reintroduces newline translation fails here
instead of in a user's session.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.api.runs_v2 import _read_text_verbatim, _snakefile_mismatch_detail, router
from app.database.lifecycle import migrate_database
from app.errors import register_error_handlers
from src.execution_runtime import set_storage
from src.execution_runtime.storage import StorageLayout
from src.execution_runtime.workspace_containment import (
    reset_approved_roots_checker,
    set_approved_roots_checker,
)
from src.services.workspace_roots import get_workspace_root_registry

RUN_PATH = "runs/CRLF"
# Written as bytes on purpose: this is the template's shape, and the point is
# that the file on disk really carries CRLF.
CRLF_SNAKEFILE = b"rule all:\r\n    input:\r\n        []\r\n"


def test_verbatim_read_preserves_crlf_so_a_crlf_snakefile_matches(tmp_path: Path) -> None:
    snakefile = tmp_path / "Snakefile"
    snakefile.write_bytes(b'rule all:\r\n    input: "out.txt"\r\n')
    frozen = snakefile.read_bytes().decode("utf-8")  # what the Client froze

    assert _read_text_verbatim(snakefile) == frozen
    # The reader this replaced would have reported the file as stale forever.
    assert snakefile.read_text(encoding="utf-8") != frozen


def test_verbatim_read_leaves_lf_text_unchanged(tmp_path: Path) -> None:
    snakefile = tmp_path / "Snakefile"
    snakefile.write_bytes(b'rule all:\n    input: "out.txt"\n')

    assert _read_text_verbatim(snakefile) == snakefile.read_text(encoding="utf-8")


def test_mismatch_detail_names_the_cause() -> None:
    """The stale error must be a diagnosis, not a black box."""
    newline_only = _snakefile_mismatch_detail("rule all:\r\n", "rule all:\n")
    assert "line endings" in newline_only and "CRLF" in newline_only

    edited = _snakefile_mismatch_detail("rule all:\n    input: []\n", "rule all:\n    input: [1]\n")
    assert "first difference" in edited and "line 2" in edited


def _client() -> TestClient:
    app = FastAPI()

    @app.middleware("http")
    async def principal(request: Request, call_next):
        request.state.principal = SimpleNamespace(user_id="local-owner")
        return await call_next(request)

    app.include_router(router)
    register_error_handlers(app)
    return TestClient(app)


def _dry_run(tmp_path: Path, frozen_snakefile: str, on_disk: bytes = CRLF_SNAKEFILE):
    """Drive the real dry-run endpoint over an on-disk file with a given frozen text."""
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    db_path = str(storage.data / "database" / "db.sqlite3")
    migrate_database(db_path)
    get_workspace_root_registry().configure(db_path)

    workspace = tmp_path / "workspace"
    run_folder = workspace / RUN_PATH
    run_folder.mkdir(parents=True)
    (run_folder / "Snakefile").write_bytes(on_disk)
    root_id, _ = get_workspace_root_registry().register("local-owner", str(workspace))
    set_approved_roots_checker(
        lambda user_id, path: get_workspace_root_registry().is_within_approved_root(user_id, path)
    )
    set_storage(storage)
    try:
        body = {
            "commit": {
                "run_id": "run_crlf_dry_run",
                "idempotency_key": "crlf-dry-run",
                "workspace_id": "workspace-crlf",
                "workspace_run_path": RUN_PATH,
                "local_root_id": root_id,
                "local_run_path": RUN_PATH,
                "workspace_tree_hash": "0" * 64,
                "workspace_files": [{
                    "path": "Snakefile",
                    "blob_hash": hashlib.sha256(on_disk).hexdigest(),
                    "size": len(on_disk),
                    "mode": "file",
                    "executable": False,
                }],
                "snakefile": frozen_snakefile,
                "config": {},
                "nodes": [],
                "targets": [],
                "user_id": "local-owner",
            },
            "inline_blobs": {},
        }
        with _client() as client:
            return client.post("/api/v2/runs/dry-run", json=body)
    finally:
        reset_approved_roots_checker()


def test_crlf_snakefile_passes_the_real_dry_run_endpoint(tmp_path: Path) -> None:
    """A CRLF Snakefile frozen verbatim must dry-run, not return RUN_PLAN_STALE."""
    # Exactly what the Client freezes: the file's bytes decoded as UTF-8.
    response = _dry_run(tmp_path, CRLF_SNAKEFILE.decode("utf-8"))

    assert response.status_code == 200, response.text
    assert response.json()["valid"] is True, response.json()["output"]


def test_a_newline_translated_freeze_reports_the_cause(tmp_path: Path) -> None:
    """The pre-fix reader's LF text must fail with the cause named, not a black box."""
    response = _dry_run(tmp_path, CRLF_SNAKEFILE.decode("utf-8").replace("\r\n", "\n"))

    assert response.status_code == 409, response.text
    error = response.json()["error"]
    assert error["code"] == "RUN_PLAN_STALE"
    assert "line endings" in error["message"], error["message"]


def test_a_removed_run_local_node_include_reports_the_remedy(tmp_path: Path) -> None:
    """The junction-era `include: "nodes/<id>/rules.smk"` can never resolve: the
    Run directory holds no nodes/ subtree (config["nodes"] is the only binding).
    Before the classifier this died inside the engine as a bare
    [WinError 3]/FileNotFoundError; the dry-run is the validity authority, so
    it must answer with the product error and the rewrite remedy.
    """
    legacy = (
        'include: "nodes/msconvert/rules.smk"\n'
        "rule all:\n    input: []\n"
    )
    response = _dry_run(tmp_path, legacy, on_disk=legacy.encode("utf-8"))

    assert response.status_code == 409, response.text
    error = response.json()["error"]
    assert error["code"] == "RUN_PLAN_INVALID"
    assert "nodes/msconvert/rules.smk" in error["message"], error["message"]
    assert "config.get('nodes')" in error["remedy"], error["remedy"]
