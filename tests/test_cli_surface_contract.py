"""CLI surface guard: the `tdeasenexus-toolbox` command/flag inventory is a contract.

The recurring audit failure mode this pins down: a behaviour fix lands (e.g.
"fit-envelope is offset-0 only") but the dead CLI flag survives every behavior
test, docs drift to a stale command count, and the next audit re-finds the
residue. Two guards:

1. ``test_cli_surface_matches_recorded_inventory`` — the full command list and
   each command's long flags must equal the recorded snapshot below. Adding or
   removing any surface element is a deliberate act: update the snapshot and
   docs/spec/RUST-MS-CONTRACT.md + docs/STATUS.md in the same change.
2. ``test_spec_invariants_hold_on_the_live_surface`` — the spec's hard
   boundaries asserted against live ``--help`` output, independent of the
   snapshot: fit-envelope exposes no offset parameter (RUST-MS-CONTRACT
   "Coordinate rules"), and fragment match writes its full tables through
   ``--evidence-out``.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

INVENTORY: dict[str, list[str]] = {
    "envelope": ["charge", "isotopes", "mass", "rt-max", "rt-min", "tolerance-ppm"],
    "envelope-windows": ["isotopes", "tolerance-ppm", "windows"],
    "fit-envelope": ["match-window-ppm", "observed", "theoretical"],
    "fragment": ["activation", "bin-ppm", "candidate-proformas", "envelope-match", "evidence-out", "ion-types", "max-charge", "max-matches", "min-correlation", "min-intensity", "minimum-abundance-pct", "mode", "neutral-losses", "proforma", "scan", "sequence", "sum-scans", "tolerance-ppm"],
    "fragment-theoretical": ["db", "ion-types", "max-charge", "mods", "neutral-losses", "no-envelope", "out-format", "proforma", "user-db"],
    "inspect": ["digest-full", "max-spectra"],
    "isotopic-batch": ["ignore-below", "truncate-after"],
    "parse-proforma": ["db", "mods", "proforma", "user-db"],
    "refine-shift": ["charge", "match-window-ppm", "mod-formula", "mod-mass", "mods", "mz", "observed", "prior-shift", "proforma", "rt-max", "rt-min", "sequence-mass", "tolerance-ppm"],
    "refine-shift-batch": ["input"],
    "resolve-shift": ["details", "ion-types", "library", "mass-max", "mass-min", "max-candidates", "max-components", "mods", "no-free-shift", "overshoot-window-da", "proforma", "scan", "scorer", "sequence", "shift", "tolerance-ppm"],
    "schema": [],
    "select": ["statement"],
    "spectrum": ["bin-ppm", "charge", "max-peaks", "max-scans", "min-intensity", "mode", "ms-level", "mz", "mz-max", "mz-min", "out-format", "peak-order", "rt-max", "rt-min", "scans", "scans-input", "tolerance", "tolerance-unit"],
    "theory": ["anchor", "charge", "ignore-below", "mods", "proforma", "truncate-after"],
    "unimod-add": ["average-mass", "formula", "mono-mass", "sites", "title", "user-db"],
    "unimod-batch-search": ["approved", "contains", "db", "excludes", "input", "keep-classification", "limit", "residues", "tolerance-unit", "user-db"],
    "unimod-batch-solve": ["allowed-site", "approved", "db", "element-whitelist", "exclude-classification", "fixed-mod", "input", "keep-classification", "limit", "max-distinct", "max-modifications", "no-allow-repeated", "tolerance-unit", "user-db"],
    "unimod-get": ["db", "id", "title", "user-db"],
    "unimod-residues": ["db", "user-db"],
    "unimod-search": ["approved", "contains", "db", "excludes", "keep-classification", "limit", "mass", "residues", "text", "tolerance", "tolerance-unit", "user-db"],
    "unimod-solve": ["allowed-site", "approved", "db", "element-whitelist", "exclude-classification", "fixed-mod", "keep-classification", "limit", "max-distinct", "max-modifications", "no-allow-repeated", "target-mass", "tolerance", "tolerance-unit", "user-db"],
    "validate-precursor": ["charge", "min-matched-peaks", "mods", "proforma", "scan", "tolerance-ppm"],
}


def _ms_bin() -> str:
    product = ROOT / "tdease-ai-capability" / "system" / "tools" / "tdeasenexus-toolbox.exe"
    if product.is_file():
        return str(product)
    for profile in ("debug", "release"):
        for name in ("tdeasenexus-toolbox.exe", "tdeasenexus-toolbox"):
            candidate = ROOT / "tdease-ai-capability" / "rust" / "target" / profile / name
            if candidate.is_file():
                return str(candidate)
    raise RuntimeError("tdeasenexus-toolbox binary not found; build the product or Rust target")


def _help(*args: str) -> str:
    out = subprocess.run(
        [_ms_bin(), *args, "--help"], capture_output=True, text=True, check=True,
    )
    return out.stdout


def _long_flags(help_text: str) -> list[str]:
    return sorted(
        set(
            re.findall(
                r"^\s+(?:-[A-Za-z],\s+)?--([a-z][a-z0-9-]+)(?:[ =<]|$)",
                help_text,
                re.M,
            )
        )
        - {"help"}
    )


def test_cli_surface_matches_recorded_inventory() -> None:
    commands = [
        c for c in re.findall(r"^\s{2}([a-z][a-z0-9-]+)\s{2,}", _help(), re.M)
        if c != "help"
    ]
    live = {c: _long_flags(_help(c)) for c in commands}
    recorded = {c: sorted(flags) for c, flags in INVENTORY.items()}
    assert live == recorded, (
        "tdeasenexus-toolbox CLI surface changed; update this snapshot together with "
        "docs/spec/RUST-MS-CONTRACT.md and docs/STATUS.md in the same change"
    )


def test_spec_invariants_hold_on_the_live_surface() -> None:
    # RUST-MS-CONTRACT §Coordinate rules: an isotope offset is peak indexing,
    # not a mass correction — fit-envelope exposes no offset parameter at all.
    fit_flags = _long_flags(_help("fit-envelope"))
    assert not [f for f in fit_flags if "offset" in f or "prior" in f], fit_flags
    for command in ("refine-shift", "validate-precursor", "theory"):
        assert "max-offset" not in _long_flags(_help(command)), command
    # §Public analysis operations: fragment matching writes its full match
    # tables to an evidence artifact, never to stdout.
    assert "evidence-out" in _long_flags(_help("fragment"))


def test_evidence_lattice_holds_on_the_live_binary() -> None:
    """docs/design/hypothesis-evidence-lattice.md (accepted 2026-08-27):
    operations that assert an isotope shape reject numeric mass-only tags;
    ladder/position operations accept them, label the massDelta rung, and
    degrade the envelope to the declared averagine approximation."""
    import json as _json

    mass_only = "PEP[+79.9663]TIDE"
    # Shape-asserters reject massDelta outright.
    for command, extra in (
        ("theory", ["--charge", "1"]),
        ("validate-precursor", ["unused.mzML", "--scan", "1", "--charge", "2"]),
    ):
        out = subprocess.run(
            [_ms_bin(), command, "--proforma", mass_only, *extra],
            capture_output=True, text=True,
        )
        assert out.returncode != 0, f"{command} must reject a mass-only hypothesis"
        assert "mass-only" in out.stderr or "isotope" in out.stderr, command
    # Ladder operation accepts the same hypothesis and says what it tested.
    out = subprocess.run(
        [_ms_bin(), "fragment-theoretical", "--proforma", mass_only,
         "--ion-types", "B", "--max-charge", "1"],
        capture_output=True, text=True,
    )
    assert out.returncode == 0, out.stderr
    result = _json.loads(out.stdout)["result"]
    assert result["hypothesisType"] == "massDelta"
    assert any("averagine" in warning for warning in result["warnings"]), (
        "the envelope degradation must be declared, not silent"
    )
