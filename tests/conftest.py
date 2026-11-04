"""Root pytest configuration for tests/.

The engine suite lives here but runs against the backend project's
environment: `uv run --project tdease-backend pytest tests/` (see CI).
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

import pytest

from src.execution_runtime.events import EventEmitter


RELEASE_GATE_ENV = "TDEASE_RELEASE_GATE"


@pytest.fixture()
def queue_run() -> Callable[..., int]:
    """Establish the journal precondition `execute()` enforces: a Run must be
    started under an open execution range before the engine will touch it.

    The real path is API -> `run.submitted` + `run.queue_requested` -> worker
    -> `begin_execution()` (run.started + execution lease) -> `execute()` (see
    `services/run_worker.execute_run`). The adapter's journal-range guard
    rejects anything lacking an open range, so every test that drives
    `execute()` directly must go through the same two steps. Centralising
    this keeps the contract visible instead of scattering submit/queue/start
    pairs.
    """

    def _queue(
        run_id: str,
        revision_id: str = "def-test",
        mode: str = "execute",
    ) -> int:
        emitter = EventEmitter(run_id)
        if not emitter.last_seq:
            emitter.run_submitted(revision_id)
        queue_seq = emitter.run_queue_requested(revision_id, mode, rerun_mode="resume")
        from src.services.run_commands import get_run_commands

        lease = get_run_commands().begin_execution(run_id)
        assert lease is not None, "begin_execution must start the queued revision"
        return queue_seq

    return _queue


def _default_ms_bin() -> str | None:
    """Locate the tdeasenexus-toolbox native binary for skill scripts that shell out to
    the Rust isotopic/envelope kernel (release preferred, then debug).

    The Rust workspace lives under the toolkit submodule
    (`tdease-ai-capability/rust/`); an explicit `TDEASENEXUS_TOOLBOX_BIN` always
    wins (the runtime convention)."""
    mass_spec = Path(__file__).resolve().parents[1] / "tdease-ai-capability" / "rust" / "target"
    names = (
        ("tdeasenexus-toolbox.exe", "tdeasenexus-toolbox")
        if os.name == "nt"
        else ("tdeasenexus-toolbox", "tdeasenexus-toolbox.exe")
    )
    # debug first: the development build is the one with the newest commands
    # (release may lag behind until a release build is cut).
    for profile in ("debug", "release"):
        for name in names:
            candidate = mass_spec / profile / name
            if candidate.exists():
                return str(candidate)
    return None


@pytest.fixture(autouse=True)
def _tdease_ms_bin_env():
    """Ensure skill scripts can reach the `tdeasenexus-toolbox` kernel two ways.

    Tests that pass an explicit binary read ``TDEASENEXUS_TOOLBOX_BIN`` and forward it
    as ``--ms-bin``; skill scripts resolving on their own use PATH (the
    runtime convention since native.py dropped env/checkout fallbacks), so
    the binary's directory is prepended to PATH as well. Fallback order for
    locating a build: the repo's debug then release target."""
    saved = {
        "TDEASENEXUS_TOOLBOX_BIN": os.environ.get("TDEASENEXUS_TOOLBOX_BIN"),
        "PATH": os.environ.get("PATH"),
    }
    if not os.environ.get("TDEASENEXUS_TOOLBOX_BIN"):
        found = _default_ms_bin()
        if found:
            os.environ["TDEASENEXUS_TOOLBOX_BIN"] = found
    explicit = os.environ.get("TDEASENEXUS_TOOLBOX_BIN")
    if explicit and os.path.isfile(explicit):
        bin_dir = os.path.dirname(explicit)
        if bin_dir and bin_dir not in os.environ.get("PATH", "").split(os.pathsep):
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
    yield
    # Restore: a leaked PATH prepend contaminates every later test and the
    # developer's own shell assumptions about the environment.
    for key, value in saved.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """A release machine is incomplete if any collected test has to skip."""
    outcome = yield
    report = outcome.get_result()
    if os.environ.get(RELEASE_GATE_ENV) == "1" and report.skipped:
        report.outcome = "failed"
        report.longrepr = (
            str(item.fspath),
            item.location[1] + 1,
            f"release gate forbids skipped tests: {report.longrepr}",
        )
