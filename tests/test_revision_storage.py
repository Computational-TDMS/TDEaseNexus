from __future__ import annotations

import os
import time
from pathlib import Path

from src.execution_runtime import set_storage
from src.execution_runtime.storage import StorageLayout
from src.services.run_definition import freeze_definition
from src.services.workspace_roots import configure_workspace_root_runtime, get_workspace_root_registry


def test_re_materialization_replaces_only_previous_shared_inputs(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path / "data")
    storage.bootstrap()
    run_root = storage.allocate_run("run-reconcile")
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = workspace / "sample.txt"
    source.write_bytes(b"old")
    configure_workspace_root_runtime(storage.data / "database" / "db.sqlite3")
    get_workspace_root_registry().register("user", str(workspace))

    old = {"path": "sample.txt", "blob_hash": storage.file_digest(source)}
    storage.materialize_local_run_files(run_root, workspace, [old], user_id="user")
    intermediate = run_root / "results" / "intermediate.bin"
    intermediate.write_bytes(b"keep")

    source.write_bytes(b"new")
    new = {"path": "sample.txt", "blob_hash": storage.file_digest(source)}
    storage.materialize_local_run_files(run_root, workspace, [new], user_id="user")

    assert (run_root / "sample.txt").read_bytes() == b"new"
    assert intermediate.read_bytes() == b"keep"


def test_local_input_snapshot_does_not_follow_workspace_in_place_edits(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path / "data")
    storage.bootstrap()
    run_root = storage.allocate_run("run-immutable-input")
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = workspace / "sample.raw"
    source.write_bytes(b"original")
    configure_workspace_root_runtime(storage.data / "database" / "db.sqlite3")
    get_workspace_root_registry().register("user", str(workspace))

    entry = {"path": "sample.raw", "blob_hash": storage.file_digest(source)}
    storage.materialize_local_run_files(run_root, workspace, [entry], user_id="user")

    # A badly behaved editor writes in place instead of atomically replacing
    # the Workspace file. A Run revision must still read the bytes it froze.
    source.write_bytes(b"edited-in-place")

    assert (run_root / "sample.raw").read_bytes() == b"original"
    assert storage.file_digest(run_root / "sample.raw") == entry["blob_hash"]


def test_definition_snapshots_are_small_and_distinct_from_execution_tree(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path / "data")
    storage.bootstrap()
    storage.allocate_run("run-definitions")
    base = {
        "run_id": "run-definitions",
        "workspace_tree_hash": "0" * 64,
        "workspace_files": [],
        "snakefile": "rule all:\n    input: []\n",
        "config": {}, "targets": [], "nodes": [],
    }
    first = freeze_definition(base)
    second = freeze_definition({**base, "snakefile": "rule all:\n    input: ['x']\n"})
    storage.write_definition_snapshot("run-definitions", first)
    storage.write_definition_snapshot("run-definitions", second)
    (storage.resolve("run-definitions", "results", "shared.bin")).write_bytes(b"one")

    assert [item["definition_revision_id"] for item in storage.definition_snapshots("run-definitions")] == [
        second["definition_revision_id"], first["definition_revision_id"],
    ]
    assert not (storage.resolve("run-definitions", "definitions", first["definition_revision_id"], "results")).exists()
    assert (storage.resolve("run-definitions", "results", "shared.bin")).read_bytes() == b"one"


def test_cas_gc_keeps_retained_revision_bytes_and_removes_orphans(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path / "data")
    storage.bootstrap()
    storage.allocate_run("run-gc")
    kept = storage.blob_put(b"retained")
    orphan = storage.blob_put(b"orphan")
    storage.write_definition_snapshot("run-gc", {
        "run_id": "run-gc", "definition_revision_id": "def-" + "2" * 24,
        "workspace_files": [{"path": "input.raw", "blob_hash": kept}],
    })
    orphan_path = storage.blob_path(orphan)
    old = time.time() - 3600
    os.utime(orphan_path, (old, old))

    removed = storage.gc_unreferenced_blobs(min_age_seconds=0)

    assert orphan in removed
    assert not orphan_path.exists()
    assert storage.blob_path(kept).is_file()


def test_worker_bootstrap_uses_the_durable_root_registry(tmp_path: Path) -> None:
    storage = StorageLayout(tmp_path / "data")
    storage.bootstrap()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    db_path = storage.data / "database" / "db.sqlite3"
    configure_workspace_root_runtime(db_path)
    root_id, _ = get_workspace_root_registry().register("worker-user", str(workspace))
    set_storage(storage)

    from src.execution_runtime.workspace_containment import validate_root_containment

    assert validate_root_containment(workspace, "worker-user") == workspace.resolve()
    assert get_workspace_root_registry().resolve("worker-user", root_id, ".") == workspace.resolve()
