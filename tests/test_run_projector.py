"""
Tests for the pure Run projection rule table (CORE-ARCHITECTURE.md §1.2-§1.3).

Every case under tests/fixtures/run-projection/ is loaded and asserted here.
The corpus is the shared contract with the TypeScript projector (§1.5): a
case added here is a case the Client test suite must also satisfy. Fixtures
are plain JSON, one directory per case, so both languages can load them
without any Python-specific encoding.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.execution_runtime.run_projector import ExecutionRange, RunProjection, project_run

FIXTURES_ROOT = Path(__file__).parent / "fixtures" / "run-projection"


def _load_cases() -> list[tuple[str, dict]]:
    cases = []
    for case_dir in sorted(p for p in FIXTURES_ROOT.iterdir() if p.is_dir()):
        case_file = case_dir / "case.json"
        assert case_file.exists(), f"missing case.json in {case_dir}"
        cases.append((case_dir.name, json.loads(case_file.read_text(encoding="utf-8"))))
    return cases


CASES = _load_cases()


def test_fixture_corpus_is_not_empty() -> None:
    assert len(CASES) >= 8


@pytest.mark.parametrize("name,case", CASES, ids=[name for name, _ in CASES])
def test_fixture_case_matches_projection(name: str, case: dict) -> None:
    projection = project_run(case["events"])
    assert projection.to_dict() == case["expect"], (
        f"case {name!r}: {projection.to_dict()} != {case['expect']}"
    )


def test_no_events_is_not_a_run() -> None:
    projection = project_run([])
    assert projection.status is None
    assert projection.ranges == ()
    assert projection.projected_at_seq == 0


def test_continue_after_failure_opens_a_second_range() -> None:
    events = [
        {"seq": 1, "type": "run.submitted", "data": {"revision_id": "rev-1"}},
        {"seq": 2, "type": "run.queue_requested", "data": {"revision_id": "rev-1", "mode": "execute"}},
        {"seq": 3, "type": "run.started", "data": {"revision_id": "rev-1", "mode": "execute"}},
        {"seq": 9, "type": "run.failed", "data": {"revision_id": "rev-1"}},
        {"seq": 10, "type": "run.queue_requested", "data": {"revision_id": "rev-1", "mode": "continue"}},
        {"seq": 11, "type": "run.started", "data": {"revision_id": "rev-1", "mode": "continue"}},
        {"seq": 31, "type": "run.succeeded", "data": {"revision_id": "rev-1"}},
    ]
    projection = project_run(events)
    assert projection.status == "SUCCEEDED"
    assert len(projection.ranges) == 2
    assert projection.ranges[0] == ExecutionRange(3, 2, "rev-1", "execute", 9, "run.failed")
    assert projection.ranges[1] == ExecutionRange(11, 10, "rev-1", "continue", 31, "run.succeeded")


def test_late_job_event_after_cancellation_does_not_resurrect_the_run() -> None:
    events = [
        {"seq": 1, "type": "run.submitted", "data": {"revision_id": "rev-1"}},
        {"seq": 2, "type": "run.queue_requested", "data": {"revision_id": "rev-1", "mode": "execute"}},
        {"seq": 3, "type": "run.started", "data": {"revision_id": "rev-1", "mode": "execute"}},
        {"seq": 4, "type": "run.cancelled", "data": {"revision_id": "rev-1"}},
        {"seq": 5, "type": "task.failed"},
    ]
    projection = project_run(events)
    assert projection.status == "CANCELLED"
    assert projection.projected_at_seq == 5


def test_queue_request_after_terminal_requeues_without_run_metadata() -> None:
    events = [
        {"seq": 1, "type": "run.submitted", "data": {"revision_id": "rev-1"}},
        {"seq": 2, "type": "run.queue_requested", "data": {"revision_id": "rev-1", "mode": "execute"}},
        {"seq": 3, "type": "run.started", "data": {"revision_id": "rev-1", "mode": "execute"}},
        {"seq": 4, "type": "run.failed", "data": {"revision_id": "rev-1"}},
        {"seq": 5, "type": "run.queue_requested", "data": {"revision_id": "rev-1", "mode": "continue"}},
    ]
    projection = project_run(events)
    assert projection.status == "QUEUED"
    assert projection.queued_mode == "continue"


def test_at_most_one_open_range_is_reported_open() -> None:
    events = [
        {"seq": 1, "type": "run.submitted", "data": {"revision_id": "rev-1"}},
        {"seq": 2, "type": "run.queue_requested", "data": {"revision_id": "rev-1", "mode": "execute"}},
        {"seq": 3, "type": "run.started", "data": {"revision_id": "rev-1", "mode": "execute"}},
    ]
    projection = project_run(events)
    assert len(projection.ranges) == 1
    assert projection.ranges[0].is_open


def test_started_must_match_a_queue_request() -> None:
    with pytest.raises(ValueError, match="run.started is invalid from status None"):
        project_run([{"seq": 1, "type": "run.started", "data": {"revision_id": "rev-1", "mode": "execute"}}])


def test_lifecycle_events_require_revision_identity() -> None:
    with pytest.raises(ValueError, match="revision_id"):
        project_run([{"seq": 1, "type": "run.queue_requested", "data": {"mode": "execute"}}])


def test_second_terminal_event_cannot_rewrite_history() -> None:
    events = [
        {"seq": 1, "type": "run.submitted", "data": {"revision_id": "rev-1"}},
        {"seq": 2, "type": "run.queue_requested", "data": {"revision_id": "rev-1", "mode": "execute"}},
        {"seq": 3, "type": "run.failed", "data": {"revision_id": "rev-1"}},
        {"seq": 4, "type": "run.succeeded", "data": {"revision_id": "rev-1"}},
    ]
    with pytest.raises(ValueError, match="invalid from status FAILED"):
        project_run(events)


def test_legacy_run_started_without_revision_or_mode_is_backfilled() -> None:
    """Journals written before revision_id/mode became required on run.started
    must still project at Backend startup (reconcile_orphaned_runs replays every
    Run journal in the lifespan). The fields are reconstructable from the
    preceding run.submitted / run.queue_requested, so the fold backfills them
    rather than crashing. Locks the backward-compat fix for the startup crash
    seen on 2026-07-28 (chlamy-h4-live-20260727)."""
    events = [
        {"seq": 1, "type": "run.submitted", "data": {"revision_id": "rev-1"}},
        {"seq": 2, "type": "run.queue_requested", "data": {"revision_id": "rev-1", "mode": "execute"}},
        # Legacy run.started: pid/worker_id present, revision_id/mode absent.
        {"seq": 3, "type": "run.started", "data": {"pid": 15080, "worker_id": "HOST"}},
        {"seq": 4, "type": "run.succeeded", "data": {"revision_id": "rev-1"}},
    ]
    projection = project_run(events)
    assert projection.status == "SUCCEEDED"
    assert len(projection.ranges) == 1
    assert projection.ranges[0].revision_id == "rev-1"
    assert projection.ranges[0].mode == "execute"


def test_legacy_run_started_backfilled_from_continue_queue_mode() -> None:
    """A legacy run.started under a continue/resume queue must inherit the
    queued mode, not default to execute — the execution range's mode drives
    Continue semantics and a wrong default would misroute a resume."""
    events = [
        {"seq": 1, "type": "run.submitted", "data": {"revision_id": "rev-1"}},
        {"seq": 2, "type": "run.queue_requested", "data": {"revision_id": "rev-1", "mode": "continue"}},
        {"seq": 3, "type": "run.started", "data": {"pid": 1, "worker_id": "HOST"}},
        {"seq": 4, "type": "run.succeeded", "data": {"revision_id": "rev-1"}},
    ]
    projection = project_run(events)
    assert projection.ranges[0].mode == "continue"


def test_run_queue_requested_without_revision_and_no_prior_submit_still_errors() -> None:
    """A run.queue_requested with no revision_id and no preceding run.submitted
    cannot be reconstructed — the identity is genuinely unknowable. This stays a
    hard error (preserves the contract) even though legacy run.started is now
    tolerated; only reconstructable legacy gaps are backfilled."""
    with pytest.raises(ValueError, match="revision_id"):
        project_run([{"seq": 1, "type": "run.queue_requested", "data": {"mode": "execute"}}])


def test_schema_v1_run_queued_journal_projects_through_terminal_event() -> None:
    events = [
        {"schema_version": 1, "seq": 1, "type": "run.queued", "data": {}},
        {"schema_version": 1, "seq": 2, "type": "run.started", "data": {"pid": 42}},
        {"schema_version": 1, "seq": 3, "type": "run.failed", "data": {"exit_code": 1}},
    ]

    projection = project_run(events)

    assert projection.status == "FAILED"
    assert projection.current_revision_id == "legacy-schema-v1"
    assert projection.ranges[0].mode == "execute"


def test_schema_v1_resume_queue_projects_as_continue() -> None:
    events = [
        {
            "schema_version": 1,
            "seq": 1,
            "type": "run.queued",
            "data": {"rerun": True, "rerun_mode": "resume"},
        },
        {"schema_version": 1, "seq": 2, "type": "run.started", "data": {}},
    ]

    projection = project_run(events)

    assert projection.status == "RUNNING"
    assert projection.ranges[0].mode == "continue"
