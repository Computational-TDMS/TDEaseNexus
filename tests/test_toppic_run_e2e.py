"""Exercise the skill entry point, saved calibration, and report-only path."""
import json
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pytest

SCRIPTS = (Path(__file__).resolve().parents[1] / "tdease-ai-capability/system"
           / "skills/toppicr-py/scripts")


def invoke(script, *args):
    result = subprocess.run([sys.executable, str(SCRIPTS / script), *map(str, args)],
                            capture_output=True, text=True, timeout=120, check=False)
    assert result.returncode == 0, result.stderr
    return result.stdout


@pytest.mark.parametrize("table_format", ["csv", "parquet"])
def test_pipeline_to_report_preserves_calibration(tmp_path, table_format):
    fasta = tmp_path / "db.fasta"
    sequences = ["ACDEFGHIK" + "A" * i for i in range(1, 9)]
    fasta.write_text("".join(f">sp|P{i}|G{i} GN=G{i}\n{seq}\n"
                             for i, seq in enumerate(sequences)), encoding="utf-8")
    inputs = []
    for sample in range(3):
        rows = []
        for i, sequence in enumerate(sequences):
            for repeat in range(2):
                mass = 1200 + i * 71
                rows.append({
                    "Data file name": f"S{sample}_ms2.msalign", "#peaks": 10,
                    "Prsm ID": i * 2 + repeat, "Scan(s)": i * 2 + repeat,
                    "Retention time": 10 + i, "Charge": 3,
                    "Precursor mass": mass + .002 * (i + repeat + sample),
                    "Adjusted precursor mass": mass,
                    "Feature intensity": 1000 + i * 100 + repeat,
                    "Feature apex time": 10 + i + sample * .1 + .003 * i * i * sample,
                    "#Protein hits": 1, "Protein accession": f"sp|P{i}|G{i}",
                    "Protein description": f"Synthetic GN=G{i}",
                    "Special amino acids": "-", "Proteoform": f".{sequence}.",
                    "#unexpected modifications": 0, "MIScore": 1,
                    "E-value": 1e-12,
                })
        path = tmp_path / f"S{sample}_ms2_toppic_prsm.tsv"
        pd.DataFrame(rows).to_csv(path, sep="\t", index=False)
        inputs.extend(["--ms2", path])
    output = tmp_path / "result with spaces"
    summary = json.loads(invoke("toppic_run.py", "--fasta", fasta, *inputs,
                                f"--output-dir={output}", "--format", table_format))
    manifest = json.loads(Path(summary["manifest"]).read_text())
    calibration_path = output / manifest["outputs"]["calibration"]
    calibration = (pd.read_parquet(calibration_path) if table_format == "parquet"
                   else pd.read_csv(calibration_path))
    assert len(calibration) == manifest["stage_metrics"]["recalibrate_ms2"]["rows"]
    assert calibration["mass_reference"].all()
    assert (calibration["recal_mass"] != calibration["precursor_mass"]).any()
    assert Path(summary["report"]).is_file()
    assert manifest["calibration"]["reference_dataset"] in calibration["dataset"].values

    # Raw inputs are unavailable to report-only. Saved values, not a refit,
    # must determine the calibration panel.
    for path in tmp_path.glob("*.tsv"):
        path.unlink()
    calibration["rt_align"] = calibration["feature_apex"] + 123.25
    if table_format == "parquet":
        calibration.to_parquet(calibration_path)
    else:
        calibration.to_csv(calibration_path, index=False)
    rendered = json.loads(invoke("toppic_plot.py", "report", "--project", output))
    html = Path(rendered["report"]).read_text(encoding="utf-8")
    assert "123.25" in html
    assert "Applied RT correction" in html
    assert not any(s.get("status") == "error" for s in rendered["sections"])


def test_help_and_legacy_report_without_calibration(tmp_path):
    help_text = invoke("toppic_run.py", "--help")
    assert "--fdr-threshold" in help_text and "--output-dir" in help_text
    pd.DataFrame({"S1": [1, 2], "S2": [2, 3]}).to_csv(tmp_path / "expression.csv")
    summary = json.loads(invoke("toppic_plot.py", "report", "--project", tmp_path))
    sections = {section["id"]: section for section in summary["sections"]}
    assert sections["rt-alignment"]["status"] == "skipped"
    assert sections["mass-error"]["status"] == "skipped"
    (tmp_path / "run_manifest.json").write_text(
        json.dumps({"outputs": {"calibration": "missing.csv"}}), encoding="utf-8")
    broken = json.loads(invoke("toppic_plot.py", "report", "--project", tmp_path))
    sections = {section["id"]: section for section in broken["sections"]}
    assert sections["rt-alignment"]["status"] == "error"
    assert sections["mass-error"]["status"] == "error"
    assert sections["completeness"]["status"] != "error"


def test_comparison_rejects_overlapping_sample_groups(tmp_path):
    expression = tmp_path / "expression.csv"
    features = tmp_path / "features.csv"
    pd.DataFrame({"A1": [10], "A2": [20], "B1": [30], "B2": [40]},
                 index=["F1"]).to_csv(expression)
    pd.DataFrame({"feature_id": ["F1"]}).to_csv(features, index=False)
    completed = subprocess.run([
        sys.executable, str(SCRIPTS / "toppic_plot.py"), "compare",
        "--expression", str(expression), "--features", str(features),
        "--group-a", "A|B", "--group-b", "B",
        "--normalize", "none", "--stats", "welch",
    ], capture_output=True, text=True, check=False)
    assert completed.returncode != 0
    assert "overlap" in completed.stderr.lower()


def test_require_unexpected_fails_loudly_without_the_column(tmp_path):
    """--require-unexpected over a features.csv that lacks n_unexpected_mods
    must refuse: a silent zero-default would return an empty candidate list
    and present it as the finding "no modified features exist"."""
    expression = tmp_path / "expression.csv"
    features = tmp_path / "features.csv"
    pd.DataFrame({"A1": [10], "A2": [20], "B1": [30], "B2": [40]},
                 index=["F1"]).to_csv(expression)
    pd.DataFrame({"feature_id": ["F1"], "rt": [1.0]}).to_csv(features, index=False)
    completed = subprocess.run([
        sys.executable, str(SCRIPTS / "toppic_plot.py"), "compare",
        "--expression", str(expression), "--features", str(features),
        "--group-a", "A", "--group-b", "B",
        "--normalize", "none", "--stats", "welch",
        "--require-unexpected",
    ], capture_output=True, text=True, check=False)
    assert completed.returncode != 0
    assert "n_unexpected_mods" in (completed.stderr + completed.stdout)
