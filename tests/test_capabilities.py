"""Tests for `GET /api/capabilities` and its correspondence with
`docs/spec/CAPABILITIES.md`.

Covers, per the A4 assignment:
- response shape matches the spec's field list, exactly (no extra/missing field
  either direction);
- the document is identical across two calls (frozen);
- no environment variable is read during a request (mutate os.environ after
  startup/import, assert the response is unchanged);
- an unknown field a client might expect does not break the Backend (additive
  tolerance is a Client-side concern; the Backend simply never errors on its own
  fixed shape).
"""

from __future__ import annotations

import os
import re
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app.api.capabilities import (
    CapabilitiesResponse,
    PROTOCOL_VERSION,
    build_capabilities,
    router,
)
from src.backend_settings import (
    BACKEND_SETTINGS,
    CAPABILITY_REGISTRY,
    RUNTIME_INVENTORY,
)
from src.execution_runtime.resource_budget import RESOURCE_BUDGET

SPEC_PATH = Path(__file__).resolve().parents[1] / "docs" / "spec" / "CAPABILITIES.md"


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _model_leaf_paths(model: type[BaseModel], prefix: str = "") -> set[str]:
    """Recursively collect dotted leaf field paths from a pydantic model."""
    paths: set[str] = set()
    for name, field in model.model_fields.items():
        dotted = f"{prefix}{name}"
        annotation = field.annotation
        origin_args = getattr(annotation, "__args__", ())
        candidates = [a for a in origin_args if a is not type(None)] or [annotation]
        nested_model = next(
            (c for c in candidates if isinstance(c, type) and issubclass(c, BaseModel)),
            None,
        )
        if nested_model is not None:
            paths |= _model_leaf_paths(nested_model, dotted + ".")
        else:
            paths.add(dotted)
    return paths


def _spec_field_table() -> str:
    text = SPEC_PATH.read_text(encoding="utf-8")
    match = re.search(r"<!-- FIELD-TABLE:START -->(.*?)<!-- FIELD-TABLE:END -->", text, re.DOTALL)
    assert match, "docs/spec/CAPABILITIES.md must contain a FIELD-TABLE block"
    return match.group(1)


def _spec_field_paths() -> set[str]:
    table = _spec_field_table()
    return set(re.findall(r"^\|\s*`([a-zA-Z0-9_.]+)`", table, re.MULTILINE))


def test_spec_document_exists_and_has_field_table():
    assert SPEC_PATH.exists()
    assert _spec_field_paths(), "field table must list at least one field"


def test_response_model_matches_spec_field_list_exactly():
    code_fields = _model_leaf_paths(CapabilitiesResponse)
    spec_fields = _spec_field_paths()
    assert code_fields == spec_fields, (
        f"code/spec drift: in code but not spec = {code_fields - spec_fields}; "
        f"in spec but not code = {spec_fields - code_fields}"
    )


def test_get_capabilities_returns_all_spec_fields():
    client = _client()
    response = client.get("/api/capabilities")
    assert response.status_code == 200
    body = response.json()

    assert PROTOCOL_VERSION == 3
    assert body["protocol_version"] == PROTOCOL_VERSION
    assert body["auth"] == {"scheme": "none", "bootstrap": None}
    assert isinstance(body["materialization"]["strategies"], list)
    assert body["materialization"]["strategies"]
    assert isinstance(body["limits"]["max_cores"], int)
    assert isinstance(body["limits"]["log_tail_max_lines"], int)
    assert body["engine"]["name"] == "snakemake"
    assert isinstance(body["engine"]["version"], str) and body["engine"]["version"]
    assert isinstance(body["features"]["run_definition"], bool)
    assert isinstance(body["multi_user"], bool)


def test_document_is_identical_across_two_calls():
    client = _client()
    first = client.get("/api/capabilities").json()
    second = client.get("/api/capabilities").json()
    assert first == second


def test_no_environment_variable_is_read_during_a_request(monkeypatch):
    client = _client()
    before = client.get("/api/capabilities").json()

    # Mutate the environment variable this module's own resolution logic reads,
    # strictly after import/startup. A per-request read would flip
    # materialization.strategies from local_workspace_hardlink to blob_store.
    monkeypatch.setenv("TDEASE_DEPLOYMENT_MODE", "remote")
    monkeypatch.setenv("TDEASE_BOOTSTRAP_SECRET", "should-not-matter")
    os.environ["TDEASE_SOME_FUTURE_ENV_VAR"] = "anything"
    try:
        after = client.get("/api/capabilities").json()
    finally:
        os.environ.pop("TDEASE_SOME_FUTURE_ENV_VAR", None)

    assert after == before


def test_unauthenticated_no_bearer_token_required():
    client = _client()
    response = client.get("/api/capabilities")
    assert response.status_code == 200


def test_response_is_frozen_pydantic_model_instance():
    # The module-level singleton must not be mutable at runtime.
    with pytest.raises(Exception):
        from app.api.capabilities import _CAPABILITIES

        _CAPABILITIES.protocol_version = 999  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Capability declarations are explicit and testable
# ---------------------------------------------------------------------------


def test_explicit_registry_is_the_only_feature_source() -> None:
    disabled = replace(
        CAPABILITY_REGISTRY,
        published_results=False,
        native_dry_run_projection=False,
    )
    document = build_capabilities(
        BACKEND_SETTINGS,
        RUNTIME_INVENTORY,
        disabled,
        RESOURCE_BUDGET,
    )
    assert document.features.published_results is False
    assert document.features.native_dry_run_projection is False


def test_settings_select_auth_and_materialization_without_runtime_reflection() -> None:
    remote = replace(BACKEND_SETTINGS, auth_mode="bearer", deployment_mode="remote")
    document = build_capabilities(
        remote,
        RUNTIME_INVENTORY,
        CAPABILITY_REGISTRY,
        RESOURCE_BUDGET,
    )
    assert document.auth.scheme == "bearer"
    assert document.auth.bootstrap == "desktop"
    assert document.materialization.strategies == ("blob_store",)


def test_published_results_is_not_advertised_while_the_route_is_absent() -> None:
    """The other half of the same claim, checked from the wire rather than the
    contract: if the Backend advertises Published Results, a route must serve them.
    Either both are present or neither is."""
    from app.main import app

    paths = app.openapi()["paths"]
    serves_results = any(path.endswith("/results") for path in paths)
    assert _capabilities_features().published_results == serves_results


def test_run_definition_registry_matches_the_public_route_surface() -> None:
    from app.main import app

    paths = app.openapi()["paths"]
    serves_definition = any(path.endswith("/definition") for path in paths)
    assert _capabilities_features().run_definition == serves_definition


def test_native_dry_run_projection_matches_the_public_response_schema() -> None:
    from app.main import app

    schemas = app.openapi()["components"]["schemas"]
    projection_is_public = "projection" in schemas["RunDryRunResponse"]["properties"]
    assert _capabilities_features().native_dry_run_projection == projection_is_public


def _capabilities_features():
    from app.api.capabilities import _CAPABILITIES

    return _CAPABILITIES.features
