"""Declared-output projection and Backend Node-catalog diagnostics."""
from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.api.runs_v2 import router
from app.errors import register_error_handlers
from src.backend_settings import configure_backend
from src.execution_runtime import EventEmitter, set_storage
from src.execution_runtime.declared_outputs import rule_all_outputs
from src.execution_runtime.storage import StorageLayout
from src.execution_runtime.workspace_containment import (
    reset_approved_roots_checker,
    set_approved_roots_checker,
)
from src.services.node_catalog import (
    bound_node_paths,
    package_digest,
    project_package,
    resolve_bindings,
    scan_node_catalog,
)


@pytest.fixture(autouse=True)
def _approve_every_local_workspace_root():
    set_approved_roots_checker(lambda user_id, candidate_path: True)
    yield
    reset_approved_roots_checker()


def _runs_client(user_id: str = "local-owner") -> TestClient:
    app = FastAPI()

    @app.middleware("http")
    async def principal(request: Request, call_next):
        request.state.principal = SimpleNamespace(user_id=user_id)
        return await call_next(request)

    app.include_router(router)
    register_error_handlers(app)
    return TestClient(app)


def _fresh_storage(tmp_path: Path) -> StorageLayout:
    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)
    return storage


def test_rule_all_parser_resolves_expand_against_config() -> None:
    snake = (
        'SAMPLES = config.get("samples", ["default_sample"])\n\n'
        "rule all:\n"
        "    input:\n"
        '        expand("{sample}_ms2_toppic_proteoform.tsv", sample=SAMPLES)\n'
    )
    assert rule_all_outputs(snake, {"samples": ["s1", "s2"]}) == [
        "s1_ms2_toppic_proteoform.tsv",
        "s2_ms2_toppic_proteoform.tsv",
    ]
    assert rule_all_outputs(snake, {}) == ["default_sample_ms2_toppic_proteoform.tsv"]
    assert rule_all_outputs("this is not { a snakefile", {}) == []


def _stage_succeeded_run(storage: StorageLayout, run_id: str, snakefile: str, config: dict) -> None:
    storage.allocate_run(run_id)
    revision_id = f"def-{run_id}"
    storage.atomic_write_json(storage.resolve(run_id, "run.json"), {
        "run_id": run_id,
        "workspace_id": "workspace-output",
        "definition_revision_id": revision_id,
        "user_id": "local-owner",
        "materialization_strategy": "local_workspace_hardlink",
        "cores": 1,
        "created_at": "2026-01-01T00:00:00+00:00",
        "labels": {},
        "snakefile": snakefile,
        "config": config,
    })
    emitter = EventEmitter(run_id)
    emitter.run_submitted(revision_id)
    emitter.run_queue_requested(revision_id, "execute")
    emitter.run_started(revision_id, "execute", pid=123, worker_id="test-worker")
    emitter.run_succeeded(revision_id, 0.1, total_tasks=1)


def test_manifest_and_files_list_flat_declared_output_even_when_empty(tmp_path: Path) -> None:
    storage = _fresh_storage(tmp_path)
    snakefile = (
        'SAMPLES = config.get("samples", ["s1"])\n\n'
        "rule all:\n"
        "    input:\n"
        '        expand("{sample}_ms2_toppic_proteoform.tsv", sample=SAMPLES)\n'
    )
    _stage_succeeded_run(storage, "run-flat", snakefile, {"samples": ["s1"]})
    storage.atomic_write(storage.resolve("run-flat", "s1_ms2_toppic_proteoform.tsv"), "")

    assert storage.declared_output_files("run-flat") == ["s1_ms2_toppic_proteoform.tsv"]
    manifest = storage.read_json(
        storage.write_results_manifest("run-flat", "def-run-flat")
    )
    assert "s1_ms2_toppic_proteoform.tsv" in {entry["path"] for entry in manifest["files"]}

    with _runs_client() as client:
        files = client.get("/api/v2/runs/run-flat/files")
        assert files.status_code == 200, files.text
        assert "s1_ms2_toppic_proteoform.tsv" in {entry["path"] for entry in files.json()["files"]}


