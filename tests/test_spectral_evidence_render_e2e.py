"""E2E anchors for the spectral-evidence entry on the real histone48 scan.

Behavioral pins against the git-tracked scan-1164 fixtures: the evidence card
(the only thing the agent reads), the artifact quartet behind it, and the
one-JSON error envelope. Exact match-count pins were removed (2026-10-13):
they went stale on every legitimate matcher change while the Rust kernel
reproduction tests (``rust/toolbox/tests/{error_map_reproduction,
msalign_reproduction}.rs``) already pin the matcher itself, on the same
fixtures, from the other side.

- ``spectral.py measure``: one kernel pass per scan for every model, and the
  verdict comes back on stdout — no sidecar assembly;
- ``spectral.py show``: the separating windows, one panel per model;
- ``spectral.py annotate``: the msalign leads view;
- bad input -> one ``{"error": {...}}`` JSON on stdout and exit code 1.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import shutil
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _ms1_fixture import graft_parent_ms1  # noqa: E402
UV = shutil.which("uv") or str(Path.home() / ".local/bin" / "uv")


ROOT = Path(__file__).resolve().parents[1]
_SYSTEM_ROOT_ENV = os.environ.get("TDEASE_SYSTEM_ASSETS")
SYSTEM_ROOT = Path(_SYSTEM_ROOT_ENV) if _SYSTEM_ROOT_ENV else (
    ROOT / "tdease-ai-capability" / "system"
)
SPECTRAL = SYSTEM_ROOT / "skills/spectral-evidence/scripts/spectral.py"
# The same git-tracked fixtures the Rust reproduction tests use.
FIXTURES = SYSTEM_ROOT.parent / "rust/toolbox/fixtures"
MZML = FIXTURES / "histone48-scan1164.mzML"
MSALIGN = FIXTURES / "histone48-scan1164.msalign"

BR_PROFORMA = (
    "[Acetyl]-SGRGKGGKGLGKGGAKRHRK[Dimethyl]VLRDNIQGITKPAIRRLARRGGVKRISGLIYEETRGVLK"
    "VFLENVIRDAVTYTEHAKRKTVTAM[Oxidation]DVVY[Bromo]ALKRQGRTLYGFGG"
)
PHOS_PROFORMA = BR_PROFORMA.replace("[Bromo]", "[Phospho]")
MODELS = [{"id": "br", "label": "Bromo", "proforma": BR_PROFORMA},
          {"id": "phos", "label": "Phospho", "proforma": PHOS_PROFORMA}]
BARE_SEQUENCE = re.sub(r"\[[^\]]+\]", "", BR_PROFORMA).lstrip("-")
# Where the two models' chemistry actually differs: residue 88.
DIFF_SITE = 88
# bromo (Br-H = 77.9105) vs phospho (HO3P = 79.9663)
COMPOSITION_DELTA_DA = 2.0558183452561707


def run_spectral(*args: str, cwd: Path | None = None) -> dict:
    """Run the entry; stdout is decoded as UTF-8 because the card carries the
    kernel's warnings verbatim and the console code page is not UTF-8 on all
    hosts."""
    completed = subprocess.run(
        [UV, "run", "--script", str(SPECTRAL), *args],
        cwd=cwd or ROOT, capture_output=True, check=False,
    )
    payload = json.loads(completed.stdout.decode("utf-8")) if completed.stdout else {}
    return {"returncode": completed.returncode, "payload": payload,
            "stderr": completed.stderr.decode("utf-8", "replace")}


@pytest.fixture(scope="module")
def card(tmp_path_factory: pytest.TempPathFactory) -> dict:
    """One comparison, measured once: the card is the expensive part and every
    assertion below is about what is in it."""
    out = tmp_path_factory.mktemp("spectral") / "card.json"
    models = out.with_name("models.json")
    models.write_text(json.dumps(MODELS), encoding="utf-8")
    result = run_spectral("measure", "--mzml", str(MZML), "--scan", "1164",
                          "--models", str(models), "--out", str(out))
    assert result["returncode"] == 0, result["stderr"]
    return {"payload": result["payload"], "path": out, "models": models}


def test_fixtures_are_committed_and_readable() -> None:
    assert MZML.is_file() and MZML.stat().st_size > 10_000
    assert MSALIGN.is_file()
    text = MSALIGN.read_text(encoding="utf-8")
    assert "SCANS=1164" in text and "ACTIVATION=ETD" in text


def test_card_is_the_whole_stdout_and_the_same_bytes_on_disk(card) -> None:
    """The agent reads stdout; nothing is assembled from sidecars. A card that
    differed on disk from what was printed would put the handoff and the record
    on different documents."""
    on_disk = json.loads(card["path"].read_text(encoding="utf-8"))
    assert on_disk == card["payload"]
    assert on_disk["card"] == "measure/ms2"


def test_card_reports_the_measurement_it_actually_made(card) -> None:
    observation = card["payload"]["observation"]
    # the series are the acquisition's, not a client-side default
    assert observation["ionTypes"] == "C,Z"
    assert observation["activation"] == "electron transfer dissociation"
    # the charge ceiling is the precursor's own, with its provenance stated
    assert observation["maxCharge"] == 17
    assert observation["maxChargeSource"] == "precursor"
    assert observation["scans"] == ["1164"]
    assert observation["figureScan"] == "1164"
    assert card["payload"]["sequence"] == BARE_SEQUENCE
    assert card["payload"]["length"] == len(BARE_SEQUENCE)
    # every model is measured and named
    assert {model["id"] for model in card["payload"]["models"]} == {"br", "phos"}
    for model in card["payload"]["models"]:
        assert model["bareSequence"] == BARE_SEQUENCE
        assert model["measurement"]["matchedIons"] > 0
        assert model["measurement"]["coverage"] > 0


def test_verdict_locates_the_differing_site_and_measures_its_separation(card) -> None:
    verdict = card["payload"]["verdict"]
    assert verdict["diffSites"] == [DIFF_SITE]
    # how far apart the models' chemistry is, from the kernel's parse of
    # each complete model: bromo (77.9105) vs phospho (79.9663)
    deltas = {row["model"]: row["deltaDa"] for row in verdict["compositionDeltaDa"]}
    assert abs(deltas["phos"] - COMPOSITION_DELTA_DA) < 1e-3
    assert verdict["differingIonKeys"] > 0
    assert verdict["ions"], "a real comparison on this scan must have a verdict"
    for row in verdict["ions"]:
        assert row["role"] in {"discriminator", "noAcceptedMatch"}
        # an ion whose span misses the differing site cannot be evidence about
        # it, and every ion whose prediction differs here DOES span it
        assert row["coversDiffSites"] == [DIFF_SITE]
        assert set(row["matchedBy"]) <= {"br", "phos"}
        assert set(row["cells"]) <= {"br", "phos"}
        for cell in row["cells"].values():
            assert cell["state"]
    # separating ions lead, and a separating ion is matched by ONE model
    first = verdict["ions"][0]
    assert first["role"] == "discriminator" and len(first["matchedBy"]) == 1


def test_card_counts_what_it_did_not_list(card) -> None:
    uninformative = card["payload"]["uninformative"]
    assert uninformative["identicalPrediction"] > 0
    assert uninformative["noModelMatched"] >= 0
    verdict = card["payload"]["verdict"]
    assert len(verdict["ions"]) <= 24
    if verdict["differingIonKeys"] > len(verdict["ions"]):
        assert any("truncated" in warning for warning in card["payload"]["warnings"])


def test_card_discloses_peaks_two_models_claim(card) -> None:
    """A near-isobar pair's isotope combs are offset, so one model's
    monoisotopic fragment can sit on the other's M+2. The same observed peak is
    then claimed twice and supports neither model independently — the card must
    say so, from the kernel's emitted observedMz rather than a re-match."""
    contested = card["payload"]["verdict"]["contestedPeaks"]
    assert contested, "offset combs on a 2.06 Da pair must show contested peaks"
    for peak in contested:
        claims = peak["claims"]
        assert len({(claim["model"], claim["label"]) for claim in claims}) > 1
        for claim in claims:
            assert claim["isotopeOffset"] is not None
    assert any("claimed by more than one" in warning
               for warning in card["payload"]["warnings"])
    assert any("share observed peaks" in step["status"]
               for step in card["payload"]["next"])


