"""Version contract for the single Snakemake integration location.

TDEase embeds the upstream engine (snakemake) behind exactly one file:
``tdease-backend/src/execution_runtime/engine_runner.py``. Every internal
touchpoint the integration relies on is locked here -- import paths, the
persistence seam, the private one-build surface, and the job-level DAG
members the projection reads. A dependency upgrade that moves any of them
turns this file red first, pointing at engine_runner.py and nowhere else.
"""

from __future__ import annotations

import dataclasses
import inspect
import json
from pathlib import Path

import pytest

ENGINE_RUNNER = (
    Path(__file__).resolve().parents[1]
    / "tdease-backend"
    / "src"
    / "execution_runtime"
    / "engine_runner.py"
)


def _engine_runner_source() -> str:
    return ENGINE_RUNNER.read_text(encoding="utf-8")


def test_api_entry_points_survive_upgrade() -> None:
    """engine_runner drives the engine only through this API chain."""
    from snakemake.api import DAGApi, SnakemakeApi, WorkflowApi

    assert hasattr(SnakemakeApi, "workflow")
    assert hasattr(WorkflowApi, "dag")
    for member in ("unlock", "execute_workflow"):
        assert hasattr(DAGApi, member), (
            f"DAGApi.{member} disappeared: fix src/execution_runtime/engine_runner.py"
        )
    assert "dag_settings" in [field.name for field in dataclasses.fields(DAGApi)]


def test_file_persistence_seam_is_the_replaced_name() -> None:
    """engine_runner redirects engine state by replacing snakemake.workflow's
    FilePersistence name -- the exact name Workflow._prepare_dag resolves."""

    from snakemake.persistence.file import FilePersistence
    import snakemake.workflow as engine_workflow_module
    from snakemake.settings.types import PersistenceBackend, WorkflowSettings

    assert engine_workflow_module.FilePersistence is FilePersistence
    # The TDEaseEnginePersistence replacement forwards `path=engine_root`.
    assert "path" in inspect.signature(FilePersistence.__init__).parameters
    # The seam only fires because upstream defaults to the file backend.
    assert (
        WorkflowSettings.__dataclass_fields__["persistence_backend"].default
        is PersistenceBackend.FILE
    )


def test_single_build_surface_in_workflow_execute() -> None:
    """The one-build mechanism: engine_runner builds via the private
    _prepare_dag/_build_dag, then pins both per-instance because
    Workflow.execute() rebuilds unconditionally."""

    from snakemake.api import SnakemakeApi  # settle upstream circular imports
    from snakemake.workflow import Workflow  # noqa: F401

    for member in ("_prepare_dag", "_build_dag", "unlock"):
        assert hasattr(Workflow, member), (
            f"Workflow.{member} disappeared: fix src/execution_runtime/engine_runner.py"
        )
    execute_source = inspect.getsource(Workflow.execute)
    assert "_prepare_dag" in execute_source and "_build_dag" in execute_source, (
        "Workflow.execute no longer rebuilds the DAG: the no-op pinning in "
        "src/execution_runtime/engine_runner.py is dead -- delete it"
    )


def test_job_level_dag_members_behind_the_projection() -> None:
    """The projection and the execution record read per-job truth off the DAG
    object (the public RULEGRAPH is rule-level and cannot replace this)."""

    from snakemake.api import SnakemakeApi  # settle upstream circular imports
    from snakemake.dag import DAG

    for member in ("jobs", "needrun", "finished", "jobid", "dependencies"):
        assert hasattr(DAG, member), (
            f"DAG.{member} disappeared: fix src/execution_runtime/engine_runner.py"
        )


def test_job_event_log_event_names() -> None:
    from snakemake_interface_logger_plugins.common import LogEvent

    names = {event.name for event in LogEvent}
    for name in ("JOB_INFO", "JOB_FINISHED", "JOB_ERROR"):
        assert name in names, (
            f"LogEvent.{name} disappeared: fix the mapping in "
            "src/execution_runtime/engine_runner.py (_JobEventHandler)"
        )


def test_build_arguments_mirrored_from_execution_settings() -> None:
    """The single DAG build mirrors Workflow.execute()'s own arguments off the
    ExecutionSettings instance it will execute with."""

    from snakemake.settings.types import DAGSettings, ExecutionSettings

    for field in ("retries", "lock", "ignore_incomplete", "shadow_prefix"):
        assert field in ExecutionSettings.__dataclass_fields__, (
            f"ExecutionSettings.{field} disappeared: the single build in "
            "src/execution_runtime/engine_runner.py mirrors it"
        )
    for field in ("targets", "forceall", "force_incomplete"):
        assert field in DAGSettings.__dataclass_fields__, (
            f"DAGSettings.{field} disappeared: fix src/execution_runtime/engine_runner.py"
        )


def test_snakemake_alias_is_still_upstream_hardcoded() -> None:
    """The `.snakemake` junction alias exists because upstream writes that
    literal name relative to cwd in several modules with no redirect knob."""

    import snakemake.persistence as engine_persistence
    import snakemake.shell as engine_shell_name

    assert ".snakemake" in inspect.getsource(engine_persistence)
    assert ".snakemake" in inspect.getsource(engine_shell_name)
    # `snakemake.shell` resolves to the shell CLASS (package attribute shadows
    # the submodule): a module-constant patch must go through sys.modules, or
    # it silently lands on the class like the deleted MAX_ARG_LEN patch did.
    assert inspect.isclass(engine_shell_name)


def test_dead_arg_len_patch_stays_deleted() -> None:
    """engine_shell.MAX_ARG_LEN = ... was a no-op (it hit the shell class while
    upstream reads the shell.py module global 65535) and must not return."""

    assert "MAX_ARG_LEN" not in _engine_runner_source()


SNAKEFILE = """
rule all:
    input:
        "results/done.txt"

rule produce:
    output:
        "results/done.txt"
    run:
        from pathlib import Path
        Path(output[0]).parent.mkdir(parents=True, exist_ok=True)
        Path(output[0]).write_text("ok", encoding="utf-8")
""".strip() + "\n"


def test_engine_runner_builds_the_dag_exactly_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """构图只发生一次: the projection, the resource assertion, and the executor
    consume one DAG. Workflow.execute() would rebuild it; engine_runner pins
    that rebuild per-instance -- this counts the real builds."""

    from snakemake.api import SnakemakeApi  # settle upstream circular imports
    from snakemake.workflow import Workflow

    (tmp_path / "Snakefile").write_text(SNAKEFILE, encoding="utf-8")
    request_dir = tmp_path / ".tdease"
    request_dir.mkdir()
    (request_dir / "engine-request.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "mode": "execute",
                "snakefile": "Snakefile",
                "config": {},
                "cores": 1,
                "targets": [],
                "rerun_incomplete": True,
                "retries": 0,
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    builds = []
    original_build = Workflow._build_dag

    def counting_build(self):
        builds.append(self)
        return original_build(self)

    monkeypatch.setattr(Workflow, "_build_dag", counting_build)

    from src.execution_runtime.engine_runner import main

    assert main() == 0
    assert len(builds) == 1, (
        "the engine built the DAG more than once: the single-build pinning in "
        "src/execution_runtime/engine_runner.py broke"
    )
    assert (tmp_path / "results" / "done.txt").read_text(encoding="utf-8") == "ok"
