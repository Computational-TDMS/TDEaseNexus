"""Install-state robustness: a real Run must survive hostile paths.

Real install locations contain spaces (`C:\\Program Files (x86)\\...`), non-ASCII
user folders, and characters with shell/YAML meaning (`&`, `%`, `#`, `'`). A Run
resolves its bound nodes through absolute catalog paths injected into the engine
config, hardlinks its inputs, and creates the `.snakemake` compatibility alias,
so every one of those characters must survive the whole chain: catalog scan,
config injection, input hardlink, engine alias, and the engine's own shell
command — the tool path itself now carries the hostile characters, where the
old run-relative convention dodged them.

This drives the real engine (`src.execution_runtime.engine_runner`) in a hostile
directory tree rather than asserting on path strings, because the failures this
guards against only appear when a subprocess actually parses the path.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

from src.execution_runtime.storage import StorageLayout
from src.execution_runtime.workspace_containment import (
    canonicalize,
    reset_approved_roots_checker,
    set_approved_roots_checker,
)
from src.services.node_catalog import (
    bound_node_paths,
    package_digest,
    resolve_bindings,
)
from types import SimpleNamespace

HOSTILE = "安装 目录 (x86) & 100% #1 'q'"


def _is_link(path: Path) -> bool:
    info = os.lstat(path)
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_reparse_tag", 0))


def test_real_engine_run_under_hostile_paths(tmp_path: Path) -> None:
    root = tmp_path / HOSTILE
    root.mkdir(parents=True)

    # A node package whose rule resolves itself from config["nodes"] — the
    # Backend's binding convention.
    package = root / "backend" / "nodes" / "mytool"
    package.mkdir(parents=True)
    (package / "tool.py").write_text(
        "import pathlib, sys\n"
        "pathlib.Path(sys.argv[2]).write_text(pathlib.Path(sys.argv[1]).read_text(), encoding='utf-8')\n",
        encoding="utf-8",
    )
    (package / "rules.smk").write_text(
        "import sys\n"
        "from pathlib import Path\n"
        "_TOOL = Path((config.get('nodes') or {}).get('mytool') or '') / 'tool.py'\n"
        "\n"
        "rule mytool_copy:\n"
        "    input:\n"
        "        raw = '{sample}.raw',\n"
        "    output:\n"
        "        out = '{sample}.out',\n"
        "    params:\n"
        "        tool = str(_TOOL),\n"
        "        python = sys.executable,\n"
        "    shell:\n"
        "        '\"{params.python}\" \"{params.tool}\" \"{input.raw}\" \"{output.out}\"'\n",
        encoding="utf-8",
    )

    storage = StorageLayout(root / "backend")
    storage.bootstrap()

    workspace = root / "工作区 & 数据"
    workspace.mkdir()
    sample = "样本 & 100% #1"
    raw = workspace / f"{sample}.raw"
    raw.write_text("hostile-path payload\n", encoding="utf-8")
    digest = storage.file_digest(raw)

    run_id = "run_hostile_paths"
    run_dir = storage.allocate_run(run_id)

    # The worker's materialization: control files written, input hardlinked.
    (run_dir / "Snakefile").write_text(
        "_MYNODE = (config.get('nodes') or {}).get('mytool')\n"
        "if not _MYNODE:\n"
        "    raise FileNotFoundError('mytool node is not bound')\n"
        "include: _MYNODE + '/rules.smk'\n"
        "\n"
        "rule all:\n"
        "    input:\n"
        f"        '{sample}.out'\n",
        encoding="utf-8",
    )
    (run_dir / "config.yaml").write_text("{}", encoding="utf-8")
    set_approved_roots_checker(
        lambda user_id, path: user_id == "user-1" and path.startswith(str(canonicalize(workspace)))
    )
    try:
        storage.materialize_local_run_files(
            run_dir, workspace, [{"path": f"{sample}.raw", "blob_hash": digest}], user_id="user-1",
        )
    finally:
        reset_approved_roots_checker()

    # The binding the Backend injects at engine-request build time. The absolute
    # catalog path carries every hostile character in `root`.
    binding = SimpleNamespace(id="mytool", digest=package_digest(package))
    resolved = resolve_bindings(root / "backend" / "nodes", [binding])
    node_config = bound_node_paths(resolved)
    assert node_config == {"mytool": package.resolve().as_posix()}
    assert not (run_dir / "nodes").exists(), "binding must not create Run content"

    request_dir = run_dir / ".tdease"
    request_dir.mkdir(parents=True, exist_ok=True)
    (request_dir / "engine-request.json").write_text(
        json.dumps({
            "schema_version": 1,
            "mode": "execute",
            "snakefile": "Snakefile",
            "config": {"nodes": node_config},
            "cores": 1,
            "targets": [],
            "rerun_incomplete": True,
            "retries": 0,
        }),
        encoding="utf-8",
    )

    completed = subprocess.run(
        [sys.executable, "-m", "src.execution_runtime.engine_runner"],
        cwd=run_dir,
        capture_output=True,
        text=True,
        timeout=180,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert (run_dir / f"{sample}.out").read_text(encoding="utf-8") == "hostile-path payload\n"
    # Engine state lives under the TDEase-owned name; the upstream compatibility
    # alias is cleaned up after the run, so no stray copy of the state remains.
    assert (run_dir / ".tdease" / "engine").is_dir()
    assert not (run_dir / ".snakemake").exists(), "the engine left a stray .snakemake behind"
    # The input was sealed once into the Backend CAS and shared into the Run:
    # the Run's copy shares an inode with the immutable blob (two links), and
    # the Workspace original is untouched.
    run_input = run_dir / f"{sample}.raw"
    assert os.stat(run_input).st_nlink == 2, "the Run stored a private input copy"
    assert raw.read_text(encoding="utf-8") == "hostile-path payload\n"


def test_engine_alias_links_under_hostile_paths(tmp_path: Path) -> None:
    """The `.snakemake` compatibility alias is a junction even when the Run path
    contains spaces, non-ASCII, `&`, `%`, `#` and `'`."""
    from src.execution_runtime.engine_layout import cleanup_engine_alias, create_engine_alias

    run_dir = tmp_path / HOSTILE / "runs" / "run-1"
    engine_root = run_dir / ".tdease" / "engine"
    engine_root.mkdir(parents=True)
    alias = run_dir / ".snakemake"

    create_engine_alias(engine_root, alias)

    assert _is_link(alias), "the alias was not created as a link"
    assert alias.is_dir()
    cleanup_engine_alias(run_dir)
    assert not alias.exists()
