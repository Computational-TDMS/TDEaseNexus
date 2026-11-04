"""Core, single-invariant pure-function tests for the foundational contracts.

These four invariants are the *only* place each is asserted, so they survived the
removal of the old `test_convergence.py` grab-bag (which mixed them with
redundant copies of lifecycle / portability / node-catalog tests already covered
elsewhere). Each test pins exactly one property, cheaply.

Coverage map (what was NOT duplicated and therefore kept here):
- enum cardinalities and membership — no other test asserts these.
- blob CAS roundtrip + declared-digest rejection — `test_upload_safety` only
  exercises CAS indirectly through dedup; this is the direct unit.
- code→domain/http_status derivation — `test_failure_contract` asserts
  `ErrorCode.*` values inside HTTP envelopes, but not that the constructor
  forces the registered domain and status onto every instance.

The lifecycle-emitter, run.json portability, workspace-identity/tree-freeze,
cancel-scoping, containment, and node-catalog tests that used to live alongside
these are deleted from here because dedicated files already cover them:
lifecycle -> tests/e2e/test_sunny_path.py; portability/cancel ->
tests/test_runs_api.py + tests/test_execution_runtime.py; containment ->
tests/test_workspace_containment.py; node catalog ->
tests/test_node_catalog_and_outputs.py.
"""
from __future__ import annotations

import hashlib
import io

import pytest

from src.contracts import (
    CANCELLABLE_STATUSES,
    EventType,
    RunStatus,
    TERMINAL_STATUSES,
)
from src.contracts.errors import ErrorCode, ErrorDomain, TDEaseError
from src.execution_runtime import StorageLayout, set_storage


def test_enum_cardinalities_and_membership() -> None:
    assert len(TERMINAL_STATUSES) == 3
    assert RunStatus.QUEUED in CANCELLABLE_STATUSES
    assert len(EventType) > 5
    assert len(ErrorCode) > 20


@pytest.fixture()
def _storage(tmp_path) -> StorageLayout:
    st = StorageLayout(tmp_path / "server-data")
    st.bootstrap()
    set_storage(st)
    return st


def test_blob_cas_roundtrip_and_declared_digest_rejection(_storage: StorageLayout) -> None:
    # content-addressed put derives the key from the bytes themselves
    data = b"hello convergence"
    h = _storage.blob_put(data)
    assert h == hashlib.sha256(data).hexdigest()
    assert _storage.blob_exists(h)
    assert _storage.blob_get(h) == data

    # the streaming upload path (the real upload route) verifies a declared digest
    streamed = b"hello streamed convergence"
    sh = hashlib.sha256(streamed).hexdigest()
    stored, size = _storage.blob_put_stream(io.BytesIO(streamed), sh)
    assert stored == sh and size == len(streamed)

    # a lie about the content is rejected and leaves nothing behind
    liar = hashlib.sha256(b"different bytes entirely").hexdigest()
    with pytest.raises(ValueError):
        _storage.blob_put_stream(io.BytesIO(streamed), liar)
    assert not _storage.blob_exists(liar)


def test_error_construction_forces_registered_domain_and_status() -> None:
    # domain and http_status are not constructor arguments: a raise site
    # cannot make a code disagree with its registered domain (§4).
    err = TDEaseError(ErrorCode.RUN_NOT_FOUND, "missing", "retry", retryable=False)
    assert err.domain == ErrorDomain.RUN
    assert err.http_status == 404
    digest = TDEaseError(ErrorCode.WORKSPACE_DIGEST_MISMATCH, "mismatch", "reupload",
                         retryable=False, details={"expected": "aaa", "actual": "bbb"})
    assert digest.details["expected"] == "aaa"
    escape = TDEaseError(ErrorCode.WORKSPACE_PATH_ESCAPE, "escape", "use approved roots",
                         retryable=False)
    assert escape.domain == ErrorDomain.WORKSPACE
