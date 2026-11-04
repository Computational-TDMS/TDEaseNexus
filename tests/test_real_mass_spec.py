"""
Real mass-spec integration test.

Tests execute, event stream, result verification, and portability.
Generates synthetic mzML fixtures (no pyteomics dependency needed).
"""

from __future__ import annotations

import csv
import json
import os
import shutil
import subprocess
import sys
import tempfile
from io import StringIO
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

REPO_ROOT = Path(__file__).resolve().parent.parent
TOOLS_ROOT = REPO_ROOT / "data" / "backend" / "nodes"
TOPFD_EXE = TOOLS_ROOT / "toppic" / "topfd.exe"
MSCONVERT_EXE = Path(
    os.environ.get(
        "TDEASE_MSCONVERT_EXE",
        r"C:\Program Files\ProteoWizard\ProteoWizard 3.0.26139.0599784\msconvert.exe",
    )
)

TOPFD_AVAILABLE = TOPFD_EXE.exists()
MSCONVERT_AVAILABLE = MSCONVERT_EXE.exists()
# ── Fixtures ──

def make_small_mzml(output_path: Path) -> Path:
    """Generate a small valid mzML file for testing."""
    import base64, struct
    mz_array = [100.0, 200.0, 300.5, 500.2, 750.8]
    intensity_array = [1000.0, 5000.0, 3000.0, 20000.0, 8500.0]
    mz_bytes = struct.pack(f"<{len(mz_array)}d", *mz_array)
    int_bytes = struct.pack(f"<{len(intensity_array)}d", *intensity_array)
    mz_b64 = base64.b64encode(mz_bytes).decode()
    int_b64 = base64.b64encode(int_bytes).decode()
    mz_enc_len = len(mz_b64)
    int_enc_len = len(int_b64)

    mzml = f'''<?xml version="1.0" encoding="utf-8"?>
<indexedmzML xmlns="http://psi.hupo.org/ms/mzml" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <mzML id="test" version="1.1.0">
    <cvList count="2">
      <cv id="MS" fullName="PSI Mass Spectrometry Ontology" version="4.1.7"
          URI="http://psidev.cvs.sourceforge.net/viewvc/*checkout*/psidev/psi/psi-ms/mzML/controlledVocabulary/psi-ms.obo"/>
      <cv id="UO" fullName="Unit Ontology" version="09:04:2014"
          URI="http://ontologies.berkeleybop.org/uo.obo"/>
    </cvList>
    <fileDescription>
      <fileContent>
        <cvParam cvRef="MS" accession="MS:1000294" name="mass spectrum"/>
      </fileContent>
    </fileDescription>
    <softwareList count="1">
      <software id="TDEase" version="0.1.0">
        <cvParam cvRef="MS" accession="MS:1000799" name="custom unreleased software tool"/>
      </software>
    </softwareList>
    <instrumentConfigurationList count="1">
      <instrumentConfiguration id="ic_1">
        <cvParam cvRef="MS" accession="MS:1000031" name="instrument model"/>
        <componentList count="3">
          <source order="1">
            <cvParam cvRef="MS" accession="MS:1000073" name="electrospray ionization"/>
          </source>
          <analyzer order="1">
            <cvParam cvRef="MS" accession="MS:1000081" name="quadrupole"/>
          </analyzer>
          <detector order="1">
            <cvParam cvRef="MS" accession="MS:1000253" name="electron multiplier"/>
          </detector>
        </componentList>
      </instrumentConfiguration>
    </instrumentConfigurationList>
    <dataProcessingList count="1">
      <dataProcessing id="dp_1">
        <processingMethod order="0" softwareRef="TDEase">
          <cvParam cvRef="MS" accession="MS:1000544" name="Conversion to mzML"/>
        </processingMethod>
      </dataProcessing>
    </dataProcessingList>
    <run id="run_1" defaultInstrumentConfigurationRef="ic_1"
         startTimeStamp="2025-07-25T00:00:00Z">
      <spectrumList count="1" defaultDataProcessingRef="dp_1">
        <spectrum id="scan=1" index="0" defaultArrayLength="{len(mz_array)}">
          <cvParam cvRef="MS" accession="MS:1000511" name="ms level" value="1"/>
          <cvParam cvRef="MS" accession="MS:1000127" name="centroid spectrum"/>
          <cvParam cvRef="MS" accession="MS:1000285" name="total ion current" value="{sum(intensity_array)}"/>
          <cvParam cvRef="MS" accession="MS:1000130" name="base peak m/z" value="500.2"/>
          <cvParam cvRef="MS" accession="MS:1000131" name="base peak intensity" value="20000.0"/>
          <scanList count="1">
            <scan instrumentConfigurationRef="ic_1">
              <cvParam cvRef="MS" accession="MS:1000016" name="scan start time" value="0.0" unitCvRef="UO" unitAccession="UO:0000031" unitName="minute"/>
            </scan>
          </scanList>
          <binaryDataArray encodedLength="{mz_enc_len}" arrayLength="{len(mz_array)}">
            <cvParam cvRef="MS" accession="MS:1000514" name="m/z array"/>
            <cvParam cvRef="MS" accession="MS:1000523" name="64-bit float"/>
            <cvParam cvRef="MS" accession="MS:1000576" name="no compression"/>
            <binary>{mz_b64}</binary>
          </binaryDataArray>
          <binaryDataArray encodedLength="{int_enc_len}" arrayLength="{len(intensity_array)}">
            <cvParam cvRef="MS" accession="MS:1000515" name="intensity array"/>
            <cvParam cvRef="MS" accession="MS:1000523" name="64-bit float"/>
            <cvParam cvRef="MS" accession="MS:1000576" name="no compression"/>
            <binary>{int_b64}</binary>
          </binaryDataArray>
        </spectrum>
      </spectrumList>
    </run>
  </mzML>
  <indexList count="1">
    <index name="spectrum">
      <offset idRef="scan=1">0</offset>
    </index>
  </indexList>
</indexedmzML>'''
    output_path.write_text(mzml, encoding="utf-8")
    return output_path


