#!/usr/bin/env python3
"""Derive release dependencies from Skill scripts' PEP 723 metadata."""

from __future__ import annotations

import argparse
import json
import tomllib
from pathlib import Path


def read_script_metadata(path: Path) -> dict:
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    try:
        start = lines.index("# /// script") + 1
        end = lines.index("# ///", start)
    except ValueError:
        return {}

    payload = []
    for line in lines[start:end]:
        if not line.startswith("#"):
            raise ValueError(f"invalid PEP 723 metadata line in {path}: {line!r}")
        payload.append(line[1:].lstrip())
    return tomllib.loads("\n".join(payload))


def collect(skills_dir: Path) -> tuple[list[str], dict[str, list[str]]]:
    scripts: dict[str, list[str]] = {}
    dependencies: set[str] = set()
    for script in sorted(skills_dir.glob("*/scripts/*.py")):
        metadata = read_script_metadata(script)
        if not metadata:
            continue
        declared = list(metadata.get("dependencies", []))
        relative = script.relative_to(skills_dir).as_posix()
        scripts[relative] = declared
        dependencies.update(declared)
    return sorted(dependencies, key=str.casefold), scripts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skills-dir", type=Path, required=True)
    parser.add_argument("--requirements-out", type=Path, required=True)
    parser.add_argument("--manifest-out", type=Path, required=True)
    args = parser.parse_args()

    dependencies, scripts = collect(args.skills_dir)
    args.requirements_out.parent.mkdir(parents=True, exist_ok=True)
    args.manifest_out.parent.mkdir(parents=True, exist_ok=True)
    args.requirements_out.write_text(
        "".join(f"{requirement}\n" for requirement in dependencies), encoding="utf-8"
    )
    args.manifest_out.write_text(
        json.dumps({"dependencies": dependencies, "scripts": scripts}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"collected {len(dependencies)} dependencies from {len(scripts)} Skill scripts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
