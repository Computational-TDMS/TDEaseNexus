---
type: design
title: Motif prior — homologous-protein motif knowledge aiding PTM exploration
description: Using homologous-protein motif prior knowledge to aid PTM exploration (design state, unfrozen).
status: partial
---

# Motif prior — design document (unfrozen; implementation follows the +317 case validation)

> Status: **design**. On 2026-08-03 the user decided to unfreeze "motif → enzyme →
> modification knowledge = B (deferred)" (the provenance layering doc was deleted 2026-08-09; git history retains it). This
document designs how to use
> **homologous-protein motif knowledge** to aid the exploration of complex combined
> modifications, especially serving the soybean nodule +317 case (Q2KMJ4/C6T4V4, Met
> removal + N-terminal myristoylation + Cys4 palmitoylation).

## 1. The problem

Routine UniMod mass search fails for **combined modifications**: a +317.39 Da shift
split into single-modification searches hits nothing individually (myristoyl +210,
palmitoyl +238, etc.); only the combination (Met removal -131.04 + myristoyl +210.20 +
Cys4 palmitoyl +238.23 = +317.39) explains it. But **how does one know to try this
combination?** The answer lies in motif priors: this protein family is known to be
N-terminally modified by "methionine removal + myristoylation", and Cys4 is a
palmitoylation hotspot.

## 2. Layered position (aligned with evidence-bounds)

Motif knowledge is a **prior, not sample evidence**:

| Layer | Content | Role | Assertable? |
|---|---|---|---|
| UniProt annotation (this protein) | known sites in `cc_ptm` | strong candidate prior | still needs spectrum verification |
| Homolog annotations | `cc_ptm` of homologs | medium candidate prior | conserved sites may transfer |
| **motif/enzyme rules** | N-terminal acetylation/myristoylation motifs, palmitoylation Cys hotspots | **combination candidate generator** | generates combinations, proves nothing |
| Spectrum evidence | fragments/isotopes/error maps | adjudicates | the only assertable layer |

**Principle**: motif rules **generate candidate combinations**; spectrum evidence
**adjudicates**. A motif hit never equals an identification.

## 3. Homolog motif query guidance (with existing tools)

No motif engine is built; use the existing UniProt capabilities for **guided
queries**:

```
1. The protein's own annotation:  uniprot.get id:<acc> fields:[cc_ptm, ft_mod_res, feature, sequence]
2. Homolog cluster:         uniprot.query resource:"homology" seed:{accession}
3. Homolog member annotations:   for each memberId → uniprot.get fields:[cc_ptm]
                   (or advancedQuery:"accession:P1 OR accession:P2" fields:[cc_ptm])
4. knowledge.db:   ms-reference/scripts/knowledge_sites.py --accession <acc>
                   (841 local sites; evidence_type="homology" can be filled in)
5. Motif induction:     align the positions appearing in homolog annotations; find conserved modification sites
```

`advancedQuery` passes the official syntax through verbatim (`cc_ptm:*`,
`ft_var_mod:*`, `lit_*`); any new UniProt field is usable directly without a TDEase
release (existing capability, confirmed 2026-08-02).

## 4. The enzyme-modification knowledge table (a future knowledge.db extension)

`site_evidence.evidence_type` in knowledge.db already reserves the `homology`
constraint but it is unused. Landing motif priors needs an
**enzyme-modification-consensus** relation:

| motif/enzyme rule | Modification | delta (Da) | Known example |
|---|---|---|---|
| N-terminal demethionylation (G2 + acetylation) | N-acetyl | +42.010 | histone H4 |
| N-terminal demethionylation + myristoylation (G2 is Gly) | Myristoyl | +210.198 | soybean Q2KMJ4 |
| Cys4 palmitoylation (near the N-terminus) | Palmitoyl | +238.230 | soybean C6T4V4 |
| ... | ... | ... | ... |

These rows do **not** become hardcoded constants in the CLI (consistent with the
`constants.rs` iron law) but queryable knowledge.db data exposed by query scripts like
`knowledge_sites.py`. The enumeration table is built from UniProt `cc_ptm` +
`ft_var_mod` + published cases.

## 5. Combination candidate generation

Given an unexplained shift Δ and the protein sequence:

1. Enumerate the known modification delta set (UniMod dual-source + knowledge.db).
2. Enumerate combinations (≤3 modifications; `tdeasenexus-toolbox unimod-solve` already
   does this).
3. **Rank the combinations by motif prior**: prefer combinations hitting known motif
   rules (N-terminal acetylation/myristoylation + Cys palmitoylation) over purely
   mass-matched combinations.
4. Every combination candidate enters `refine-shift` verification (prior_shift = the
   combination's total Δ).

`tdeasenexus-toolbox unimod-solve` already returns combinations; the motif prior only
**ranks** them; the search itself is unchanged.

## 6. Delivery

- **Timing**: validated along with the soybean nodule +317 case (the paper's main
  line). First run Stage 7 (UniProt priors, landed 2026-08-03) through the +317 case,
  confirm the motif ranking's gain on combination hits, then implement this design.
- **Additions (at implementation time)**:
  - knowledge.db gains a `motif_rules` table (or reuses `modification_sites` + a new
    table)
  - `knowledge_sites.py` gains a `--motif` query returning the enzyme-motif rules
  - the census/copilot skill layer gains Stage 8 (combination candidates
    + motif ranking)

## 7. Honest boundaries

- The motif prior is a **candidate generator**, not evidence. Combined modifications
  must still pass `refine-shift` + fragment verification.
- Conserved-site transfer is homolog reasoning, **not** an observation of this sample.
  Cross-species/subtype motif rules may not apply.
- knowledge.db has only 55 proteins/841 sites (an imported subset); motif-rule
  coverage is limited; when data is missing, explicitly report "no motif prior; pure
  mass search".
- `solveMass`'s combinatorial explosion is a real risk: max_modifications ≤ 3 +
  motif-rank convergence must not be loosened.

## Related

- [Subagent runtime design](./SUBAGENT-RUNTIME.md)
- [UniProt query capability](../solutions/native-capabilities/uniprot-query-capability.md)