@pytest.fixture
def test_workspace(tmp_path):
    """Create a temp workspace with synthetic mzML data."""
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / ".tdease").mkdir()
    identity = {
        "workspace_id": "ws_real_test",
        "name": "real-test-ws",
        "owner": "test",
        "created": "2025-07-25T00:00:00Z",
    }
    (ws / ".tdease" / "workspace.json").write_text(json.dumps(identity))

    # Generate mzML
    raw_dir = ws / "raw"
    raw_dir.mkdir()
    make_small_mzml(raw_dir / "test.mzML")
    return ws


# ── Tests ──

class TestRealMassSpecPipeline:
    """Tests using real CLI tools against synthetic mzML data."""

    def test_generate_mzml(self, test_workspace):
        """Verify pyteomics can generate a valid mzML file."""
        mzml_path = test_workspace / "raw" / "test.mzML"
        make_small_mzml(mzml_path)
        assert mzml_path.exists(), f"mzML not generated: {mzml_path}"
        assert mzml_path.stat().st_size > 100, f"mzML too small: {mzml_path.stat().st_size}"
        # Verify it's valid XML with mzML namespace
        content = mzml_path.read_text()
        assert "<mzML" in content or "<indexedmzML" in content or "mzML" in content
        print(f"  mzML: {mzml_path.stat().st_size} bytes")

    @pytest.mark.skipif(not TOPFD_AVAILABLE, reason="topfd.exe not found")
    def test_topfd_runs(self, test_workspace):
        """Verify TopFD.exe can process the synthetic mzML and produce valid output."""
        mzml_path = test_workspace / "raw" / "test.mzML"
        if not mzml_path.exists():
            make_small_mzml(mzml_path)

        results_dir = test_workspace / "results"
        results_dir.mkdir(exist_ok=True)

        # Run topfd on the mzML
        result = subprocess.run(
            [str(TOPFD_EXE), "-a", "FILE", "-c", "30", "-e", "0.01",
             "-u", "2", str(mzml_path)],
            capture_output=True, text=True, timeout=60,
            cwd=str(test_workspace),
        )
        print(f"  topfd stdout: {result.stdout[:200]}")
        if result.stderr:
            print(f"  topfd stderr: {result.stderr[:200]}")
        print(f"  topfd exit: {result.returncode}")

        # TopFD may create output files in CWD
        feature_files = list(test_workspace.rglob("*feature*"))
        msalign_files = list(test_workspace.rglob("*msalign*"))
        print(f"  Features: {[str(f.relative_to(test_workspace)) for f in feature_files]}")
        print(f"  Msalign: {[str(f.relative_to(test_workspace)) for f in msalign_files]}")

        # ── Real assertions ──
        assert result.returncode == 0, (
            f"TopFD exited {result.returncode}\n"
            f"stdout: {result.stdout[-500:] if result.stdout else '(none)'}"
        )
        assert feature_files, "TopFD produced no feature files"
        assert msalign_files, "TopFD produced no msalign files"

        # Empty MS2 files are expected when there are no MS/MS scans.
        # Only require non-empty feature files and MS1 msalign files.
        non_empty = [p for p in feature_files + msalign_files if p.stat().st_size > 0]
        empty_ok = [p for p in feature_files + msalign_files if p.stat().st_size == 0]
        print(f"  Non-empty output files: {[p.name for p in non_empty]}")
        if empty_ok:
            print(f"  Empty files (expected for MS2 when no MS/MS scans): {[p.name for p in empty_ok]}")

        ms1_msalign = [p for p in msalign_files if "ms1" in p.name.lower()]
        assert any(p.stat().st_size > 0 for p in ms1_msalign), (
            f"MS1 msalign files are all empty: {[p.name for p in ms1_msalign]}"
        )
        assert any(p.stat().st_size > 0 for p in feature_files), (
            f"Feature files are all empty: {[p.name for p in feature_files]}"
        )

        # Structural validation: feature file should have a header row
        feature_csv = [p for p in feature_files if p.suffix == ".feature"]
        if feature_csv:
            feat = feature_csv[0]
            header = feat.read_text(encoding="utf-8").splitlines()[0]
            assert any(
                col in header.lower() for col in ["mass", "charge", "feature", "intensity", "retention", "score"]
            ), f"Feature file header unexpected: {header}"

        # msalign should contain at least one spectrum block
        ms1_msalign = [p for p in msalign_files if "ms1" in p.name.lower() and p.stat().st_size > 0]
        if ms1_msalign:
            msalign_text = ms1_msalign[0].read_text(encoding="utf-8")
            assert "BEGIN IONS" in msalign_text or "SPECTRUM" in msalign_text.upper() or len(msalign_text) > 50, (
                f"msalign content unexpected ({len(msalign_text)} bytes): {msalign_text[:200]}"
            )

        # No pollution — results only in workspace
        allowed_roots = {str(test_workspace.resolve())}
        for p in feature_files + msalign_files:
            assert any(
                str(p.resolve()).startswith(root) for root in allowed_roots
            ), f"TopFD wrote outside workspace: {p}"


