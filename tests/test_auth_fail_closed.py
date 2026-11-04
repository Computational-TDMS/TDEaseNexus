"""docs/STATUS.md -- Desktop authentication must fail closed.

Before the fix, `DesktopAuth.authenticate()` returned `LOCAL_OWNER` for every
request whenever no bootstrap secret had been supplied, without ever inspecting
the `Authorization` header. These tests pin the fixed behaviour: absent
credentials reject every protected request, token comparison is constant-time,
the secret is never observable in a response or a log, and the failure carries
the full envelope from CORE-ARCHITECTURE.md section 7.1.
"""

from __future__ import annotations

import logging
from dataclasses import replace

import pytest
from fastapi import HTTPException

from app.auth import LOCAL_OWNER, DesktopAuth, authenticate_request


# ---------------------------------------------------------------------------
# No secret configured at startup -> permanently fails closed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_local_mode_uses_local_owner_without_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.auth as auth_module

    monkeypatch.setattr(
        auth_module,
        "BACKEND_SETTINGS",
        replace(auth_module.BACKEND_SETTINGS, auth_mode="local"),
    )
    url = type("Url", (), {"path": "/api/v2/runs"})()
    request = type("Request", (), {"method": "GET", "url": url})()

    assert await authenticate_request(request) == LOCAL_OWNER


def test_no_secret_at_startup_rejects_request_with_no_header() -> None:
    auth = DesktopAuth(None)

    with pytest.raises(HTTPException) as denied:
        auth.authenticate(None)

    assert denied.value.status_code == 401
    envelope = denied.value.detail["error"]
    assert envelope["code"] == "AUTH_BOOTSTRAP_SECRET_MISSING"
    assert envelope["domain"] == "environment"
    assert envelope["retryable"] is False
    assert envelope["remedy"]


def test_no_secret_at_startup_rejects_every_subsequent_request() -> None:
    """The historical defect: a caller could reach a protected route without
    ever presenting a header. Confirm the header is irrelevant here -- every
    shape of request is rejected identically, there is no accidental grant.
    """

    auth = DesktopAuth("")

    for header in (None, "", "Bearer whatever", "Bearer ", "not-a-bearer-token"):
        with pytest.raises(HTTPException) as denied:
            auth.authenticate(header)
        assert denied.value.status_code == 401
        assert denied.value.detail["error"]["domain"] == "environment"


def test_no_secret_configured_flag_is_never_true() -> None:
    auth = DesktopAuth(None)
    assert auth.configured is False


def test_missing_secret_logs_a_startup_error_without_crashing(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.ERROR, logger="app.auth"):
        auth = DesktopAuth(None)

    assert auth is not None
    assert any(record.levelno == logging.ERROR for record in caplog.records)


# ---------------------------------------------------------------------------
# Secret configured -> only the correct Bearer token for the minted token
# authenticates; everything else is rejected.
# ---------------------------------------------------------------------------


@pytest.fixture
def configured_auth() -> tuple[DesktopAuth, str]:
    auth = DesktopAuth("bootstrap-secret")
    tokens = auth.exchange("bootstrap-secret")
    return auth, tokens["access_token"]


def test_configured_backend_rejects_missing_header(configured_auth: tuple[DesktopAuth, str]) -> None:
    auth, _token = configured_auth
    with pytest.raises(HTTPException) as denied:
        auth.authenticate(None)
    assert denied.value.status_code == 401
    # `environment`, not `backend`: a rejected token is a broken Desktop launch, not
    # a Backend fault. The domain used to be a free string at the raise site, which
    # is how this one came to disagree with the sibling AUTH_BOOTSTRAP_SECRET_MISSING
    # rejection a few tests above; it is now derived from the code.
    assert denied.value.detail["error"]["domain"] == "environment"
    assert denied.value.detail["error"]["code"] == "AUTH_TOKEN_INVALID"


def test_configured_backend_rejects_wrong_token(configured_auth: tuple[DesktopAuth, str]) -> None:
    auth, _token = configured_auth
    with pytest.raises(HTTPException) as denied:
        auth.authenticate("Bearer wrong-token")
    assert denied.value.status_code == 401