def test_running_file_snapshot_lists_only_current_execution_artifacts(tmp_path: Path) -> None:
    storage = _fresh_storage(tmp_path)
    storage.allocate_run("run-active")
    revision_id = "def-run-active"
    storage.atomic_write_json(storage.resolve("run-active", "run.json"), {
        "run_id": "run-active",
        "workspace_id": "workspace-output",
        "definition_revision_id": revision_id,
        "user_id": "local-owner",
        "materialization_strategy": "local_workspace_hardlink",
        "cores": 1,
        "created_at": "2026-01-01T00:00:00+00:00",
        "labels": {},
        "snakefile": 'rule all:\n    input: "sample.tsv"\n',
        "config": {},
        "workspace_files": [{"path": "input.raw"}],
    })
    emitter = EventEmitter("run-active")
    emitter.run_submitted(revision_id)
    emitter.run_queue_requested(revision_id, "execute")
    emitter.run_started(revision_id, "execute", pid=123, worker_id="test-worker")
    storage.atomic_write(storage.resolve("run-active", "input.raw"), "input")
    storage.atomic_write(storage.resolve("run-active", "sample.tsv"), "partial")
    storage.atomic_write(storage.resolve("run-active", "nodes", "tool", "rules.smk"), "rule x:")
    storage.atomic_write(storage.resolve("run-active", "database.fasta_idx", "shard"), "index")
    storage.atomic_write(storage.resolve("run-active", "logs", "tasks", "engine.stdout.log"), "log")

    with _runs_client() as client:
        response = client.get("/api/v2/runs/run-active/files")
    assert response.status_code == 200, response.text
    assert response.json()["files"] == [{"path": "sample.tsv", "size": 7, "sha256": None}]