def test_card_points_at_its_evidence_and_explains_itself(card) -> None:
    audit = card["payload"]["audit"]
    evidence = Path(audit["evidence"]["path"])
    assert evidence.is_file()
    assert evidence.stat().st_size == audit["evidence"]["size"] > 100_000
    # the artifact is the same document shape as stdout: the full tables in
    # place, the verdict a bounded projection of it
    artifact = json.loads(evidence.read_text(encoding="utf-8"))
    assert artifact["schemaVersion"] == 1
    assert artifact["result"]["comparisons"][0]["scan"] == "1164"
    assert artifact["result"]["comparisons"][0]["measurement"]["candidates"]
    figure = Path(audit["figure"])
    assert figure.is_file()
    manifest = json.loads(Path(audit["figureManifest"]).read_text(encoding="utf-8"))
    assert [c["id"] for c in manifest["params"]["candidates"]] == ["br", "phos"]
    assert manifest["params"]["ion_types"] == "C,Z"
    assert card["payload"]["next"]


def test_one_model_audits_and_says_it_cannot_separate(tmp_path: Path) -> None:
    models = tmp_path / "one.json"
    models.write_text(json.dumps([MODELS[0]]), encoding="utf-8")
    result = run_spectral("measure", "--mzml", str(MZML), "--scan", "1164",
                          "--models", str(models), "--out", str(tmp_path / "one-card.json"))
    assert result["returncode"] == 0, result["stderr"]
    card = result["payload"]
    assert card["verdict"]["ions"] == [] and card["verdict"]["diffSites"] == []
    assert card["models"][0]["measurement"]["matchedIons"] > 0
    assert any("can separate nothing" in warning for warning in card["warnings"])