def test_configured_backend_rejects_malformed_header(configured_auth: tuple[DesktopAuth, str]) -> None:
    auth, token = configured_auth
    for malformed in ("", token, f"Bearer{token}", "Bearer"):
        with pytest.raises(HTTPException) as denied:
            auth.authenticate(malformed)
        assert denied.value.status_code == 401


def test_configured_backend_rejects_correct_token_wrong_scheme(configured_auth: tuple[DesktopAuth, str]) -> None:
    auth, token = configured_auth
    with pytest.raises(HTTPException) as denied:
        auth.authenticate(f"Basic {token}")
    assert denied.value.status_code == 401


def test_configured_backend_accepts_correct_bearer_token(configured_auth: tuple[DesktopAuth, str]) -> None:
    auth, token = configured_auth
    principal = auth.authenticate(f"Bearer {token}")
    assert principal == LOCAL_OWNER
    assert principal.user_id == "local-owner"
    assert principal.role == "owner"


# ---------------------------------------------------------------------------
# Constant-time comparison
# ---------------------------------------------------------------------------


def test_authenticate_uses_constant_time_comparison(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.auth as auth_module

    calls: list[tuple[str, str]] = []
    real_compare_digest = auth_module.secrets.compare_digest

    def spy(a: str, b: str) -> bool:
        calls.append((a, b))
        return real_compare_digest(a, b)

    monkeypatch.setattr(auth_module.secrets, "compare_digest", spy)

    auth = DesktopAuth("bootstrap-secret")
    tokens = auth.exchange("bootstrap-secret")
    auth.authenticate(f"Bearer {tokens['access_token']}")

    assert calls, "authenticate() must validate the token via secrets.compare_digest, not '=='"


def test_exchange_uses_constant_time_comparison(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.auth as auth_module

    calls: list[tuple[str, str]] = []
    real_compare_digest = auth_module.secrets.compare_digest

    def spy(a: str, b: str) -> bool:
        calls.append((a, b))
        return real_compare_digest(a, b)

    monkeypatch.setattr(auth_module.secrets, "compare_digest", spy)

    auth = DesktopAuth("bootstrap-secret")
    auth.exchange("bootstrap-secret")

    assert calls, "exchange() must validate the candidate secret via secrets.compare_digest, not '=='"


# ---------------------------------------------------------------------------
# The secret never leaks into a response body or a log record.
# ---------------------------------------------------------------------------


def test_secret_never_appears_in_rejection_bodies(caplog: pytest.LogCaptureFixture) -> None:
    secret = "sh-do-not-leak-this-secret-value"

    with caplog.at_level(logging.DEBUG):
        auth = DesktopAuth(secret)

        with pytest.raises(HTTPException) as bad_exchange:
            auth.exchange("wrong-candidate")
        assert secret not in str(bad_exchange.value.detail)

        tokens = auth.exchange(secret)

        with pytest.raises(HTTPException) as denied:
            auth.authenticate("Bearer wrong")
        assert secret not in str(denied.value.detail)
        for token in tokens.values():
            assert token not in str(denied.value.detail)

    for record in caplog.records:
        assert secret not in record.getMessage()


def test_secret_never_appears_in_no_secret_rejection_body(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.DEBUG):
        auth = DesktopAuth(None)
        with pytest.raises(HTTPException) as denied:
            auth.authenticate("Bearer anything")

    # No secret value exists in this scenario (none was ever supplied); assert
    # the envelope carries no `details`/`cause` payload that could later be
    # used to smuggle one in.
    assert "details" not in denied.value.detail["error"]
    assert "cause" not in denied.value.detail["error"]
    for record in caplog.records:
        assert "bootstrap-secret" not in record.getMessage()


# ---------------------------------------------------------------------------
# Browser origin gate (app/main.py browser_origin_gate)
# ---------------------------------------------------------------------------

def test_cross_site_browser_origin_is_rejected_before_routing() -> None:
    """In local auth mode every request is trusted, so the only boundary
    against a malicious page driving this tokenless loopback server is the
    Origin gate: a browser always attaches Origin to cross-origin requests,
    and the Desktop's own origins (loopback, or "null" for the Electron
    file:// renderer) are the only browser origins answered."""
    from fastapi.testclient import TestClient

    from app.main import app as backend_app

    with TestClient(backend_app) as client:
        drive_by = client.get("/health", headers={"Origin": "http://evil.com"})
        assert drive_by.status_code == 403
        assert drive_by.json()["error"]["code"] == "AUTH_ORIGIN_FORBIDDEN"

        # DNS-rebinding shape: same attack, secure scheme, odd port.
        rebound = client.get("/health", headers={"Origin": "https://evil.example:8443"})
        assert rebound.status_code == 403

        # The Desktop's own browser origins pass the gate.
        for origin in ("null", "http://127.0.0.1:5173", "http://localhost:5173"):
            response = client.get("/health", headers={"Origin": origin})
            assert response.status_code == 200, (origin, response.text)

        # Non-browser Clients (Electron main, agent harness) send no Origin.
        assert client.get("/health").status_code == 200


# ---------------------------------------------------------------------------
# Launch token pair: owner + agent principals (the agent blast-radius ceiling)
# ---------------------------------------------------------------------------

def test_exchange_mints_owner_and_agent_tokens_with_different_scopes() -> None:
    auth = DesktopAuth("bootstrap-secret")
    tokens = auth.exchange("bootstrap-secret")

    owner = auth.authenticate(f"Bearer {tokens['access_token']}")
    agent = auth.authenticate(f"Bearer {tokens['agent_token']}")
    assert owner.user_id == "local-owner"
    assert "run:purge" in owner.scopes
    # Same user identity — the agent is the owner's scoped delegate, so Runs it
    # dispatches land in the owner's namespace — separated only by role/scope.
    assert agent.user_id == owner.user_id
    assert agent.role == "agent"
    assert "run:execute" in agent.scopes
    # The ceiling: the agent principal must not hold the irreversible scope.
    assert "run:purge" not in agent.scopes
    # The secret is single-use and burned; a second exchange is unavailable.
    with pytest.raises(HTTPException):
        auth.exchange("bootstrap-secret")


def test_scope_gate_denies_agent_principal_on_purge() -> None:
    from fastapi import FastAPI, Response
    from fastapi.testclient import TestClient

    from app.auth import DESKTOP_AGENT, LOCAL_OWNER, require_scope
    from app.errors import register_error_handlers

    app = FastAPI()
    register_error_handlers(app)

    @app.middleware("http")
    async def _principal(request, call_next):
        request.state.principal = (
            DESKTOP_AGENT if request.headers.get("X-Test-Principal") == "agent" else LOCAL_OWNER
        )
        return await call_next(request)

    @app.delete("/probe", status_code=204)
    def _probe(_scope=require_scope("run:purge")):
        return Response(status_code=204)

    client = TestClient(app)
    denied = client.delete("/probe", headers={"X-Test-Principal": "agent"})
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "AUTH_SCOPE_DENIED"

    allowed = client.delete("/probe", headers={"X-Test-Principal": "owner"})
    assert allowed.status_code == 204


def test_bootstrap_secret_arrives_from_the_launch_environment(tmp_path) -> None:
    import json as _json

    from src.backend_settings import load_backend_settings

    config = tmp_path / "backend.json"
    config.write_text(_json.dumps({
        "schemaVersion": 1, "dataRoot": "runtime",
        "auth": {"mode": "bearer"},
    }), encoding="utf-8")
    # The Desktop launcher hands the per-launch secret through the child env.
    settings = load_backend_settings(
        config, allow_env_overrides=True,
        environ={"TDEASE_BOOTSTRAP_SECRET": "launch-secret-xyz"},
    )
    assert settings.bootstrap_secret == "launch-secret-xyz"
    # Without a secret, bearer mode stays fail-closed (never implicit trust).
    bare = load_backend_settings(config, allow_env_overrides=True, environ={})
    assert bare.bootstrap_secret is None