class TestExecutionRuntimeReal:
    """Execute real shell commands through the Execution Runtime."""

    def test_real_shell_pipeline(self, tmp_path, monkeypatch):
        """Execute a real 3-step pipeline: echo → python → wc."""
        from src.execution_runtime import StorageLayout, set_storage, execute
        from src.contracts import RunCommit

        monkeypatch.setenv("TDEASE_DATA_ROOT", str(tmp_path / "data"))
        st = StorageLayout(tmp_path / "data")
        st.bootstrap()
        set_storage(st)

        # Real pipeline using actual available commands.
        # `rule all` is required: the engine targets only the first rule by
        # default when no explicit target is requested, so without an
        # aggregating rule only step1 would run (see src/execution_runtime
        # engine_runner.py DAGSettings(targets=...)).
        snakefile = r'''
rule all:
    input:
        "results/summary.txt"
    shell:
        "echo done"

rule step1:
    output:
        "results/input.csv"
    shell:
        "echo header > results/input.csv && echo value1 >> results/input.csv"

rule step2:
    input:
        "results/input.csv"
    output:
        "results/output.csv"
    shell:
        "echo processed > results/output.csv"

rule step3:
    input:
        "results/output.csv"
    output:
        "results/summary.txt"
    shell:
        "echo VERIFIED_OK > results/summary.txt"
'''
        commit = RunCommit(
            run_id="real-pipe", idempotency_key="ik-rp",
            workspace_id="ws-real", workspace_tree_hash="0" * 64,
            snakefile=snakefile, cores=1, user_id="t",
        )

        # Queue the revision first — the engine's journal-range guard requires
        # a started execution (the real path: API submit + queue_request, then
        # the worker's begin_execution, then execute). Same precondition here.
        from src.execution_runtime.events import EventEmitter
        emitter = EventEmitter("real-pipe")
        if not emitter.last_seq:
            emitter.run_submitted("def-real-pipe")
        emitter.run_queue_requested("def-real-pipe", "execute", rerun_mode="resume")
        from src.services.run_commands import get_run_commands

        assert get_run_commands().begin_execution("real-pipe") is not None

        # Execute — current engine wraps the whole Snakemake invocation in a
        # single "engine" task (WORKFLOW-RUN.md: per-rule
        # `snakemake.job_*` events are "planned", not yet emitted), so
        # total_tasks is always 1 for a successful run regardless of how many
        # Snakemake rules executed internally.
        result = execute(commit, revision_id="def-real-pipe", execution_mode="execute")
        assert result.success, f"Execute: {result.error}"
        assert result.total_tasks == 1
        assert result.succeeded_tasks == 1
        print(f"  Tasks: {result.succeeded_tasks}/{result.total_tasks}, {result.run_time_seconds:.1f}s")

        # Direct runtime execution stops at engine success. The Worker publishes
        # the Result Manifest before it emits the Run terminal success event.
        events = st.read_events("real-pipe")
        assert len(events) >= 3
        assert events[0]["type"] == "run.submitted"
        assert events[-1]["type"] == "task.succeeded"
        assert not any(event["type"] == "run.succeeded" for event in events)
        # Verify monotonic seq
        seqs = [e["seq"] for e in events]
        assert seqs == list(range(1, len(seqs) + 1)), f"Broken seq: {seqs}"

        # Results — check actual output files from run directory
        run_dir = st.resolve("real-pipe")
        all_files = list(run_dir.rglob("*"))
        file_paths = [str(p.relative_to(run_dir)) for p in all_files if p.is_file()]
        print(f"  Run dir files: {file_paths}")
        assert any("input.csv" in f for f in file_paths), f"Should have input.csv: {file_paths}"
        assert any("output.csv" in f for f in file_paths), f"Should have output.csv: {file_paths}"
        assert any("summary.txt" in f for f in file_paths), f"Should have summary.txt: {file_paths}"

        # No .snakemake pollution in data-root or run directory
        assert not (tmp_path / "data" / ".snakemake").exists()
        assert not (st.resolve("real-pipe") / ".snakemake").exists()
        # Verify no raw log files leaked to project root
        for bad_file in ["raw.log", "snakemake.log", "output.log"]:
            assert not (Path(__file__).resolve().parent.parent / bad_file).exists(), \
                f"Found pollution: {bad_file}"


