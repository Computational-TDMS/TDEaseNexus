"""Shared fixture builders for the skill tests.

``graft_parent_ms1`` turns the trimmed single-MS2 fixture into one that also
carries the MS1 parent its MS2 ``spectrumRef`` points at — every MS1 route
refuses to run without it.
"""

from __future__ import annotations

from pathlib import Path


def graft_parent_ms1(source: Path, destination: Path) -> None:
    """Copy the trimmed single-MS2 fixture and add the MS1 parent its MS2
    ``spectrumRef`` points at — validate-precursor refuses to run without it.
    The synthesized envelope deliberately does not match the test's model:
    with ``--isotope-gate diagnostic`` the scan is kept and the mismatch is
    reported as a warning instead of silently dropping the measurement."""
    import base64
    import struct
    import zlib

    text = source.read_text(encoding="utf-8")

    def encoded(values):
        return base64.b64encode(
            zlib.compress(struct.pack(f"<{len(values)}d", *values))).decode()

    mzs = [671.6141 + i * 0.05902 for i in range(8)]
    ints = [2.4e7 * 0.72 ** i for i in range(8)]
    ms1 = (
        '        <spectrum index="0" id="controllerType=0 controllerNumber=1 scan=1148" defaultArrayLength="8">\n'
        '          <cvParam cvRef="MS" accession="MS:1000579" name="MS1 spectrum" value=""/>\n'
        '          <cvParam cvRef="MS" accession="MS:1000511" name="ms level" value="1"/>\n'
        '          <cvParam cvRef="MS" accession="MS:1000127" name="centroid spectrum" value=""/>\n'
        '          <cvParam cvRef="MS" accession="MS:1000504" name="base peak m/z" value="671.6141" unitCvRef="MS" unitAccession="MS:1000040" unitName="m/z"/>\n'
        '          <cvParam cvRef="MS" accession="MS:1000505" name="base peak intensity" value="2.4e7" unitCvRef="MS" unitAccession="MS:1000131" unitName="number of detector counts"/>\n'
        '          <cvParam cvRef="MS" accession="MS:1000285" name="total ion current" value="7.0e7"/>\n'
        '          <scanList count="1">\n'
        '            <cvParam cvRef="MS" accession="MS:1000795" name="no combination" value=""/>\n'
        '            <scan count="1">\n'
        '              <cvParam cvRef="MS" accession="MS:1000016" name="scan start time" value="37.78" unitCvRef="UO" unitAccession="UO:0000031" unitName="minute"/>\n'
        '              <binaryDataArrayList count="2">\n'
        f'                <binaryDataArray encodedLength="{len(encoded(mzs))}">\n'
        '                  <cvParam cvRef="MS" accession="MS:1000514" name="m/z array" value=""/>\n'
        '                  <cvParam cvRef="MS" accession="MS:1000523" name="64-bit float" value=""/>\n'
        '                  <cvParam cvRef="MS" accession="MS:1000574" name="zlib compression" value=""/>\n'
        f'                  <binary>{encoded(mzs)}</binary>\n'
        '                </binaryDataArray>\n'
        f'                <binaryDataArray encodedLength="{len(encoded(ints))}">\n'
        '                  <cvParam cvRef="MS" accession="MS:1000515" name="intensity array" value=""/>\n'
        '                  <cvParam cvRef="MS" accession="MS:1000523" name="64-bit float" value=""/>\n'
        '                  <cvParam cvRef="MS" accession="MS:1000574" name="zlib compression" value=""/>\n'
        f'                  <binary>{encoded(ints)}</binary>\n'
        '                </binaryDataArray>\n'
        '              </binaryDataArrayList>\n'
        '            </scan>\n'
        '          </scanList>\n'
        '        </spectrum>\n'
    )
    text = text.replace('spectrumList count="1"', 'spectrumList count="2"')
    text = text.replace(
        '<spectrum index="0" id="controllerType=0 controllerNumber=1 scan=1164"',
        '<spectrum index="1" id="controllerType=0 controllerNumber=1 scan=1164"')
    marker = '        <spectrum index="1" id="controllerType=0 controllerNumber=1 scan=1164"'
    assert marker in text
    text = text.replace(marker, ms1 + marker)
    data = text.encode("utf-8")
    offsets = {
        "scan=1148": data.find(b'<spectrum index="0"'),
        "scan=1164": data.find(b'<spectrum index="1"'),
    }
    index = (
        '  <indexList count="1">\n'
        '    <index name="spectrum">\n'
        f'      <offset idRef="controllerType=0 controllerNumber=1 scan=1148">{offsets["scan=1148"]}</offset>\n'
        f'      <offset idRef="controllerType=0 controllerNumber=1 scan=1164">{offsets["scan=1164"]}</offset>\n'
        '    </index>\n'
        '  </indexList>\n'
    )
    index_offset = len(data) + len(index.encode())
    text = text.replace(
        "    </run>\n  </mzML>",
        "    </run>\n" + index
        + f"  <indexListOffset>{index_offset}</indexListOffset>\n  </mzML>")
    destination.write_text(text, encoding="utf-8")
