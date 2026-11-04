"""Build a fresh H4 comparison from the shipped runner and published references."""
from __future__ import annotations

import csv
import hashlib
import json
import os
import statistics
import subprocess
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
CASE = ROOT / "docs/paper/results/data/certified-cases/chlamy-five-sample-rerun"
OUT = ROOT / "docs/paper/results/current-isoforma-20261008"
RUNNER = ROOT / "tdease-ai-capability/system/skills/isoforma/scripts/isoforma_run.py"
_KERNEL_NAMES = (
    ("tdeasenexus-toolbox.exe", "tdeasenexus-toolbox")
    if os.name == "nt"
    else ("tdeasenexus-toolbox", "tdeasenexus-toolbox.exe")
)
KERNEL = next(
    (
        candidate
        for profile in ("debug", "release")
        for name in _KERNEL_NAMES
        for candidate in (ROOT / "tdease-ai-capability/rust/target" / profile / name,)
        if candidate.is_file()
    ),
    ROOT / "tdease-ai-capability/system/tools" / _KERNEL_NAMES[0],
)
SITES = ["K5", "K8", "K12", "K16"]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    OUT.mkdir(exist_ok=True)
    frozen = json.loads((CASE / "five-sample-rerun-manifest.json").read_text())
    scan_map = CASE / "selection-scan-map.csv"
    point_rows = list(csv.DictReader((CASE / "sample-proportions.csv").open()))
    files = sorted({row["sample"] for row in point_rows})
    ids = {row["sample"]: row["sample_id"] for row in point_rows}
    command = [sys.executable, str(RUNNER), "--mzml-dir",
               str(ROOT / "data/workspace/runs/chlamy-pnnl-batch"),
               "--sequence", frozen["parameters"]["sequence"],
               "--sites", "K,5,8,12,16", "--mod-tag", "Acetyl",
               "--fixed-tags", "N-term:Acetyl,79:Methyl,84:Oxidation",
               "--occupancies", "1", "--feature-scan-map", str(scan_map),
               "--rt-min", "0", "--rt-max", "1000000000", "--activation", "ETD",
               "--ion-types", "c", "--fragment-ppm", "10", "--max-fragment-charge", "4",
               "--min-correlation", "0.7", "--bin-ppm", "5", "--ms-bin", str(KERNEL)]
    for source in files:
        command += ["--source", source + ".mzML"]
    provenance = {"command": command, "runnerSha256": sha(RUNNER), "kernelSha256": sha(KERNEL),
                  "scanMapSha256": sha(scan_map),
                  "selection": "Frozen feature-linked scan union, with current runner precursor-mass and activation gates. RT imposes no additional restriction.",
                  "estimator": "joint conditional beta; formal results only",
                  "sources": [{"path": source + ".mzML", "sampleId": ids[source],
                               "sha256": sha(ROOT / "data/workspace/runs/chlamy-pnnl-batch" / (source + ".mzML"))}
                              for source in files]}
    result_path = OUT / "runner-result.json"
    if result_path.exists():
        recorded = json.loads((OUT / "provenance.json").read_text())
        if any(recorded.get(key) != value for key,value in provenance.items()):
            raise RuntimeError("Cached run inputs or implementation changed; preserve it and choose a new output directory")
        payload = json.loads(result_path.read_text())
    else:
        (OUT / "provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
        print("Running current IsoForma on five files...", flush=True)
        completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
        (OUT / "runner-stderr.txt").write_text(completed.stderr, encoding="utf-8")
        if completed.returncode:
            raise RuntimeError(completed.stderr)
        result_path.write_text(completed.stdout, encoding="utf-8")
        payload = json.loads(completed.stdout)
    formal = []
    rows = []
    for result in payload["results"]:
        sample_id = ids[Path(result["source"]).stem]
        print(sample_id, result["status"], result["acceptedScanCount"], result.get("nRatios"), flush=True)
        if result.get("reportability") == "reportable" and result.get("status") == "solved":
            values = {"K" + str(item["sites"][0][0]): item["fraction"] for item in result["proportions"]}
            assert set(values) == set(SITES)
            assert abs(sum(values.values())-1) < 2e-6
            formal.append((sample_id, values))
            for site in SITES:
                rows.append({"sample_id": sample_id, "site": site, "fraction": values[site],
                             "accepted_scans": result["acceptedScanCount"], "estimator": result["estimator"]})
    with (OUT / "sample-proportions.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, ["sample_id", "site", "fraction", "accepted_scans", "estimator"])
        writer.writeheader()
        writer.writerows(rows)
    if not formal:
        raise RuntimeError("No formally reportable fits; cannot draw a quantitative comparison")
    n = len(formal)
    means = [statistics.fmean(values[site] for _,values in formal) for site in SITES]
    sd = [statistics.stdev(values[site] for _,values in formal) if n > 1 else 0 for site in SITES]
    iso_path = ROOT / "docs/paper/literature/degnan2024-isoforma/fig1b-digitized.json"
    lit_path = ROOT / "docs/paper/results/data/chlamy-literature-figure3b.csv"
    iso_rows = json.loads(iso_path.read_text())
    with lit_path.open(encoding="utf-8-sig") as stream:
        lit_rows = list(csv.DictReader(line for line in stream if not line.startswith("#")))
    iso = [next(row for row in iso_rows if row["iso"] == site) for site in SITES]
    lit = [next(row for row in lit_rows if row["occupancy"] == "1" and row["isomer"] == site) for site in SITES]
    x = np.arange(4)
    fig, ax = plt.subplots(figsize=(10.2, 5.3))
    fig.subplots_adjust(left=.10, right=.98, bottom=.13, top=.80)
    ax.bar(x-.26, means, .24, yerr=sd if n>1 else None, capsize=4, color="#0072B2",
           label=f"This work: current algorithm ({n} files; SD)")
    ax.bar(x, [r["isoforma"] for r in iso], .24,
           yerr=np.array([[r["isoforma"]-r["ci_lo"] for r in iso], [r["ci_hi"]-r["isoforma"] for r in iso]]),
           capsize=4, color="#D55E00", label="IsoForma 2024 (published; 95% CI)")
    ax.bar(x+.26, [float(r["within_pct"])/100 for r in lit], .24,
           yerr=[float(r["within_sd_pct"])/100 for r in lit], capsize=4,
           color="white", edgecolor="#777", hatch="///", label="Rommelfanger 2021 (published; SD)")
    for index, (sample, values) in enumerate(formal):
        ax.scatter(x-.26+(index-(n-1)/2)*.028, [values[site] for site in SITES],
                   color="#222", s=19, edgecolors="white", linewidths=.4, zorder=4)
    ax.set(xticks=x, xticklabels=SITES, ylim=(0,.85), ylabel="Within monoacetylated H4 fraction",
           xlabel="Monoacetylation site")
    from matplotlib.ticker import PercentFormatter
    ax.yaxis.set_major_formatter(PercentFormatter(1))
    ax.spines[["top", "right"]].set_visible(False)
    ax.legend(frameon=False, fontsize=9, loc="upper center", bbox_to_anchor=(.5,1.27))
    accepted = sum(r["acceptedScanCount"] for r in payload["results"])
    requested = sum(r["requestedScanCount"] for r in payload["results"])
    fig.savefig(OUT / "h4-current-algorithm-comparison.png", dpi=250)
    fig.savefig(OUT / "h4-current-algorithm-comparison.svg")
    plt.close(fig)
    provenance.update(reportableFiles=n, referenceHashes={"IsoForma2024": sha(iso_path), "Rommelfanger2021": sha(lit_path)},
                      admittedScans=accepted, featureLinkedScans=requested,
                      mean=dict(zip(SITES,means)), sd=dict(zip(SITES,sd)),
                      excludedFiles=[r["source"] for r in payload["results"] if r.get("status") != "solved"])
    (OUT / "provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    print(json.dumps({"output":str(OUT), "n":n, "means":means, "sd":sd}), flush=True)


if __name__ == "__main__":
    main()
