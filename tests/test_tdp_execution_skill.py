"""Tests for the tdp-execution skill (TDP pipeline selection + node manuals).

The skill carries byte-copies of the runnable templates so a walkthrough
never leaves the skill tree; `system/templates/` stays the single
authority, and the copies must move in the same commit as any authoritative
template change (the templates/README.md states this; the test enforces it).
"""
from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SKILL = ROOT / "tdease-ai-capability" / "system" / "skills" / "tdp-execution"
TEMPLATES = ROOT / "tdease-ai-capability" / "system" / "templates"


@pytest.mark.parametrize("template_id", ["toppic-raw-pipeline", "informed-proteomics-pipeline"])
def test_skill_template_copies_are_in_sync(template_id: str) -> None:
    for name in ("Snakefile", "config.yaml", "template.json"):
        authority = TEMPLATES / template_id / name
        copy = SKILL / "templates" / template_id / name
        assert authority.is_file(), f"authoritative template missing: {template_id}/{name}"
        assert copy.read_bytes() == authority.read_bytes(), (
            f"tdp-execution skill copy of {template_id}/{name} drifted from "
            "system/templates — refresh the copy in the same commit"
        )


def test_skill_names_every_pipeline_template_it_copies() -> None:
    """The selection table in SKILL.md must cover the copies: a template
    added to the skill without a selection-table entry is unrouteable."""
    text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
    for template_id in ("toppic-raw-pipeline", "informed-proteomics-pipeline"):
        assert template_id in text, f"SKILL.md selection table lacks {template_id}"
