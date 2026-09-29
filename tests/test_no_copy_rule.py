"""The shared-storage rule: a Run never privately duplicates a Workspace input
or carries node-package bytes.

Inputs are sealed once in the Backend CAS and then linked into a Run; tools
stay in the Backend node catalog and the engine reaches them through absolute
config paths. This guards the decision against a per-Run "just copy it"
fallback: a silent multi-GB duplicate makes the executed bytes impossible to
account for, and the user never sees the cost.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from src.execution_runtime.storage import StorageLayout
from src.execution_runtime.workspace_containment import (
    canonicalize,
    reset_approved_roots_checker,
    set_approved_roots_checker,
)


@pytest.fixture(autouse=True)
def _reset_checker():
    reset_approved_roots_checker()
    yield
    reset_approved_roots_checker()


def test_a_local_input_that_cannot_be_linked_is_refused_not_copied(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    run_dir = storage.allocate_run("run_no_copy")
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    payload = workspace / "big.raw"
    payload.write_bytes(b"x" * 4096)
    set_approved_roots_checker(
        lambda user_id, path: user_id == "user-1" and path.startswith(str(canonicalize(workspace)))
    )

    def _refuse_link(source, target):
        raise OSError(18, "Invalid cross-device link")

    monkeypatch.setattr(os, "link", _refuse_link)

    with pytest.raises(ValueError) as excinfo:
        storage.materialize_local_run_files(
            run_dir, workspace,
            [{"path": "big.raw", "blob_hash": storage.file_digest(payload)}],
            user_id="user-1",
        )
    message = str(excinfo.value)
    assert "cannot be sealed into the Backend CAS" in message
    assert not (run_dir / "big.raw").exists(), "the input was copied despite the refusal"
