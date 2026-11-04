"""
Tests for `app/core/errors.py` against `docs/spec/FAILURE-CONTRACT.md`.

These tests exercise the module in isolation. They do not import `app.main` or
any `app.api` route, and they do not call `register_error_handlers` against a
real app beyond a bare `FastAPI()` instance built inline for the handler test —
wiring the handler into the real app is a separate change owned by another
agent, per the Track A assignment.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from src.contracts.errors import (
    CODE_DOMAIN,
    CODE_HTTP_STATUS,
    DOMAIN_HTTP_STATUS,
    http_status_for,
    ErrorCode,
    ErrorDomain,
    TDEaseError,
    redact,
)
from app.errors import register_error_handlers, tdease_error_handler


# ---------------------------------------------------------------------------
# Closed enumeration integrity
# ---------------------------------------------------------------------------


def test_every_error_code_has_a_domain() -> None:
    """CODE_DOMAIN must be exhaustive over ErrorCode (FAILURE-CONTRACT.md §1.1)."""

    for code in ErrorCode:
        assert code in CODE_DOMAIN, f"{code} has no domain mapping"


def test_every_domain_has_an_http_status() -> None:
    for domain in ErrorDomain:
        assert domain in DOMAIN_HTTP_STATUS, f"{domain} has no http_status mapping"


def test_domains_are_the_closed_six() -> None:
    assert {d.value for d in ErrorDomain} == {
        "workspace",
        "run",
        "engine",
        "agent",
        "backend",
        "environment",
    }


# ---------------------------------------------------------------------------
# Envelope round-trip, every code
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("code", list(ErrorCode))
def test_every_code_round_trips_through_the_envelope(code: ErrorCode) -> None:
    err = TDEaseError(
        code=code,
        message="a message",
        remedy="a remedy",
        retryable=False,
        details={"k": "v"},
        cause={"run_id": "run_x", "event_seq": 1},
    )

    envelope = err.to_envelope()

    assert set(envelope.keys()) == {"error"}
    body = envelope["error"]
    assert body["code"] == code.value
    assert body["domain"] == CODE_DOMAIN[code].value
    assert body["message"] == "a message"
    assert body["remedy"] == "a remedy"
    assert body["retryable"] is False
    assert body["details"] == {"k": "v"}
    assert body["cause"] == {"run_id": "run_x", "event_seq": 1}

    # http_status is derived from code, never a field of the envelope itself.
    assert "http_status" not in body
    assert err.http_status == http_status_for(code)


def test_details_and_cause_are_absent_not_null_when_not_supplied() -> None:
    err = TDEaseError(
        code=ErrorCode.RUN_NOT_FOUND,
        message="Run not found",
        remedy="Check the run id and retry.",
        retryable=False,
    )

    body = err.to_envelope()["error"]

    assert "details" not in body
    assert "cause" not in body


# ---------------------------------------------------------------------------
# retryable is a real, caller-supplied boolean — never inferred from status
# ---------------------------------------------------------------------------


def test_retryable_is_an_explicit_boolean_not_inferred_from_status() -> None:
    # Two errors sharing an http_status-yielding domain can still disagree on
    # retryable: nothing about the envelope derives retryable from http_status
    # or from domain. This is the discriminating case FAILURE-CONTRACT.md §1.1
    # calls out explicitly.
    not_retryable = TDEaseError(
        code=ErrorCode.ENGINE_TASK_FAILED,
        message="task failed",
        remedy="Inspect the failed task's log.",
        retryable=False,
    )
    retryable = TDEaseError(
        code=ErrorCode.ENGINE_RESOURCE_EXHAUSTED,
        message="resource exhausted",
        remedy="Free resources or lower requested cores, then resubmit.",
        retryable=True,
    )

    # Both share the same domain (and therefore the same http_status)...
    assert not_retryable.domain == retryable.domain == ErrorDomain.ENGINE
    assert not_retryable.http_status == retryable.http_status

    # ...yet retryable differs, proving it is not derived from either.
    assert not_retryable.retryable is False
    assert retryable.retryable is True
    assert isinstance(not_retryable.retryable, bool)
    assert isinstance(retryable.retryable, bool)


def test_retryable_coerces_truthy_input_to_a_real_bool() -> None:
    err = TDEaseError(
        code=ErrorCode.RUN_NOT_FOUND,
        message="m",
        remedy="r",
        retryable=1,  # type: ignore[arg-type]
    )
    assert err.retryable is True
    assert type(err.retryable) is bool


# ---------------------------------------------------------------------------
# domain and http_status are derived from code, not chosen per raise site
# ---------------------------------------------------------------------------


def test_domain_is_derived_from_code_and_not_a_constructor_argument() -> None:
    err = TDEaseError(
        code=ErrorCode.WORKSPACE_PATH_ESCAPE,
        message="escape",
        remedy="stay inside the workspace",
        retryable=False,
    )
    assert err.domain == ErrorDomain.WORKSPACE
    # Not the workspace default of 400: a containment rejection is not a request
    # the caller can correct by editing a field. See CODE_HTTP_STATUS.
    assert err.http_status == 403


def test_engine_domain_maps_to_a_200_family_status_never_a_5xx() -> None:
    """
    FAILURE-CONTRACT.md §6: a workflow failure is a successful observation of a
    Run, never a product error. An engine-domain TDEaseError must therefore
    resolve to a 2xx, not a 5xx, even in the degenerate case where it reaches
    the HTTP boundary directly.
    """

    for code in ErrorCode:
        if CODE_DOMAIN[code] is ErrorDomain.ENGINE:
            err = TDEaseError(
                code=code,
                message="engine observation",
                remedy="diagnose from job events",
                retryable=False,
            )
            assert 200 <= err.http_status < 300
            assert not (500 <= err.http_status < 600)


def test_http_status_is_the_code_table_then_the_domain_default() -> None:
    """The invariant is that a *raise site* cannot choose a status -- not that the
    table is keyed by domain. `http_status_for` is the only resolver; every code
    either appears in the closed override table or takes its domain's default, and
    nothing else can influence the result."""

    for code in ErrorCode:
        expected = CODE_HTTP_STATUS.get(code, DOMAIN_HTTP_STATUS[CODE_DOMAIN[code]])
        assert http_status_for(code) == expected

        err = TDEaseError(code=code, message="m", remedy="r", retryable=False)
        assert err.http_status == expected, f"{code} resolved outside the tables"


def test_no_override_moves_a_code_into_an_incompatible_class() -> None:
    """An override may sharpen a status inside its domain's meaning; it may never
    turn a failure into a success or an internal fault. Engine codes stay 2xx (§6)
    and nothing else may become 2xx by way of the override table."""

    for code, status in CODE_HTTP_STATUS.items():
        assert not (200 <= status < 300), f"{code} override makes a failure a success"
        assert not (500 <= status < 600), f"{code} override claims an internal fault"
    for code in ErrorCode:
        if CODE_DOMAIN[code] is ErrorDomain.ENGINE:
            assert code not in CODE_HTTP_STATUS, f"{code} must keep the §6 2xx status"


def test_non_engine_domains_never_map_to_2xx() -> None:
    for domain, status in DOMAIN_HTTP_STATUS.items():
        if domain is not ErrorDomain.ENGINE:
            assert not (200 <= status < 300), f"{domain} incorrectly resolves to a 2xx"


# ---------------------------------------------------------------------------
# Redaction happens at construction
# ---------------------------------------------------------------------------


def test_redact_removes_a_secret_by_key_name() -> None:
    details = {"api_token": "abc123", "note": "fine"}
    result = redact(details)
    assert result is not None
    assert result["api_token"] == "[redacted]"
    assert result["note"] == "fine"


@pytest.mark.parametrize(
    "key",
    ["token", "secret", "api_key", "password", "Authorization", "SECRET_TOKEN"],
)
def test_redact_matches_every_documented_secret_key_pattern(key: str) -> None:
    result = redact({key: "sensitive-value"})
    assert result is not None
    assert result[key] == "[redacted]"


def test_redact_removes_an_absolute_path_outside_the_workspace() -> None:
    details = {"path": "C:\\Users\\ray\\Desktop\\secret.txt"}
    result = redact(details)
    assert result is not None
    assert result["path"] == "[redacted-path]"


def test_redact_keeps_a_path_inside_the_declared_workspace_root() -> None:
    details = {"path": "C:/Workspace/raw/sample.mzML"}
    result = redact(details, workspace_root="C:/Workspace")
    assert result is not None
    assert result["path"] == "C:/Workspace/raw/sample.mzML"


def test_redact_recurses_into_nested_dicts_and_lists() -> None:
    details = {
        "outer": {"auth_secret": "xyz", "safe": "ok"},
        "items": [{"password": "hunter2"}, "plain-string"],
    }
    result = redact(details)
    assert result is not None
    assert result["outer"]["auth_secret"] == "[redacted]"
    assert result["outer"]["safe"] == "ok"
    assert result["items"][0]["password"] == "[redacted]"
    assert result["items"][1] == "plain-string"


def test_redact_of_none_is_none() -> None:
    assert redact(None) is None


def test_tdease_error_constructor_redacts_details_before_anything_reads_them() -> None:
    err = TDEaseError(
        code=ErrorCode.BACKEND_INTERNAL,
        message="m",
        remedy="r",
        retryable=False,
        details={"secret_key": "leak-me", "path": "/etc/passwd"},
    )

    # The raw, un-redacted value was never retained anywhere on the instance.
    assert err.details == {"secret_key": "[redacted]", "path": "[redacted-path]"}
    assert "leak-me" not in str(err.to_envelope())
    assert "/etc/passwd" not in str(err.to_envelope())


# ---------------------------------------------------------------------------
# Product errors are not execution outcomes (§6) — encoded via the handler
# ---------------------------------------------------------------------------


def test_engine_error_through_the_handler_is_a_200_family_response_shape() -> None:
    err = TDEaseError(
        code=ErrorCode.ENGINE_TASK_FAILED,
        message="Task failed (exit 1).",
        remedy="Diagnose from job events; resubmit is not a fix by itself.",
        retryable=False,
        cause={"run_id": "run_x", "event_seq": 12},
    )

    response = asyncio.run(tdease_error_handler(request=None, exc=err))  # type: ignore[arg-type]

    assert isinstance(response, JSONResponse)
    assert 200 <= response.status_code < 300
    assert not (500 <= response.status_code < 600)


def test_workspace_error_through_the_handler_is_never_2xx() -> None:
    err = TDEaseError(
        code=ErrorCode.WORKSPACE_PATH_ESCAPE,
        message="The submitted path resolves outside the approved Workspace root.",
        remedy="Choose a file inside the opened Workspace.",
        retryable=False,
        details={"path": "../../etc/passwd"},
    )

    response = asyncio.run(tdease_error_handler(request=None, exc=err))  # type: ignore[arg-type]

    assert not (200 <= response.status_code < 300)


def test_register_error_handlers_wires_tdease_error_without_raising() -> None:
    app = FastAPI()
    register_error_handlers(app)
    assert TDEaseError in app.exception_handlers


# ---------------------------------------------------------------------------
# str() carries the code, for anyone who does log it as evidence (§7)
# ---------------------------------------------------------------------------


def test_str_carries_the_code_for_log_evidence() -> None:
    err = TDEaseError(
        code=ErrorCode.RUN_PLAN_STALE,
        message="the plan changed",
        remedy="re-run dry-run",
        retryable=False,
    )
    assert err.code.value in str(err)


# ---------------------------------------------------------------------------
# On the wire: a failing response body IS the envelope, not a second shape
# ---------------------------------------------------------------------------

_REQUIRED_KEYS = {"code", "domain", "message", "remedy", "retryable"}
_OPTIONAL_KEYS = {"details", "cause"}


def assert_is_envelope(body: object, where: str) -> None:
    """The whole point of M1: one shape, checked structurally rather than by
    spot-checking a couple of fields. Before this, four incompatible shapes were
    live at once -- `{"detail": {"error": ...}}`, `{"detail": "<string>"}`,
    `{"error": "<string>"}` and FastAPI's own `{"detail": [...]}` -- and every one
    of them passed a test that only asserted a status code."""

    assert isinstance(body, dict), f"{where}: body is not an object: {body!r}"
    assert set(body) == {"error"}, f"{where}: body is not the envelope: {body!r}"
    error = body["error"]
    assert isinstance(error, dict), f"{where}: error is not an object: {error!r}"
    assert _REQUIRED_KEYS <= set(error), f"{where}: missing {_REQUIRED_KEYS - set(error)}"
    assert set(error) <= _REQUIRED_KEYS | _OPTIONAL_KEYS, (
        f"{where}: unexpected keys {set(error) - _REQUIRED_KEYS - _OPTIONAL_KEYS}"
    )
    code = ErrorCode(error["code"])  # raises if the code left the closed enum
    assert error["domain"] == CODE_DOMAIN[code].value, f"{where}: domain disagrees with code"
    assert isinstance(error["retryable"], bool), f"{where}: retryable is not a boolean"
    assert error["message"], f"{where}: empty message"
    assert error["remedy"], f"{where}: empty remedy -- a failure with no next step"


def _runs_client(user_id: str = "local-owner"):
    from types import SimpleNamespace

    from fastapi import FastAPI, Request
    from fastapi.testclient import TestClient

    from app.api.runs_v2 import router
    from app.errors import register_error_handlers

    app = FastAPI()

    @app.middleware("http")
    async def principal(request: Request, call_next):
        request.state.principal = SimpleNamespace(user_id=user_id)
        return await call_next(request)

    app.include_router(router)
    register_error_handlers(app)
    return TestClient(app)


def test_every_failing_run_route_answers_with_the_envelope(tmp_path) -> None:
    from src.execution_runtime import set_storage
    from src.execution_runtime.storage import StorageLayout

    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)

    # Application failures only. A 405 for a method the router never declared, or
    # Starlette's own 404 for an unrouted path, are framework responses raised
    # before any TDEase code runs -- they are outside this contract by construction,
    # not an exemption granted to a route.
    probes = [
        ("GET", "/api/v2/runs/no-such-run", None),
        ("GET", "/api/v2/runs/no-such-run/files", None),
        ("GET", "/api/v2/runs/no-such-run/files/results/out.txt", None),
        ("GET", "/api/v2/runs/no-such-run/log", None),
        ("GET", "/api/v2/runs/no-such-run/files?pattern=../elsewhere/**", None),
        ("POST", "/api/v2/runs/no-such-run/rerun", {"mode": "overwrite"}),
        ("POST", "/api/v2/runs/no-such-run/cancel", None),
        ("POST", "/api/v2/runs/no-such-run/trash", None),
        ("POST", "/api/v2/runs/trash/no-such-run/restore", None),
    ]

    with _runs_client() as client:
        for method, path, payload in probes:
            response = client.request(method, path, json=payload)
            assert response.status_code >= 400, f"{method} {path} unexpectedly succeeded"
            assert_is_envelope(response.json(), f"{method} {path}")


def test_the_remaining_routers_answer_with_the_envelope(tmp_path) -> None:
    """`nodes`, `templates` and `uploads` were the last three routers still raising
    a bare `HTTPException(404, "node not found")`. Nothing caught them because the
    envelope tests only covered the Run surface — so the M1 gate ("every error
    response validates against the single envelope schema") read as met while three
    routers spoke a different shape."""

    from types import SimpleNamespace

    from fastapi import FastAPI, Request
    from fastapi.testclient import TestClient

    from src.execution_runtime import set_storage
    from src.execution_runtime.storage import StorageLayout

    from app.api.nodes import router as nodes_router
    from app.api.uploads import router as uploads_router
    from app.errors import register_error_handlers

    storage = StorageLayout(tmp_path / "backend")
    storage.bootstrap()
    set_storage(storage)

    app = FastAPI()

    @app.middleware("http")
    async def principal(request: Request, call_next):
        request.state.principal = SimpleNamespace(user_id="local-owner")
        return await call_next(request)

    for router in (nodes_router, uploads_router):
        app.include_router(router)
    register_error_handlers(app)

    probes = [
        ("GET", "/api/nodes/no-such-node", None),
        ("PUT", "/api/v2/uploads/not-a-digest", None),
    ]
    with TestClient(app) as client:
        for method, path, payload in probes:
            kwargs = {"files": {"file": ("x.bin", b"x")}} if method == "PUT" else {"json": payload}
            response = client.request(method, path, **kwargs)
            assert response.status_code >= 400, f"{method} {path} unexpectedly succeeded"
            assert_is_envelope(response.json(), f"{method} {path}")


def test_an_unauthenticated_request_answers_with_the_envelope(monkeypatch) -> None:
    """The auth middleware runs before FastAPI's exception handlers, so it has to
    produce the envelope itself. It used to wrap an already-enveloped detail in a
    second `{"detail": ...}` layer, which no Client could parse with the same code
    path as every other error."""

    from fastapi.testclient import TestClient

    import app.auth as auth_module
    from app.main import app as real_app
    from dataclasses import replace
    from src.backend_settings import BACKEND_SETTINGS

    # The default local mode lets every request through as LOCAL_OWNER, so an
    # unauthenticated probe would answer 200, not 401. This contract is about the
    # bearer-mode rejection path, so drive the middleware off bearer settings.
    monkeypatch.setattr(auth_module, "BACKEND_SETTINGS",
                        replace(BACKEND_SETTINGS, auth_mode="bearer"))

    with TestClient(real_app) as client:
        denied = client.get("/api/v2/runs")

    assert denied.status_code == 401
    assert denied.headers.get("WWW-Authenticate") == "Bearer"
    assert_is_envelope(denied.json(), "GET /api/v2/runs (unauthenticated)")
