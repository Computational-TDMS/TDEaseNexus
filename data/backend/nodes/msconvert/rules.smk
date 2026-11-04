# TDEase node: msconvert
# Wrapper around ProteoWizard msconvert (raw → mzML conversion).
# The node ships the calibrated ProteoWizard build for the host platform (the
# Windows distribution: msconvert.exe + vendor DLLs; Linux: a `msconvert`
# wrapper that runs the vendor-enabled ProteoWizard Docker image when Docker is
# available and falls back to the bundled static binary for open formats) in
# the Backend's node catalog; the engine
# resolves this package at execution time via the absolute path in
# config["nodes"]["msconvert"] — a Run never requires ProteoWizard on the host
# and never carries tool bytes. A host install can be used deliberately by
# setting `msconvert.bin_dir` in the Run config (absolute directory holding the
# binary), which the Run's provenance then records.
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
import sys
from pathlib import Path

# The Backend injects this node's deployed catalog directory as an absolute
# path in config["nodes"] at execution time; failing loudly when the Run did
# not bind the node beats silently hunting a host install.
_MSC_DIR = Path((config.get("nodes") or {}).get("msconvert") or "")

# The package is deployed per host platform: the Windows build carries
# msconvert.exe + vendor DLLs, the Linux build is a single static `msconvert`.
# Same rules file, binary name chosen by the host running the Run.
_MSC_NAME = "msconvert.exe" if sys.platform.startswith("win") else "msconvert"


# `<id>.bin_dir` in the Run's config.yaml replaces the directory this node
# resolves its executable from (a host ProteoWizard install). The choice is part
# of the Run's config.yaml, so the provenance sidecar can cite which binary
# produced the mzML. Unset: the package's own calibrated binary. There is
# deliberately NO host discovery fallback (WORKFLOW-RUN.md: no Run depends on
# host PATH) — an unbound Run fails at parse time naming this node.
_MSC_BIN_DIR = (config.get("msconvert") or {}).get("bin_dir")


def _resolve_msconvert() -> str:
    """A host install named by config, else the node's own calibrated binary.
    Resolution happens once, at parse time, so the Run's recorded command line
    names the binary that actually ran."""
    if _MSC_BIN_DIR:
        return str(Path(_MSC_BIN_DIR) / _MSC_NAME)
    bundled = _MSC_DIR / _MSC_NAME
    if not bundled.is_file():
        raise FileNotFoundError(
            "msconvert node is not usable: bind it (config['nodes']['msconvert']) "
            "or set msconvert.bin_dir to a host install"
        )
    return str(bundled)


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
