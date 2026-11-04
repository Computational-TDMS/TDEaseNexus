"""The shipped system-doctor skill runs against the real development layout.

This is the end-to-end contract for `tdeasenexus-docs`: the doctor is executed
through the same surface the product uses (`uv run --script`), against the real
Backend data root, the real Workspace and the real shipped assets, and its
findings must match what is actually on disk. It must also be read-only — a
health report that mutates the tree it inspects is worse than no report.

The System-data root is a throwaway fixture so the report never depends on the
developer's `%APPDATA%` profile.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
UV = shutil.which("uv") or str(Path.home() / ".local/bin" / "uv")

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "tdease-ai-capability" / "system" / "skills" / "tdeasenexus-docs"
DOCTOR = SKILL / "scripts" / "doctor.py"
DATA_ROOT = ROOT / "data"
WORKSPACE = DATA_ROOT / "workspace"
ASSETS = ROOT / "tdease-ai-capability" / "system"


def run_doctor(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [UV, "run", "--script", str(DOCTOR), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def _tree_state(root: Path) -> dict[str, tuple[int, int]]:
    return {
        path.relative_to(root).as_posix(): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


@pytest.fixture()
def system_root(tmp_path: Path) -> Path:
    """A valid writable System root, so profile state cannot leak into the run."""
    root = tmp_path / "system"
    (root / "logs").mkdir(parents=True)
    (root / "settings.json").write_text(
        json.dumps({"schemaVersion": 3, "providers": {"deepseek": {"api_key": "fixture"}}}),
        encoding="utf-8",
    )
    (root / "workspaces.json").write_text(
        json.dumps({"workspaces": [{"workspace_id": "dev", "local_path": str(WORKSPACE)}]}),
        encoding="utf-8",
    )
    return root


def test_doctor_reports_the_real_layout_and_writes_nothing(system_root: Path) -> None:
    runs_root = DATA_ROOT / "backend" / "runs"
    before = _tree_state(runs_root)

    completed = run_doctor(
        "--workspace", str(WORKSPACE),
        "--data-root", str(DATA_ROOT),
        "--system-root", str(system_root),
        "--system-assets", str(ASSETS),
        "--json",
    )
    assert completed.returncode == 0, completed.stderr or completed.stdout
    report = json.loads(completed.stdout)
    checks = {check["id"]: check for check in report["checks"]}

    assert report["exit_code"] == 0
    assert Path(report["roots"]["backend_root"]) == (DATA_ROOT / "backend").resolve()
    assert Path(report["roots"]["backend_project"]) == (ROOT / "tdease-backend").resolve()
    assert Path(report["roots"]["system_assets"]) == ASSETS.resolve()

    # The Backend facts are read from the real tree, not assumed.
    assert checks["backend.index"]["status"] == "ok"
    assert checks["backend.nodes"]["status"] == "ok"
    assert checks["backend.env"]["status"] == "ok"
    assert checks["system-assets"]["status"] == "ok"
    assert "tdeasenexus-toolbox" in checks["system-assets.tool"]["detail"]
    assert checks["workspace.layout"]["status"] == "ok"

    # Journal projection: every Run under the real data root resolves to a
    # terminal status or is reported, never silently dropped.
    run_names = {line.strip().split(":")[0] for line in checks["backend.runs"]["detail"].splitlines()[1:]}
    on_disk = {path.name for path in runs_root.iterdir() if path.is_dir()}
    assert on_disk <= run_names, f"uninspected Runs: {on_disk - run_names}"
    # A live dev data root may hold a genuinely RUNNING/QUEUED Run; the
    # property under test is that every Run resolves to a projected status and
    # none is silently dropped, not that the tree is quiescent.
    assert all(
        any(word in line for word in ("SUCCEEDED", "FAILED", "CANCELLED", "RUNNING", "QUEUED"))
        for line in checks["backend.runs"]["detail"].splitlines()[1:]
    ), "a listed Run did not resolve to a projected status"

    assert _tree_state(runs_root) == before, "the doctor must not modify the Run tree"


def test_skill_reference_pointers_resolve() -> None:
    """Every reference the skill names must exist in the shipped skill tree."""
    text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
    for reference in ("references/system-map.md", "references/run-mechanism.md",
                      "references/repair-playbook.md", "scripts/doctor.py"):
        assert reference in text, f"SKILL.md no longer points at {reference}"
        assert (SKILL / reference).is_file(), f"missing shipped resource: {reference}"
    assert os.path.isfile(UV), "uv is required to execute skill scripts (see design/skill-runtime.md)"
    assert sys.version_info >= (3, 11)
