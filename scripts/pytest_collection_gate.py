#!/usr/bin/env python3
"""
Pytest collection gate — a collection error is a build failure, not a footnote.

Context (docs/STATUS.md): two test modules used to call
``sys.exit()`` at module scope. Pytest's own SystemExit handling turns that
into an INTERNALERROR that aborts the *entire* session mid-collection — before
a single test runs. A plain ``pytest tests/`` swallowed this into a wall of
traceback noise that was easy to miss in CI logs, and nothing in this repo's
tooling treated "the suite never even started" differently from "one test
failed".

This script isolates collection health as its own fast, unambiguous gate:

  python scripts/pytest_collection_gate.py

Exit 0  → every test module under tests/ imports and collects cleanly.
Exit 1  → collection failed (import error, unmatched syntax, a stray
          module-scope ``sys.exit()``, etc.) — run it locally with
          ``pytest tests/ --collect-only`` to see the traceback.

Wire this in before the full suite in CI (or as a pre-commit / local check):
it fails fast, and its failure means "the codebase is not even testable",
which is worse than any individual test failing.

Run ``uv run pytest tests/ -x -q`` (see CLAUDE.md / assignment) for the full
suite; this script only gates collection, not test outcomes.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/", "--collect-only", "-q"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)

    if result.returncode != 0:
        print(
            "\nCOLLECTION GATE FAILED: `pytest tests/ --collect-only` exited "
            f"{result.returncode}. The suite is not collectable — this must "
            "be fixed before any test result can be trusted. See traceback "
            "above.",
            file=sys.stderr,
        )
        return 1

    print("Collection gate OK: all test modules under tests/ import and collect cleanly.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
