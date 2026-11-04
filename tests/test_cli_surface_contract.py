"""CLI behavior guards on the live `tdeasenexus-toolbox` binary.

The snapshot inventory guard was removed (2026-10-13): it pinned the full
command/flag list, went stale on every legitimate kernel change while
guarding nothing behavioral, and the recorded snapshot drifted from the
shipped binary. What remains asserts the spec's hard boundaries against
live `--help` output and real invocations:

1. ``test_spec_invariants_hold_on_the_live_surface`` — fit-envelope exposes
   no offset parameter (RUST-MS-CONTRACT "Coordinate rules"), and fragment
   match writes its full tables through ``--evidence-out``.
2. ``test_evidence_lattice_holds_on_the_live_binary`` — the isotope-shape
   lattice behavior on mass-only tags.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# The shipped product is per-platform; prefer the binary this host can execute.
_TOOLBOX_NAMES = (
    ("tdeasenexus-toolbox.exe", "tdeasenexus-toolbox")
    if sys.platform == "win32"
    else ("tdeasenexus-toolbox", "tdeasenexus-toolbox.exe")
)


def _ms_bin() -> str:
    product_dir = ROOT / "tdease-ai-capability" / "system" / "tools"
    for name in _TOOLBOX_NAMES:
        product = product_dir / name
        if product.is_file():
            return str(product)
    for profile in ("debug", "release"):
        for name in _TOOLBOX_NAMES:
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
    """archive/docs-prune-2026-10-12/docs/design/hypothesis-evidence-lattice.md (accepted 2026-08-27, archived 2026-10-12):
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


def test_refinement_keeps_the_declared_mass_basis_across_entry_points(tmp_path):
    """Selecting a later isotope must not move the extraction away from M0."""
    import base64
    import json
    import struct

    def invoke(*args):
        completed = subprocess.run([_ms_bin(), *map(str, args)],
                                   capture_output=True, text=True)
        assert completed.returncode == 0, completed.stderr
        return json.loads(completed.stdout)["result"]

    sequence = "ACDEFGHIKLMNPQRSTVWY"
    base = invoke("theory", "--proforma", sequence, "--charge", 3)
    modified = invoke("parse-proforma", "--proforma", f"[Acetyl]-{sequence}")
    residual = modified["monoisotopicMass"] - base["monoisotopicMass"]
    peaks = [{"mz": p["mz"] + residual / 3, "intensity": p["intensity"] * 1e6}
             for p in base["anchored"]["peaks"]]
    template = ROOT / "tdease-ai-capability/rust/toolbox/fixtures/chlamy-h4-scan4113-z11.mzML"
    xml = template.read_text(encoding="utf-8")
    xml = re.sub(r'defaultArrayLength="\d+"', f'defaultArrayLength="{len(peaks)}"', xml)
    arrays = iter(base64.b64encode(struct.pack(
        "<" + "d" * len(peaks), *(p[key] for p in peaks),
    )).decode() for key in ("mz", "intensity"))
    xml = re.sub(r"<binary>.*?</binary>", lambda _: f"<binary>{next(arrays)}</binary>", xml)
    mzml = tmp_path / "synthetic.mzML"
    mzml.write_text(xml, encoding="utf-8")
    observed = tmp_path / "observed.json"
    observed.write_text(json.dumps(peaks), encoding="utf-8")
    args = ["refine-shift", mzml, "--proforma", sequence, "--mod-mass", residual,
            "--prior-shift", residual, "--mz", peaks[-1]["mz"], "--charge", 3]
    single = invoke(*args)
    reused = invoke(*args, "--observed", observed)
    request = tmp_path / "requests.json"
    request.write_text(json.dumps([{
        "id": "example", "sequence": sequence, "modificationMass": residual,
        "priorShift": residual, "mz": peaks[-1]["mz"], "charge": 3,
        "rtMin": -1, "rtMax": 1,
    }]), encoding="utf-8")
    batch = invoke("refine-shift-batch", mzml, "--input", request)["results"][0]
    assert batch["ok"], batch
    assert single["observed"] == batch["result"]["observed"]
    for result in (single, reused, batch["result"]):
        assert result["matchedPeaks"] >= 4
        assert abs(result["refinedShiftAfterDeclared"] - residual) < 0.001
        assert any("mass-only" in warning for warning in result["warnings"])


def test_batch_combination_search_preserves_global_and_branch_fixed_components(tmp_path):
    import json

    def invoke(*args):
        run = subprocess.run([_ms_bin(), *map(str, args)], capture_output=True, text=True)
        assert run.returncode == 0, run.stderr
        return json.loads(run.stdout)["result"]

    base = invoke("parse-proforma", "--proforma", "ACDMK")["monoisotopicMass"]
    modified = invoke("parse-proforma", "--proforma", "[Acetyl]-ACDM[Oxidation]K")
    target = modified["monoisotopicMass"] - base
    rows = [{"id": "open", "mass": target, "tolerance": 0.001},
            {"id": "conditional", "mass": target, "tolerance": 0.001,
             "fixedMods": ["Acetyl"]}]
    path = tmp_path / "branches.json"
    path.write_text(json.dumps(rows), encoding="utf-8")
    batch = invoke("unimod-batch-solve", "--input", path, "--fixed-mod", "Oxidation",
                   "--max-modifications", 2)
    for row in batch["queries"]:
        assert "Oxidation" in row["fixedMods"]
        expected = ["Oxidation"] + (["Acetyl"] if row["id"] == "conditional" else [])
        single = invoke("unimod-solve", "--target-mass", target, "--tolerance", 0.001,
                        "--max-modifications", 2,
                        *(arg for name in expected for arg in ("--fixed-mod", name)))
        single.pop("source", None)  # Batch source metadata belongs to the shared result.
        assert row["solution"] == single
        assert row["solution"]["candidates"]
        for candidate in row["solution"]["candidates"]:
            fixed = {mod["title"] for mod in candidate["modifications"] if mod["fixed"]}
            assert set(expected) <= fixed
