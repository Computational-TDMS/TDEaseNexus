"""Tests for `app/core/workspace_roots.py` -- the per-Principal registered
Workspace root store (docs/STATUS.md P0 "Workspace root registration").

Covers, per the B2 assignment:
- canonicalisation rejects relative and UNC paths outright (decided in the
  module docstring, not silently coerced);
- `is_within_approved_root` -- the exact lookup function
  `src/execution_runtime/storage.py` (owned by agent B4) must call -- refuses a
  path under a root that was never registered, even when a request "declares"
  that root itself (the defect this registry replaces: a caller asserting its
  own boundary);
- registration is isolated per Principal: a root approved for one Principal is
  never approved for another;
- a sibling directory that merely shares a string prefix with an approved root
  (e.g. `/root-2` vs. `/root`) is never treated as contained -- the exact bug a
  naive `str.startswith` containment check would have;
- the HTTP surface (`POST`/`GET /api/workspace-roots`) round-trips through the
  same per-Principal isolation and never reads an environment variable.
"""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from src.contracts.errors import ErrorCode, ErrorDomain, TDEaseError
from app.errors import register_error_handlers
from app.api.workspace_roots import router
from src.services.workspace_roots import (
    WorkspaceRootRegistry,
    canonicalize_root,
    get_workspace_root_registry,
)


def _client(registry: WorkspaceRootRegistry, monkeypatch, user_id: str = "owner-a") -> TestClient:
    """Route handlers reach the registry through `get_workspace_root_registry()`, which
    reads the module-level `_registry`
    global directly, so tests substitute their own isolated registry via
    `monkeypatch` (auto-restored at test teardown) instead of mutating the real
    process-lifetime singleton other tests/routes may depend on."""
    app = FastAPI()
    register_error_handlers(app)

    @app.middleware("http")
    async def principal(request: Request, call_next):
        request.state.principal = SimpleNamespace(user_id=user_id)
        return await call_next(request)

    import src.services.workspace_roots as workspace_roots_module

    monkeypatch.setattr(workspace_roots_module, "_registry", registry)
    app.include_router(router)
    return TestClient(app)


# ---------------------------------------------------------------------------
# Canonicalisation -- decisions stated in the module docstring
# ---------------------------------------------------------------------------


def test_canonicalize_root_rejects_relative_path() -> None:
    with pytest.raises(TDEaseError) as exc_info:
        canonicalize_root("relative/workspace")
    assert exc_info.value.http_status == 400
    assert exc_info.value.code == ErrorCode.WORKSPACE_IDENTITY_INVALID
    assert exc_info.value.domain == ErrorDomain.WORKSPACE
    assert exc_info.value.remedy


@pytest.mark.parametrize("unc_path", [r"\\host\share\workspace", "//host/share/workspace"])
def test_canonicalize_root_rejects_unc_path(unc_path: str) -> None:
    with pytest.raises(TDEaseError) as exc_info:
        canonicalize_root(unc_path)
    assert exc_info.value.http_status == 400
    assert exc_info.value.code == ErrorCode.WORKSPACE_IDENTITY_INVALID


def test_canonicalize_root_rejects_empty_path() -> None:
    with pytest.raises(TDEaseError) as exc_info:
        canonicalize_root("   ")
    assert exc_info.value.code == ErrorCode.WORKSPACE_IDENTITY_INVALID


def test_canonicalize_root_resolves_symlink(tmp_path: Path) -> None:
    real_dir = tmp_path / "real"
    real_dir.mkdir()
    link = tmp_path / "link"
    try:
        link.symlink_to(real_dir, target_is_directory=True)
    except OSError:
        pytest.skip("symlink creation requires elevated privilege on this platform")
    resolved = canonicalize_root(str(link))
    assert resolved == real_dir.resolve()


# ---------------------------------------------------------------------------
# `is_within_approved_root` -- the exact lookup function B4's storage.py must call
# ---------------------------------------------------------------------------


