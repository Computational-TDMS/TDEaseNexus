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
    backed by a queued revision before the engine will touch it.

    The real path is API -> `run.submitted` + `run.queue_requested` -> worker
    -> `execute()` (see `services/run_worker.execute_run`). The adapter's
    journal-range guard rejects anything lacking a queued revision, so every
    test that drives `execute()` directly must queue first. Centralising this
    keeps the contract visible instead of scattering submit/queue pairs.
    """

    def _queue(
        run_id: str,
        revision_id: str = "def-test",
        mode: str = "execute",
    ) -> int:
        emitter = EventEmitter(run_id)
        if not emitter.last_seq:
            emitter.run_submitted(revision_id)
        return emitter.run_queue_requested(revision_id, mode, rerun_mode="resume")

    return _queue


def _default_ms_bin() -> str | None:
    """Locate the tdeasenexus-toolbox native binary for skill scripts that shell out to
    the Rust isotopic/envelope kernel (release preferred, then debug).

    The Rust workspace lives under the toolkit submodule
    (`tdease-ai-capability/rust/`); an explicit `TDEASENEXUS_TOOLBOX_BIN` always
    wins (the runtime convention)."""
    mass_spec = Path(__file__).resolve().parents[1] / "tdease-ai-capability" / "rust" / "target"
    # debug first: the development build is the one with the newest commands
    # (release may lag behind until a release build is cut).
    for profile in ("debug", "release"):
        for name in ("tdeasenexus-toolbox.exe", "tdeasenexus-toolbox"):
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
