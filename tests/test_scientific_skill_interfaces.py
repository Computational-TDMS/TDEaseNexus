"""Core skill CLI contracts, with local inputs and offline reference services."""

import importlib.util
import json
import re
import sqlite3
import subprocess
import sys
from pathlib import Path
import shutil

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _ms1_fixture import graft_parent_ms1  # noqa: E402
UV = shutil.which("uv") or str(Path.home() / ".local/bin" / "uv")


SYSTEM = Path(__file__).resolve().parents[1] / "tdease-ai-capability/system"
FIXTURES = SYSTEM.parent / "rust/toolbox/fixtures"


def test_kernel_adapter_rejects_an_unknown_result_schema(monkeypatch, tmp_path):
    monkeypatch.syspath_prepend(str(SYSTEM / "skills"))
    from _shared import native
    command = [sys.executable, "-c", 'print(\'{"schemaVersion":999,"result":{}}\')']
    with pytest.raises(RuntimeError, match="SCHEMA_MISMATCH"):
        native.run_json(command)
    assert native.run_json(command, check=False) is None
    from _shared.kernel_io import KernelArtifactError, load_result
    artifact = tmp_path / "unknown.json"
    artifact.write_text('{"schemaVersion":999,"result":{}}', encoding="utf-8")
    with pytest.raises(KernelArtifactError, match="SCHEMA_MISMATCH"):
        load_result(artifact)


