from __future__ import annotations

from unittest.mock import Mock, patch

import pytest

from app.api.capabilities import _CAPABILITIES
from app.api.runs_v2 import _reject_removed_commit_fields, _schedule_commit
from src.contracts.errors import TDEaseError
from src.contracts.run import RunCommit
from src.execution_runtime.execution import _isolate_engine_process
from src.execution_runtime.resource_budget import RESOURCE_BUDGET, resolve_resource_budget
from src.backend_settings import BACKEND_SETTINGS, RUNTIME_INVENTORY


def test_default_budget_reserves_service_cpu_and_memory() -> None:
    budget = resolve_resource_budget(32, "", 32768, "")
    assert budget.reserved_service_cpus == 4
    assert budget.compute_cpus == 28
    assert budget.compute_cpu_ids == tuple(range(28))
    assert budget.reserved_service_memory_mb == 10240
    assert budget.compute_memory_mb == 22528
    assert budget.max_concurrent_runs == 1


def test_default_memory_reservation_keeps_a_minimum_compute_working_set() -> None:
    budget = resolve_resource_budget(8, "", 8192, "")
    assert budget.reserved_service_cpus == 4
    assert budget.compute_cpus == 4
    assert budget.reserved_service_memory_mb == 4096
    assert budget.compute_memory_mb == 4096


def test_reserved_cpu_override_is_applied() -> None:
    budget = resolve_resource_budget(32, "6", 32768, "8192")
    assert budget.reserved_service_cpus == 6
    assert budget.compute_cpus == 26
    assert budget.reserved_service_memory_mb == 8192
    assert budget.compute_memory_mb == 24576


def test_capabilities_and_scheduling_share_the_frozen_budget() -> None:
    assert _CAPABILITIES.limits.max_cores == RESOURCE_BUDGET.compute_cpus
    assert _CAPABILITIES.limits.max_memory_mb == RESOURCE_BUDGET.compute_memory_mb
    assert _CAPABILITIES.limits.max_concurrent_runs == 1
    commit = _schedule_commit(
        RunCommit(run_id="r", idempotency_key="k", workspace_id="w", user_id="caller",
                  workspace_tree_hash="0" * 64, snakefile=""),
        "user",
    )
    assert commit.cores == RESOURCE_BUDGET.compute_cpus
    assert commit.memory_mb == RESOURCE_BUDGET.compute_memory_mb


def _request_with_commit(commit: dict) -> Mock:
    request = Mock()

    async def _json():
        return {"commit": commit}

    request.json = _json
    return request


@pytest.mark.asyncio
async def test_caller_declared_compute_fields_are_rejected_by_name() -> None:
    for field in ("cores", "memory_mb"):
        with pytest.raises(TDEaseError, match=field):
            await _reject_removed_commit_fields(_request_with_commit({field: 4}))
    # Absent fields pass through untouched.
    await _reject_removed_commit_fields(_request_with_commit({"snakefile": ""}))


def test_frozen_budget_uses_the_shared_startup_snapshot() -> None:
    expected = resolve_resource_budget(
        RUNTIME_INVENTORY.logical_cpus,
        BACKEND_SETTINGS.reserved_logical_cpus,
        RUNTIME_INVENTORY.total_memory_mb,
        BACKEND_SETTINGS.reserved_memory_mb,
    )
    assert RESOURCE_BUDGET == expected


def test_engine_process_gets_compute_affinity_and_lower_priority() -> None:
    process = Mock()
    fake_psutil = Mock()
    fake_psutil.Process.return_value = process
    fake_psutil.BELOW_NORMAL_PRIORITY_CLASS = 16384
    with patch.dict("sys.modules", {"psutil": fake_psutil}), patch(
        "src.execution_runtime.execution.os.name", "nt"
    ):
        _isolate_engine_process("run-a", "engine", 123)

    fake_psutil.Process.assert_called_once_with(123)
    process.cpu_affinity.assert_called_once_with(list(RESOURCE_BUDGET.compute_cpu_ids))
    process.nice.assert_called_once_with(16384)