def test_path_under_unregistered_root_is_refused_even_when_declared(tmp_path: Path) -> None:
    """The defect this registry replaces: containment validated against the root
    supplied in the request itself. A candidate under a root that was never
    registered for this Principal is refused, regardless of what the caller
    claims about that root."""
    registry = WorkspaceRootRegistry()
    approved = tmp_path / "approved"
    approved.mkdir()
    unregistered = tmp_path / "unregistered"
    unregistered.mkdir()

    registry.register("owner-a", str(approved))

    # The caller "declares" unregistered as if it were an approved root; the
    # registry consults only what it has itself approved.
    candidate = unregistered / "sample.mzML"
    assert registry.is_within_approved_root("owner-a", str(candidate)) is False


def test_path_under_registered_root_is_approved(tmp_path: Path) -> None:
    registry = WorkspaceRootRegistry()
    approved = tmp_path / "approved"
    approved.mkdir()
    registry.register("owner-a", str(approved))

    assert registry.is_within_approved_root("owner-a", str(approved / "sample.mzML")) is True
    assert registry.is_within_approved_root("owner-a", str(approved)) is True


def test_sibling_directory_sharing_string_prefix_is_not_contained(tmp_path: Path) -> None:
    """`/root-2` must never be mistaken for a child of `/root` -- the exact bug a
    plain `str.startswith` containment check would have."""
    registry = WorkspaceRootRegistry()
    root = tmp_path / "root"
    root.mkdir()
    sibling = tmp_path / "root-2"
    sibling.mkdir()
    registry.register("owner-a", str(root))

    assert registry.is_within_approved_root("owner-a", str(sibling / "file.txt")) is False


def test_registration_is_isolated_per_principal(tmp_path: Path) -> None:
    registry = WorkspaceRootRegistry()
    shared_path = tmp_path / "workspace"
    shared_path.mkdir()
    registry.register("owner-a", str(shared_path))

    # owner-b never registered anything; the same directory is not approved for them.
    assert registry.is_within_approved_root("owner-b", str(shared_path)) is False
    assert registry.is_within_approved_root("owner-a", str(shared_path)) is True


def test_unknown_principal_is_never_approved(tmp_path: Path) -> None:
    registry = WorkspaceRootRegistry()
    assert registry.is_within_approved_root("nobody", str(tmp_path)) is False


def test_malformed_candidate_path_is_not_contained_and_does_not_raise(tmp_path: Path) -> None:
    registry = WorkspaceRootRegistry()
    approved = tmp_path / "approved"
    approved.mkdir()
    registry.register("owner-a", str(approved))
    assert registry.is_within_approved_root("owner-a", "\x00bad-path") is False


def test_registering_the_same_root_twice_is_idempotent(tmp_path: Path) -> None:
    registry = WorkspaceRootRegistry()
    root = tmp_path / "workspace"
    root.mkdir()
    first_id, first_path = registry.register("owner-a", str(root))
    second_id, second_path = registry.register("owner-a", str(root))
    assert first_id == second_id and first_path == second_path
    assert len(registry.list_roots("owner-a")) == 1


@pytest.mark.skipif(os.name != "nt", reason="Windows-only case-insensitivity behaviour")
def test_windows_root_comparison_is_case_insensitive(tmp_path: Path) -> None:
    registry = WorkspaceRootRegistry()
    root = tmp_path / "Workspace"
    root.mkdir()
    registry.register("owner-a", str(root))

    differently_cased = str(root).upper() + "\\sample.mzML"
    assert registry.is_within_approved_root("owner-a", differently_cased) is True


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------


def test_http_register_and_list_round_trip(tmp_path: Path, monkeypatch) -> None:
    registry = WorkspaceRootRegistry()
    root = tmp_path / "workspace"
    root.mkdir()

    client = _client(registry, monkeypatch, user_id="owner-a")
    with client:
        created = client.post("/api/workspace-roots", json={"path": str(root)})
        assert created.status_code == 201, created.text
        body = created.json()
        assert body["path"] == str(root.resolve())
        assert body["root_id"]

        listed = client.get("/api/workspace-roots")
        assert listed.status_code == 200
        assert [entry["path"] for entry in listed.json()["roots"]] == [str(root.resolve())]


