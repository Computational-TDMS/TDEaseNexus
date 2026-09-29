"""E2E anchors for the spectral-evidence visualization entries on the real
histone48 scan.

Pins the agent-facing stdout contracts of the two entries against the
git-tracked scan-1164 fixtures (the same blocks the Rust kernel tests in
``rust/toolbox/tests/{error_map_reproduction,msalign_reproduction}.rs`` pin
from the other side — matched counts here must track those tests, which run
the identical matcher invocation at --max-charge 14):

- ``ms2_visualize.py --mzml --candidates`` (``oneflow-discrimination``,
  and ``--proforma`` as arity-1 sugar — every raw-mzML view is this full
  figure): canonical Bromo Y88 vs Phospho Y88 numbers, including the
  LOCAL-continuity discriminator (Phospho z17-z29 missing run) that totals
  alone do not show;
- ``ms2_visualize.py --msalign --proforma`` (standard ``fragment-annotation``):
  charge-aware neutral-mass matching, per-model annotation numbers;
- ``ms2_visualize.py --mzml --candidates`` (``oneflow-discrimination``):
  dual/single-candidate totals and missing runs;
- ``ms1_visualize.py --refine``: envelope metrics pass through untouched.

Error contract: bad input -> one ``{"error": {...}}`` JSON on stdout and
exit code 1.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_SYSTEM_ROOT_ENV = os.environ.get("TDEASE_SYSTEM_ASSETS")
SYSTEM_ROOT = Path(_SYSTEM_ROOT_ENV) if _SYSTEM_ROOT_ENV else (
    ROOT / "tdease-ai-capability" / "system"
)
SPECTRAL_EVIDENCE = SYSTEM_ROOT / "skills/spectral-evidence/scripts"
# The same git-tracked fixtures the Rust reproduction tests use.
FIXTURES = SYSTEM_ROOT.parent / "rust/toolbox/fixtures"
MZML = FIXTURES / "histone48-scan1164.mzML"
MSALIGN = FIXTURES / "histone48-scan1164.msalign"

BR_PROFORMA = (
    "[Acetyl]-SGRGKGGKGLGKGGAKRHRK[Dimethyl]VLRDNIQGITKPAIRRLARRGGVKRISGLIYEETRGVLK"
    "VFLENVIRDAVTYTEHAKRKTVTAM[Oxidation]DVVY[Bromo]ALKRQGRTLYGFGG"
)
PHOS_PROFORMA = BR_PROFORMA.replace("[Bromo]", "[Phospho]")


def run_renderer(script: Path, *args: str) -> dict:
    completed = subprocess.run(
        ["uv", "run", "--script", str(script), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    payload = json.loads(completed.stdout) if completed.stdout else {}
    return {"returncode": completed.returncode, "payload": payload}


def test_fixtures_are_committed_and_readable() -> None:
    assert MZML.is_file() and MZML.stat().st_size > 10_000
    assert MSALIGN.is_file()
    text = MSALIGN.read_text(encoding="utf-8")
    assert "SCANS=1164" in text and "ACTIVATION=ETD" in text


def test_raw_mzml_single_model_canonical(tmp_path: Path) -> None:
    # --proforma is arity-1 sugar: the SAME full figure, one candidate, and
    # the same kernel invocation the Rust reproduction test pins.
    out_br = tmp_path / "br.html"
    out_phos = tmp_path / "phos.html"
    br = run_renderer(
        SPECTRAL_EVIDENCE / "ms2_visualize.py",
        "--mzml", str(MZML), "--scan", "1164",
        "--proforma", BR_PROFORMA, "--out", str(out_br),
    )
    phos = run_renderer(
        SPECTRAL_EVIDENCE / "ms2_visualize.py",
        "--mzml", str(MZML), "--scan", "1164",
        "--proforma", PHOS_PROFORMA, "--out", str(out_phos),
    )
    assert br["returncode"] == 0
    br_model = br["payload"]["candidates"][0]
    assert br_model["total"] == 151 and br_model["counts"] == {"c": 58, "z": 33}
    assert phos["returncode"] == 0
    phos_model = phos["payload"]["candidates"][0]
    assert phos_model["total"] == 170 and phos_model["counts"] == {"c": 57, "z": 35}
    # The discriminator is LOCAL continuity, not totals: the wrong chemistry
    # (Phospho) carries the continuous z17-z29 missing run across the
    # crossing region; Bromo keeps hits there (its only z gap inside 17-29
    # is 20-22).
    assert {"start": 17, "end": 29, "length": 13} in phos_model["missingRuns"]["z"]
    z_runs_br = br_model["missingRuns"]["z"]
    assert {"start": 20, "end": 22, "length": 3} in z_runs_br
    assert not any(r["start"] <= 17 and r["end"] >= 29 for r in z_runs_br)
    # Artifact quartet lands next to the figure.
    assert out_br.is_file() and out_br.with_suffix(".data.json").is_file()
    assert out_br.with_suffix(".manifest.json").is_file()
    assert (tmp_path / "br_match_model.json").is_file()


def test_msalign_annotation_br_vs_phos(tmp_path: Path) -> None:
    br = run_renderer(
        SPECTRAL_EVIDENCE / "ms2_visualize.py",
        "--msalign", str(MSALIGN), "--scan", "1164",
        "--proforma", BR_PROFORMA, "--out", str(tmp_path / "br.html"),
    )
    phos = run_renderer(
        SPECTRAL_EVIDENCE / "ms2_visualize.py",
        "--msalign", str(MSALIGN), "--scan", "1164",
        "--proforma", PHOS_PROFORMA, "--out", str(tmp_path / "phos.html"),
    )
    # Per-model annotation on the deconvoluted domain (NOT discrimination):
    # Bromo plain-z has no matches here (TopFD reports the radical z species);
    # Phos's z positions are borrow coincidences — both pinned as-is.
    assert br["returncode"] == 0
    assert br["payload"]["peaks"] == 60 and br["payload"]["matchedFragments"] == 60
    assert br["payload"]["coverage"] == pytest.approx(0.4158415841584158)
    assert phos["returncode"] == 0
    assert phos["payload"]["peaks"] == 90 and phos["payload"]["matchedFragments"] == 90
    assert phos["payload"]["coverage"] == pytest.approx(0.46534653465346537)
    # One stdout surface: "figure" is the resolved HTML path in every route.
    assert phos["payload"]["figure"] == str((tmp_path / "phos.html").resolve())


def test_oneflow_dual_and_single_candidate(tmp_path: Path) -> None:
    candidates = json.dumps([
        {"id": "br", "label": "Bromo Y88", "proforma": BR_PROFORMA},
        {"id": "phos", "label": "Phospho Y88", "proforma": PHOS_PROFORMA},
    ])
    dual = run_renderer(
        SPECTRAL_EVIDENCE / "ms2_visualize.py",
        "--mzml", str(MZML), "--scan", "1164",
        "--candidates", candidates, "--focus-site", "88",
        "--out", str(tmp_path / "dual.html"),
    )
    assert dual["returncode"] == 0
    by_id = {c["id"]: c for c in dual["payload"]["candidates"]}
    assert by_id["br"]["total"] == 151
    assert by_id["phos"]["total"] == 170
    assert {"start": 17, "end": 29, "length": 13} in by_id["phos"]["missingRuns"]["z"]
    assert {"start": 88, "end": 99, "length": 12} in by_id["br"]["missingRuns"]["c"]

    single = run_renderer(
        SPECTRAL_EVIDENCE / "ms2_visualize.py",
        "--mzml", str(MZML), "--scan", "1164",
        "--candidates", json.dumps([{"id": "br", "label": "Bromo Y88",
                                     "proforma": BR_PROFORMA}]),
        "--out", str(tmp_path / "single.html"),
    )
    assert single["returncode"] == 0
    assert single["payload"]["candidates"][0]["total"] == 151


def test_oneflow_infers_etd_and_writes_default_report(tmp_path: Path) -> None:
    candidates = json.dumps([
        {"id": "br", "label": "Bromo Y88", "proforma": BR_PROFORMA},
        {"id": "phos", "label": "Phospho Y88", "proforma": PHOS_PROFORMA},
    ])
    completed = subprocess.run(
        [
            "uv", "run", "--script",
            str(SPECTRAL_EVIDENCE / "ms2_visualize.py"),
            "--mzml", str(MZML), "--scan", "1164",
            "--candidates", candidates,
        ],
        cwd=tmp_path,
        text=True,
        capture_output=True,
        check=False,
    )
    payload = json.loads(completed.stdout)
    assert completed.returncode == 0 and payload["candidates"]
    report = tmp_path / "histone48-scan1164-scan1164-comparison.html"
    assert report.is_file()
    manifest = json.loads(report.with_suffix(".manifest.json").read_text(encoding="utf-8"))
    assert manifest["params"]["ion_types"] == "C,Z"
    assert manifest["params"]["tolerance_ppm"] == 10.0
    assert len(manifest["inputs"]) == 3  # mzML, one shared comparison sidecar, data contract


@pytest.mark.parametrize("script,args", [
    ("ms2_visualize.py",
     ("--mzml", str(MZML), "--scan", "99999", "--proforma", BR_PROFORMA)),
    ("ms2_visualize.py",
     ("--mzml", str(MZML), "--scan", "1164", "--candidates", "[]")),
    ("ms2_visualize.py",
     ("--msalign", str(MSALIGN), "--scan", "1164", "--proforma", "SGRG[Bogus]K")),
    # The msalign domain renders one model; candidates are a raw-mzML concept.
    ("ms2_visualize.py",
     ("--msalign", str(MSALIGN), "--scan", "1164",
      "--candidates", '[{"id":"a","proforma":"PEPTIDEK"}]')),
])
def test_error_contract(tmp_path: Path, script: str, args: tuple[str, ...]) -> None:
    result = run_renderer(
        SPECTRAL_EVIDENCE / script, *args, "--out", str(tmp_path / "err.html"))
    assert result["returncode"] == 1
    assert set(result["payload"]) == {"error"}
    assert result["payload"]["error"]["code"]
    assert result["payload"]["error"]["message"]


def test_missing_required_renderer_args_use_json_error_contract() -> None:
    result = run_renderer(SPECTRAL_EVIDENCE / "ms2_visualize.py")
    assert result["returncode"] == 1
    assert result["payload"]["error"]["code"] == "MS2_VISUALIZE_FAILED"
    assert "use --help" in result["payload"]["error"]["message"]


def test_ms1_theory_overlay_passes_fit_metrics(tmp_path: Path) -> None:
    # The composition flow's natural artifacts: one envelope-extract feature
    # JSON + one theory JSON per candidate (+ one fit-envelope JSON each).
    # The renderer must produce the standard interactive envelope-compare
    # figure and pass the fit numbers through untouched.
    observed = tmp_path / "observed.json"
    observed.write_text(json.dumps({"result": {
        "charge": 14, "mass": 11393.31, "peaks": [
            {"mz": 814.8104 + i * 0.0627, "intensity": 1e6 * (0.6 ** abs(i - 6))}
            for i in range(8)]}}, ensure_ascii=False), encoding="utf-8")

    def write_theory(name: str, offset: float) -> Path:
        path = tmp_path / name
        path.write_text(json.dumps({"result": {
            "envelope": {"charge": 14, "peaks": [
                {"mz": 814.8104 + offset + i * 0.0627,
                 "intensity": 1e6 * (0.6 ** abs(i - 6))} for i in range(8)]}}},
            ensure_ascii=False), encoding="utf-8")
        return path

    theo_a = write_theory("theory_a.json", 0.0)
    theo_b = write_theory("theory_b.json", 0.02)
    fit_a = tmp_path / "fit_a.json"
    fit_a.write_text(json.dumps({"result": {
        "charge": 14, "evaluation": {"pearson": 0.912, "matchedPeaks": 8,
                                     "coverage": 0.99}}}, ensure_ascii=False),
        encoding="utf-8")
    report = tmp_path / "ms1.html"
    result = run_renderer(
        SPECTRAL_EVIDENCE / "ms1_visualize.py",
        "--observed", str(observed),
        "--theory", str(theo_a), "--theory", str(theo_b),
        "--fit", str(fit_a),
        "--theory-label", "A", "--theory-label", "B",
        "--out", str(report),
    )
    assert result["returncode"] == 0, result["payload"]
    assert report.is_file() and report.with_suffix(".data.json").is_file()
    assert result["payload"]["observedPeaks"] == 8
    assert result["payload"]["candidateCount"] == 2
    assert result["payload"]["fits"][0]["pearson"] == 0.912
    assert result["payload"]["candidates"][0]["pearson"] == 0.912

    # charge mismatch between an overlay candidate and the observed feature
    # is a hard error, not a silently wrong figure
    theo_z15 = tmp_path / "theory_z15.json"
    theo_z15.write_text(json.dumps({"result": {
        "envelope": {"charge": 15, "peaks": [{"mz": 762.0, "intensity": 1.0}]}}},
        ensure_ascii=False), encoding="utf-8")
    bad = run_renderer(
        SPECTRAL_EVIDENCE / "ms1_visualize.py",
        "--observed", str(observed), "--theory", str(theo_z15),
        "--out", str(tmp_path / "bad.html"),
    )
    assert bad["returncode"] == 1
    assert "CHARGE_MISMATCH" in bad["payload"]["error"]["message"]


def test_envelope_report_preserves_metrics_without_inventing_qc(tmp_path: Path) -> None:
    source = tmp_path / "measured.json"
    source.write_text(json.dumps({"params": {"charge": 2}, "result": {
        "observed": [{"mz": 500.0, "intensity": 10}, {"mz": 500.5, "intensity": 5}],
        "theoretical": [{"mz": 501.0, "intensity": 10}, {"mz": 501.5, "intensity": 5}],
        "pearson": 0.123, "refinedMass": 998.0, "matchedPeaks": 2,
    }}), encoding="utf-8")
    report = tmp_path / "envelope.html"
    result = run_renderer(SPECTRAL_EVIDENCE / "ms1_visualize.py",
                          "--refine", str(source), "--out", str(report))
    assert result["returncode"] == 0, result["payload"]
    assert result["payload"]["metrics"]["pearson"] == 0.123
    assert report.is_file()
    manifest = report.with_suffix(".manifest.json").read_text(encoding="utf-8")
    for removed in ("spacingQc", "mass_alignment", "systematic_offset_suspected"):
        assert removed not in result["payload"]
        assert removed not in manifest
