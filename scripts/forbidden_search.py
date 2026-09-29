#!/usr/bin/env python3
"""
Forbidden-search gate — forbids the following concepts from entering the TDEaseNexus
codebase in any form.

Usage:
  python scripts/forbidden_search.py           # check for net-new violations
  python scripts/forbidden_search.py --all     # list all violations (incl. baseline)
  python scripts/forbidden_search.py --baseline # regenerate the baseline

CI pass criterion: exit 0 (no net-new violations).
Net-new violations = current hits - baseline hits.

Baseline file: scripts/forbidden_baseline.txt
Records file:line:pattern for all known violations; updated as Phase 1 eliminates them.

Rule source: CONVERGENCE-PLAN.md Phase 0
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINE_FILE = ROOT / "scripts" / "forbidden_baseline.txt"

# --- Forbidden pattern definitions ---
FORBIDDEN: list[tuple[str, str, str]] = [
    # (pattern, type, explanation)
    # type: "regex" = Python/ripgrep regex
    (
        r"\bDONE\b",
        "regex",
        "DONE is forbidden as a status marker. Use the RunStatus enum.",
    ),
    (
        r"\bWebSocket\b",
        "regex",
        "WebSocket is forbidden. Run push uses SSE.",
    ),
    (
        r"\bnode\.json\b",
        "regex",
        "The old node.json manifest is forbidden. Use package rules.smk.",
    ),
    (
        r"\bruns\.jsonl\b",
        "regex",
        "runs.jsonl as a second source of truth is forbidden. Truth lives in runs/<id>/run.json.",
    ),
    (
        r"\bsamples\b",
        "regex",
        "The samples concept is forbidden (legacy TDEaseNext domain term).",
    ),
    (
        r"\bWorkflowSpec\b",
        "regex",
        "A homegrown WorkflowSpec DSL is forbidden. Write Snakemake Snakefiles directly.",
    ),
    (
        r"\bworkflow_spec\b",
        "regex",
        "workflow_spec module references are forbidden.",
    ),
    (
        r"\bLocalBackend\b",
        "regex",
        "Dual backends are forbidden. Desktop starts the same FastAPI.",
    ),
    (
        r"\bWorkspaceBackend\b",
        "regex",
        "WorkspaceBackend references are forbidden.",
    ),
    (
        r"\bsynthetic.?event\b",
        "regex",
        "Synthetic events are forbidden. Events come only from events.jsonl appends.",
    ),
]

# --- Exclusions (non-source files) ---
EXCLUDE_DIRS: set[str] = {
    ".git", ".claude", "node_modules", "__pycache__",
    ".venv", "venv", "dist", "build",
    "downloads", "server-data", "test-results",
}

EXCLUDE_SUFFIXES: set[str] = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg",
    ".woff", ".woff2", ".ttf", ".eot",
    ".db", ".sqlite3", ".sqlite", ".zst", ".gz", ".zip",
    ".tar", ".bin", ".exe", ".dll", ".so", ".dylib",
    ".log", ".out.log", ".lock", ".yaml.lock",
}

EXCLUDE_FILE_NAMES: set[str] = {
    "pnpm-lock.yaml",
    "package-lock.json",
    "forbidden_baseline.txt",
}

# Exclude files whose paths start with these prefixes
EXCLUDE_PATH_PREFIXES: tuple[str, ...] = (
    # Design docs reference forbidden terms to explain decisions
    "docs/design/",
    # Plan/log files
    "findings.md",
    "progress.md",
    "task_plan.md",
    # Development logs
    "TDEase-FrontEnd/vite-",
    "TDEase-FrontEnd/vite-dev-",
    "TDEase-FrontEnd/vite-polish",
    # openspec archives
    "openspec/",
    "TDEase-FrontEnd/openspec/",
    # Legacy tests (to be rewritten in Phase 1)
    "tests/e2e/",
    # The migrator — must reference old concepts to perform the conversion
    "cli/migrate.py",
)

FORBIDDEN_SELF = Path(__file__).name


def _should_skip(rel_path: str) -> bool:
    """Decide whether a file should be skipped during scanning."""
    # Directory exclusions
    parts = set(Path(rel_path).parts)
    if parts & EXCLUDE_DIRS:
        return True
    # File-name exclusions
    fname = Path(rel_path).name
    if fname in EXCLUDE_FILE_NAMES or fname == FORBIDDEN_SELF:
        return True
    # Suffix exclusions
    if Path(rel_path).suffix in EXCLUDE_SUFFIXES:
        return True
    # Path-prefix exclusions (Windows-compatible: normalize to /)
    normalized = rel_path.replace("\\", "/")
    for prefix in EXCLUDE_PATH_PREFIXES:
        if normalized.startswith(prefix):
            return True
    return False


def scan() -> dict[str, set[str]]:
    """
    Scan the codebase; returns { "file:line:pattern_hash": explanation }.
    Keys are used for baseline comparison.
    """
    hits: dict[str, str] = {}

    for fp in ROOT.rglob("*"):
        if not fp.is_file():
            continue

        try:
            rel = str(fp.relative_to(ROOT))
        except ValueError:
            continue

        if _should_skip(rel):
            continue

        # Only read text files
        try:
            text = fp.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue

        for lineno, line in enumerate(text.splitlines(), start=1):
            for pattern, ptype, explanation in FORBIDDEN:
                if ptype == "regex" and re.search(pattern, line):
                    key = f"{rel}:{lineno}:{_hash8(pattern)}"
                    hits[key] = explanation

    return hits


def _hash8(s: str) -> str:
    return hashlib.md5(s.encode()).hexdigest()[:8]


def load_baseline() -> set[str]:
    """Load the baseline (key lines only; skip comments and empty lines)."""
    if not BASELINE_FILE.exists():
        return set()
    lines = BASELINE_FILE.read_text(encoding="utf-8").splitlines()
    return {line.strip() for line in lines if line.strip() and not line.startswith("#")}


def save_baseline(hits: dict[str, str]) -> None:
    """Save the baseline file."""
    lines = [
        "# Forbidden-search baseline — known violations to be resolved in Phase 1-5.",
        "# Generated by: python scripts/forbidden_search.py --baseline",
        "# Each line = file:line:pattern_hash",
        "# Remove lines as you fix violations; CI fails on any NEW line not in this file.",
        "",
    ]
    for key in sorted(hits):
        lines.append(key)
    BASELINE_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Baseline written: {len(hits)} entries → {BASELINE_FILE}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Forbidden-search gate")
    parser.add_argument(
        "--all", action="store_true",
        help="list all violations (incl. baseline)",
    )
    parser.add_argument(
        "--baseline", action="store_true",
        help="regenerate the baseline file",
    )
    args = parser.parse_args()

    hits = scan()

    if args.baseline:
        save_baseline(hits)
        return 0

    baseline = load_baseline()

    if args.all:
        print(f"All hits ({len(hits)} total, {len(baseline)} in baseline):\n")
        for key in sorted(hits):
            marker = "  [BASELINE]" if key in baseline else "  [NEW]"
            print(f"{marker} {key}")
        return 0

    # Normal mode: report net-new violations only
    new_hits = {k: v for k, v in hits.items() if k not in baseline}
    resolved = [k for k in baseline if k not in hits]

    if resolved:
        print(f"Resolved from baseline: {len(resolved)}")
        for k in sorted(resolved):
            print(f"  - {k}")

    if not new_hits:
        print(f"forbidden-search gate: PASS ({len(hits)} total, {len(baseline)} baseline, 0 new)")
        return 0

    print(f"\nFORBIDDEN-SEARCH GATE: FAIL — {len(new_hits)} new violation(s):\n")
    for key in sorted(new_hits):
        print(f"  {key}")
        print(f"    reason: {new_hits[key]}\n")
    print(f"Fix: resolve violations or update baseline with --baseline")
    return 1


if __name__ == "__main__":
    sys.exit(main())