def test_show_draws_one_panel_per_model_per_ion(tmp_path: Path, card) -> None:
    separating = [row["label"] for row in card["payload"]["verdict"]["ions"]
                  if row["role"] == "discriminator"][:2]
    assert separating
    result = run_spectral("show", str(card["path"]), "--ions", ",".join(separating),
                          "--out", str(tmp_path / "windows.html"))
    assert result["returncode"] == 0, result["stderr"]
    payload = result["payload"]
    assert len(payload["panels"]) == len(separating) * len(MODELS)
    for panel in payload["panels"]:
        # the kernel's verdict and the window's own count are different
        # statistics; the subtitle must not offer either alone
        assert "kernel:" in panel["subtitle"], panel["subtitle"]
        assert "slots" in panel["subtitle"], panel["subtitle"]
    assert len(payload["extractions"]) == len(payload["panels"])
    assert Path(payload["figure"]).is_file()
    for extraction in payload["extractions"]:
        assert Path(extraction).is_file()


def test_annotate_returns_the_msalign_leads_card(tmp_path: Path) -> None:
    out = tmp_path / "annotation.html"
    result = run_spectral("annotate", "--msalign", str(MSALIGN), "--scan", "1164",
                          "--proforma", PHOS_PROFORMA, "--out", str(out))
    assert result["returncode"] == 0, result["stderr"]
    card = result["payload"]
    assert card["card"] == "annotate/msalign"
    assert card["verdict"]["matchedFragments"] > 0
    assert card["verdict"]["coverage"] > 0
    assert out.is_file() and Path(card["audit"]["evidence"]["path"]).is_file()
    # the annotation is leads, not a verdict: it must say so
    assert any("not whether" in step["status"] for step in card["next"])


@pytest.mark.parametrize("args,expected", [
    # a required argument is missing (argparse lands on the JSON contract too)
    (("measure", "--mzml", str(MZML), "--scan", "1164"), "--models"),
    # a scan that does not exist in the file
    (("measure", "--mzml", str(MZML), "--scan", "99999",
      "--models", json.dumps([MODELS[0]])), None),
    # a model list that is not a model list
    (("measure", "--mzml", str(MZML), "--scan", "1164",
      "--models", '{"id": "a"}'), "non-empty JSON array"),
    # an invalid ProForma
    (("annotate", "--msalign", str(MSALIGN), "--scan", "1164",
      "--proforma", "SGRG[Bogus]K"), "Bogus"),
])
def test_error_contract(args: tuple, expected: str | None) -> None:
    result = run_spectral(*args)
    assert result["returncode"] == 1
    assert set(result["payload"]) == {"error"}
    assert result["payload"]["error"]["code"] == "SPECTRAL_FAILED"
    message = result["payload"]["error"]["message"]
    assert message
    if expected:
        assert expected.lower() in message.lower(), result["payload"]