def test_http_registration_is_isolated_per_principal(tmp_path: Path, monkeypatch) -> None:
    registry = WorkspaceRootRegistry()
    root_a = tmp_path / "workspace-a"
    root_a.mkdir()

    client_a = _client(registry, monkeypatch, user_id="owner-a")
    with client_a:
        client_a.post("/api/workspace-roots", json={"path": str(root_a)})

    client_b = _client(registry, monkeypatch, user_id="owner-b")
    with client_b:
        listed_b = client_b.get("/api/workspace-roots")
        assert listed_b.json()["roots"] == []


def test_http_register_rejects_relative_path(tmp_path: Path, monkeypatch) -> None:
    registry = WorkspaceRootRegistry()
    client = _client(registry, monkeypatch, user_id="owner-a")
    with client:
        response = client.post("/api/workspace-roots", json={"path": "relative/workspace"})
        assert response.status_code == 400, response.text
        error = response.json()["error"]
        assert error["code"] == "WORKSPACE_IDENTITY_INVALID"
        assert error["domain"] == "workspace"


def test_registration_never_reads_an_environment_variable(tmp_path: Path, monkeypatch) -> None:
    """M0 grep gate: registering/looking up a Workspace root must not consult
    the process environment at request time."""
    monkeypatch.setenv("TDEASE_DEPLOYMENT_MODE", "remote")
    monkeypatch.setenv("TDEASE_DATA_ROOT", str(tmp_path / "not-a-real-root"))

    registry = WorkspaceRootRegistry()
    root = tmp_path / "workspace"
    root.mkdir()

    client = _client(registry, monkeypatch, user_id="owner-a")
    with client:
        created = client.post("/api/workspace-roots", json={"path": str(root)})
        assert created.status_code == 201, created.text
        assert created.json()["path"] == str(root.resolve())


# ---------------------------------------------------------------------------
# Composition root -- the join between the two halves
# ---------------------------------------------------------------------------


def test_backend_startup_wires_the_registry_into_the_containment_checker(tmp_path, monkeypatch) -> None:
    """Both halves of Workspace-root containment shipped correct, tested and green
    while nothing joined them: `set_approved_roots_checker` was never called at
    startup, so the fail-closed default approved no root for any Principal and every
    local Run died with WORKSPACE_PATH_ESCAPE.

    No other test in this repository can see that. They each either build a private
    `FastAPI()` around `router` (every HTTP test above) or stub the checker open in a
    fixture (`tests/test_runs_api.py`), so both halves stay green while the seam
    between them is missing. This one asserts the seam itself, on the real
    `app.main:app`, through its real lifespan.
    """
    import src.services.workspace_roots as workspace_roots_module
    from src.execution_runtime import set_storage
    from src.execution_runtime.storage import StorageLayout
    from src.execution_runtime.workspace_containment import (
        reset_approved_roots_checker,
        validate_root_containment,
    )

    set_storage(StorageLayout(str(tmp_path / "backend")))
    monkeypatch.setattr(workspace_roots_module, "_registry", WorkspaceRootRegistry())
    reset_approved_roots_checker()

    root = tmp_path / "workspace"
    (root / "raw").mkdir(parents=True)

    from app.main import app as real_app

    try:
        with TestClient(real_app):
            # Nothing registered yet: the wired checker must still refuse, i.e. the
            # startup wiring did not simply replace fail-closed with approve-all.
            with pytest.raises(TDEaseError):
                validate_root_containment(root / "raw", "local-owner")

            workspace_roots_module._registry.register("local-owner", str(root))

            assert validate_root_containment(root / "raw", "local-owner") == (root / "raw").resolve()
            # Still per-Principal after wiring.
            with pytest.raises(TDEaseError):
                validate_root_containment(root / "raw", "someone-else")
    finally:
        reset_approved_roots_checker()
