# TDEase node: msconvert
# Wrapper around ProteoWizard msconvert (raw → mzML conversion).
# The node ships the full ProteoWizard distribution (msconvert.exe + DLLs, the
# calibrated version) in the Backend's node catalog; the engine resolves this
# package at execution time via the absolute path in config["nodes"]
# ["msconvert"] — a Run never requires ProteoWizard on the host and never
# carries tool bytes. A host install can be used deliberately by setting
# `msconvert.bin_dir` in the Run config (absolute directory holding
# msconvert.exe), which the Run's provenance then records.
#
# ============================================================================
# WHAT AN AGENT NEEDS TO KNOW BEFORE CHANGING THESE PARAMETERS
# ============================================================================
#
# `precision` decides whether the analysis downstream of this rule can tell two
# modifications apart. It is not a storage-size preference.
#
#   Top-down interpretation turns on differences that are small in absolute
#   terms and are the entire question being asked:
#
#     acetylation vs trimethylation            36  mDa apart
#     phosphorylation vs sulfation              9.5 mDa apart
#     bromination (+77.91) vs phosphorylation (+79.97)
#
#   These are resolved from the measured m/z of many peaks across an isotope
#   envelope, so precision lost in the file is lost for every downstream step:
#   deconvolution, mass-shift assignment, fragment matching, error maps. No
#   later tool can recover it.
#
#   msconvert's own default is 64-bit m/z with 32-bit intensity, and that is
#   what published top-down workflows and the reference mzML in this Workspace
#   use. `precision: 64` reproduces it. Choosing 32 applies `--32` to BOTH
#   arrays, narrowing m/z as well; there is no top-down use case for that, so
#   64 is the default here. Intensity does not carry the same requirement.
#
# `zlib` is safe and roughly halves file size. It is off by default only
#   because compression is a deployment choice, not an analysis one.
#
# DO NOT enable MS-Numpress compression. The mzML reader in the
#   `spectral-evidence` skill decodes zlib but not Numpress, and returns
#   `UNSUPPORTED_ENCODING` rather than a partial read. A file the evidence
#   layer cannot read cannot support a conclusion.
#
# `centroid` runs `peakPicking true 1-`, which uses the vendor algorithm when
#   one is available. TopFD consumes centroided peak lists; leave this on
#   unless a specific step needs profile data, and record why in the config.
#
# Whatever is chosen belongs in the record: conversion parameters are part of
# what a mass measurement means, so cite them alongside any conclusion drawn
# from the converted file.
# ============================================================================
import shutil
import glob
from pathlib import Path

# The Backend injects this node's deployed catalog directory as an absolute
# path in config["nodes"] at execution time; failing loudly when the Run did
# not bind the node beats silently hunting a host install.
_MSC_DIR = Path((config.get("nodes") or {}).get("msconvert") or "")


# `<id>.bin_dir` in the Run's config.yaml replaces the directory this node
# resolves its executable from (a host ProteoWizard install). The choice is part
# of the Run's config.yaml, so the provenance sidecar can cite which binary
# produced the mzML. Unset: the package's own calibrated binary, then a
# discovered host install.
_MSC_BIN_DIR = (config.get("msconvert") or {}).get("bin_dir")


def _resolve_msconvert() -> str:
    """A host install named by config, else the node's own calibrated binary,
    else a discovered host install. Resolution happens once, at parse time, so
    the Run's recorded command line names the binary that actually ran."""
    if _MSC_BIN_DIR:
        return str(Path(_MSC_BIN_DIR) / "msconvert.exe")
    bundled = _MSC_DIR / "msconvert.exe"
    if bundled.is_file():
        return str(bundled)
    for name in ("msconvert", "msconvert.exe"):
        found = shutil.which(name)
        if found:
            return found
    for pattern in (r"C:\Program Files\ProteoWizard\*\msconvert.exe",
                    r"C:\Program Files (x86)\ProteoWizard\*\msconvert.exe"):
        hits = sorted(glob.glob(pattern))
        if hits:
            return hits[0]
    return str(bundled)  # nothing found: fail loudly naming the node's own path


_MSC_BIN = _resolve_msconvert()
_RAW_PATTERN = "{sample}" + (config.get("msconvert") or {}).get("raw_extension", ".raw")


# ----------------------------------------------------------------------------
# rule msconvert — convert vendor raw to mzML
# Inputs : a vendor raw file (.raw / .d / .wiff)
# Outputs: centroided mzML
# Params (config-driven, see README.md):
#   centroid       bool, centroid spectra          (--filter "peakPicking true 1-")
#   precision      64 | 32                          (--64 or --32; see note above)
#   zlib           bool, zlib compression           (-z)
#   binary         absolute path to a host msconvert.exe; default = the
#                  bundled calibrated binary in this node package
#                  (config key: `msconvert.bin_dir`)
# ----------------------------------------------------------------------------
rule msconvert:
    input:
        raw = _RAW_PATTERN,
    output:
        mzml = "{sample}.mzML",
    threads:
        1
    resources:
        mem_mb = 1024,
    params:
        centroid       = lambda wc, cfg=config: '--filter "peakPicking true 1-"' if cfg.get("msconvert", {}).get("centroid", True) else "",
        precision      = lambda wc, cfg=config: f"--{cfg.get('msconvert', {}).get('precision', 64)}",
        zlib           = lambda wc, cfg=config: "-z" if cfg.get("msconvert", {}).get("zlib", False) else "",
        msconvert_bin  = _MSC_BIN,
    message:
        "msconvert: {input.raw} -> {output.mzml}"
    shell:
        '("{params.msconvert_bin}" "{input.raw}" --mzML {params.centroid} {params.precision} {params.zlib} '
        '--outfile "{output.mzml}")'