def test_mixed_backbones_degrade_loudly_not_silently(tmp_path: Path) -> None:
    """An off-by-one backbone silently invalidates every per-ion comparison,
    so the comparison is switched off loudly instead: each model keeps its own
    independent measurement and the card declares the absence — nothing is
    refused and no positional mapping is faked."""
    result = run_spectral(
        "measure", "--mzml", str(MZML), "--scan", "1164",
        "--models", json.dumps([{"id": "a", "proforma": BR_PROFORMA},
                                {"id": "b", "proforma": "PEPTIDEK"}]),
        # no --out: the default-named artifacts must land in the test dir, not
        # in the repository root.
        cwd=tmp_path)
    assert result["returncode"] == 0, result["stderr"]
    card = result["payload"]
    assert card["sharedBackbone"] is False
    assert card["ionComparisonAvailable"] is False
    assert card["verdict"]["ions"] == []
    assert any("measured on its own backbone" in note for note in card["warnings"])


def test_show_refuses_a_card_it_cannot_draw(tmp_path: Path) -> None:
    msalign = run_spectral("annotate", "--msalign", str(MSALIGN), "--scan", "1164",
                           "--proforma", PHOS_PROFORMA, "--out", str(tmp_path / "a.html"))
    assert msalign["returncode"] == 0, msalign["stderr"]
    card_path = tmp_path / "a-card.json"
    assert card_path.is_file()
    result = run_spectral("show", str(card_path))
    assert result["returncode"] == 1
    assert "annotate/msalign" in result["payload"]["error"]["message"]


def test_show_requires_an_ion_charge(card) -> None:
    """A bare ion expands to every charge state, so the panel would stop being
    one window."""
    result = run_spectral("show", str(card["path"]), "--ions", "z50")
    assert result["returncode"] == 1
    assert "ION:CHARGE" in result["payload"]["error"]["message"]


def test_ms1_card_binds_each_model_to_the_observed_feature(tmp_path: Path) -> None:
    """The composition route: one observed precursor feature measured against
    each complete model's theoretical envelope, with the mass distance to the
    feature stated per model rather than implied by list order."""
    data = tmp_path / "msdata"
    data.mkdir()
    graft_parent_ms1(MZML, data / "sample.mzML")
    models = tmp_path / "models.json"
    models.write_text(json.dumps(MODELS), encoding="utf-8")
    out = tmp_path / "ms1-card.json"
    result = run_spectral("measure", "--ms1", "--mzml", str(data / "sample.mzML"),
                          "--feature", "f1", "11400.3", "17", "37.7", "37.9",
                          "--models", str(models), "--out", str(out))
    assert result["returncode"] == 0, result["stderr"]
    card = result["payload"]
    assert card["card"] == "measure/ms1"
    feature = card["verdict"]["features"][0]
    assert feature["observedMass"] == 11400.3
    assert feature["charge"] == 17
    assert {row["model"] for row in feature["ranking"]} == {"br", "phos"}
    for row in feature["ranking"]:
        assert isinstance(row["anchorMass"], float)
        # the offset is the model's composition distance from the measured
        # feature mass: auditable, and stated per model
        assert abs(row["anchorOffsetDa"] - (row["anchorMass"] - 11400.3)) < 1e-6
    # the two models' compositions differ by exactly their bromo/phospho delta
    anchors = {row["model"]: row["anchorMass"] for row in feature["ranking"]}
    assert abs((anchors["phos"] - anchors["br"]) - COMPOSITION_DELTA_DA) < 1e-6
    # and the card says what MS1 can and cannot separate
    assert "never" in card["uninformative"]["note"]
    assert Path(card["audit"]["figure"]).is_file()
    assert json.loads(out.read_text(encoding="utf-8")) == card
