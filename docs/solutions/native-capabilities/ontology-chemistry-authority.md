---
title: Remove local modification chemistry overrides
date: 2026-09-05
module: proteomics
problem_type: logic_error
component: domain_proteomics
severity: high
symptoms:
  - "Deamidation and UNIMOD:7 produced different masses for the same peptide."
root_cause: logic_error
resolution_type: code_fix
tags: [mzcore, proforma, chemistry, deamidation]
---

# Remove local modification chemistry overrides

## Problem

A local built-in modification table took precedence over mzcore's ontology.
Its Deamidation formula omitted H-1, changing exact mass and isotope theory.

## Symptoms

AQ[Deamidation]K contributed 1.99184061501 Da, whereas AQ[UNIMOD:7]K
contributed 0.984015583112 Da. The former used N-1O rather than H-1N-1O.

## What Didn't Work

Preserving historical built-in values maintained a second, inconsistent chemical
authority. Correcting only this entry would leave the duplicate table in place.

## Solution

Removed the local table. Names and ontology IDs now pass to mzcore unchanged;
only explicitly supplied user formulas override ontology lookup. Fragment matching
constructs typed mzcore peptides and obtains mass and theory from that model.

## Why This Works

Adapters normalize syntax, not chemistry. The same ontology defines named and
ID-based modifications, eliminating an independent formula maintenance surface.

## Prevention

CLI regression compares exact composition and mass for name/ID pairs including
Deamidation, Acetyl, Phospho and Oxidation. Unknown aliases must error, never
receive a guessed formula. Historical artifacts are not rewritten; analyses
using old named chemistry require explicit reruns to obtain corrected results.

## Related

- [Rust scientific contract](../../spec/RUST-MS-CONTRACT.md)