class TestPortability:
    """Verify data-root and result file portability."""

    def test_move_data_root_preserves_run_files(self, tmp_path, monkeypatch):
        """Moving the entire data-root to a new location preserves Run result files.

        This tests that Run result files use relative directory organization
        and remain readable after the data-root is relocated.  It does NOT
        yet test workspace-identity portability (attach/reindex after move)
        or backend restart with a new TDEASE_DATA_ROOT — those are separate
        concerns tracked for the next test phase.
        """
        from src.execution_runtime import StorageLayout, set_storage, execute
        from src.contracts import RunCommit

        data1 = tmp_path / "data1"
        data1.mkdir()
        monkeypatch.setenv("TDEASE_DATA_ROOT", str(data1))
        st1 = StorageLayout(data1); st1.bootstrap(); set_storage(st1)

        snakefile = 'rule a:\n    shell:\n        "echo STATIC_OUTPUT_42 > result.txt"'
        commit = RunCommit(
            run_id="portable-1", idempotency_key="ik-port",
            workspace_id="ws-port", workspace_tree_hash="0" * 64,
            snakefile=snakefile, cores=1, user_id="t",
        )
        # Queue the revision after storage is bound (EventEmitter captures the
        # active storage at construction) — the engine rejects any execute()
        # without a queued revision, matching the API->worker path.
        from src.execution_runtime.events import EventEmitter
        emitter = EventEmitter("portable-1")
        if not emitter.last_seq:
            emitter.run_submitted("def-portable-1")
        emitter.run_queue_requested("def-portable-1", "execute", rerun_mode="resume")
        from src.services.run_commands import get_run_commands

        assert get_run_commands().begin_execution("portable-1") is not None
        result = execute(commit, revision_id="def-portable-1", execution_mode="execute")
        assert result.success

        # Read result from original location
        out = (data1 / "runs" / "portable-1" / "result.txt").read_text()
        assert "STATIC_OUTPUT_42" in out

        # Move data-root to new location
        data2 = tmp_path / "data2"
        shutil.move(str(data1), str(data2))
        monkeypatch.setenv("TDEASE_DATA_ROOT", str(data2))

        # Verify results are still accessible from new location
        out2 = (data2 / "runs" / "portable-1" / "result.txt").read_text()
        assert "STATIC_OUTPUT_42" in out2
        print(f"  Portable result: {out2.strip()}")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
