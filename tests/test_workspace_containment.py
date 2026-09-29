"""
Workspace root containment — docs/STATUS.md P0 "Workspace root
registration" (the B4 half), CORE-ARCHITECTURE.md §7.

`src.execution_runtime.workspace_containment` validates a candidate path
against *approved* roots only, never against a root supplied alongside the
candidate in the same request. B2 supplies the approval lookup at Backend
startup; here it is injected directly (or via `set_approved_roots_checker`)
so these tests exercise the containment rule with no dependency on
`app/**` and no live registry.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from src.contracts.errors import ErrorCode, TDEaseError
from src.execution_runtime.workspace_containment import (
    canonicalize,
    default_no_roots_approved,
    get_approved_roots_checker,
    reset_approved_roots_checker,
    set_approved_roots_checker,
    validate_root_containment,
)


@pytest.fixture(autouse=True)
def _reset_checker():
    """Every test starts from the fail-closed default and restores it after."""
    reset_approved_roots_checker()
    yield
    reset_approved_roots_checker()


def _junction(link: Path, target: Path) -> bool:
    """Create a Windows directory junction (no admin privilege required,
    unlike os.symlink). Returns False if unsupported (non-Windows or the
    mklink call fails), so tests can skip rather than fail on a platform
    limitation unrelated to the containment logic under test."""
    if os.name != "nt":
        try:
            os.symlink(target, link, target_is_directory=True)
            return True
        except OSError:
            return False
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
    )
    return result.returncode == 0


# ---------------------------------------------------------------------------
# Fail-closed default
# ---------------------------------------------------------------------------


def test_default_checker_approves_nothing() -> None:
    assert get_approved_roots_checker() is default_no_roots_approved
    assert default_no_roots_approved("any-user", "C:\\anything") is False


def test_no_checker_wired_raises_workspace_path_escape(tmp_path: Path) -> None:
    with pytest.raises(TDEaseError) as excinfo:
        validate_root_containment(tmp_path, "user-1")
    assert excinfo.value.code == ErrorCode.WORKSPACE_PATH_ESCAPE


def test_tdease_error_accepts_runtime_traceback_metadata() -> None:
    error = TDEaseError(ErrorCode.WORKSPACE_PATH_ESCAPE, "outside", "use an approved root", retryable=False)
    error.__traceback__ = None
    assert error.__traceback__ is None


def test_none_user_id_is_never_approved(tmp_path: Path) -> None:
    set_approved_roots_checker(lambda user_id, path: True)  # approves everything
    with pytest.raises(TDEaseError) as excinfo:
        validate_root_containment(tmp_path, None)
    assert excinfo.value.code == ErrorCode.WORKSPACE_PATH_ESCAPE


def test_empty_user_id_is_never_approved(tmp_path: Path) -> None:
    set_approved_roots_checker(lambda user_id, path: True)
    with pytest.raises(TDEaseError):
        validate_root_containment(tmp_path, "")


# ---------------------------------------------------------------------------
# A caller-supplied root is never trusted, only an approved one
# ---------------------------------------------------------------------------


def test_a_root_named_only_in_the_request_is_not_approved(tmp_path: Path) -> None:
    """The exact defect this module replaces: naming a root in the same
    request as the candidate must not make the candidate approved."""
    approved_root = tmp_path / "approved"
    approved_root.mkdir()
    unrelated_root = tmp_path / "unrelated"
    unrelated_root.mkdir()
    candidate = unrelated_root / "file.mzML"
    candidate.write_text("x", encoding="utf-8")

    checker_calls = []

    def checker(user_id: str, path: str) -> bool:
        checker_calls.append((user_id, path))
        # Only `approved_root` is ever approved, regardless of what the
        # caller claims `workspace_root` is.
        return str(canonicalize(approved_root)) in path or path.startswith(
            str(canonicalize(approved_root))
        )

    set_approved_roots_checker(checker)

    with pytest.raises(TDEaseError) as excinfo:
        validate_root_containment(candidate, "user-1")
    assert excinfo.value.code == ErrorCode.WORKSPACE_PATH_ESCAPE
    assert checker_calls, "the checker must actually be consulted"


def test_candidate_inside_an_approved_root_is_accepted(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    candidate = root / "raw" / "sample.mzML"
    candidate.parent.mkdir()
    candidate.write_text("x", encoding="utf-8")

    set_approved_roots_checker(lambda user_id, path: user_id == "user-1" and path.startswith(str(canonicalize(root))))

    result = validate_root_containment(candidate, "user-1")
    assert result == canonicalize(candidate)


def test_candidate_for_a_different_principal_is_rejected(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    candidate = root / "sample.mzML"

    set_approved_roots_checker(lambda user_id, path: user_id == "user-1")

    with pytest.raises(TDEaseError):
        validate_root_containment(candidate, "user-2")


# ---------------------------------------------------------------------------
# `..` is rejected only via resolution, never by a pre-resolution scan
# ---------------------------------------------------------------------------


def test_dotdot_that_stays_inside_the_root_after_resolution_is_accepted(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    (root / "sub").mkdir(parents=True)
    target = root / "sample.mzML"
    target.write_text("x", encoding="utf-8")
    candidate_with_dotdot = root / "sub" / ".." / "sample.mzML"

    set_approved_roots_checker(lambda user_id, path: path.startswith(str(canonicalize(root))))

    result = validate_root_containment(candidate_with_dotdot, "user-1")
    assert result == canonicalize(target)


def test_dotdot_that_escapes_the_root_after_resolution_is_rejected(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    candidate_escaping = root / ".." / "outside" / "secret.txt"

    set_approved_roots_checker(lambda user_id, path: path.startswith(str(canonicalize(root))))

    with pytest.raises(TDEaseError) as excinfo:
        validate_root_containment(candidate_escaping, "user-1")
    assert excinfo.value.code == ErrorCode.WORKSPACE_PATH_ESCAPE


# ---------------------------------------------------------------------------
# Canonicalisation: symlink resolution and Windows case/separator folding
# ---------------------------------------------------------------------------


def test_symlink_escaping_an_approved_root_is_rejected(tmp_path: Path) -> None:
    approved_root = tmp_path / "approved"
    approved_root.mkdir()
    secret_root = tmp_path / "secret"
    secret_root.mkdir()
    (secret_root / "secret.txt").write_text("classified", encoding="utf-8")

    link = approved_root / "escape_link"
    if not _junction(link, secret_root):
        pytest.skip("directory junction/symlink creation not permitted in this environment")

    candidate = link / "secret.txt"

    # The checker only ever approves paths textually under approved_root --
    # but the candidate, once resolved through the junction, points at
    # secret_root instead.
    set_approved_roots_checker(lambda user_id, path: path.startswith(str(canonicalize(approved_root))))

    with pytest.raises(TDEaseError) as excinfo:
        validate_root_containment(candidate, "user-1")
    assert excinfo.value.code == ErrorCode.WORKSPACE_PATH_ESCAPE


def test_symlink_target_inside_the_same_approved_root_is_accepted(tmp_path: Path) -> None:
    approved_root = tmp_path / "approved"
    real_dir = approved_root / "real"
    real_dir.mkdir(parents=True)
    (real_dir / "sample.mzML").write_text("x", encoding="utf-8")

    link = approved_root / "alias"
    if not _junction(link, real_dir):
        pytest.skip("directory junction/symlink creation not permitted in this environment")

    candidate = link / "sample.mzML"
    set_approved_roots_checker(lambda user_id, path: path.startswith(str(canonicalize(approved_root))))

    result = validate_root_containment(candidate, "user-1")
    assert result == canonicalize(real_dir / "sample.mzML")


@pytest.mark.skipif(os.name != "nt", reason="Windows-case-folding is a Windows-specific rule")
def test_windows_case_is_folded_for_comparison(tmp_path: Path) -> None:
    root = tmp_path / "Workspace"
    root.mkdir()
    candidate_uppercase = Path(str(tmp_path / "WORKSPACE").upper()) / "sample.mzML"

    canonical_root = canonicalize(root)
    canonical_candidate = canonicalize(candidate_uppercase)
    # Same normcase() folding applied to both sides is what makes the
    # differently-cased spellings compare equal.
    assert str(canonical_candidate).startswith(str(canonical_root))


def test_canonicalize_normalises_separators_and_dotdot() -> None:
    raw = "C:/Users/x/../y/./z" if os.name == "nt" else "/tmp/x/../y/./z"
    result = canonicalize(raw)
    assert ".." not in result.parts
    assert "." not in result.parts


# ---------------------------------------------------------------------------
# Integration: the actual call site, storage.materialize_local_run_files
# ---------------------------------------------------------------------------


def test_materialize_local_run_files_requires_user_id_and_fails_closed(tmp_path: Path) -> None:
    """The regression this file exists to guard: materialize_local_run_files
    must accept a `user_id` and route it through validate_root_containment --
    not crash on a stale import, and not trust workspace_root unchecked."""
    from src.execution_runtime.storage import StorageLayout

    storage = StorageLayout(tmp_path / "data")
    storage.bootstrap()
    storage.allocate_run("run-1")
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()

    with pytest.raises(TDEaseError) as excinfo:
        storage.materialize_local_run_files(storage.allocate_run("run-1"), workspace_root, [], user_id="user-1")
    assert excinfo.value.code == ErrorCode.WORKSPACE_PATH_ESCAPE


def test_materialize_local_run_files_succeeds_once_root_is_approved(tmp_path: Path) -> None:
    from src.execution_runtime.storage import StorageLayout

    storage = StorageLayout(tmp_path / "data")
    storage.bootstrap()
    storage.allocate_run("run-2")
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    sample = workspace_root / "sample.txt"
    sample.write_bytes(b"hello")
    digest = storage.file_digest(sample)

    set_approved_roots_checker(lambda user_id, path: user_id == "user-1" and path.startswith(str(canonicalize(workspace_root))))

    storage.materialize_local_run_files(
        storage.allocate_run("run-2"), workspace_root, [{"path": "sample.txt", "blob_hash": digest}],
        user_id="user-1",
    )

    materialized = storage.resolve("run-2", "sample.txt")
    assert materialized.exists()
    assert materialized.read_bytes() == b"hello"