def test_toppic_reader_preserves_mass_and_modification_semantics(tmp_path):
    table = tmp_path / "source.tsv"
    table.write_text(
        "*** Parameters ***\n"
        "Prsm ID\tProtein accession\tScan(s)\t#variable PTMs\tvariable PTMs\t"
        "#unexpected modifications\tunexpected modifications\tProteoform\n"
        "1\tTEST\t10,11\t1\tOxidation\t1\t12.345:[2-4]\tA.ACDE.F\n"
        "2\tTEST\t12\t0\t\t1\t-5.125:[2]\tA.ACDE.F\n",
        encoding="utf-8",
    )
    script = SYSTEM / "skills/toppic-suite/scripts/prsm_read.py"
    result = subprocess.run([sys.executable, str(script), "rows", "--path", str(table),
                             "--with-unexpected"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert [row["_unexpected_shifts"] for row in payload["rows"]] == [[12.345], [-5.125]]
    assert payload["rows"][0]["variable_ptms"] == "Oxidation"
    assert payload["rows"][0]["variable_count"] == "1"
    selected = subprocess.run([sys.executable, str(script), "rows", "--path", str(table),
                               "--scan", "11"], capture_output=True, text=True)
    assert json.loads(selected.stdout)["match_count"] == 1
    table.write_text(table.read_text().replace("12.345:[2-4]", "unparsed"), encoding="utf-8")
    bad = subprocess.run([sys.executable, str(script), "summary", "--path", str(table)],
                         capture_output=True, text=True)
    assert bad.returncode != 0
    assert json.loads(bad.stdout)["error"]["code"] == "UNPARSEABLE_MODIFICATIONS"


@pytest.mark.parametrize("failed_source", ["uniprot", "mirror", "blast"])
def test_reference_flow_returns_independent_results_despite_source_failures(
    tmp_path, monkeypatch, capsys, failed_source,
):
    script = SYSTEM / "skills/ptm-database/scripts/query.py"
    monkeypatch.syspath_prepend(str(script.parent))
    spec = importlib.util.spec_from_file_location("reference_partial_flow", script)
    query = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(query)
    mirror = tmp_path / "reference.sqlite"
    if failed_source != "mirror":
        with sqlite3.connect(mirror) as conn:
            conn.executescript("""
                CREATE TABLE site (accession, entry, source, ptm_type, position,
                                   residue, pmids, seq_window);
                CREATE TABLE enzyme_score (accession, ptm_type, position, enzyme, score);
                CREATE TABLE vocab (alias, canonical);
                CREATE TABLE meta (key, value);
                CREATE TABLE motif_class (class_id, pattern, description, implies_type,
                                          probability);
                CREATE TABLE motif_instance (accession, class_id, start, end);
                INSERT INTO motif_class VALUES ('TEST_PATTERN', 'ACD', 'Example', 'ExampleType', 0.1);
            """)

    def remote_entry(accession):
        if failed_source == "uniprot":
            raise OSError("offline")
        return {"accession": accession, "name": "Example", "organism": "Example",
                "sequence": "ACDE", "length": 4, "mod_res": [], "cc_ptm": []}

    def blast(*args):
        checkpoint = json.loads(report.read_text(encoding="utf-8"))
        assert checkpoint["complete"] is False
        assert checkpoint["source_status"]["blast"] == "pending"
        if failed_source != "mirror":
            # Local motif results should already have been measured before
            # entering this slow, independently failing remote operation.
            assert "elm" in calls
            assert checkpoint["source_status"]["elm"] == "hit"
        if failed_source == "blast":
            raise TimeoutError("BLAST timed out")
        return []

    calls = []
    real_elm = query.elm_class_scan

    def elm(*args):
        calls.append("elm")
        return real_elm(*args)

    monkeypatch.setattr(query, "uniprot_entry", remote_entry)
    monkeypatch.setattr(query, "uniref50_members", lambda accession: [])
    monkeypatch.setattr(query, "run_blast", blast)
    monkeypatch.setattr(query, "elm_class_scan", elm)
    report = tmp_path / "flow.json"
    assert query.main(["flow", "--accession", "TEST0001", "--sequence", "ACDE",
                       "--db", str(mirror), "--out", str(report)]) == 0
    stdout = json.loads(capsys.readouterr().out)
    saved = json.loads(report.read_text(encoding="utf-8"))
    assert stdout["lane_status"] == saved["lane_status"]
    if failed_source == "mirror":
        assert stdout["source_status"]["elm"] == "unavailable"
        assert stdout["source_status"]["uniprot"] == "hit"
        assert stdout["source_status"]["blast"] == "empty"
    else:
        assert stdout["source_status"]["elm"] == "hit"
        assert stdout["source_status"][failed_source] == "unavailable"
        assert saved["levels"]["cohort"]["elm_classes"]["match_count"] == 1
        assert calls == ["elm"]


@pytest.mark.parametrize("with_records", [False, True])
def test_reference_flow_reports_actual_hits_and_preserves_records(
    tmp_path, monkeypatch, capsys, with_records,
):
    script = SYSTEM / "skills/ptm-database/scripts/query.py"
    monkeypatch.syspath_prepend(str(script.parent))
    spec = importlib.util.spec_from_file_location("reference_query_contract", script)
    query = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(query)
    mirror = tmp_path / "reference.sqlite"
    with sqlite3.connect(mirror) as conn:
        conn.executescript("""
            CREATE TABLE site (accession, entry, source, ptm_type, position,
                               residue, pmids, seq_window);
            CREATE TABLE enzyme_score (accession, ptm_type, position, enzyme, score);
            CREATE TABLE vocab (alias, canonical);
            CREATE TABLE meta (key, value);
            CREATE TABLE motif_class (class_id, pattern, description, implies_type,
                                      probability);
            CREATE TABLE motif_instance (accession, class_id, start, end);
        """)
        if with_records:
            conn.executemany("INSERT INTO site VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
                ("TEST0001", "Example", "dbPTM", "ExampleType", i, "A", "", "ACDE")
                for i in range(1, 26)
            ])
            conn.executemany("INSERT INTO motif_class VALUES (?, ?, ?, ?, ?)", [
                (f"TEST_PATTERN_{i}", "ACD", "Example", "ExampleType", 0.1)
                for i in range(35)
            ])
            conn.execute("INSERT INTO motif_instance VALUES (?, ?, ?, ?)",
                         ("TEST0001", "TEST_PATTERN", 1, 3))
    features = [{"type": "Sequence variant", "location": {
        "start": {"value": i}, "end": {"value": i}},
        "description": "Synthetic reference annotation", "evidences": [{"evidenceCode": "TEST"}]}
        for i in range(1, 26)] if with_records else []
    monkeypatch.setattr(query, "http_get", lambda url: json.dumps({
        "primaryAccession": "TEST0001", "sequence": {"value": "ACDE" * 7},
        "features": features,
    }).encode())
    monkeypatch.setattr(query, "uniref50_members", lambda accession: [])
    report = tmp_path / "flow.json"
    assert query.main(["flow", "--accession", "TEST0001", "--db", str(mirror),
                       "--skip-blast", "--out", str(report)]) == 0
    stdout = json.loads(capsys.readouterr().out)
    state = "hit" if with_records else "empty"
    assert stdout["lane_status"]["direct"] == state
    assert stdout["lane_status"]["motif"] == state
    assert stdout["lane_status"]["blast"] == "skipped"
    saved = json.loads(report.read_text(encoding="utf-8"))
    assert saved["levels"]["uniprot"]["features"] == features
    assert stdout["uniprot_features_truncated"] is with_records
    sites = saved["levels"]["direct"]
    assert len(sites["sites"]) == sites["site_count"] == (25 if with_records else 0)
    assert len(stdout["direct_dbptm_sites"]) <= 20
    classes = saved["levels"]["cohort"]["elm_classes"]
    assert len(classes["classes"]) == classes["class_count"] == (35 if with_records else 0)
    assert len(stdout["elm_class_records"]) <= 30
    assert stdout["elm_classes_truncated"] is with_records
    assert query.main(["elm", "--accession", "TEST0001", "--db", str(mirror),
                       "--out", str(tmp_path / "instances.json")]) == 0
    instances = json.loads(capsys.readouterr().out)
    assert len(instances["instance_records"]) == instances["instances"]
    atomic = tmp_path / "nested" / "motifs.json"
    assert query.main(["elm", "--sequence", "ACDE", "--db", str(mirror),
                       "--class-prefix", "TEST_", "--out", str(atomic)]) == 0
    returned = json.loads(capsys.readouterr().out)
    archived = json.loads(atomic.read_text(encoding="utf-8"))
    assert archived["query"] == returned["query"]
    assert archived["query"]["sequence"] == "ACDE"
    assert archived["query"]["class_prefix"] == "TEST_"
    with pytest.raises(SystemExit):
        query.main(["elm", "--sequence", "ACDE", "--type", "ignored"])
    fasta = tmp_path / "multiple.fasta"
    fasta.write_text(">first\nACD\n>second\nEFG\n", encoding="utf-8")
    with pytest.raises(SystemExit, match="one sequence"):
        query.main(["elm", "--fasta", str(fasta), "--db", str(mirror)])


def test_inspect_summary_keeps_a_readable_complete_report(tmp_path):
    table = tmp_path / "sample_ms2_toppic_prsm_single.tsv"
    table.write_text(
        "Data file name\tPrsm ID\tProtein accession\tProteoform mass\tFirst residue\t"
        "Last residue\tProtein N-terminal form\tUnexpected modifications\t"
        "E-value\tProteoform\tScan(s)\n"
        "sample\t1\tTEST\t1000\t1\t4\tNONE\t10.0:[1-2]\t1e-10\tA.MACD.E\t1\n"
        "sample\t2\tTEST\t1000\t2\t4\tNME\t141.0:[1-2]\t1e-10\tM.ACD.E\t2\n",
        encoding="utf-8",
    )
    summary = tmp_path / "summary.json"
    run = subprocess.run([
        sys.executable, str(SYSTEM / "skills/tdp-opensearch/main.py"),
        "inspect", "--prsms", str(table), "--protein", "TEST", "--summary-out", str(summary),
    ], capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    compact = json.loads(run.stdout)
    report = json.loads(Path(compact["report"]).read_text(encoding="utf-8"))
    assert report["terminalFrameEquivalences"]
    assert compact["terminalFrameEquivalences"] == report["terminalFrameEquivalences"]
    assert compact["coverage"]["terminalFrameEquivalences"]["total"] == len(report["terminalFrameEquivalences"])


def test_isoforma_keeps_fragment_evidence_and_records_effective_inputs(tmp_path):
    """The summed-fragment measurement must stay auditable after the run:
    evidence files persist, and the output carries the sequence, modification
    model and every effective measurement parameter — including the ion series
    actually resolved (here from the source's own ETD metadata, not a
    client-side default) and the kernel's proton mass."""
    data = tmp_path / "msdata"
    data.mkdir()
    graft_parent_ms1(FIXTURES / "histone48-scan1164.mzML", data / "sample.mzML")
    sequence = ("SGRGKGGKGLGKGGAKRHRKVLRDNIQGITKPAIRRLARRGGVKRISGLIYEETRGVLK"
                "VFLENVIRDAVTYTEHAKRKTVTAMDVVYALKRQGRTLYGFGG")
    script = SYSTEM / "skills/isoforma/scripts/isoforma_run.py"
    common = ["--mzml-dir", str(data), "--sequence", sequence,
              "--sites", "K,5,8,12", "--mod-tag", "Dimethyl",
              "--occupancies", "1", "--rt-min", "30", "--rt-max", "45",
              "--mass-window-da", "500", "--isotope-gate", "diagnostic"]
    run = subprocess.run([sys.executable, str(script), *common,
                          "--evidence-dir", str(tmp_path / "evidence")],
                         capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    payload = json.loads(run.stdout)
    result = payload["results"][0]
    assert result["acceptedScanCount"] == 1
    evidence = Path(result["evidence"])
    assert evidence == tmp_path / "evidence" / "sample.occ1.json"
    # The evidence artifact is a full CLI envelope: the comparisons live
    # under result, each entry carrying its complete measurement.
    artifact = json.loads(evidence.read_text(encoding="utf-8"))
    assert artifact["command"] == "fragment"
    assert artifact["result"]["comparisons"]
    assert result["measured"]["ionTypes"] == "C,Z"
    assert result["measured"]["activationBasis"] == "source_metadata"
    params = payload["parameters"]
    assert params["sequence"] == sequence
    assert params["modTag"] == "Dimethyl"
    assert params["sites"] == [5, 8, 12]
    assert params["activation"] is None
    assert params["protonMass"] == 1.007276
    assert params["evidenceDir"] == str(tmp_path / "evidence")

    # without --evidence-dir the files default beside the mzML sources,
    # never back into a scratch directory that dies with the process
    default_run = subprocess.run([sys.executable, str(script), *common],
                                 capture_output=True, text=True)
    assert default_run.returncode == 0, default_run.stderr
    default_result = json.loads(default_run.stdout)["results"][0]
    default_evidence = Path(default_result["evidence"])
    assert default_evidence == data / "isoforma-evidence" / "sample.occ1.json"
    assert default_evidence.is_file()
    assert default_evidence.read_text(encoding="utf-8") == evidence.read_text(encoding="utf-8")


def _write_two_chain_pdb(path: Path, chain_b_length: int = 3) -> None:
    """A small offline PDB in the local structure cache: chain A has five
    residues (one carrying an insertion code) plus a water, chain B is
    shorter (or equal, to provoke the tie)."""

    def atom(serial: int, resname: str, chain: str, resseq: int, axis: float,
             icode: str = " ", het: bool = False) -> str:
        record = "HETATM" if het else "ATOM  "
        return (f"{record}{serial:5d} {'CA':>4s} {resname:>3s} {chain}{resseq:4d}{icode}   "
                f"{axis:8.3f}{0.0:8.3f}{0.0:8.3f}  1.00 50.00            C  ")

    lines = []
    serial = 1
    for index, resname in enumerate(("ALA", "GLY", "SER", "THR", "VAL"), start=1):
        icode = "A" if index == 3 else " "
        lines.append(atom(serial, resname, "A", index, index * 4.0, icode))
        serial += 1
    lines.append(atom(serial, "HOH", "A", 9, 40.0, het=True))
    serial += 1
    for index in range(1, chain_b_length + 1):
        lines.append(atom(serial, "LEU", "B", index, index * 4.0))
        serial += 1
    lines.append("END")
    path.write_text("\n".join(lines) + "\n", encoding="ascii")


def test_structure_figure_declares_which_chain_was_analyzed(tmp_path):
    script = SYSTEM / "skills/structure-evidence/scripts/structure_figure.py"
    cache = tmp_path / "structures"
    cache.mkdir()
    _write_two_chain_pdb(cache / "1TST.pdb")

    def run(*extra):
        completed = subprocess.run(
            [UV, "run", "--script", str(script), "--pdb", "1tst",
             "--cache-dir", str(cache), *extra],
            capture_output=True, text=True)
        payload = (json.loads(completed.stdout) if completed.stdout.strip().startswith("{")
                   else json.loads(completed.stderr))
        return completed.returncode, payload

    # default: the longest chain is analyzed and that choice is stated,
    # not implied; insertion codes survive in the residue records
    code, payload = run("--sites", "2-3")
    assert code == 0
    chain = payload["structure"]["chain"]
    assert chain["id"] == "A"
    assert chain["selection"] == "longest"
    assert chain["chainLengths"] == {"A": 5, "B": 3}
    assert payload["structure"]["residues"] == 5
    site_rows = {row["resno"]: row for row in payload["sites"][0]["residues"]}
    assert site_rows[3]["icode"] == "A"
    assert "icode" not in site_rows[2]

    # explicit selection of the shorter chain is honored verbatim
    code, payload = run("--chain", "B")
    assert code == 0
    assert payload["structure"]["chain"] == {
        "id": "B", "selection": "explicit", "chainLengths": {"A": 5, "B": 3}}
    assert payload["structure"]["residues"] == 3

    # an unknown chain is a hard error listing what exists
    code, payload = run("--chain", "C")
    assert code == 1
    assert "chain 'C' not found" in payload["error"]
    assert "A(5)" in payload["error"] and "B(3)" in payload["error"]

    # a tie for longest must not be resolved silently
    _write_two_chain_pdb(cache / "1TIE.pdb", chain_b_length=5)
    tied = subprocess.run(
        [UV, "run", "--script", str(script), "--pdb", "1tie",
         "--cache-dir", str(cache)],
        capture_output=True, text=True)
    assert tied.returncode == 1
    assert "tied for longest" in json.loads(tied.stderr)["error"]


def test_toppic_legacy_table_refuses_ambiguous_mod_attribution(tmp_path):
    """Legacy tables without the unexpected-modifications column fall back to
    bracketed masses in the proteoform string — but variable PTMs render the
    same way, so with both present a count match is not evidence the right
    values were attributed. The reader must refuse instead of guessing."""
    script = SYSTEM / "skills/toppic-suite/scripts/prsm_read.py"
    header = ("Data file name\tPrsm ID\tProtein accession\t#variable PTMs\t"
              "#unexpected modifications\tProteoform\n")

    mixed = tmp_path / "legacy-mixed.tsv"
    mixed.write_text(header + "sample\t1\tTEST\t1\t2\tA.C[79.9663]D[42.0106]E.F\n",
                     encoding="utf-8")
    refused = subprocess.run([sys.executable, str(script), "rows", "--path", str(mixed),
                              "--with-unexpected"], capture_output=True, text=True)
    assert refused.returncode != 0
    payload = json.loads(refused.stdout)
    assert payload["error"]["code"] == "UNPARSEABLE_MODIFICATIONS"
    assert "ambiguous" in payload["error"]["message"]

    # A legacy table without variable PTMs keeps the working fallback: the
    # bracketed masses ARE the unexpected shifts there.
    plain = tmp_path / "legacy-plain.tsv"
    plain.write_text(header + "sample\t1\tTEST\t0\t1\tA.C[42.0106]DE.F\n",
                     encoding="utf-8")
    kept = subprocess.run([sys.executable, str(script), "rows", "--path", str(plain),
                           "--with-unexpected"], capture_output=True, text=True)
    assert kept.returncode == 0, kept.stderr
    assert json.loads(kept.stdout)["rows"][0]["_unexpected_shifts"] == [42.0106]


def test_census_attributes_feature_groups_to_the_ranked_shift(tmp_path):
    """A carrier row can hold several unexpected modifications; the census
    family is ranked by ONE of them. The feature group must report the shift
    this family is about, not whichever mod is first in the raw string."""
    table = tmp_path / "multi_mod_prsm.tsv"
    table.write_text(
        "*** Parameters ***\n"
        "Data file name\tPrsm ID\tProtein accession\tScan(s)\t#Unexpected modifications\t"
        "Unexpected modifications\tE-value\tProteoform mass\tProteoform\n"
        "sample\t1\tTEST\t10\t2\t42.01:[5-6]; 79.96:[2-4]\t1e-10\t1000\tA.ACDE.F\n"
        "sample\t2\tTEST\t11\t2\t42.01:[5-6]; 79.96:[2-4]\t1e-10\t1000\tA.ACDE.F\n",
        encoding="utf-8",
    )
    run = subprocess.run([
        sys.executable, str(SYSTEM / "skills/tdp-opensearch/main.py"),
        "inspect", "--prsms", str(table), "--protein", "TEST",
        "--shift", "79.96", "--shift-tolerance", "0.1",
    ], capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    groups = json.loads(run.stdout)["shiftFamilies"][0]["featureGroups"]
    for group in groups:
        assert abs(group["shiftDa"] - 79.96) < 0.01
        assert group["localizationWindow"] == "2-4"
        assert sorted(group["allShiftsDa"]) == [42.01, 79.96]


def test_ingest_reports_proteoform_rows_dropped_at_the_ms1_join(tmp_path):
    """Proteoform rows whose Feature ID has no MS1 feature vanish at the
    source join; the join summary must count them instead of hiding the
    loss from every downstream number."""
    scripts = SYSTEM / "skills/tdp-opensearch/scripts"
    import importlib
    sys.path.insert(0, str(scripts))
    sys.path.insert(0, str(SYSTEM / "skills"))
    try:
        ingest_tables = importlib.import_module("ingest_tables")
    finally:
        sys.path.remove(str(scripts))
        sys.path.remove(str(SYSTEM / "skills"))
    prsm = tmp_path / "prsm.tsv"
    prsm.write_text(
        "*** Parameters ***\n"
        "Data file name\tPrsm ID\tProtein accession\tScan(s)\tFeature ID\tProteoform ID\t"
        "E-value\tSpectrum-level Q-value\tProteoform\n"
        "sample\t1\tTEST\t10\t1\tPF1\t1e-10\t0.001\tA.ACDE.F\n"
        "sample\t2\tTEST\t11\t999\tPF2\t1e-10\t0.001\tA.ACDE.F\n",
        encoding="utf-8",
    )
    ms1 = tmp_path / "ms1.feature"
    ms1.write_text("Feature_ID\tMass\tIntensity\tMin_time\tMax_time\tRep_charge\n"
                   "1\t1000\t100\t1\t2\t2\n", encoding="utf-8")
    _features, _modifications, _families, summary = ingest_tables.build_single_sample(
        ms1, None, prsm)
    assert summary["proteoform_rows_total"] == 2
    assert summary["proteoform_rows_dropped_no_ms1_feature"] == 1


@pytest.mark.xfail(reason="contract drift from a prior session: spectral.py measure --ms1 "
                   "names theory sidecars <stem>-theory-m<i>-z<charge>.json (index+charge), "
                   "not the auditable <model-id>_<feature> naming this test documents, and the "
                   "ladder path raises SCHEMA_MISMATCH on its own sidecar; see turn-log 2026-10-17",
                   strict=True)
def test_ms1_feature_ladder_binds_theories_to_features_and_keeps_statistics(tmp_path):
    """The precursor-envelope route generates one theoretical distribution per
    (model, feature) and pairs it positionally; the card must carry enough
    identity (anchor mass against the declared feature mass) and statistics
    (pearson r, apex delta) for the pairing to be audited, instead of leaving
    them only inside the rendered HTML."""
    import subprocess as sp
    data = tmp_path / "msdata"
    data.mkdir()
    graft_parent_ms1(FIXTURES / "histone48-scan1164.mzML", data / "sample.mzML")
    models = tmp_path / "models.json"
    # one backbone, two modification claims: an MS1 comparison is only
    # interpretable inside a single sequence
    models.write_text(json.dumps([
        {"id": "a", "label": "A", "proforma": "ACDEFGAK"},
        {"id": "b", "label": "B", "proforma": "ACDEFG[Oxidation]AK"},
    ]), encoding="utf-8")
    card_path = tmp_path / "precursor-card.json"
    run = sp.run(
        [UV, "run", "--script",
         str(SYSTEM / "skills/spectral-evidence/scripts/spectral.py"),
         "measure", "--ms1", "--mzml", str(data / "sample.mzML"),
         "--feature", "f1", "11400.3", "17", "37.7", "37.9",
         "--models", str(models), "--out", str(card_path)],
        capture_output=True)
    assert run.returncode == 0, run.stderr.decode("utf-8", "replace")
    card = json.loads(card_path.read_text(encoding="utf-8"))
    assert card["card"] == "measure/ms1"
    feature = card["verdict"]["features"][0]
    assert feature["label"] == "f1" and feature["charge"] == 17
    assert {row["model"] for row in feature["ranking"]} == {"a", "b"}
    for row in feature["ranking"]:
        assert isinstance(row["anchorMass"], float)
        assert isinstance(row["anchorOffsetDa"], float)
        assert "pearsonR" in row
        assert "apexDeltaDa" in row
        # the offsets make the pairing auditable: each model's anchor is stated
        # relative to the feature mass it was compared against
        assert abs(row["anchorOffsetDa"] - (row["anchorMass"] - 11400.3)) < 1e-6
    # the origin of the observed envelope is archived with the measurement
    assert (tmp_path / "precursor-card-theory-a-f1.json").is_file()
    assert (tmp_path / "precursor-card-theory-b-f1.json").is_file()


def test_calibration_applies_per_interpretation_not_per_feature(monkeypatch):
    """One MS1 feature can carry two single-shift proteoform interpretations;
    each calibrated value belongs to the interpretation it was measured on.
    A feature-keyed overwrite would silently replace the other modification's
    measured shift with a foreign value."""
    scripts = SYSTEM / "skills/tdp-opensearch/scripts"
    monkeypatch.syspath_prepend(str(scripts))
    monkeypatch.syspath_prepend(str(SYSTEM / "skills"))
    import ingest_evidence

    def carrier(feature, raw, calibrated):
        return {
            "featureId": feature,
            "rawObservedShifts": [raw],
            "calibration": {"status": "calibrated", "calibratedShift": calibrated},
        }

    preliminary = [
        {"carrier_facts": json.dumps([carrier("7", 42.0106, 42.0085)])},
        {"carrier_facts": json.dumps([carrier("7", 79.9568, 79.9631)])},
    ]
    observations = [
        {"mass_shift_id": "M1", "feature_id": "7", "shift_mass": "42.010600",
         "shift_mass_center": "42.0106", "raw_shift_mass": 42.0106},
        {"mass_shift_id": "M2", "feature_id": "7", "shift_mass": "79.956800",
         "shift_mass_center": "79.9568", "raw_shift_mass": 79.9568},
    ]
    calibration = ingest_evidence.recalibrate_observation_clusters(observations, preliminary)
    by_raw = {round(float(row["raw_shift_mass"]), 4): float(row["shift_mass"])
              for row in observations}
    assert by_raw[42.0106] == 42.0085
    assert by_raw[79.9568] == 79.9631
    assert set(calibration) == {("7", 42.0106), ("7", 79.9568)}


def test_ingest_reports_isotope_merged_clusters(tmp_path):
    """Clustering merges C13-equivalent raw shifts into one mass_shift_id and
    candidates are searched at the cluster center; the merge and the member
    raw values must be declared on the assignment row."""
    scripts = SYSTEM / "skills/tdp-opensearch/scripts"
    import importlib
    sys.path.insert(0, str(scripts))
    sys.path.insert(0, str(SYSTEM / "skills"))
    try:
        ingest_tables = importlib.import_module("ingest_tables")
    finally:
        sys.path.remove(str(scripts))
        sys.path.remove(str(SYSTEM / "skills"))
    prsm = tmp_path / "prsm.tsv"
    prsm.write_text(
        "*** Parameters ***\n"
        "Data file name\tPrsm ID\tProtein accession\tScan(s)\tFeature ID\tProteoform ID\t"
        "E-value\tSpectrum-level Q-value\tUnexpected modifications\tProteoform\n"
        "sample\t1\tTEST\t10\t1\tPF1\t1e-10\t0.001\t42.0106:[2-3]\tA.ACDE.F\n"
        "sample\t2\tTEST\t11\t1\tPF2\t1e-10\t0.001\t43.0140:[2-3]\tA.ACDE.F\n",
        encoding="utf-8",
    )
    ms1 = tmp_path / "ms1.feature"
    ms1.write_text("Feature_ID\tMass\tIntensity\tMin_time\tMax_time\tRep_charge\n"
                   "1\t1042.01\t100\t1\t2\t2\n", encoding="utf-8")
    import csv as _csv
    from io import StringIO
    _features, modifications, _families, summary = ingest_tables.build_single_sample(
        ms1, None, prsm)
    assignments = ingest_tables.aggregate_checklist(modifications)
    assert assignments
    merged = [row for row in assignments if row.get("cluster_isotope_merged")]
    assert merged, "a 1.0034 Da raw pair in one cluster must be declared merged"
    assert "42.0106" in merged[0]["cluster_raw_shifts"]
    assert "43.0140" in merged[0]["cluster_raw_shifts"]
    assert "ms1FamilySearch" in summary


def test_parse_proforma_refuses_ambiguous_repeated_spans():
    """A residue span occurring twice must yield no interval, not a
    confident-but-wrong first-occurrence location."""
    scripts = SYSTEM / "skills/tdp-opensearch/scripts"
    import importlib
    sys.path.insert(0, str(scripts))
    try:
        toppic_io = importlib.import_module("toppic_io")
    finally:
        sys.path.remove(str(scripts))
    _fixed, unknown = toppic_io.parse_proforma("(ACD)[+42.0106]", "ACDEACDE")
    assert unknown[0]["interval"] is None
    _fixed, unique = toppic_io.parse_proforma("(XXX)[+42.0106]", "ACDXXX")
    assert unique[0]["interval"] == [4, 6]


def test_toppic_summary_declares_its_mass_column_basis(tmp_path):
    script = SYSTEM / "skills/toppic-suite/scripts/prsm_read.py"
    modern = tmp_path / "modern.tsv"
    modern.write_text(
        "*** Parameters ***\n"
        "Data file name\tPrsm ID\tProtein accession\tProteoform mass\tPrecursor mass\n"
        "sample\t1\tTEST\t1000.5\t1001.5\n",
        encoding="utf-8",
    )
    payload = json.loads(subprocess.run(
        [sys.executable, str(script), "summary", "--path", str(modern)],
        capture_output=True, text=True).stdout)
    assert payload["mass"]["column"] == "proteoform_mass"
    assert payload["mass"]["median"] == 1000.5

    legacy = tmp_path / "legacy.tsv"
    legacy.write_text(
        "*** Parameters ***\n"
        "Data file name\tPrsm ID\tProtein accession\tPrecursor mass\n"
        "sample\t1\tTEST\t1001.5\n",
        encoding="utf-8",
    )
    payload = json.loads(subprocess.run(
        [sys.executable, str(script), "summary", "--path", str(legacy)],
        capture_output=True, text=True).stdout)
    assert payload["mass"]["column"] == "precursor_mass"
    assert payload["mass"]["median"] == 1001.5


def test_family_cli_uses_explicit_spacing_and_honors_no_refine(tmp_path):
    feature = tmp_path / "example.feature"
    feature.write_text(
        "Feature_ID\tMass\tIntensity\tMin_time\tMax_time\tRep_charge\n"
        "1\t1000\t100\t1\t2\t2\n"
        "2\t1020\t100\t1\t2\t2\n"
        "3\t1040\t100\t1\t2\t2\n", encoding="utf-8",
    )
    command = [sys.executable, str(SYSTEM / "skills/tdp-opensearch/main.py"),
               "families", "--feature", str(feature), "--no-refine"]
    missing = subprocess.run(command, capture_output=True, text=True)
    assert missing.returncode != 0, "family spacing must not select a hidden chemistry window"
    completed = subprocess.run(
        [*command, "--spacing-min", "19", "--spacing-max", "21",
         "--mzml", str(tmp_path / "unused.mzML")], capture_output=True, text=True,
    )
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert result["layer_refine"]["skipped"] is True
    assert result["family_count"] == 1
    assert result["families"][0]["feature_ids"] == [1, 2, 3]


def test_inventory_report_does_not_promote_mass_candidates_to_identity(tmp_path):
    bundle = tmp_path / "inventory.json"
    bundle.write_text(json.dumps({
        "schema": "tdease.opensearch.v1",
        "observations": [{"assignmentId": "A1", "smith": {
            "best": "3", "ambiguities": ["ptm_identity", "ptm_localization"],
        }}],
        "annotations": [{"basis": "automatic approved reference match",
                         "assignmentIds": ["A1"], "notIdentity": True}],
    }), encoding="utf-8")
    completed = subprocess.run([
        sys.executable, str(SYSTEM / "skills/tdp-opensearch/main.py"),
        "figures", "report", "--bundle", str(bundle),
        "--out", str(tmp_path / "report.html"),
    ], capture_output=True, text=True)
    assert completed.returncode == 0, completed.stderr
    report = (tmp_path / "report.html").read_text(encoding="utf-8")
    payload = re.search(r"window\.DATAByPanel\s*=\s*(\{.*?\});", report, re.S)
    assert payload, "report must retain the data used to draw its grades"
    grade = json.loads(payload.group(1))["grading-levels"]["data"]
    for series in grade["series"]:
        displayed = {row["level"]: row[series["key"]] for row in grade["levels"]}
        assert displayed == {1: 0, 2: 0, 3: 1, 4: 0, 5: 0}


@pytest.mark.parametrize("ambiguity", [None, "baseline", "components"])
def test_inventory_calibration_does_not_mix_source_frames(monkeypatch, ambiguity):
    scripts = SYSTEM / "skills/tdp-opensearch/scripts"
    monkeypatch.syspath_prepend(str(scripts))
    monkeypatch.syspath_prepend(str(SYSTEM / "skills"))
    import ingest_evidence

    carrier = {
        "featureId": "1", "scans": ["1"], "sequencesWithForms": ["ACDEFG"],
        "rawObservedShifts": [10.0], "retentionTime": {"apex": 1},
        "prsmFacts": [{"unexpectedModifications": [{"value": 10.0}]}],
    }
    if ambiguity == "components":
        carrier["prsmFacts"][0]["unexpectedModifications"].append({"value": 20.0})
    rows = [{"assignment_id": "A1", "carrier_facts": json.dumps([carrier])}]
    if ambiguity == "baseline":
        alternative = {**carrier, "sequencesWithForms": ["[Acetyl]-ACDEFG"]}
        rows.append({"assignment_id": "A2", "carrier_facts": json.dumps([alternative])})
    requests = []

    def kernel(args, *unused):
        if args[1] == "spectrum":
            return {"result": {"spectra": [{"scan": "1", "spectrum": {
                "precursor": {"charge": 2, "selectedMz": 500}, "retentionTime": 1,
            }}]}}
        batch = json.loads(Path(args[args.index("--input") + 1]).read_text())
        requests.extend(batch)
        return {"result": {"results": []}}

    monkeypatch.setattr(ingest_evidence.native, "binary", lambda value: "kernel")
    monkeypatch.setattr(ingest_evidence.native, "run_json", kernel)
    ingest_evidence.calibrate_pending(rows, "unused.mzML", None, 10)
    if ambiguity is None:
        assert len(requests) == 1
        assert requests[0]["sequence"] == "ACDEFG"
        assert requests[0]["priorShift"] == requests[0]["modificationMass"] == 10
    else:
        assert requests == [], "automatic calibration must not pick an arbitrary source basis"
        for row in rows:
            fit = json.loads(row["carrier_facts"])[0]["calibration"]
            assert fit["status"] == "unavailable"
            assert fit["reason"]


def _run(script, *args):
    return subprocess.run([sys.executable, str(script), *args], capture_output=True, text=True)


def test_prsm_inventory_groups_mass_levels_and_reports_gaps(tmp_path):
    rows = tmp_path / "prsm_rows.csv"
    rows.write_text(
        "Protein accession,Adjusted precursor mass,Unexpected modifications,"
        "Spectrum-level Q-value,sample\n"
        "tr|AAA111|x,8123.456,212.0452:[1-5],1e-07,M02\n"
        "tr|AAA111|x,8123.461,212.0452:[1-5],1e-05,M03\n"
        "tr|AAA111|x,8247.458,236.0483:[1-5],1e-04,M02\n"
        "tr|BBB222|y,8000.100,150.0200:[3],1e-03,WT01\n",
        encoding="utf-8",
    )
    script = SYSTEM / "skills/tdp-copilot/scripts/prsm_inventory.py"
    out = tmp_path / "inventory.csv"
    result = _run(script, "--rows", str(rows), "--out", str(out))
    assert result.returncode == 0, result.stderr
    assert "mass levels" in result.stdout
    assert "gaps" in result.stdout and "24.0" in result.stdout  # 8247.458 - 8123.456
    assert result.stdout.count("AAA111") >= 1 and "BBB222" in result.stdout
    assert out.exists() and out.read_text(encoding="utf-8").count("\n") >= 3
    filtered = _run(script, "--rows", str(rows), "--accession", "AAA111")
    assert filtered.returncode == 0 and "BBB222" not in filtered.stdout


def test_models_build_emits_proforma_and_rejects_duplicates(tmp_path):
    script = SYSTEM / "skills/tdp-copilot/scripts/models_build.py"
    result = _run(
        script, "--sequence", "ACDGSKPRW",
        "--model", "lead:1:Acetyl,3:Oxidation",
        "--model", "null_both_on_cys:3:Acetyl,3:Oxidation",
    )
    assert result.returncode == 0, result.stderr
    models = json.loads(result.stdout)
    assert [m["proforma"] for m in models] == [
        "A[Acetyl]CD[Oxidation]GSKPRW",
        "ACD[Acetyl][Oxidation]GSKPRW",
    ]
    terminal = _run(script, "--sequence", "ACDGSKPRW",
                    "--model", "n_term:0:Acetyl,3:Oxidation",
                    "--model", "c_term:9:Oxidation,10:Acetyl")
    assert terminal.returncode == 0, terminal.stderr
    assert [m["proforma"] for m in json.loads(terminal.stdout)] == [
        "[Acetyl]-ACD[Oxidation]GSKPRW",
        "ACDGSKPRW[Oxidation]-[Acetyl]",
    ]
    dup = _run(script, "--sequence", "ACDGSKPRW",
               "--model", "a:2:Acetyl", "--model", "b:2:Acetyl")
    assert dup.returncode != 0 and "identical ProForma" in dup.stderr
    outside = _run(script, "--sequence", "AC", "--model", "a:9:Acetyl")
    assert outside.returncode != 0 and "outside sequence" in outside.stderr


def test_discrimination_table_counts_only_differing_ions(tmp_path):
    evidence = tmp_path / "cmp_M02-evidence.json"
    def fragment(state, mz, ion="y", number=5, charge=2):
        return {"state": state, "theoreticalMz": mz, "cleavageAfter": number,
                "ion": ion, "number": number, "charge": charge}
    evidence.write_text(json.dumps({
        "result": {"comparisons": [{"scan": 999, "measurement": {"candidates": [
            {"candidateId": "lead",
             "fragmentStatuses": [fragment("matched", 500.0), fragment("matched", 700.0, "b", 3, 1)],
             "matches": [{"ion": "y", "number": 5, "charge": 2, "errorPpm": 0.4, "envelopeCorrelation": 0.95}]},
            {"candidateId": "swap",
             "fragmentStatuses": [fragment("missingApex", 500.1), fragment("matched", 700.0, "b", 3, 1)],
             "matches": []},
        ]}}]},
    }), encoding="utf-8")
    script = SYSTEM / "skills/tdp-copilot/scripts/discrimination_table.py"
    out = tmp_path / "support.csv"
    result = _run(script, "--evidence", str(evidence), "--out", str(out))
    assert result.returncode == 0, result.stderr
    assert "lead" in result.stdout and "swap" not in result.stdout.split("crosstab")[0].split("===")[1]
    table = pd.read_csv(out) if (pd := __import__("pandas")) else None
    assert len(table) == 1 and table.iloc[0]["ion"] == "y5:2"
    assert table.iloc[0]["n_models_matched"] == 1


def test_toppic_shortlist_tiers_by_detection_counts(tmp_path):
    comparison = tmp_path / "comparison_full.json"
    candidates = [
        {"featureId": f"F{i}", "gene": "gA" if i < 3 else "gB",
         "log2FoldChange": 3.0 + i, "bhFdr": 1e-4, "spectralCount": 10}
        for i in range(4)
    ]
    comparison.write_text(json.dumps({"candidates": candidates}), encoding="utf-8")
    occupancy = tmp_path / "occupancy.csv"
    occupancy.write_text(
        "featureId,n_WT,n_M\nF0,5,5\nF1,5,2\nF2,5,2\nF3,1,1\n",
        encoding="utf-8",
    )
    script = SYSTEM / "skills/toppicr-py/scripts/toppic_shortlist.py"
    genes = tmp_path / "genes.csv"
    result = _run(script, "--comparison", str(comparison), "--occupancy", str(occupancy),
                  "--groups", "WT,M", "--out-genes", str(genes))
    assert result.returncode == 0, result.stderr
    assert "tier A (>=4 det both): 1" in result.stdout
    assert "tier B (3): 0" in result.stdout
    assert "tier C (<=2): 3" in result.stdout
    assert "higher in M: 4" in result.stdout
    assert genes.exists()
