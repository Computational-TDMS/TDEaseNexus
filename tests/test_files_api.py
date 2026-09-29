"""Files API (app/api/files.py) — read/write path protection.

This endpoint takes no run_id/principal context at all, so it cannot enforce
per-Principal ownership the way app/api/runs_v2.py does. The only safe
contract is a fixed denylist of Backend-owned directories it must never
reach at all, for reads and writes alike, plus a stricter write-only
denylist for the Snakemake node packages Backend executes as code.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from app.api.files import _safe_path, _writable_path
from src.contracts.errors import ErrorCode, TDEaseError
from src.execution_runtime.storage import StorageLayout, set_storage


@pytest.fixture(autouse=True)
def _storage(tmp_path: Path) -> StorageLayout:
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)
    return storage


@pytest.mark.parametrize("rel_path", [
    "runs/some-run/results/secret.txt",
    "runs/some-run/run.json",
    "database/db.sqlite3",
    "store/ab/cd/deadbeef",
    "blobs/deadbeef",
    ".runtime/whatever",
    ".tdease/engine-request.json",
    ".snakemake/metadata",
])
def test_read_denies_every_backend_owned_prefix(rel_path: str) -> None:
    """GET /api/v2/files (and /list, which shares _safe_path) must never
    reach Run data, the SQLite database, or the CAS blob store -- this
    endpoint has no ownership check to gate them with (the real bug: it used
    to serve any Run's files to any caller, bypassing runs_v2.py's
    Depends(_owned_run))."""
    with pytest.raises(TDEaseError) as exc_info:
        _safe_path(rel_path)
    assert exc_info.value.code is ErrorCode.WORKSPACE_PATH_ESCAPE
    assert exc_info.value.http_status == 403


def test_read_still_allows_ordinary_workspace_paths() -> None:
    # Unaffected, non-denylisted paths remain reachable (no behaviour change
    # for the endpoint's actual intended use).
    resolved = _safe_path("workspace/raw/sample.mzML")
    assert resolved.name == "sample.mzML"


def test_write_denies_node_rule_files() -> None:
    """PUT /api/v2/files must never overwrite nodes/**/rules.smk -- Snakemake
    imports and executes those as Python `shell:` directives, so an
    unrestricted write there is remote code execution the next time any Run
    touches that node."""
    with pytest.raises(TDEaseError) as exc_info:
        _writable_path("nodes/msconvert/rules.smk")
    assert exc_info.value.code is ErrorCode.WORKSPACE_PATH_ESCAPE
    assert exc_info.value.http_status == 403


def test_write_denies_every_read_protected_prefix_too() -> None:
    with pytest.raises(TDEaseError) as exc_info:
        _writable_path("runs/some-run/run.json")
    assert exc_info.value.code is ErrorCode.WORKSPACE_PATH_ESCAPE
    assert exc_info.value.http_status == 403
