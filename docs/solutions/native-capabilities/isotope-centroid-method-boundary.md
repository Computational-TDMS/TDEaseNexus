---
title: Preserve BRAIN centroids outside nominal-isotope matchers
date: 2026-09-05
module: native-capabilities
problem_type: logic_error
component: domain_proteomics
severity: high
symptoms:
  - "Frozen Chlamy fits changed by up to 0.036404 without input changes."
root_cause: scope_issue
resolution_type: code_fix
tags: [isoforma, brain, isotope, error-map, reproduction]
---

# Preserve BRAIN centroids outside nominal-isotope matchers

## Problem

A Spectator-specific nominal C13 matching coordinate had replaced BRAIN
isotope centroids in general fragment theory. IsoForma consumes that theory;
its matched intensities and fitted proportions therefore changed silently.

## Symptoms

On frozen Chlamy inputs, 19 fits retained their status and rank but 80 reported
fractions drifted, with a maximum absolute difference of 0.036404. One c16
channel changed from 2409.4594167 to 1045.7012167 despite unchanged neutral mass.

## What Didn't Work

Repeated fitting reproduced the drift. The previous release also drifted;
the latest Rust consolidation was not the cause. The paper-era binary restored
the frozen matrix on the same hash-verified MGF.

## Solution

General fragment envelopes retain dependency-generated BRAIN centroids,
translated from neutral M0 into the requested charge frame. Only error-map
matching uses its documented nominal C13 coordinates. No new user switch or
chemistry implementation is required.

Array indices and neutron offsets are separate: sparse envelopes can omit
intermediate weak isotopes. Apex status, displayed ppm, and observed neutral
mass use the actual neutron offset, never the envelope array index.
Numeric named losses retain an explicitly approximate intact envelope shape;
formula-defined engine losses retain their formula-derived envelopes.

## Why This Works

Theory reports chemistry; each measurement method owns its matching convention.
Restoring this boundary reproduces all 80 frozen fractions exactly (maximum
absolute difference 0.0) across 19 fits. This is a fixed-input numerical control,
not evidence that an Agent discovered the paper model autonomously.

## Prevention

- Preserve the centroid invariant against the underlying neutral envelope.
- Exercise sparse offsets in the existing error-map matching test.
- Run the real Wilson error-map and Chlamy paper controls together.
- Keep MGF exports, declared grouping, pooling, and tool version in provenance.

## Related

- [Rust measurement contract](../../spec/RUST-MS-CONTRACT.md)
- [Paper control runner](../../paper/results/run_chlamy_five_sample_isoforma.py)