def test_scan_node_catalog_reports_a_missing_tools_root(tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist"
    nodes, errors = scan_node_catalog(missing)
    assert nodes == []
    assert len(errors) == 1
    assert errors[0]["node_root"] == str(missing)


def test_scan_node_catalog_healthy_empty_root_has_no_error(tmp_path: Path) -> None:
    empty = tmp_path / "nodes"
    empty.mkdir()
    assert scan_node_catalog(empty) == ([], [])


def test_package_digest_memo_invalidates_on_content_change(tmp_path: Path) -> None:
    """The memo must never serve a digest for bytes that changed.

    Same length on purpose: only the mtime moves, so the test proves the tree
    signature -- not a size heuristic -- drives invalidation.
    """
    package = tmp_path / "nodes" / "mytool"
    package.mkdir(parents=True)
    rules = package / "rules.smk"
    rules.write_text("rule a:\n", encoding="utf-8")
    os.utime(rules, (1_700_000_000, 1_700_000_000))

    first = package_digest(package)
    assert package_digest(package) == first  # memo hit, no re-hash

    rules.write_text("rule b:\n", encoding="utf-8")
    os.utime(rules, (1_700_000_100, 1_700_000_100))

    assert package_digest(package) != first


def test_scan_node_catalog_skips_underscore_templates(tmp_path: Path) -> None:
    """`_`-prefixed directories are templates/drafts, not nodes."""
    root = tmp_path / "nodes"
    template = root / "_template"
    template.mkdir(parents=True)
    (template / "rules.smk").write_text("rule template_cap:\n    output:\n        \"out.txt\"\n", encoding="utf-8")
    node = root / "mytool"
    node.mkdir()
    (node / "rules.smk").write_text("rule mytool_cap:\n    output:\n        \"out.txt\"\n", encoding="utf-8")

    nodes, errors = scan_node_catalog(root)
    assert [entry["id"] for entry in nodes] == ["mytool"]
    assert errors == []


def test_scan_node_catalog_skips_dot_directories(tmp_path: Path) -> None:
    """Dot-prefixed directories are internal state (`.snapshots` history), never packages."""
    root = tmp_path / "nodes"
    internal = root / ".snapshots"
    internal.mkdir(parents=True)
    (internal / "rules.smk").write_text("rule internal_cap:\n    output:\n        \"out.txt\"\n", encoding="utf-8")
    node = root / "mytool"
    node.mkdir()
    (node / "rules.smk").write_text("rule mytool_cap:\n    output:\n        \"out.txt\"\n", encoding="utf-8")

    nodes, errors = scan_node_catalog(root)
    assert [entry["id"] for entry in nodes] == ["mytool"]
    assert errors == []


def test_api_nodes_reads_the_configured_node_deployment(tmp_path: Path) -> None:
    set_storage(StorageLayout(tmp_path / "backend"))
    data_root = tmp_path / "deployment"
    data_root.mkdir()
    for node_id in ("toppic", "msconvert"):
        package = data_root / "nodes" / node_id
        package.mkdir(parents=True)
        (package / "rules.smk").write_text(
            f"rule {node_id}_cap:\n    output:\n        \"out.txt\"\n", encoding="utf-8"
        )
    config = data_root / "config.json"
    config.write_text(json.dumps({
        "schemaVersion": 1,
        "environment": "development",
        "deploymentMode": "local",
        "dataRoot": ".",
        "server": {"host": "127.0.0.1", "port": 0},
        "auth": {"mode": "local"},
        "logging": {"level": "INFO"},
        "resources": {},
    }), encoding="utf-8")

    from app.api.nodes import router as nodes_router

    app = FastAPI()

    @app.middleware("http")
    async def principal(request: Request, call_next):
        request.state.principal = SimpleNamespace(user_id="local-owner")
        return await call_next(request)

    app.include_router(nodes_router)
    register_error_handlers(app)

    import src.backend_settings as settings_module

    previous = settings_module.BACKEND_SETTINGS
    try:
        # No nodeRoot key: the node root must default under dataRoot.
        configure_backend(config)
        with TestClient(app) as client:
            response = client.get("/api/nodes")
        assert response.status_code == 200, response.text
        body = response.json()
        assert {node["id"] for node in body["nodes"]} == {"toppic", "msconvert"}
        assert body["errors"] == []
    finally:
        settings_module.BACKEND_SETTINGS = previous


def test_resolve_bindings_tolerates_unbound_garbage_packages(tmp_path: Path) -> None:
    healthy = tmp_path / "nodes" / "tool"
    healthy.mkdir(parents=True)
    (healthy / "rules.smk").write_text("rule x:\n    output:\n        \"out.txt\"\n", encoding="utf-8")
    (tmp_path / "nodes" / "garbage").mkdir()  # no rules.smk: catalog noise only

    binding = SimpleNamespace(id="tool", digest=package_digest(healthy))
    resolved = resolve_bindings(tmp_path / "nodes", [binding])
    assert [node["id"] for _, node in resolved] == ["tool"]

    # Binding the garbage package itself still fails — loudly, and alone.
    with pytest.raises(ValueError, match="node not found: garbage"):
        resolve_bindings(tmp_path / "nodes", [SimpleNamespace(id="garbage", digest="stale")])


def test_bound_nodes_stay_in_the_catalog_and_out_of_the_run(tmp_path: Path) -> None:
    """Tool binding is a config mapping, never Run-directory content.

    The engine receives each bound package's absolute catalog path through
    config["nodes"]; no `nodes/` entry may appear inside the Run, so a Run
    carries zero tool bytes and deleting a Run can never touch the catalog.
    """
    catalog = tmp_path / "nodes"
    package = catalog / "tool"
    package.mkdir(parents=True)
    (package / "rules.smk").write_text("rule x:\n    output:\n        \"out.txt\"\n", encoding="utf-8")
    (package / "payload.bin").write_bytes(b"x" * 4096)

    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    run_root = storage.resolve("run_link_probe")
    run_root.mkdir(parents=True, exist_ok=True)

    binding = SimpleNamespace(id="tool", digest=package_digest(package))
    resolved = resolve_bindings(catalog, [binding])
    paths = bound_node_paths(resolved)

    assert paths == {"tool": package.resolve().as_posix()}
    assert not (run_root / "nodes").exists(), "binding must not create Run content"
    assert not any(run_root.iterdir()), "the Run stores nothing for its tools"

    storage.remove_tree(run_root)
    assert not run_root.exists()
    assert (package / "payload.bin").is_file(), "deleting the Run deleted the catalog package"


def test_a_catalog_edit_does_not_invalidate_a_binding(tmp_path: Path) -> None:
    """The catalog IS deployment state: a binding names a node id, and an
    execution uses whatever bytes the catalog currently holds. The digest a
    definition records documents authorship provenance, nothing more."""
    catalog = tmp_path / "nodes"
    package = catalog / "tool"
    package.mkdir(parents=True)
    rules = package / "rules.smk"
    rules.write_text("rule old:\n    output:\n        \"out.txt\"\n", encoding="utf-8")

    binding = SimpleNamespace(id="tool", digest=package_digest(package))
    assert [node["id"] for _, node in resolve_bindings(catalog, [binding])] == ["tool"]

    rules.write_text("rule new:\n    output:\n        \"out.txt\"\n", encoding="utf-8")

    assert [node["id"] for _, node in resolve_bindings(catalog, [binding])] == ["tool"]


def test_param_inline_comments_reach_the_capability_digest() -> None:
    """Inline `# comments` on params are the author's usage notes: they must
    ride the capability entries the Agent's node digest renders, verbatim."""
    from src.services.node_catalog import _extract_capabilities

    rules = (
        "# mytool\n"
        "rule mytool:\n"
        "    input:\n"
        "        raw = '{sample}.raw',\n"
        "    output:\n"
        "        out = '{sample}.out',\n"
        "    params:\n"
        "        level = 'fast',   # fast|deep: deep doubles runtime\n"
        "        threads = 4,\n"
        "    message: 'convert raw'\n"
        "    shell:\n"
        "        '\"{params.binary}\" --level {params.level}'\n"
    )
    caps = _extract_capabilities(rules)
    params = {entry["name"]: entry for entry in caps[0]["params"]}
    assert params["level"]["comment"] == "fast|deep: deep doubles runtime"
    assert "comment" not in params["threads"]
