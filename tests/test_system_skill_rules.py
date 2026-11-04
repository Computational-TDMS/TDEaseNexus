"""Shipped skill structure and accidental acceptance-case contamination checks.

These checks do not validate scientific reasoning or require policy wording
to be repeated in multiple prompt layers.
"""

from pathlib import Path


ROOT = Path(__file__).parents[1]
SKILLS = ROOT / "tdease-ai-capability" / "system" / "skills"


def test_system_skills_are_rules_not_private_runner_manuals() -> None:
    for skill_file in SKILLS.glob("*/SKILL.md"):
        text = skill_file.read_text(encoding="utf-8")
        frontmatter = text.split("---", 2)[1]
        keys = {
            line.split(":", 1)[0].strip()
            for line in frontmatter.splitlines()
            if ":" in line
        }
        assert keys == {"name", "description"}, skill_file


def test_skills_never_hardcode_an_ion_series_default() -> None:
    """The agent derives ion series from the observed fragmentation mode; a
    skill doc must not pre-commit to c-ions (the old ETD-only default)."""
    for skill_file in SKILLS.rglob("*.md"):
        text = skill_file.read_text(encoding="utf-8").lower()
        assert '"iontypes":["c"' not in text, skill_file
        assert "--ion-type c" not in text, skill_file


def test_opensearch_skill_is_blind_to_case_truth() -> None:
    """Candidate discovery must not carry the answer: the OpenSearch-facing
    skill text stays free of case-specific chemistry tokens."""
    root = SKILLS / "tdp-opensearch"
    text = "\n".join(path.read_text(encoding="utf-8") for path in root.rglob("*.md")).lower()
    forbidden = (
        "bromo", "phospho", "br-rich", "79br", "81br", "78.91 da",
        "77.91 da", "+317", "myristoyl", "palmitoyl",
    )
    assert not any(token in text for token in forbidden)


def test_focused_skills_do_not_embed_acceptance_case_answers() -> None:
    """Focused skills may explain a method but must not preload the carrier,
    background, sites, or chemistry used to accept that method."""
    # structure-evidence is scanned too: its reference-structures data dir was
    # the one route a real acceptance case (AF-C6T4V4) slipped through as
    # "reference data" — text scans alone are not the whole surface.
    roots = (
        SKILLS / "isoforma",
        SKILLS / "tdp-copilot",
        SKILLS / "spectral-evidence",
        SKILLS / "structure-evidence",
    )
    text = "\n".join(
        path.read_text(encoding="utf-8")
        for root in roots
        for path in root.rglob("*")
        if path.suffix.lower() in {".md", ".py", ".json"}
    ).lower()
    forbidden = (
        "p50566", "79:methyl", "84:oxidation", "chlamy",
        "c6t4v4", "q2kmj4", "+317", "121.9", "5,8,12,16",
        "histone48", "f67", "y88", "scan1164",
    )
    assert not any(token in text for token in forbidden)
