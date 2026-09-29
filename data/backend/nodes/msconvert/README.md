# msconvert

Wrapper around ProteoWizard `msconvert` for converting vendor raw formats
(`.raw`, `.d`, `.wiff`) to mzML.

> **Calibrated against `msconvert.exe --help` (ProteoWizard 3.0.26139.0599784,
> 2026-07-27)**. This node produces the mzML that
> [`toppic`](../toppic/README.md) consumes — topfd's `mz_error` is downstream
> of the precision chosen here, so the two are calibrated together.

## Important

This node ships the **full ProteoWizard distribution** — `msconvert.exe` and
its DLLs sit next to `rules.smk`, and that bundled binary is the calibrated
version. The rule binds it directly inside the Run's materialized node
snapshot (`nodes/msconvert/msconvert.exe` relative to the Run root), so a Run
never needs ProteoWizard installed on the host.

To use a **host-installed ProteoWizard** deliberately, set its install
directory in the Run config:

```yaml
msconvert:
  bin_dir: 'C:\Program Files\ProteoWizard\ProteoWizard 3.0.23233.c72ce16'
```

The choice lives in the Run's `config.yaml`, so the provenance sidecar can
cite which binary produced the mzML. There is no wrapper script: the rule
invokes `msconvert.exe` itself, so nothing ever probes the host behind the
Run's back.

## Binary layout

```
msconvert/
  msconvert.exe     # ProteoWizard 3.0.26139.0599784 + its DLLs (bound by rules.smk)
  rules.smk
  README.md
```

## Parameters

All four are declared and wired in `rules.smk`, the Node's only contract.
Defaults match ProteoWizard's own
`--help` output (`--64`, `--mzML`, zlib off by default); only `centroid` is a
ProteoWizard *filter* rather than a top-level flag.

| param         | default | type           | description                                                              |
|---------------|---------|----------------|--------------------------------------------------------------------------|
| raw_extension | `.raw`  | `.raw`/`.wiff`/`.d` | Vendor input suffix used to resolve each sample's source file      |
| centroid      | true    | bool           | centroid spectra (`--filter "peakPicking true 1-"`)                      |
| precision     | **64**  | 64 \| 32       | binary m/z precision (`--64` / `--32`)                                   |
| zlib          | false   | bool           | zlib compression (`-z`)                                                  |
| binary        | bundled exe | absolute path | host-installed `msconvert.exe` to use instead of the bundled binary  |

### Why precision defaults to 64

Top-down interpretation turns on mass differences that are the question being
asked: acetyl vs trimethyl (36 mDa), phospho vs sulfo (9.5 mDa), bromination
(+77.91) vs phosphorylation (+79.97). They are resolved from measured m/z
across an isotope envelope, so precision lost here is lost for deconvolution,
mass-shift assignment, fragment matching and error maps alike — no later tool
recovers it.

`--32` narrows **both** arrays, m/z included. msconvert's own default is 64-bit
m/z with 32-bit intensity, which is what published top-down workflows use and
what the reference mzML in this Workspace carries. There is no top-down use
case for 32-bit m/z.

**Never enable MS-Numpress.** The `spectral-evidence` skill's mzML reader
decodes zlib but not Numpress and returns `UNSUPPORTED_ENCODING` rather than a
partial read.

The chosen parameters are part of what a mass measurement means. Cite them
alongside any conclusion drawn from the converted file.

## Example config.yaml

```yaml
msconvert:
  raw_extension: .raw
  centroid: true
  precision: 64
  zlib: false
  # binary: 'C:\Program Files\ProteoWizard\...\msconvert.exe'   # optional host install
```
