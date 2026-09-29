# Exploration Log

> Purpose: manage the **hypothesis–experiment–verdict loop of scientific
> exploration** and prevent going in circles. Each entry answers four
> things: what the hypothesis was, what was run, the verdict, and what is
> still owed. Only **cognitive state** is recorded here; "what is
> implemented" belongs in `STATUS.md`.
>
> Rules:
> 1. One entry = one adjudicated exploration round. Verdicts: `confirmed`
>    / `refuted` / `ambiguous` / `insufficient_data`. No entry may end
>    without a verdict.
> 2. A path already ruled out is not re-run, unless the record states new
>    evidence that overturns the original exclusion reason.
> 3. Mass closure ≠ chemical assignment; significant composition (≥2
>    log10 gap) ≠ site determined. These two are the constitution of this
>    log, drawn from the actual lessons of 2026-08-19/20.
> 4. Before starting a new round, read this file first and check whether a
>    verdict already exists.
> NOTE (2026-08-25): older entries cite the pre-restructure skill layout
> (`mass-shift-analysis/...`, `mass-shift-analysis/subagents/massshift-deepresearch`).
> That skill is gone — its capability now lives in `tdp-copilot` (focused verdicts,
> references/adjudication-methods.md) and `tdp-opensearch` (census) — and the
> deep-research subagent role is no longer shipped. Historical paths stay as written.
>
> 5. Exploration must follow the three-step LOOP of
>    [`design/MASS-SHIFT-LOOP.md`](design/MASS-SHIFT-LOOP.md)
>    (exploration adjustment → dryrun → three data-change questions);
>    record the answers to the three questions each round.
> 6. Scope boundary: this log covers **post-data-analysis only** — the
>    scientific loop over already-deconvoluted, already-searched products
>    (msalign / feature / PrSM → attribution, assignment, census,
>    verification). Data pre-processing — RAW→mzML conversion, TopFD/TopPIC
>    deconvolution runs, node deployment and recovery — is operational
>    infrastructure, owned by `NODES.md`, `STATUS.md` and Run-level
>    provenance; it is never itself an exploration round. Upstream tool
>    artifacts (e.g. a TopFD isotope misassignment) may enter an entry as
>    input constraint or evidence, but repairing or re-running the
>    pre-processing step belongs to the operational layer.

## Currently active fronts

- **Mouse deep queue**: 6 hard-unexpected records / 5 recurring masses
  (70.93, 143.81, 40.94, 54.87, 24.10, 52.10×2) — see E4.
- **Correctness fixes for combinational modification assignment**:
  same-mass modification dedup + symmetry normalization not implemented;
  the mass_closed fast path is deleted but joint-scoring semantics await
  E2E verification — see E7.
- **Follow-up verification of the H4 +121.98 / 79 Da family**: the
  current three-feature envelope result supports the Bromo family; still
  needs follow-up independent data review, and draws no site conclusion —
  see E46.

## E1 · High-throughput funnel performance (2026-08-19) — `confirmed`

**Hypothesis**: the bottleneck of prsm-refine is per-spectrum repeated
MSAlign parsing and serial composition scoring.
**Experiment**: extracted `query_prsm_localize_spectra` (parse once per
scan, reused across compositions) + Rayon-parallel composition scoring.
Soybean 7-record benchmark 167.7 s → 44.4 s (~3.8×).
**Verdict**: two independent release re-runs matched item by item
exactly (knownMass / unexplained / scoreGap / ambiguous) — a pure
performance change, zero drift in scientific conclusions. Remaining
bottleneck = exhaustive candidate-site enumeration.

## E2 · Ambiguity-rule correction (2026-08-19) — `confirmed`

**Hypothesis**: the old rule `ranked.len()>1 ⇒ ambiguous` wrongly pushed
evidence-dominant candidates into the ambiguity channel.
**Correction**: composition ambiguity requires runner-up gap < 2 log10
(hundredfold); `localized` additionally requires a unique best site.
Mouse 36/36 strong-PrSM round: 10 records with ≥2 log10 gap, of which
only 3 also had a unique site.
**Verdict**: rule adopted — "composition significant" and "site unique"
are two independent thresholds, never merged.

## E3 · Soybean M01 strong-record deep dive (2026-08-19) — `ambiguous` (partially `confirmed`)

**Experiment**: full-scan MS2 for +79.072284 and +119.031553.
**Results**: +79.07 → Methyl+Acetyl with +23.05 unexplained (gap 1.15,
ambiguous, site 1-9); +119.03 → Dimethyl+Phospho with +11.03 (gap 2.38,
composition no longer ambiguous, but site interval 98-100). Neither
residual has a ≤0.05 Da direct UniMod match.
**Verdict**: soybean has 0 reference-free hard-unexpected records; 2
await deeper evidence, one with composition settled but site unsettled.

## E4 · Mouse hard shortlist (2026-08-19) — `confirmed` (partially excluded)

**Experiment**: 9 hard records (all sibling scans) completed in 256 s.
**Results**: direct UniMod matches 55.04 (Met→Trp/Thr→Arg), 84.06
(isovaleryl-like), 6.94 (Arg→Tyr substitution-like) — these three
classes are not new-PTM claims. The remaining 6 records / 5 recurring
masses form the bulk of this round's deep queue; several have
composition evidence but wide site intervals.

## E5 · Role clarification for family priors (2026-08-19) — `confirmed`

**Hypothesis (refuted)**: `ms1-families.csv` can be joined to the PrSM
checklist.
**Experiment**: E2E showed 0/95 (mouse), 0/77 (soybean) overlap — these
are precisely the MS1-only features deliberately excluded.
**Verdict**: `ms1-families` only builds sample priors (mouse 24 families
= 18 named + 6 unexplained, mostly in 78.64-79.02 Da; soybean 13 = 12 +
1). Family evidence is not site evidence and does not directly archive
PrSM records.

## E6 · Chemical model for combinational modifications (2026-08-20) — `confirmed` (modeling rules established)

Rules established while exploring combinational assignment
(multi-methylation + oxidation etc.):

1. Two modification events of the same mass/name (e.g. dimethyl-1@K20 +
   dimethyl-2@K40 vs the reverse labeling) are chemically equivalent;
   output must apply **combination dedup and symmetry normalization**.
2. By default the same residue may not stack two identical
   modifications (two +28.0313 on one K is not "two dimethylation
   sites", it is further methylation).
3. When only a single cleavage can distinguish them, localization is
   only to a set/interval; do not claim two independent single points
   are both determined.
4. An M-site constraint can markedly narrow the oxidation search, but
   the unconstrained top score must not be auto-treated as the correct
   site.

## E7 · mass_closed fast-path defect (2026-08-20) — `refuted` (path deleted)

**How it surfaced**: a mis-targeted run (72.0575 = 2×dimethyl +
oxidation) accidentally revealed: when the modification library happens
to close the total mass, the code skipped MS2 scoring and returned the
first candidate site directly, and allowed two dimethyls on the same K5
— the output looked localized but was mere mass conservation.
**Verdict**: the fast path is a real defect, deleted from `prsm.rs`.
Fix direction (verified in E8): mass closure must also run joint MS2
scoring over the full combination; identical modifications are banned
from the same residue; output only candidate sets with score gaps.

## E8 · H4 +121.98 PrSM joint assignment (2026-08-20) — `ambiguous`

**Target**: mouse brain histone H4, +121.9846, scans 1164/1165/1204
(the +122-family residual of paper case-1).
**Modification library**: dimethyl(+28.0313, K) + oxidation(+15.9949, M).
**Result**: dimethyl→K16, oxidation→M84, residual +77.9584 (interval
69-88), verdict ambiguous. MS2 did participate in joint scoring (not the
mass-closure shortcut).
**Verdict**: this is the **best joint combination under the current
model**, which does not mean K16/M84 are independently confirmed. Note
that the +77.96 residual and the paper-side elemental-level MS2 doublet
evidence for Y88Br (scan 1164) point to the same unclosed region —
reconciling the two fronts is the next adjudicative action.
**Owed**: (a) candidate-score comparison of unconstrained vs
residue-constrained runs, to test K16/M84 stability; (b) re-run after
same-mass combination dedup (E6-1, unimplemented) lands; (c) a formal
hypothesis-compare against the Y88Br hypothesis.

> **Status update (E46)**: E8 is retained as the historical PrSM joint
> assignment result. The full MS1 envelope competition for the same H4
> serial family was done separately in E46; E46's family-level Bromo
> verdict supersedes E8's "final assignment pending" status for that
> family, but does not change E8's historical record of its old PrSM
> combination localization result.

## E9 · Pre-submission reviewer-view reconciliation (2026-08-20) — `confirmed` (all green)

**Four-line review**: figure-text panel references, body numbers vs data
sources, asset/string leftovers, citation completeness.

- **Final ruling on census conventions**: the top-level
  `shift_observations=6180` of `mouse-census-full.json` is the raw
  convention including 1,362 singletons; the body's 4,818 = sum of
  in-cluster counts, mechanically exportable from JSON — **no
  regeneration needed**. Panels no longer contain auto-stat strings;
  6180 no longer appears in the figures. The two conventions are equal
  for chlamy/soybean (no singletons); only mouse has this fork.
- **All numbers correct**: truth-manifest matches the body item by item —
  mouse 879/4818, ledger 755/717/76, +121.98→12 partitions/6 genes;
  chlamy 1115/2036; soybean 2936/16697 (= all ten PrSM tables),
  2,365×10, 344=45+299, C6T4V4 60.2×/51.1×, Q2KMJ4 257.3× (padj 0.0647).
- **case1 deep-dive numbers all correct**:
  f67-dual-hypothesis-comparison.json carries evidenceLog10 Br=113.80 vs
  phospho=21.40, LR 10^92.4, 63 vs 14, per-position ≥6.1, precursor
  0.4 vs −178.5 ppm, 4/4 per-spectrum wins. The body wording is
  restrained ("the error map alone is not presented as elemental-level
  direct proof").
- **Figure panels**: scripts back to five panels (A–E), the guard
  `check_figure_refs` green; three figures rebuilt with the current
  scripts (identical byte sizes, proving the old builds were in sync);
  OCR visual review clean for case1/case3, case2 source pie clean.
- **Real evidence not yet in the text**: f67-site-window-sweep.json
  records the Y88 cross-position-window halogen isotope doublet (median
  0.99 vs control 0.22; no signal in the Y60 control window) —
  elemental-level Br evidence independent of the mass-hypothesis
  comparison, currently unmentioned in the body. **Suggestion**: add one
  sentence in the case1 paragraph citing this record, putting "we really
  saw the Br isotope peaks" into the text.

## E10 · Closed-combination scoring + combination dedup landed (2026-08-20) — `confirmed`

**Hypothesis**: the other half of E7's gap — closed combinations with
`|unexplained| < 0.01` in `prsm.rs` were silently dropped — can be fixed
by "a closed combination treats its last component as the free
localization target, the rest pinned", reusing the existing kernel
(`delta=0` degenerates localize's plain/shifted matching, so the
kernel's non-zero restriction is not relaxed).

**Changes** (`prsm.rs`, one file):
1. Closed combinations are no longer dropped: pin-k-1/localize-1
   semantics, the last component goes through the localize profile;
2. Combinations dedup by multiset signature of component masses (4
   decimals); UniMod same-mass synonyms no longer repeat on the board;
3. Site permutations of identical components get a non-decreasing prune
   (symmetric labelings enumerated once);
4. Mass closure never short-circuits MS2 scoring (stated explicitly in
   notes).

**E2E acceptance (F67 scan 1164, +121.9569, Dimethyl/MetOx/Bromo
library)**: the 3-component closed combination (residual 3.8 mDa)
**competed and lost** — Br's profile is flat across Y51/72/88, evidence
below the 2-component + residual hypothesis (37.6). Exactly the intended
semantics: closure does not win automatically. The single-component
closure (Bromo exact closure) previously always reported "no composition
improved"; it now scores normally (evidence 3.0, interval 52-91, verdict
ambiguous).

**Regression (soybean 7-record batch)**: all 7 records show zero drift
in score multisets; only two tied (gap=0) pairs swapped combination
order, verdict unchanged; #5 `compositionAmbiguous` True→False is the E2
rule correction first reaching soybean output (baseline generated before
the rule fix), not a regression.

**Incidental finding**: the submodule carries many uncommitted changes
predating this change (args/commands/fragment etc.); the 5
`cli_contract` failures (parse-proforma/schema key-count comparisons)
are pre-existing drift unrelated to refine — booked as debt.

## E11 · Nature of the 6 calibration-leftover hard-unexpecteds (2026-08-20) — `confirmed`

**Question**: are the 6 hard residuals left after batch calibration
(24.10/40.94/52.10/54.87/70.93/143.81) "fragments" of ordinary
modifications, or independent signals?

**Triple test**:
1. residual − strong cluster ≈ ordinary PTM? None match (nearest 0.07
   Da).
2. UniMod wide-tolerance (0.5 Da) nearest neighbor? All ≥0.06 Da, 52.10
   has none; all exceed the ±0.05 naming window.
3. residual = difference of strong clusters? 4/6 coincide, but the null
   (random masses in 20–150 Da) gives a 25% coincidence rate,
   P(≥4/6)≈0.04 — weakly significant, only hinting that "different
   ordinary-decomposition views of the same unknown event" can share
   evidence; it does not establish fragmenthood.

**Verdict**: not fragments. Each has 5–14 supporting PrSMs, site already
narrowed to an interval (143.81 narrowed to single point 33), and is far
from every known modification — genuine independent unknown signals; the
deep queue classification is correct. During deep dives note that the 4
with coinciding differences may share one unknown event.

**Incidental**: the +122 case examples in SKILL.md and
event-validation.md were anonymized (+103/~47 and 40/120); prompts no
longer carry the shape of case answers (user iron rule).

## E12 · Full ledger rebuild (dryrun-iter-6, 2026-08-20) — `confirmed`

**Action**: delete-and-rebuild the mouse ledger —
`proteoform_pipeline.py` fully re-ran batch calibration + merging from
the raw tables, output to `data/backend/runs/dryrun-iter-6/mouse/`
(iter-5 kept as the pre-change baseline).

**Result**: 978 features → 819 merged features → 293 clusters → **755
ledger rows / 717 with PrSM support** — exactly matching the paper
truth-manifest's 755/717 (iter-5's 712 was the row count after the
residual-queue fan-out fix, not the ledger row count; the paper's
convention is thereby cleared).

**755-row distribution**: routing = composition 362 / prsm_refine 242 /
sequence_event_review 92 / archive 45 / **mass_difference_review 14**
(new channel: MS1-only family ladder shifts
+84.04/+125.03/+168.12/+209.05, tier 1, no PrSM — precisely the
"family destination" landing point in the LOOP design); calibration =
calibrated 249 / weak 434 / failed 34 / unavailable 38; verdict =
ambiguous 495 / unexplained 181 / prior 73 / auto 6.

**Drift to investigate** (non-blocking): clusters 293 vs iter-5's 375
(clustering/calibration code evolved between the two runs); auto naming
6 vs iter-5 8 vs manifest round 8 (the auto gate for marginal clusters
decides differently across code versions — 202.095/HexNAc and
99.944/Succinyl dropped out this round; the manifest round's
42.104/Trimethyl and 68.165/Crotonyl have no corresponding cluster this
round). Classified as a concrete instance of the skill-side
"three-generation schema ledger convergence" debt.

## E12b · Insufficient-merge check on the 755 rows (2026-08-20) — `confirmed` (main layer clean) + 1 item pending

**Three questions**: same-mass multiple ids? 0. Adjacent clusters
<0.05 Da? 0 (minimum spacing >0.05, exceeding the 0.02 clustering
tolerance; no fragment clusters). 1-neutron isotope splits? 0. The
25/730 same-feature-multi-cluster cases are all legitimate multiple
proteoform interpretations.

**The only too-coincidental signal**: a 2.007 Da period between clusters
— 12 pairs fall in the 1.99–2.013 band (permutation test p=0.015,
expected ~5), of which **7 pairs share a protein** (56.06/58.06 with 12
PrSMs each, 77.97/79.97 with 24+ PrSMs each, etc.). Mechanism candidate
= TopFD/TopPIC 2-neutron monoisotopic misassignment: the feature merge
gate admits only ±1 C13 (`--n-max-c13 1`); a 2-neutron misassignment
splits the same chemistry into two clusters 2.0067 apart.

**Verdict**: the main-layer merge has no "many fragments"; there exist
on the order of 7 pairs / 293 clusters (~2%) of 2-neutron split
candidates. The fix (relaxing the C13 gate to 2, or a shift-layer
2.0067 audit) touches merge semantics and waits for the next LOOP
round: change code → dryrun-iter-7 → three-question comparison (755 row
count, routing distribution, whether the +122 family is disturbed).

## E12c · n-max-c13=2 experimental round (dryrun-iter-7, 2026-08-20) — `refuted` (the parameter is not a lever)

**Action**: per the user's preset "try but don't adopt", rebuilt with
`--n-max-c13 2`.

**Result**: cluster masses **identical** to iter-6 (293 clusters match
mass by mass); all 12 pairs of 2.007-band splits unchanged; 755 rows,
19 ladders, 38 MS1-only rungs all unchanged. Only 7 rows micro-shifted
in routing (local union changes from the relaxed feature merge window).

**Verdict**: `n-max-c13` acts only on the **feature merge layer**, while
the 2-neutron splits occur in the **shift cluster layer** (TopPIC
precursor monoisotopic misassignment goes straight into the shift value)
— the parameter has no effect here. To handle 2-neutron splits the lever
is the shift layer (audit 2.0067 offsets before clustering), and the
user has already ruled against relaxing (iter-7 is an experimental
round; the authoritative ledger remains iter-6). The experiment
directory is kept as evidence.

## E13 · Refine performance diagnosis and Informed-Proteomics comparison (2026-08-20) — `confirmed`

**Measured** (representative record totalShift 169.98, 7-modification
library, max_components 3): 85 combinations pass the mass gate → total
site-permutation leaves **297,373**, each leaf one full localize (full
fragment-ladder reconstruction + binary peak matching over all peaks × 3
scans). ~3.3 s/record × 287 representatives ≈ 16 min. CPU saturation =
combinatorial enumeration complexity, not an implementation constant.

**Informed-Proteomics (MSPathFinderT) comparison**: the core is
`SequenceGraph` — nodes = (sequence position × modification state/mass
bin); `GetFragmentScore` does **one dynamic-programming pass** on the
DAG for the optimal score over all modification placements (maxScore
table, Sequence Graph.cs:340-353); peak lookup uses
`FilteredProteinMassBinning` (27-bit bin comparator, O(1) positioning).
There is no "combination × site permutation" enumeration layer.

**Conclusion**: we are not "considering too much" — the **search
structure is wrong**: the full spectrum is re-scored per site
permutation. MSPathFinder is fast because DP yields the optimal
placement in one pass, with fragment matching shared per combination.

**Fix directions** (keep atomic semantics, implement next round):
1. Structural fix (~50× expected): one DP joint placement per
   combination — fragment matching arrays cached and shared by (scan,
   combination), position advance O(n×k); equivalent to replacing
   refine's outer `search` enumeration with a SequenceGraph-style DAG
   DP.
2. Branch-and-bound as a short-term stopgap: prune when a partial
   placement's score upper bound < the current best.
3. Combination-layer mass gate: combinations with a free residual but a
   too-small known share (e.g. 28 vs 170) can be deferred until the
   representative combinations fail.

## E14 · TopPIC prior wiring + three questions on full representative refine (2026-08-20) — `confirmed`

**Changes** (consume existing TopPIC capabilities, no library search):
1. Sole sequence source = the TopPIC proteoform table
   (`FeatureID|ProteoformID|accession` triple match, falling back to
   ProteoformID+accession when Feature ID spaces disagree); the FASTA
   path fully removed — the earlier reading of FeatureID as sequence
   coordinates was a wrong implementation.
2. `topPicIntervals` (protein coordinates, including truncated-window
   offset conversion) serve as refine's component search intervals: a
   shift's components may only fall inside TopPIC-localized intervals.
   Sibling intervals intersect; when disjoint, the union is taken.
3. proforma terminal fixed modifications (`[Acetyl]-` etc., mapped by
   library name) are pinned into the fragment ladder; mid-sequence
   numeric intervals are the unknown shift itself and are never pinned.
4. Rust batch requests accept optional `range`/`modifications`;
   out-of-range intervals raise a clear error (previously a panic).

**Performance**: 280 representatives in 52 s (0.19 s/record) vs 3.3
s/record without priors (**18×**); 40× smaller than the original
full-enumeration plan over 709 rows (~40 min). The DP replica
(SequenceGraph-style joint placement) remains the structural fix; its
priority dropped after the prior wiring.

**Three-question results** (280 representatives = 287 classes - 7
unparseable sequences):
1. **Coverage**: 195 with verdicts + 85 honestly excluded (61
   no-closable library combination + 24 no library-compatible residue
   inside the interval). Nothing silently disappeared.
2. **Verdict distribution**: localized 8 / ambiguous 187. Ambiguous
   breakdown: multiple possibilities (composition gap <2) 149,
   composition settled but site unsettled 38.
3. **Common unexpecteds**: weak residual recurrence (+35.9/+30.0/+2.0/
   +75.9/+62.9 with 2 records each, no too-coincidental clusters); the
   61 "no-closable library combination" records carry the main unknown
   masses, including E11's 6 hard patterns (no library explanation left
   inside their intervals — more honest than the old full-sequence
   scattering; all should go to the deep-dive queue).

**Semantic changes** (12-record sample comparison): verdicts mostly
stable; 1 upgraded to localized (gap 0.1→8.2, real evidence separation);
3 went from "scoring points by scattering far away" to honest exclusion.
With N-terminal Acetyl pinned into the ladder, N-side fragment matching
is correct again.

## E15 · Multi-proforma cross-consideration + unknown-mass merge test (2026-08-20) — `confirmed`

**A. Cross-voting among same-cluster members** (full refine of 672
member rows, 126 s): 203 clusters have assessable members. Aggregated by
"majority of members share the top-1 composition and lead the
runner-up":
- **35 clusters with majority agreement** (31 of them representative-
  level ambiguous → resolved by cross evidence, 17% of the original 187
  ambiguous clusters; e.g. Methyl wins all 5/5 members, 9/16, 6/12);
- **87 clusters with split member opinions** — confirming "mass
  coincidence is not shared chemistry" (the correctness of partitioning
  the ledger by cluster × protein); these should stay split, not be
  force-merged;
- 81 clusters single-member or unanimous.

The current vote is count-level; the correct merge is **summing log10
evidence by composition signature across same-cluster members**
(sibling spectra jointly localized), which should be the kernel's next
atomic feature (joint-refine).

**B. Merge test of 85 non-adjudicable unknown masses**: at 0.05 Da
tolerance **85 records = 85 independent masses, zero recurrence** — no
systematic artifact class exists; each needs individual deep-dive
evidence. High-support unique unknowns worth priority attention: -44.990
(40 PrSMs, H2B3B; ≈CO2 loss -43.9898, artifact-class suspect), +36.124
(19 PrSMs, H31; member of E12b's 2-neutron pair), -18.003 (≈H2O loss),
-2.989, -73.122. E11's 6 hard patterns are not among these (their reps
are ok-ambiguous, unknown residual band rather than whole-shift
unknown).

## E16 · Automated ladder L3/L4 landed (2026-08-20) — `confirmed`

**New batch tools** (in-skill, atomic; dispatch but do not execute):
1. `joint_refine.py` (L3): sums log10 evidence by composition signature
   across same-cluster members; only candidates appearing in ≥2 members
   are eligible, and resolution requires a joint gap ≥2 log10.
   Measured: **62/198 clusters jointly resolved** (double the crude
   vote's 31), 136 clusters still ambiguous.
2. `dispatch_discriminators.py` (L4): multiset difference identifies
   degenerate pairs (Acetyl↔Dimethyl+Methyl 36 mDa etc.), dispatches
   fragment-ppm / neutral loss / envelope. Measured at member level:
   **88 dispatches** (fragment-ppm 80 + envelope 8).

**Key calibration**: the top-2 difference distribution shows most
competition is ordinary decomposition competition (Acetyl↔Phospho swaps
41 times, 42 vs 80 Da non-degenerate, belongs to L3/L5); the only true
degeneracy is the Acetyl↔Dimethyl+Methyl class — the dispatcher takes
only the degenerate minority, no overreach.

**Current totals** (280-representative granularity): 8 clusters cleanly
localized → +62 clusters jointly resolved → +88 records with dispatched
discriminating measurements → 136 clusters awaiting L5 full scan/L7 →
85 unique unknowns entering L7 after the L6 artifact audit. Every layer
is machine-readable, ledger states can flow.

## E17 · Two-question census (2026-08-20) — `confirmed`

**Q1 clusters with qualifying PrSMs still needing deep dives**: all 293
clusters have qualifying PrSMs; L2+L3 auto-resolved 65 (8 localized + 62
joint, overlap 5). **228 clusters remain**: 28 clusters have L4
dispatches pending execution (fast path), **200 clusters true deep
dives** — of which ~85 clusters are unique unknowns the library cannot
explain (L6 artifact audit → L7) and ~115 clusters evidence-ambiguous
(L5 full-scan extension → L7).

**Q2 shifts with no qualifying MS2 and not covered by a family**:
**0**. By construction the ledger is anchored on PrSM clusters; all 38
MS1-only rows have exact (d=0.000) PrSM twin clusters (+41.009×13,
+125.031×6, +84.042×3, etc. — extra features/ladder rungs of existing
clusters, quantitative and family evidence, not orphans). 15 rows
explicitly attach to a family ladder. The pure-MS1 family spacings
(ms1-families, 24 families) all anchor on identified carriers, 9 of them
in the 77.7-79.0 band (the phosphate/bromine degeneracy band) — exactly
the target class for batch envelope comparison.

**Conclusion**: triage is closed — no orphan masses; the deep-dive queue
= 200 clusters, of which batch processing can first consume the +79 band
(envelope class) and the 28 dispatched clusters; what is finally left
for AI peak-existence checks is a small number of high-support unique
unknowns (−44.99 etc.).

## E18 · Wide-library standalone run for the unassigned + final census (2026-08-20) — `confirmed`

**Action**: AI decision layer — assigned records go through the normal
gate; for the 82 unassigned clusters the AI decided to relax the
hypothesis space in a standalone run: rebuilt library from all approved
single-residue PTMs in unimod.sqlite (218 entries, Label class removed),
TopPIC intervals + 3 scans, 105 s.

**Result**: 80/85 have verdicts (0 with the original library). Verdicts:
only 2 localized, 78 ambiguous (67 compositionAmbiguous — the
combination space of 218 modifications is naturally fiercely
competitive; the 2-log10 gate rightly refuses coronation). **The key
change is structure, not verdicts**:
- "completely unexplained" went from 82 → **5** (true hard core:
  F63074/F927/F3003/F407/F8636);
- 78 records went from "nameless" to "with a ranked candidate list" —
  each record's top candidate is the input for a discriminating
  measurement/subagent; the AI no longer has to invent hypotheses from
  zero.

**Final census** (293 clusters):
- verdicts resolved: 65 (L2 8 + L5 5 + L3 61, overlap 5);
- fast lane pending execution: 28 clusters (dispatched) + 3 clusters
  with artifact flags pending review;
- **true-deep: 198 clusters** — of which 5 hard-core with no candidates,
  78 wide-library ambiguous (with candidates), ~115 narrow-library
  ambiguous. Marginal returns at the batch layer are exhausted: the
  remaining bottleneck is discriminating evidence (L4 execution,
  envelope families, AI peak checks), not throughput or hypothesis
  coverage.

**Methodological confirmation**: the wide library is a live demo of the
coverage-precision tradeoff — narrow library means no explanation, wide
library means composition ambiguity; the right posture is layering
(narrow library through the normal gate → wide library for hypothesis
generation → discriminating measurements decide), not one wide library
run to the end.

## E19 · Batch execution of fragment-ppm discriminators (2026-08-20) — `confirmed`

**Executor** `execute_discriminators.py`: each dispatch takes the best
site placement of the top/runner combinations, double-runs `fragment
--mode match` on the same spectrum (z≤8, 5 ppm), aggregating all sibling
scans of the member (a single scan has too few discriminating ions). 80
tasks in 16 min.

**Result**: 70/80 adjudicated (top-wins 36 / runner-wins 34 / ambiguous
10), of which **45 tasks with |Δmatches|≥3 are decisive, covering 28
clusters**. Total matches rose to 250-350 per hypothesis; both groups'
median |ppm| ~2.1-2.7 — the win rests on the count difference of the
discriminating-ion subset (the two hypotheses share all
non-discriminating ions), not on overall goodness of fit.

**Updated totals**: verdicts resolved 65 + 28 = **93/293 clusters**;
true-deep ~170. Note: for runner-wins records the ledger "top" should be
flipped to the runner combination — discrimination results await ledger
writeback (next step). Remaining batch actions: the envelope family
batch (+79 band, 9 families), discrimination-result writeback.

## E20 · Ledger writeback + envelope batch (2026-08-20) — `confirmed`

**Writeback**: `ledger_writeback.py` wrote the 28 decisive fragment-ppm
clusters into the ledger (180 rows: assignment=winning composition,
basis=`fragment_ppm_discriminated`, evidence_refs with the execution
files; site verdicts untouched — composition and site remain separate
claims).

**Envelope batch** (`envelope_batch.py`, all 8 tasks executed, a
Se-element candidate crash fixed mid-way): 6× Phospho~Sulfo =
POSITION-DEGENERATE (the whole envelope is genuinely inseparable,
physically correct, routed to fragment-level neutral loss); 2×
INTEGER-REGISTRATION DIVERGES (neither candidate of the pair closes
under integer registration — the hypothesis pair itself is wrong,
candidates need regeneration). **0 directly assigned, 8 honestly
routed** — the envelope rules only when it can.

## E22 · Wipe and re-walk (2026-08-20) — `confirmed`

**Cleanup**: the wrong-semantics artifacts of E15-E20 (joint
coronations, parallel UniMod matching, the writeback-contaminated
ledger/queue/dispatch/execution files, 30 in total) were quarantined to
`data/backend/runs/quarantine-20260820/`; iter-6/iter-7 kept as history.

**Clean baseline** (dryrun-iter-8, straight from the raw tables): 755
rows / 79 named / routing composition 362 + prsm_refine 242 +
sequence_event 92 + archive 45 + mass_difference_review 14. Semantics
obey the natural flow (the 2026-08-20 correction section of
`design/MASS-SHIFT-LOOP.md`): mass closure is the only entrance, residual
recursion never crowns, state vocabulary named/decomposed/
residual_recurring/unknown. The performance and tooling conclusions of
E15-E21 are retained (prior wiring, closure scoring, speedups); **all
adjudication numbers are voided**, superseded by the new conventions
after re-walking the natural flow.

## E23 · +122 envelope arbitration + default-library lesson (2026-08-20) — `confirmed`

**+122 closed-loop multi-candidate arbitration (envelope, zero-offset
rule, no 2-neutron/doublet)**: comparison of two closed-loop hypotheses
on F67 (scan 1157, z14) — acetyl+phospho (r=0.911, apex off +1.00 bin,
needs a +1-neutron registration excuse) vs dimethyl+metox+br (r=0.981,
apex +0.00 bin, intact −2.2 ppm, no offset) → **verdict:
POSITION-DECIDED: dimethyl+metox+br**. Consistent with the E8 refine
(dimethyl@K16+ox@M84+residual 77.9) and the paper's Y88Br chain.

**Default-library lesson**: a common-sense wide site library (Methyl on
all sites etc.) dropped closed loops from 208→12 (combinatorial
explosion drowns the top-5) — library feedback must be surgical
(specific modification + specific sites), never a global relaxation.

**The H4-tail unexpecteds take no common-sense anchors** (0/12): the
K19-22 window series +12.98/+12.06/+38.04/+47.91 are true unknowns; the
first regional deep-dive case file.

## E24 · Consuming the remainder: region collapse + residual recursion + core verification (2026-08-20) — `confirmed`

**Correction to the previous account**: E-clean-walk's "208 closed
loops" was a one-off script counting bug; the narrow library truly
closes ~25 clusters. The unknown path has 547 records (~245 clusters).

**Three-layer consumption**:
1. **Region collapse** (48 hot regions, connected components of anchor
   differences Me/DiMe/Ac/P/Ox/But/Suc): 111 records entered series, 40
   cores. H3.1 16-30 produced the full methylation ladder
   [14.015…84.072]=1-6×Me — a pure ladder `max_components=3` cannot
   hold.
2. **Residual recursion** (integer-coefficient re-decomposition):
   another 84 records consumed (Me-ladder class).
3. **Recurring-core verification**: 17 cores with ≥3 occurrences;
   wide-library nearest neighbors are all substitution-class
   (T→N/K→F/E→M…, 3-21 mDa); +12.98's T→N hypothesis was excluded at the
   localized point by a fragment pre-check (no T inside the interval) —
   **substitution-class fails for the main cores**.

**End state** (natural-flow vocabulary): named 23 + closed loops ~25 +
recursively decomposed 84 records; **unknown 463 records / 375 cores**:
322 singletons (one-off phenomena) + 17 recurring cores (+12.98×12,
+26.99×9=12.98+Me same series — true new-phenomenon candidates that
library/substitution/ladder all fail to explain). The unknowns hold
1,952 PrSMs in total.

**Verdict**: what batch algorithms can consume has been consumed. The
remaining unknowns are an honest end state: 322 singletons await more
data; the 17 recurring cores are the first-priority case files for
subagent/AI peak checks (the +12.98 series = highest priority, 12
records, including a 70-PrSM record, localized to an R region).

## E25 · Recurring-core final review: peak existence + variants + family registration + UniProt (2026-08-20) — `confirmed`

**Peak-existence verification batch** (`core_verify.py`, fragment
compare, all 17 recurring cores):
- **real-localized 3 cores**: +15.02×5 (all localized, up to 13
  discriminating ions), +43.99×3, +51.10×3;
- **mass-present-unlocalized 10 cores** (incl. +12.98×12: only 1
  localized, the mass is present but most records lack discriminating
  ions; +26.99×9: 3 localized to H2B K15/K22);
- **fragment-absent 4 cores** (+1.99/+37.95/+230.91/+65.95): no peaks
  at the fragment layer — upstream (precursor-level) artifact suspicion,
  moved out of deep dives.

**H2B variant-mismatch class confirmed**: +15.02/+26.99/+43.99 all fall
in H2B-family variant residue regions; variant reorder matching won 2
records decisively (margin 15/28, winners H2B3B/H2B1K).

**UniProt region-prior hit**: H2B1F (P10853) is officially annotated
K58 N6,N6-dimethyl (the +15.02 core localizes to 60-64 = K58±flank);
the region also carries hydroxyisobutyryl/glutaryl annotations — the
region prior aligns with the recurring core's position.

**Family envelope registration batch**: 12 Br-band families, 2 anchored
by arithmetic back-inference (bromo+1n hypothesis), **both registration
tests rejected** (bin offsets +17/+10/−9 and −6/−1/+18, no constant
registration) — they are not bromine ladders; the other 10 have no
identified-carrier anchor. Conclusion: MS1-only family adjudication
needs a PrSM carrier of the correct composition; arithmetic anchors are
insufficient.

**Artifacts**: `core-verified.json`, `core-classification.csv`,
`core1298-variant-test.json`, `brband-carriers.json`,
`brband-registration.json` (all under dryrun-iter-8/mouse/).

## E26 · Core final-review closeout: ledger writeback + targeted identification + full scan (2026-08-20) — `confirmed`

1. **Ledger writeback**: the core final-review classification
   (core_mass/core_classification columns) written into
   `assignment-checklist.csv`; 69 rows carry core status.
2. **Targeted identification** (real-localized 3 cores, fragment compare
   per hypothesis): +43.99's Ala→Asp candidate excluded as **residue-
   incompatible** (no Ala at the localized G/K/Q); +15.02's
   Amino(15.0109)/Ile→Lys(15.0106) is mass-degenerate with the observed
   core within fragment precision (disc both 11/8/6), only H2B1C-I60 is
   residue-compatible with I→K — identity stays "candidate",
   localization confirmed.
3. **Full-scan re-verification** (--max-scans 0; fixed the scans[:0]
   slicing bug): +15.02's F234 disc 7→13, +25.02's F668 8→11
   (discriminating ions did get supplemented); **the +12.98 core's
   highest-support record (70 scans) has zero fragment-layer matches** —
   this core exists only at the precursor layer, contradicting its
   mass-present classification; flagged for review (suspected
   record-level sequence mismatch, while same-cluster 1-scan records
   F412/F837 have 91/97 matches).
4. Final classification: real_localized 3 / mass_present_unlocalized 11
   / fragment_absent 3.

**Honest boundary**: +15.02 localized + region prior (UniProt K58me2
neighborhood) but identity-degenerate; +43.99 localized but with no
compatible chemistry; +12.98 suspected precursor-layer artifact. These
three classes have reached the physical boundary of the current data —
going further needs new measurements (targeted MS2 re-runs / higher
mass accuracy), not more batch runs.

## E27 · The F0 zero-match mystery + core_verify window bug fix + final classification (2026-08-20) — `confirmed`

**F0 investigation (directive item)**: tried every proteoformRefs
sequence one by one — the sequences all match (65 ions); the root cause
of zero matches was **core_verify's own bug**: windowed sequence (101aa
starting from G, losing the N-terminus) + the fixed Acetyl landing on
window position 1 (wrong residue) → the ladder shifts systematically →
candidates wiped. Re-tested with the complete mature sequence: F0's
+12.98 on 5 scans matched 67-117, disc 2-6, localized 19-22 (K region) —
**neither a precursor artifact nor a sequence mismatch, but a window bug
in our verification tool**.

**Fix**: core_verify switched to the full chain + window-offset
back-mapping of sites. Full re-verification (all scans): records of
+18.97/+121.17/+38.09/+133.08 upgraded to localized; **the +12.98 core
finally = fragment-visible but weakly discriminating** (localized to the
K region, most records disc<2).

**Final core classification** (17 cores, ledger 69 rows updated):
- real_localized **7** (+15.02, +43.99, +51.10, +38.09, +18.97,
  +121.17, +133.08 — 24 localized records in total);
- mass_present_unlocalized **7** (+12.98×12, +26.99×9, +200.19×4, etc.);
- fragment_absent **3** (+1.99, +230.91, +65.95 — precursor-layer
  artifact suspicion).

**Lesson** (merged into methodology): the verification tool's sequence
coordinate space must match hypothesis generation; any mixing of windowed
sequences with absolute positions silently produces all-zero results.

## E28 · Targeted hypothesis sweep + singleton end state + one core consumed (2026-08-20) — `confirmed`

**Targeted hypothesis sweep** (7 mass-present cores × fine mass grid
±0.04 + chemical series, fixed full-chain/offset machinery,
`hypo-sweep.json`):
- **+26.99 consumed**: winning delta = **28.0313 (Dimethyl)**; the
  observed core is 1.04 Da low = 1-neutron calibration class. 9 records
  assigned `identified_dimethyl_neutron1_offset`.
- +12.98: true event mass **12.99** (disc 12, sharp) but sites diffuse
  (I26/S1/Q6, none consistently T) — Thr→Asn localization fails,
  remains unnamed.
- +36.20 → 36.16 (disc 15 sharp event, unnamed); +25.02→24.98,
  +121.17→121.14 (refined masses, unnamed); +200.19/+98.93 all delta
  disc=0 (no discriminating evidence).

**Singleton end state** (322 records, new ledger columns singleton_*):
approved candidates ≤20 mDa → **22 records**
`named_candidate_provisional`; 42 records `unknown_nearest_XmDa` with
nearest-neighbor distance; 258 records
`unknown_no_candidate_in_0.02Da`. **Every singleton record has a named
destination or an explicit unknown criterion**.

**Ledger end state**: 37 rows of hypothesis-sweep rulings + 322 rows of
singleton end states + 69 rows of core classification all entered
`assignment-checklist.csv`.

## E29 · Skill restructure: capability catalog + evidence constitution (2026-08-20) — `confirmed`

**Restructure** (user's framing: provide capabilities and principles, do
not prescribe process; one skill suffices):
1. `mass-shift-analysis/SKILL.md` rewritten in four sections:
   **evidence constitution** (8 unbendable criteria, all from E1-E28
   hands-on lessons) + **capability catalog** (36 scripts organized as
   "problem → tool → adjudication rule": ledger/closed-loop
   decomposition/peak existence/degeneracy discrimination/regional
   series/ledger landing/library strategy) + **AI decision boundary** +
   §6 contracts.
2. deep-dive is no longer a "mode" but a group of tools in the catalog;
   explicitly stated "order not prescribed — routing is a cost decision
   made from ledger state".
3. `subagents/massshift-deepresearch/SKILL.md` slimmed to **pure role
   wiring**: all methodology delegated to the parent skill
   (system_prompt points to the constitution and catalog), retaining
   only a restatement of the doublet ban. One methodology, no longer
   two copies.
4. Consistency check: the 7 references cited by SKILL and all scripts in
   place; no stale cross-references from old sections.

**Constitution clause provenance** (each clause experiment-backed): #1
closed loop as sole entrance / residual recursion (E22/E24 +122
false-coronation reversal); #2 four-word vocabulary (E22); #3
composition/site separation (E2/E19); #4 coordinate-space consistency
(E27 windowed sequences silently all-zero); #5 doublet ban (user's
physical ruling + deepresearch measured ΔPearson +0.013); #6
same-model competition (E23); #7 reference libraries are priors (E25);
#8 reconcile from artifacts (E24's 208 counting bug).

## E30 · Full LOOP blind walk on histone48 + tooling gap-fill (2026-08-20) — `confirmed`

**Hypothesis**: the restructured capability catalog (E29) suffices for
the whole journey "TopPIC tables in, massshift annotations out"; the
friction points exposed along the way are the tooling list.

**Experiment**: walk the LOOP only (no infrastructure changes): iter-8
queue of 558 records → `batch_prsm_refine` (reused) → **new**
`residual_recursion.py` (5-scan screening) → **new**
`series_collapse.py` → `core_verify` (all scans) →
`dispatch/execute_discriminators` → `envelope_batch` → **new**
`singleton_stamp.py`.

**Results** (replay-e30-histone/coverage-summary.json, 558 records,
zero gaps zero overlaps):
- closures 19 (depth1 11 + recursion 8);
- core line: 64 recurring masses / 175 records → 49 masses truly
  localized, 11 mass-present unlocalized, 4 fragment-absent (15.02 all
  localized, 43.99 all localized, 121.17/133.08/38.09 localized —
  iter-8's core conclusions independently reproduced);
- degeneracy line: fragment-ppm 85 (top 40 / runner 33 / ambiguous 12),
  writeback 176 rows; envelope 8 (6 Sulfo↔Phospho position-degenerate,
  2 integer-registration divergence = carrier composition wrong);
- singleton line: 364 (90 provisional ≤20 mDa / 59 nearest / 215 no
  candidate).

**New tools (generalized, zero case content)**:
`residual_recursion.py` (mechanizes constitution #1),
`series_collapse.py` (anchors = library single components + pairwise
sums ±0.03; noise floor 1 Da; records without intervals joined only by
same mass), `singleton_stamp.py` (three unimod-proximity end states).
Fixes: `envelope_batch.py` feature-parsing fallback (merged space →
TopFD space, first field of proteoformRefs) + the feature table must be
TopFD ms1.feature.

**Lessons**:
1. iter-8's recursion/series/singleton were all run-directory ad-hoc
   scripts (`run_identify.py` even hard-coded a mouse answer dict) —
   precisely the form the anti-cheating rule forbids; this time all were
   generalized into the skill; "capabilities, not process" landed.
2. Full-scan residual recursion is waste: 5-scan screening decides
   closure, depth is left to core_verify (division of labor written into
   SKILL).
3. Remaining friction: checklist writeback covers only the degeneracy
   line (176 rows); the end states of the closure/core/singleton lines
   live only in JSON artifacts with no CSV writeback channel — add
   terminal writeback next round.
4. chlamy fraction 1 lacks ms2.msalign (20 topfd minutes to fill); the
   kernel's prsm-refine-batch eats only msalign while fragment eats
   mzML — inconsistent input surface, recorded as a kernel unification
   item.

**E30 extension (chlamy + soybean, same-day blind walk, upstream not
re-run)**:
- chlamy fraction 1: 112 records zero gaps (6 closures + 2 core records
  + 61 singletons + 43 library-no-improvement); fragment-ppm 11
  (4/4/3); envelope 2 (1 measurable).
- soybean 10 fractions: 1901 records zero gaps (closures 116 = depth1 69
  + recursion 47; core 342 records/116 masses, 109 truly localized;
  fragment-ppm 66 (29/21/16); singletons 611 (227 provisional/86
  nearest/298 no candidate); 832 library-no-improvement). Per-fraction
  coverage-summary.json, grand total coverage-total.json.
- Additional fixes: `ledger_writeback.py` safely skips ambiguous tasks
  (no matches count), no longer crashes and breaks the whole chain;
  run-dir runner scripts (run_loop.sh/resume_loop.sh) live only in the
  run directory, not in the skill.

## E31 · Terminal-state ledger writeback (2026-08-20) — `confirmed`

**Hypothesis**: E30 left the three lines' end states in JSON artifacts
with only a degeneracy-line writeback channel in the checklist (E30
lesson #3) — the ledger was not yet the "sole authority". Add the four
writeback paths closure/core/singletons/library-no-improvement so every
checklist row has an end state.

**Experiment**: new `terminal_writeback.py` (idempotent): closed
composition → assignment/basis=composition_closed (overwrites only
placeholder bases: candidate_screened/unknown, never touches judged
bases); core verification → core_mass/core_classification columns;
singletons → singleton_candidate/err/terminal columns; clusters where
refine all failed → basis=library_no_improvement. Executed in full on
all three samples.

**Result**: histone 755 / chlamy 127 / soybean 2448 (10 fractions) —
**3330 ledger rows, zero unmarked rows** (every row has basis or core or
singleton columns non-empty). During the fix we found the core line
writes only the core columns without touching basis (placeholder-basis
rows still carry core/singleton marks; coverage complete).
`ledger_writeback.py` also hardened: ambiguous tasks (no matches count)
safely skipped, no longer breaking the whole chain.

**Lessons**:
1. The last link of "record, don't recall" (constitution #8) is the
   writeback channel itself — without writeback tools the end states
   scatter across JSON and the ledger is not authoritative.
2. Idempotent design (never overwriting existing strong evidence) lets
   all three samples be safely re-executed.
3. Ledger rows are cluster-level (mass_shift_id), records are
   record-level (assignmentId): aggregated writeback must merge by
   cluster prefix, not fill row by row.

## E32 · Full review of skill structure and vocabulary (2026-08-21) — `confirmed`

**Background** (user review + framing):
1. "Stop being deceived" — old reports wrote classification-complete as
   assignment-complete, candidate names as real names, fragment absence
   as artifact; the final states must converge to explained / candidate
   / unexplained, with everything else as evidence fields.
2. skill = principle guidance + script placement unit; whether the
   sample-level main skill and the single-event deep-research skill
   should stay separate needed full consideration.

**Verification (already landed)**: the main skill is already three-state
+ observation-chain data model + capability catalog; deep-research is an
independent skill (input = routed records, output = evidence envelope,
three states + insufficient_data data threshold); subagent is pure role
wiring; old vocabulary in the doc layer (residual_recurring /
evidence_assigned / named_candidate_provisional / real_localized etc.)
cleared — machine labels of script artifacts remain as evidence fields,
and the docs state explicitly "nearest UniMod hit is a prior, not an
assignment"; E-value>1e-3 is reference only; cluster/family/series all
demoted to derived views.

**Corrections this round**: the deep-research skill's measurement section
gained concrete tool references (each question → minimal sufficient
script set, scripts invoked by path from the main skill's catalog); the
main skill's capability map gained an "Event-adjudication tools" group
(owned by deep-research); legacy annotations (fragment_doublet old
doublet tool; smith_levels/confidence_level/closure_audit only grade,
never adjudicate; census_panel/fragment_spectrum/_paper render only).

**Conclusion** (on the split's validity): main + deep-research as two
skills stands, because input scope (whole sample vs single event), cost
model (batch vs one-by-one), and output contract (ledger row vs evidence
envelope) all differ; spectral-evidence stays a low-level general tool
and is not merged.

**Remaining deviations (honestly listed, not pretending done)**:
1. The checklist is still cluster rows aggregated by mass_shift_id — the
   observation chain itself already exists in evidence-ledger.jsonl /
   queue (record level), but the user-mandated "one row per observation
   in the main ledger" has not yet reached checklist semantics; cluster
   rows are currently a summary view. Next round: change checklist
   semantics to observation rows (or explicitly mark them derived
   views).
2. residual terminology lingers in script/artifact filenames
   (residual_recursion.py, residual-recursion.json) — the doc layer
   already uses unexplained_mass_difference; filenames keep the
   historical artifact naming, not renamed.
3. The "zero gaps / all stamped" wording recorded in E30/E31 is the
   **classification coverage** convention, not chemical assignment; from
   this review on, report wording is "classified / evidence state", and
   we do not write "assigned / explained" unless closure + evidence
   support it.

## E33 · Main ledger converted to observation rows (2026-08-21) — `confirmed`

**Hypothesis** (E32 leftover #1 + user framing): the checklist's
(mass_shift_id × feature) carrier rows still merge the multiple
proteoform interpretations within a feature; identity must be Feature ID
+ Proteoform ID + Protein accession, with mass_shift_id demoted to a
derived index.

**Experiment**: `proteoform_pipeline.aggregate_checklist` grouping key
changed from (mass_shift_id, feature_id) to (mass_shift_id, feature_id,
proteoform_ref), first expanding the classification rows' multi-valued
proteoform_ref field into single-ref copy rows (fixing the first
version's defect of 80 rows with multi-valued identity); assignment_id =
mass_shift_id:F{feature}:P{proteoform}. Downstream fully compatible
(ledger_writeback/terminal_writeback/checklist_query match by the
mass_shift_id column or assignment_id, row granularity irrelevant). All
three samples re-ran the pipeline (parsing layer, no measurements
re-run); the writeback chain reuses existing JSON artifacts.

**Result**: histone 755→861 rows, chlamy 127→128, soybean 2448→2540, in
total 3529 observation rows; identity columns all single-valued
(feature_ids/proteoform_refs each a single value); every row has an
end-state mark (basis or core or singleton columns), zero unmarked.
mass_shift_id kept as an index column.

**Lessons**:
1. The pipeline classification rows' proteoform_ref field is itself a
   multi-valued string — "one row per observation" must expand rows by
   ref before grouping; never assume the underlying rows are already
   single-ref.
2. Observation-row conversion is a pure parsing-layer refactor: all
   measurement JSON artifacts (refine/core_verify/envelope/
   discriminator) are record-level and directly reused; zero
   measurement recompute.
3. Checklist row counts grow with the number of proteoform
   interpretations, but identity is now consistent with the record level
   of evidence-ledger/queue — ledger and routing are at last the same
   granularity.

## E34 · Skill merge: deep-research folded into mass-shift-analysis (2026-08-21) — `confirmed`

**Verdict**: the core is **routine batch assignment** (especially
all-UniMod single modifications); attention is only a fallback routing
reference; single-event discrimination is a toolbox that "picks a
technique by evidence shape", not flattened into the main document. The
two skills merged into one.

**Experiment**: `mass-shift-deep-research/SKILL.md` deleted; its content
was transcribed and reorganized into
`mass-shift-analysis/references/adjudication-methods.md` (technique
table organized by evidence shape: mass degeneracy → MS2 neutral-loss
diagnostic peaks (masalign/mzML), contiguous family → envelope
registration (noted as insufficient for single-modification
explanations), single modification → MS2 spectrum inspection;
composition/site/element/ppm degeneracy/regional recurrence/knowledge
checks each with their techniques; includes input contracts, output
envelope, boundaries). New `references/attention-guidance.md`: ranking
is a reference, not a gate (score = recurrence×2 + evidence layer +
ladder; the user decides order and depth), plus recorded AI
amplification means (cross-protein common masses, full ladders,
cross-observation candidate-consistency cross-checks, cross-database
reconciliation, cross-sample reproduction). The main SKILL.md was
rewritten as "capability map + principles + assignment-first reference
path" (Phase A all-UniMod single modifications → Phase B common library
combinations); the deepresearch subagent now points to
adjudication-methods.md; the full-workflow.md scope note updated.

**Result**: the skill library went 9 → 8; zero reference-chain
leftovers (grep finds only the merge comment).

**Lessons**:
1. Assignment is the goal, attention is routing — ranking tools are
   never written as gates.
2. The discrimination toolbox is discoverable only when organized as
   "evidence shape → technique"; flattened into the capability map it
   fails because "which tool solves which shape" is left implicit.
3. The key to merging is cleaning the reference chain in one pass
   (subagent system_prompt, scope note, docs); otherwise leftover skill
   paths mislead later loads.

## E35 · Identity-link three-hop audit: feature → proteoform → prsm (2026-08-21) — `confirmed` (two defects fixed)

**Verdict**: the correct key for identity links is **(feature_id,
proteoform_id)**; accession is explanatory metadata (the same PrSM can
match multiple proteins); the event mass frame must share the ledger's
source (calibrated cluster mass) — ProForma parse mass is another frame
and must not be mixed in.

**Experiment** (histone three tables + ledger cross-validation):
1. queue→PrSM: queue-row prsmIds verified against the prsm table by
   their (feature, pf): 2472/2472 = 100% — the ledger layer was already
   healthy.
2. proteoform→prsm: entities.prsms_of used exact triple matching
   (feature, pf, accession), only 47.8% — TopPIC's prsm_single table
   contains interpretations the proteoform_single table filtered out
   (FDR semantics), and multi-protein PrSM accessions disagree with
   proteoform-table rows. After switching to the (feature, pf) primary
   key: 622/622 = 100%.
3. events→queue: the ad-hoc event file (ProForma parse frame) matched
   only 55.7% — event mass (raw +mass) and queue totalShift (calibrated
   cluster) are two different aggregations; the same (feature, pf) can
   internally hold both 32.01 and 31.02. Wrote the formal generator
   build_events.py (queue as source, totalShift as the event mass frame,
   aggregation key (pf, acc, mass@0.1), preserving
   featureIds/assignmentIds/prsmIds); match rate 100%.
4. 38 queue rows with empty proteoform placeholder
   `proteoformRefs: [""]` (MS1-only observations) changed to `[]` — no
   fake refs produced, and no observations lost.

**Result**: all 547 histone events carry PrSM evidence; Phase A
(automated unimod single-modification assignment) first run: 68 single
modifications + 66 common library combinations = 134/547 directly
explained; all 89 attention clusters carry evidenceRefs; 121.98 → #3
(Gold tier 2, 57 PrSMs), 41.0 → #1 — the acceptance targets surfaced
naturally under the correct frame.

**Lessons**:
1. Use the minimal stable unit for identity keys (feature, pf);
   multi-valued fields (accession) do not enter keys.
2. Cross-artifact matching must first unify the mass frame — frame
   mixing is the stealthiest link breakage.
3. Event-level artifacts need a formal generator; ad-hoc script outputs
   drift with the pipeline and can no longer be aligned with the ledger
   at audit time.

## E36 · Three-layer CSV integration + modification-localization queries (2026-08-21) — `confirmed` (three parsing defects fixed)

**Verdict**: TopPIC's localization info takes the form
`+mass:[start-end]` protein-coordinate intervals (no Localized-sites
residue column); the proteoform rows' residue strings live in the
ProForma `(RES)[+mass]`. The entity layer must parse both, with the
interval frame unified to protein coordinates.

**Experiment**:
1. The `_UNEXPECTED` regex did not match the real format: it was written
   with parentheses `+32.0148:(59-62)`, but TopPIC actually uses
   **colon + square brackets** `+32.0148:[59-62]` (both tables 574/574,
   6190/6190 all square brackets) — interval parsing had always
   returned [0,0]. After the fix, prsm intervals 5496/6190 (the rest are
   bare masses without intervals, normal).
2. The proteoform table's Unexpected modifications column was previously
   unparsed — now Proteoform.unexpected_mods carries intervals; the
   `modifications(ref)` profile prefers the ProForma (RES)[+mass]
   residue strings and full-chain intervals (measured: +121.98 →
   SGRGK[1-5], +32.01 → MGIM[59-62]); the Unexpected column supplements
   bare masses without residue strings.
3. New queries: `feature(id)`, `residues(ref, interval)` (interval →
   site text), `modifications(ref)` (full profile),
   `site_candidates(key)` (best PrSM localization candidates); after
   fixing the PrSM Scan(s)/# Matched fragments column names, 7100/7100
   fully parsed.

**Result**: three-layer integrated query demo (H2B2E) — feature (mass
13884.59, RT 21.5, charge 13-23) → proteoform (+32.0148 → MGIM 59-62) →
best PrSM (E 7e-45, 83 fragments, scan 313) — the whole chain in one
line of code.

**Lessons**:
1. Parsing regexes must be validated against real table values — one
   colon of format difference and all interval data is lost.
2. Localization info is split between ProForma (residue strings) and the
   Unexpected column (intervals); profile queries must merge both —
   using either alone is incomplete.

## E37 · First shallow-to-deep simulation: histone + soybean full chain (2026-08-21) — `confirmed`

**Verdict**: the restructured batch chain (entity layer → events →
Phase A/B assignment → attention) walked end-to-end on two real
samples; the acceptance targets surfaced naturally.

**Experiment** (subagent dispatch hit its cap; the main chain executed
directly):
- histone: 547 events (100% with PrSM) → 134 explained (68 unimod_single
  + 66 library_combo) + 116 competing + 297 unexpected; all 89
  attention clusters carry evidenceRefs; 121.98 → #3 (Gold, 57 PrSMs);
  the 42.0 acetylation variant (41.0086 cluster, ±1 Da) → #1
  (recurrence 13, 137 PrSMs); 31.0 → explained.
- soybean: 10 fractions' 2448 queue rows merged and deduped → 2218
  events (100% with PrSM) → 714 explained (32%) + 254 competing + 1250
  unexpected; 94 attention clusters; 317 → #2 (recurrence 22); 119 →
  Phase A unimod_single = Cysteinyl (4.1 mDa); 25 → partially Cyano
  (25.00, 42 mDa) + partially competing into attention.

**Problems found**:
1. **±1 Da mass variants coexist** (PrSMs of the same feature/pf split
   into 42.01 and 41.02 branches): the cluster frame (totalShift) takes
   the 41.0 branch while the ProForma profile reports the 42.0 branch —
   the event frame is self-consistent, but modifications() mismatches
   ProForma when matching by mass. Known limitation, recorded not fixed
   (different frame semantics).
2. soybean's E-values used the single-fraction (M01) prsm table, so
   cross-fraction events lacked evidence layers (77/94 with
   evidenceRefs) — needs per-fraction E-value table merging.
3. soybean unexpected 1250 (56%) is notably higher than histone
   (54%→297/547, also 54%) — neither is low: histone 297/547, soybean
   1250/2218. Batch assignment rate = Phase A coverage + common-library
   match rate; soybean's plant-specific modifications exceeding the
   18-entry common library is the main cause, as expected.

**Lessons**:
1. The "shallow" of the shallow-to-deep chain uses the queue/cluster
   frame as the only anchor; any other frame (ProForma) serves only as
   profile/localization supplement, not event identity.
2. Attention acceptance = check the mass family (within ±1 Da), not
   exact-mass matching.
3. E-value evidence for multi-fraction samples must merge all fractions;
   a single-fraction table underestimates the evidence layer.

## E37b · Batch-layer compression fixes (2026-08-21) — `confirmed`

**Verdict**: what TopPIC already settled (archive) is archived directly;
family priors named in batch; cross-fraction E-value pairing; attention
low-mass stratification.

**Experiment**:
1. build_events carries routingStates; preliminary_assign directly
   explains all-archive events (basis=toppic_archive) — histone 27
   events, soybean +39 (714→753).
2. family_prior_audit wired in: histone 24 families, 18 named (6
   unexplained); soybean 10 fractions, 129 families, 127 named (3
   unexplained) — MS1 family spacings are mostly priors of known
   modifications.
3. attention_rank --prsm-table/--queue supports duplicates (paired by
   position): soybean evidence coverage 77/94 → **87/87 (100%)**; 317's
   evidence tier 1→2 (cross-fraction Gold PrSM found).
4. attention entries gain a lowMass tag (<100 Da): of soybean's 87
   clusters 54 are <100 Da (62%) — deep-dive priority goes to ≥100 Da
   (33 clusters).

**Result**: soybean unexpected 1250→1229 (after archiving), histone
297→296. The bulk of unexpecteds are <100 Da low-mass events (soybean
82%), now stratified and tagged; high-mass deep-dive targets converge to
33 clusters.

**Lessons**:
1. "Archiving" must land via the ledger's routingState, otherwise
   clusters TopPIC already settled repeatedly go through unimod search.
2. Family priors are batch-nameable (spacing→unimod), ahead of any deep
   dive.
3. Cross-fraction evidence merging is mandatory, not an optimization.

## E38 · L6 library induction wired in + termination mechanism (2026-08-21) — `confirmed`

**Verdict**: library induction (induce a sample-level library from
explained events, merge and re-run Phase B) is the main lever on batch
assignment rate; batch_report becomes the batch layer's unified entrance
and termination node.

**Experiment**:
1. library_induce adapted to the prelim format (explained +
   candidate.name/deltaMass; support = count of event assignmentIds);
   combination-closure entries enter the library by total deltaMass
   (later Phase B closes the same mass with 1 component).
2. batch_report wires in L6: induce → merge default + induced libraries
   (name clashes keep the default) → second prelim pass → propagation →
   attention → report (including the library_induced layer).
3. Effect (vs post-E37b):
   - histone: unexpected 270→191 (-79), coverage 30.2%→36.4%, attention
     76→67 clusters; induced library 13 entries (Hexanoyl/Butyryl/
     Hydroxyl-farnesyl and other histone acylations).
   - soybean: unexpected 1146→1066 (-80), while competing 236→335 (a
     quality shift from "no candidate" to "candidate degeneracy");
     induced library 5 entries (Hydroxymethyl/Cyano/Nitro and other
     plant modifications).
4. Acceptance fully maintained: 317 attention #1 (score 47, recurrence
   22, Gold); 25 → 26 explained + 11 competing; 119 all explained.

**Patterns found**:
1. Induced-library entries turn more unexpecteds into competing (more
   degenerate pairs) — this is progress (from no candidate to
   candidate), but shifts degeneracy-discrimination pressure to L8-L10.
2. Coverage dipped slightly on soybean (37.7%→36.8%) while unexpected
   dropped by a net 80 — the single coverage metric masks the
   unexpected→competing quality gain; reports must watch three-state
   transitions together.

**Lessons**:
1. Library induction is a parsing-layer assignment gain with no
   measurements; it outranks any measurement-layer batch work.
2. Three-state transitions (unexpected→competing) are quality progress;
   coverage alone is not enough.
3. Discriminating competing candidates (L8-L10) is the next bottleneck —
   measurement layer, routed by evidence shape (envelope only for
   family/elemental shapes, errormap only when PrSMs exist).

## E39 · Full-path simulation of acceptance targets + deep-dive route/loop guide (2026-08-21) — `confirmed`

**Verdict**: the deep-dive guide must be a loop of "shape picks the
starting point + results decide the next step", not a fixed dead
process.

**Guide update** (adjudication-methods.md "Routes and loops"): shape
decides the starting point, not the route; measurement results decide
the next step — separation → end state; residual → residual_recursion;
no separation → switch to another shape's route (envelope → errormap →
neutral loss → UniProt/motif); all tried with no separation →
evidence_ceiling (record what is missing). Loop termination is based on
evidence, not effort; routes are per-event independent; family
adjudication does not replace member measurement.

**Lessons**:
1. An acceptance target's path in the system = the triple of three-state
   position + attention rank + discrimination plan; all three must be
   visible, none may be missing.
2. The input of "completing localization" (ProForma residue strings)
   must be carried out with the event from the entity layer, so the
   deep-dive layer has a starting point.
3. The deep-dive guide's loop semantics (switch routes, don't repeat
   routes) matter more than the tool list.

## E40 · Skill-system simplification (2026-08-21) — `confirmed`

**Verdict**: the system is over-complex — stacked evidence layers
(three-state/basis/discrimination plan/evidence gap/existing-evidence
references, several parallel structures) hinder transfer use.
Simplification = entity JSON as the sole annotation carrier + reporting
left to the AI + the entrance lists only the core.

**Experiment**:
1. references 13 → 6 core (five-level-systems/evidence-reasoning/
   adjudication-methods/attention-guidance/termination-protocol/
   artifacts) + 7 historical ones moved into references/legacy/
   (checklist-format/discovery-partition/discrimination-planning/
   event-validation/full-workflow/uniprot-prior/visualization),
   reference chains updated.
2. SKILL.md 316 → 156 lines: the capability map lists only the 7
   core-chain items + the discrimination toolbox + the ledger;
   historical scripts moved into a Legacy section (19 of them, no
   longer referenced at the entrance, kept traceable).
3. batch_report 325 → 257 lines: removed the
   adjudicationPlan/evidenceGap/existingEvidence nesting — the judgment
   of "what evidence to add" goes to the AI (reading entity JSON + the
   adjudication-methods guide); the report has 5 keys (sample/coverage/
   layers/attention/residual), residual with 8 flat fields.
4. artifacts.md: 17-artifact contract table → 8 core + one section for
   other artifacts (per docstring + unified traceability-key rules).

**Result**: --report-only full-chain verification passed (histone 36.4%
coverage, flat residual structure). The transfer-use surface = 6
references + 1 SKILL + 7 core scripts.

**Lessons**:
1. Complexity comes from parallel structures (each stage building its
   own evidence view), not from script count — a single entity-JSON
   carrier + AI-generated reports is the simplification axis.
2. Historical content has value but should not occupy the entrance —
   legacy/ keeps traceability; the entrance lists only the core.
3. "The AI decides what evidence to add" is a capability, not a data
   structure — guides (adjudication-methods) carry the judgment;
   artifacts carry only facts.

## E41 · Attention merged into event ordering + four-piece doc set (2026-08-21) — `confirmed`

**Verdict**: attention needs no separate JSON — the order of the
events/checklist itself is the attention order; docs reorganized into
four pieces (SKILL philosophy / evidence-reasoning evidence strategy /
tools manual + assets / five-level grading).

**Experiment**:
1. attention_rank rewritten as in-place annotated sorting: every
   residual event tagged with
   attentionRank/attentionScore/attentionRecurrence/attentionTier/
   attentionLadder/attentionPrsmCount; the events array reordered =
   residual by descending score → singletons → explained.
   attention.json deleted. Core artifacts 3 → 2 (events + progress,
   with the progress final record containing coverage/layers/residual).
2. Script cleanup: singleton_stamp/checklist_query (old E31 channels)
   deleted; 36 scripts. Audit confirmed no dead code in the toolbox
   mode.
3. Doc reorganization:
   - SKILL.md (211 lines) = 8 philosophy points + chain + termination
     protocol + layer-mechanism table + capability map (the governing
     main document).
   - evidence-reasoning.md strengthened: evidence → scientific-question
     mapping table + analysis strategy (for unknown events, UniProt/
     motif first, then unimod decomposition; for plants with sparse
     UniProt annotations, look for homologous motifs; combinations kept
     only if site-feasible).
   - tools.md newly created = script capability descriptions + usage
     manual + asset contracts (merged artifacts.md).
   - five-level-systems.md gained TopPIC evidence-completeness grades
     C0-C3 (attention aid: Gold+C3 > Gold+C1 at equal recurrence).

**Result**: histone full chain keeps 36.4%; events file order =
attention order (41.01 rank 1-3 first, explained after); --report-only
normal. Final shape: 1 SKILL + 4 references + 36 scripts + 2 core
artifacts + 1 command.

**Lessons**:
1. Ordering is the artifact — the file's order is itself the attention
   list; no second view needed.
2. "Which evidence to look at when" is the core of the methodology
   (protein before mass, motif before decomposition); it determines
   analysis quality more than the tool list does.
3. Manual and contract in one (tools.md) — script capabilities, usage,
   and assets found in a single document.

## E41b · Script merging and dead-code removal (2026-08-21) — `confirmed`

**Verdict**: of the 36 scripts, the three ledger-writeback siblings
(E31 era) are dead (input artifacts deleted, no callers); the three
envelope tools and two discriminator tools are the same measurement
family, merged into subcommand-style scripts.

**Experiment**:
1. Deleted terminal_writeback / ledger_writeback (they read deleted
   artifacts like singleton-stamps, no callers).
2. envelope_fit / envelope_batch / envelope_arbitrate_all →
   `envelope.py` (subcommands fit / batch / arbitrate, parameter
   surface preserved).
3. dispatch_discriminators / execute_discriminators →
   `discriminators.py` (subcommands dispatch / execute).
4. SKILL / adjudication-methods / tools references updated in sync
   (zero leftovers).

**Result**: 36 → 31 scripts. Full-chain verification passed (histone
36.4%, 121.98 #3).

**Sufficiency judgment**: the remaining 31 = 7 core chain (one per
step) + 12 toolbox ("one tool per evidence shape", referenced by shape
in adjudication-methods — a methodology design, no longer merged for
count) + 3 ledger + 8 assets + 2 physics. Optional merge:
batch_prsm_refine + joint_refine (both refine family, low marginal
benefit).

**Lessons**:
1. The signature of dead code is "input artifacts deleted + no callers"
   — sweep regularly with these two signals; more reliable than judging
   by name.
2. Merging a measurement family into subcommand-style scripts
   (parameter surface untouched) gains both discoverability and a lower
   count; merging scripts across responsibilities (e.g. audit and
   recursion) only adds single-file complexity.

## Ruled-out paths (do not re-run)

- ms1-families ↔ PrSM checklist join (E5, 0 overlap, structurally
  impossible).
- mass_closed emitting sites directly (E7, defect deleted).
- `ranked.len()>1 ⇒ ambiguous` (E2, corrected).
- 55.04 / 84.06 / 6.94 Da as new-PTM claims (E4, UniMod already has
  direct matches).
- Machine-readable prior tables (a parallel JSON data structure for
  artifact/substitution masses, 2026-08-22) — the semantic body already
  covers the same content; a parallel structure violates the E40
  simplification principle.

## E42 · Chain scripts merged into events.py (2026-08-21) — `confirmed`

**Verdict**: the 5 batch-chain scripts (build_events / routine_assign /
family_propagate / library_induce / attention_order) are essentially
five transitions of one state machine, merged into `events.py`
subcommands (build / assign / propagate / induce / order); batch_run's
single command unchanged. 31 → 27 scripts.

**Result**: histone full-chain re-run keeps 36.4%; zero doc-reference
leftovers.

## E43 · From-scratch full-chain verification: three broken links from incomplete deletion fixed (2026-08-21) — `confirmed`

**Motivation**: re-run two samples from zero (TopPIC three tables →
queue → full chain → report) to verify the simplified system is
self-consistent. Conclusion: the chain itself runs with one command,
but the entrance had three broken links from "incomplete deletion" —
exactly what from-zero verification is meant to catch.

**Defects and fixes** (AGENTS.md rule 3: fix robustness, don't patch):
1. **Pipeline dangling imports**: SKILL declared mass_shift_assign.py /
   _checklist_v2.py deleted (legacy table), but proteoform_pipeline.py
   still imported them → ModuleNotFoundError; ingestion completely
   unrunnable. Architectural judgment: the old classification layer
   (unimod-search classifying every row) duplicated the chain's
   events.py assign — the chain is the sole chemistry referee. Fix:
   pipeline inlined two path helpers (_default_tdease_ms), dropped the
   assign_modifications call (aggregate/decomposition consume raw rows
   directly, classification columns empty), dropped annotate_degeneracy
   (its input candidates column no longer exists; degeneracy semantics
   are carried by the chain's Phase B competing), deleted the
   v2_columns call.
2. **L2 archive gate dead**: the only producer of routingState=archive
   was the old classification (auto_assigned/prior_assigned). With
   classification deleted the gate never fires → dead code. Removed the
   archive branch of events.py assign + STATE_MACHINE's toppic_archive
   + the batch_run report layer + the SKILL layer-mechanism table (L2
   archive row deleted; L3a/L3b renumbered to L2/L3).
3. **Queue interface inconsistency**: pipeline writes singular
   proteoformRef per row (rows are themselves single-ref granularity),
   while events.py build/order read only plural proteoformRefs (old-
   queue legacy) → the new queue produced 0 events. Fix: the consumer
   aligned with the fallback pattern already used by the deep-dive
   tools (plural first, singular fallback); both old and new queues
   readable.

**Simplicity accounting**: script count unchanged (27); what was deleted
was three layers of redundancy — the old classification layer (1065
lines of mass_shift_assign), the L2 archive shortcut, the queue plural
key. The chain's chemistry adjudication now lives in exactly one place
(events.py assign + the induce second pass).

**Lessons**:
1. When deleting a module, the list of files importing it is the repair
   checklist — deletion must come with a grep of the whole directory's
   import surface; otherwise the docs claim legacy while the code still
   depends on it, the most common form of failing to run from zero.
2. A second signature of "dead code": the sole producer of a gate is
   deleted — even with inputs the gate never fires again; delete it
   too.
3. The value of from-zero verification: the old queue masked the
   producer/consumer key-name mismatch (old artifacts were generated by
   an older version; the new code had never really consumed a new
   queue).

## E44 · PEP 723 refactor: one entrance + ten packages + two kernels (2026-08-21) — `confirmed`

**Motivation**: the user pointed at the root of the system's messiness
— it claimed PEP 723 + uv, but only 2/12 files had `# /// script`
headers, entities' pydantic dependency was undeclared, and `uv run
--script events.py` failed outright; free cross-imports among scripts
were hidden coupling. Decision: keep pydantic; **one main file declares
all PEP dependencies, everything else is a dependency package**.

**Experiment**:
1. Family merging (17 files → 6 packages): events absorbed
   batch_run(run)/priors; ingest = cluster + pipeline + feature_family;
   adjudicate = envelope + core_verify + plan_localization +
   batch_prsm_refine + joint_refine + discriminators; research =
   residual_recursion + hypotheses + series_collapse + artifact_audit +
   uniprot_site_audit; levels = smith_levels + confidence_level;
   figures = _paper + census_panel + mass_shift_spectrum. Deleted
   assignment_finalize (input columns empty, dead).
2. Merge-and-fix connections: envelope.py doubly broken (an early
   `__main__` called fit main and exited directly, so the 570-line
   dispatcher never ran and fit_main doesn't exist → batch/arbitrate
   unreachable) — fixed during the merge; `--unimod-sqlite` → `--db`
   unified; fragment main gained argv defaults.
3. PEP 723: new `mass_shift.py` as the sole entrance, header declaring
   `dependencies = ["pydantic", "matplotlib"]`; family files stripped of
   `__main__` and headers, becoming purely importable packages. Zero
   imports between packages (they import only the kernels
   entities/_physics); they talk only through artifact schemas.
4. The chain's run is an in-process direct call (sys.argv passed, no
   subprocess pipes) — errors propagate up; the silent-0-event failure
   class of bug is eliminated.

**Result**: `uv run --script mass_shift.py ingest build → priors → run`
reproduced the pre-merge baseline end to end from the TopPIC three
tables to the termination report (histone 375 clusters / 564 events /
33.3% / 41.01 rank 1-4 / --report-only normal). 27 scripts → 10
packages + 1 entrance + 2 kernels + 1 test; the PEP 723 promise is
honored: uv's isolated environment installs all dependencies at once,
runnable on any machine.

**Lessons**:
1. "Claiming PEP 723" is not PEP 723 — dependency declarations live in
   headers, not docs. One entrance declaring all dependencies and
   everything else declaring none is the simplest portable form.
2. A hidden benefit of merging: envelope's batch/arbitrate subcommands
   had long been unreachable (double main); only the forced check of
   "fewer files" exposed it.
3. Inter-package contracts = artifact schemas (tools.md), not imports.
   Key names align at the contract layer (proteoformRef singular/
   plural, --db naming); code no longer "matches by accident".

## E46 · H4 F1/F67/F122 complete-envelope family registration (2026-08-22) — `confirmed`

**Question**: do H4's three distinct features F1/F67/F122 belong to a
contiguous Bromo family, or to an equally ~79 Da Phospho family? F1 is
the shared base and cannot adjudicate alone; the comparison needs the
full envelope-fitting stability of the later family rungs.

**Targets**: the same protein `sp|P62806|H4_MOUSE`, feature masses and
RT apex:

| Feature | Mass (Da) | RT apex (min) |
|---|---:|---:|
| F1 | 11314.407467 | 33.387 |
| F67 | 11393.313753 | 37.588 |
| F122 | 11472.215443 | 42.335 |

Adjacent spacings are 78.906286 / 78.901690 Da. All three complete
models share the common background: N-terminal Acetyl, K20 Dimethyl,
M84 Oxidation. The complete families compared are `base + 0/1/2 x
Bromo` and `base + 0/1/2 x Phospho`.

**Measurement**: for each feature, use its own TopFD feature's apex
scan, representative charge, 8 MS1 scans before and after the apex, and
the complete theoretical isotope envelope; the comparison results are:

| Family hypothesis | F1 | F67 | F122 |
|---|---:|---:|---:|
| Bromo, 0/1/2 rungs | 0.995 | 0.981 | 0.982 |
| Phospho, 0/1/2 rungs | 0.995 | 0.876 | 0.601 |

**Verdict**: `confirmed`, composition-level Bromo family. The Bromo
family holds ~0.98 Pearson on the latter two members; the Phospho
family clearly degrades as the ladder advances. This verdict covers
only family-level composition/element pattern; it does not localize the
Bromo site, nor propagate F67's result to other features.

**Explicit exclusions**: this round uses no neutron removal/registration
correction, no intact-protein halogen twin-peak rule, no single-feature
`refine-shift`, and does not name by TopPIC `+121.9846` or the candidate
theoretical mass `163.9473` alone. The fixed N-terminal Acetyl belongs
to the common baseline of every complete proteoform and is not counted
in the `+121.9846` unexpected shift; that shift is defined after TopPIC
excludes fixed forms.

**Three-step LOOP**:

1. **Exploration adjustment**: from single-feature/candidate ranking to
   a complete envelope family comparison of the same protein's three
   features.
2. **dryrun**: with identical sequence/background, fit each of the
   three rungs for Bromo and Phospho, outputting each member's Pearson
   rather than a long candidate list.
3. **Three data-change questions**: is the Bromo Pearson stable across
   members? Yes (0.981/0.982). Is Phospho stable? No (0.876→0.601). Is
   there new site evidence? No — hence the conclusion stops at family
   composition, leaving sites to later independent verification.

**Follow-up**: after any envelope, TopFD/TopPIC, or input-coordinate
fix, re-run these three members; if the stability no longer holds,
withdraw this `confirmed` — it must not be automatically restored by
historical MS2 conclusions.

## E47 · Filling the TDP domain-semantics gap (2026-08-22) — `confirmed`

**Problem**: the methodology layer (evidence constitution, three
rulers, evidence logic, shape → technique) is complete, but nobody
holds the semantics of the domain data itself — the physical meaning
and adjudicative consequences of words like mass/isotope/charge/
fragmentation/acquisition/artifact. Every related phenomenon had to be
solved after the fact: E12b's double-neutron split, E15's
artifact-suspect tagging, E28's 1-neutron calibration offset.

**Action**: close-read the domain canon (Roberts et al., *Top-down
proteomics*, Nat. Rev. Methods Primers 4:38, 2024), draw boundaries
against the existing references, then create
`mass-shift-analysis/references/tdp-semantics.md`, each entry organized
as "meaning → consequence for adjudication":

- the five sources of proteoform shifts (PTM/variant/splicing/
  truncation/disulfide) and their hypothesis constraints (a variant
  hypothesis requires the old residue in place, a PTM does not);
- the difference among four masses (nominal/mono/most abundant/
  average); ≥30 kDa mono peaks invisible, reported values are
  averagine extrapolations; 1.00235/1.00335 spacings; ±1.003×n
  residuals and the 2.0067 double neutron are deconvolution-layer
  artifacts; ppm scales with mass (5 ppm = 57 mDa at 11 kDa);
- charge-state dilution and S/N decay with mass, dynamic range
  10^8–10^12, co-elution convolution;
- activation ↔ ion-series table (intact proteins retain labile PTMs
  better than peptides); end-biased cleavage/mid-chain blind zone =
  physics, not tool failure; internal fragments; sibling scans vs co-
  isolation;
- DDA/duty cycle: C0 (no qualifying PrSM) is expected acquisition
  physics;
- artifact prior table (oxidation/in-vitro dephosphorylation/
  glycation/in-source neutral loss/adducts) — ordering priors, never
  adjudicating;
- biological facts (histone tail ladders collapse by family, N-terminal
  modifications belong to the common base, multi-gene family mass
  degeneracy is expected) and quantitative semantics (label-free
  belongs to the feature layer).

**Boundaries**: score semantics belong to identification-quality.md,
rulers to five-level-systems.md, evidence logic to
evidence-reasoning.md, technique routing to adjudication-methods.md;
this file only supplies word meanings. One SKILL.md References index
wire-up. The canon's full-text extract is stored at
`docs/design/ref-papers/tdp-primer-extract.txt` (for provenance, not authoritative).

**Verdict**: `confirmed` — the gap is real and filled by a single
reference (no parallel structure, following the E40 simplification
principle). The canon also endorses existing practice: open search +
spectral alignment is the field's standard route, the five-level
classification is in use, ambiguous as an honest end state resonates
with the Limitations chapter, and deconvolution-layer isotope
misassignment is a named, known trap.

## E48 · End of Python's second physics engine: the doublet layer killed everywhere (2026-08-22) — `confirmed`

**Problem**: the Rust `isotope_pair.rs` module header self-declares
"rust core's single copy of the measurement physics that used to live
in `_physics.py::enumerate_doublets` … Rust is the core truth; python
is a thin caller", but the old Python engine was still in service (the
`fragment_spectrum.py --doublet-*` plot layer), ingest still hid a
legacy pipeline calling the deleted script `fragment_doublet.py` (the
`--enable-legacy-doublet` gate), and constants were copied in four
places (BR2 in both `_physics` and `fragment_spectrum`, drifting from
Rust `constants.rs`). User ruling: the doublet is garbage too; kill it.

**Actions** (structural deletion, zero new abstractions):
1. `fragment_spectrum.py`: `classify_doublet`/`doublet_layer`/
   `merge_doublet`, the four `--doublet-*` parameters, render-pipeline
   parameters and plotting blocks (brackets/stars/verdict titles), the
   manifest doublet keys, the local BR2 constant, the doublet role in
   EVIDENCE_ROLE_TAG — all deleted;
2. `ingest.py`: the whole `annotate_doublet_column` function + its
   dedicated helpers (`_proforma_facts`/`_DECOMP_TOKEN`), the
   `--skip-doublet`/`--enable-legacy-doublet` flags, the checklist
   `doublet` column and `_doublet_record` writeback, the doublet wording
   in decomposition comments — all deleted;
3. `_physics.py` shrank to mzML decoding + envelope binning constants
   (NEUTRON/KMAX/NS/decode_array), its docstring now declares "all
   physics lives in the Rust kernel"; `test_physics_invariants.py`
   (pinning only dead physics) deleted; `mod-library-soybean.json` (a
   sample-customized library with zero repo references) deleted;
4. SKILL.md / tools.md `_physics` and test lines rewritten in sync.

**Verification**: py_compile passes for all scripts; `main.py fragment
--help` normal (PEP 723 routing); real-data end-to-end smoke (histone48
scan 1164, full ProForma [Acetyl]+K20[Dimethyl]+M84[Oxidation]): 2828
theoretical fragments / 281 matches / median 1.92 ppm / Dimethyl=C2H4
locked by the kernel regression — the rendering chain is intact after
deletion.

**Verdict**: `confirmed` — no second physics engine exists on the
Python side anymore.

**Correction (same day, user pointed out)**: this entry previously said
"the sole engine for halogen-doublet measurement is `tdease-ms
isotope-pair`" — wrong. The system's only measurement interface is
**full ProForma → kernel theoretical spectrum (`fragment-theoretical`,
with per-fragment BRAIN isotope envelopes, raw and deconvoluted frames
from the same source) → matching**; the theoretical spectrum of a
Br-containing model itself carries the M/M+2 shape, and matching is the
measurement. `isotope-pair` was a standalone shortcut command ported
from the dead Python engine; after the Python-side cleanup it had zero
callers in the repo — **deleted the same day** (module/command/schema
item/457 lines; no tests or callers depended on it; lib 82 +
cli_contract 46 + integration tests all green confirmed).
isoforma is likewise a pure consumer of `fragment-theoretical`; its
local z-dot formula existed only to cover a kernel interface gap —
`fragment.rs` has the `(Z,1)→ZDot` mapping but the upstream generator
did not produce that variant (measured `--ion-types ZDOT` → 0 rows).
**The gap was closed the same day**: the generation model enabled
mzannotate's z-series hydrogen variants
(`FragmentationModel::all().z(PrimaryIonSeries::default().variants([0,1,2]))`,
whose own test pins z•1(AAA) m/z 74.036231); the kernel now emits
`z`/`z*`(z•)/`z'`; the contract test locks z•=z+H (AK z1 three variants
129.078979/130.086804/131.094629); default `C,Z` output unchanged, F67
smoke bit-identical; isoforma migrated to pure kernel consumption (the
local z-dot formula and AA table fully deleted, z rows upgraded to
kernel BRAIN envelopes); suite 8 pass/2 fail (the failures are
pre-existing in-flight, stash verification unrelated to the
migration).
**A/B behavioral-consistency verification** (same input, same command,
stash-switching old vs new): the first round exposed a real regression —
the old z ladder's pos → fragment mapping is "fragment starts at
pos+1" (including the 1-residue z•1 row), while the kernel path's
`_fragment_number` computes "starts at pos"; after migration the z•1 row
was dropped and labels were off by one; the fix aligned z's numbering
with the old semantics (`number = L - pos`, y unchanged); after the
fix, both cases (clean single-peak msalign neutral domain + multi-
charge MGF m/z domain with carbon envelopes) are **bit-identical** in
rows/labels/masses/abundances/proportions. Lesson: acceptance of a
consumer migration is not "tests pass" but an old-vs-new behavioral
diff — the test suite covered only the c series; the z series' behavior
contract surfaced only in the A/B.
**Real quantitative verification (chlamy H4 mono-acetyl, paper
protocol)**: input rebuilt from raw data (feature 83 = 11432.36
mono-acetyl H4, RT 126.4-131.3, neutral-mass back-calculation selected
2 ETD scans 4635/4638, product peaks merged at 10 ppm), run the
migrated quantify with the paper's original command (--ion-type c,
other parameters verbatim): K5 0.4506 / K16 0.2759 / K12 0.2445 / K8
0.0291 — each value falls inside the paper's recorded replicate
distribution (K5 0.394±0.047 / K12 0.277±0.032 / K16 0.245±0.071 /
K8 0.085±0.059, all ≤1.2 SD; the K12/K16 swap lies within both SDs,
consistent with the paper's "category/rank-level" verification
resolution). Old-vs-new diff on the same input: **c-only
bit-identical** (ratio 0.00e+00, same row/discriminator counts). The
mixed c,z series is underdetermined in both versions (existing solver
behavior: z rows have no discriminating power for N-terminal tail
sites; the paper protocol's c-only exists for exactly this).
**Autopsy of the z-row difference (correcting the initial reading)**:
at steady state the old has 169 rows vs the new 185; c rows are
bit-identical, the difference is all in z — the cause is not the
contamination guard but **envelope-stick semantics**: the kernel
envelope is the full BRAIN stick set (2-15 isotope peaks, M0 only ~55%
for large fragments); the new z rows match and sum over the full sticks
like c/b/y; the old z fallback matched only 3 equidistant sticks (z30
abundance 366→2340 is exactly this). This is a consistency fix aligning
z-row measurement semantics with c/b/y, not a regression; no current
consumer depends on absolute z-row abundances. Two methodological
lessons: (1) the synthetic A/B fixture contains only the M0/M1/M2
peaks, so the extra full-stick positions had no peaks to match and it
looked "bit-identical" — A/B fixtures must cover the full spectral
shape of the measured path; real data is the final judge; (2) the old
code produced one 167-row ghost run (1 of 6 processes, identical
parameter echo, irreproducible, suspected environmental), while the new
code is 4/4 deterministic — control experiments must be re-run
repeatedly to reach steady state; a single run does not count.
**Distilled**: this round's methodology has entered
`solutions/domain-proteomics/consumer-migration-ab-protocol.md`
(an A/B protocol for migrating consumers to the kernel theoretical
interface: dictionary alignment, numbering mapping, same-input
diffing, shape-complete fixtures, steady-state re-runs, attributing
from code paths rather than resemblance).

**Variant selection vs fragmentation-mode selection (same-day design
ruling)**: mzannotate has presets organized by fragmentation mode (ETCID
= c/z variants [0,1] etc.), but the presets bundle opinions like charge
ranges and companion series, and the measured scan 1164 ETD spectrum
contains **both** plain z (78 matches) and z• (73 matches; c+z+z•
combined 350) — hydrogen-state occupancy is a property of the spectrum,
not of the activation label. Ruling: the kernel generates variants
unconditionally, and the caller selects by data with ion-type tokens;
an "ETD→z•" hard binding would lose real signal, so no `--activation`
gate.

**cli_contract 6 reds closed the same day (all green 46)**:
`parse-proforma`'s default path now goes through the core single parser
`parse_proforma` (mzcore backend, embedded ontology, TopPIC-flanking
support; explicit `--db/--user-db` goes through the core-exported
dual-source resolver, USER:n/ambiguity semantics preserved); the schema
table gained `fragment-batch`/`prsm-refine-batch`; the unimod-search/
solve contract tests gained the kernel-matching `--limit 100` and
`--element-whitelist ""` (CLI defaults untouched). The skill-side smoke
(scan 1164: 281 matches / 1.92 ppm) is bit-identical to before.

**Leftovers (recorded in STATUS, not pretending to be solved)**:
1. `make_census_marks.py` (the paper's +122 deep mark) mechanically
   asserts the `doublet` column of a **frozen historical ledger** — it
   passes while the historical artifacts remain in place; if the paper
   is rebuilt from the new ledger, that check must be repointed to the
   recorded isotope-pair evidence JSON;
2. `fragment-theoretical` accepts the `ZDOT` token but enumerates 0
   rows (measured `--ion-types ZDOT` → 0 rows) — the generic fragment
   enumeration does not emit z•, so isoforma's Python z-dot formula
   remains required in service; migration becomes possible only after
   the kernel's z• enumeration is completed;
3. `cli_contract` 6 reds (5 reds at E10, drift rising) remain a
   kernel-side contract-authority debt.


## E49 · Informed-Proteomics core port: the sequence-graph engine (2026-08-22) — `confirmed`

**Problem (settling E13's debt)**: refine's search structure was
"combination × site-permutation DFS with full re-scoring at every
leaf" — E13 already judged it structurally wrong; the fix was bypassed
by E14's TopPIC priors and left on the books until this round.
Comparative research (a close reading of the whole IP repo + two
external surveys) confirmed the DP / integer mass space / combination
state table trio had never been implemented (earlier reports of
"MSPathFinder-style already implemented" were misreports; the code had
always been DFS).

**Action**: the IP core chain ported one-to-one as
`rust/mass-spec/src/seqgraph.rs` (~1400 lines) + CLI `graph-search`:

1. composition: short atom counts (C/H/N/O/S/P + 38-element table incl.
   Br/sugar atoms) + a free-delta wrapper; dual bin constants (×0.9995
   nominal, ×274.335215 fine ~3.6 mDa).
2. ModificationParams: a full pre-catalog of combinations (with
   repetition, ≤max_mods) + a (prev, mod)→new transition table + a
   reverse table; SHIFT at most once per combination.
3. SequenceGraph: reverse-order layered construction, dedup by
   combination index (permutation collapse), lazy caching of node
   compositions (shared by all placements), one max-DP + backtrack
   (modification@position), a placement-count table, cleave_n_term.
4. Free residual = a combination-state-aware virtual SHIFT: delta
   dynamically resolves per combination as observed − Σ(other members)
   — a generalization of IP's ShiftedSequenceGraph anchored-endpoint
   pseudo-residue (its original consumer was the skipped tag search;
   declared deviation #1). Fixed modifications pinned at TopPIC
   positions (deviation #2; IP bakes them in by residue class).
5. scoring: bin→peak pre-indexing (±tolerance covering all overlapping
   fine bins); a counting version + the IP weighted discriminant
   (source constant ×4.0; msalign has no envelope Corr/Dist → explicit
   downgrade recorded, the negative-Count-weight discriminant semantics
   preserved).

**Verification**: 10 unit tests (combination space/transitions/graph
collapse/DP localization/SHIFT localization/fixed modifications/
truncation/weighted negative Count/end-to-end synthetic msalign),
semantics aligned with IP's TestSequenceGraph; full suite 92 lib + 47
cli_contract + 3 e2e green. Real regression: H4 scans 1164/1165, fixed
nTerm Acetyl, library Dimethyl(K)/Oxidation(M)/Bromo(Y), +121.9846,
5 ppm — **59 ms** to finish enumeration (30 combinations) → gate
evaluation (9) → ranking; `Dimethyl+Oxidation+SHIFT free=77.9584` is
bit-identical to the residual 77.9584 recorded in E8; in closed mode
(--no-free-shift) Dimethyl+Ox+Bromo evaluates normally; both the count
scorer and weighted paths usable; schema/help complete.

**Reconciliation**: E48 leftover #3 (cli_contract 6 reds) measured all
green (47/47) — fixed in the previous session but not written back;
aligned here.

**Verdict**: `confirmed` — the engine structure is correct and
acceptance passed. Honest boundary (declared in output): under tied
scores the site is the canonical first-best (same semantics as IP), not
evidence-discriminated; msalign has no envelope-shape term, so
discriminating power is weaker than IP's full scorer.
**Owed**: (a) replacing prsm-refine's DFS and wiring into events
routing (next round); (b) enumerating alternative sites of tied groups
(ambiguity reporting); (c) mass bin graph + GeneratingFunction
(spectral E-value, deferred).


## E50 · Sequence-graph engine completed: alternative sites / spectral E-value / skill routing (2026-08-22) — `confirmed`

**Settling E49's three owed items**:

1. **Alternative-site enumeration (E49-owed b)**:
   `optimal_placements` — after the DP, walk back along optimal
   equivalent paths (criterion: prev's max score == the maximum over
   all predecessors), enumerating all optimal placements of tied groups
   (cap 6); candidates carry an `alternativePlacements` count + the
   first 5 groups. Test: GGKGGK with no discriminating peaks → both
   K3/K6 placements reported.
2. **Spectral E-value (E49-owed c)**: IP's
   `FilteredProteinMassBinning` + `ProteinScoringGraphFactory` +
   `GeneratingFunction` ported one-to-one (f64 top-position truncating
   bin comparator; fine-bin reachability closure → 27-bit compression;
   node score = prefix+suffix hits; GF score-distribution convolution
   DP; cached by candidate protein mass). **Scientific verdict**: count
   semantics do not discriminate at whole-protein scale — zero-space
   paths of matching mass also hit the real spectral ladder bins, and
   the E-value is astronomical (measured 1e216 @ 52 ions); IP's
   discriminating power comes from the envelope-fitting terms
   (Corr/Dist), for which msalign has no input. Disposition: when
   Ev>1, emit a non-discriminating declaration; **the default scorer
   switched to count (DeconvScorer semantics), the IP weighted
   discriminant demoted to opt-in** — measurement showed its negative
   Count weight penalizes real hits and flips direction without
   Corr/Dist (a real bug, fixed). The E-value machinery is complete;
   discriminating power awaits raw-mzML envelope-fitting input.
3. **Routing (E49-owed a)**: `graph-search-batch` (JSON multi-record
   batch) + the skill's `adjudicate graph` subcommand (queue row →
   fetch sequence/fixed modifications from the TopPIC tables → batch
   graph search → candidate envelope, measurementRole =
   candidate_model_evaluation / notIdentity). Skill-level E2E: F198
   +121.9846, default 16-modification library, 143 combinations,
   Dimethyl+Oxidation+Bromo tops with 51 ions. **`prsm-refine`'s DFS +
   ladder evidence is intentionally retained** (the carrier-existence
   binomial test is a different observation model, not an old
   implementation being replaced).

**Verification**: 13 seqgraph unit tests; full suite 145 pass 0 fail;
real data H4 single query 3.2 s (GF-dominated; binning/GF once per
sequence, intra-batch reuse pending optimization).

**E50 addendum (closure-gate defect exposed by a fair-library test,
same day) — `confirmed`**: in a routine-library
(Methyl/Dimethyl/Acetyl/Phospho/Ox) test, `Methyl+Dimethyl+Phospho`
topped with 70 ions but with a +28.7 mDa mass difference (238 ppm) —
count scoring is blind to closure error, ions that don't cross the
modification region pile up points, and the discriminating ions happen
to be all wrong. Root cause: the 60 mDa mixed window (prsm-refine's
co-elution semantics) was wrongly inherited into closed mode. Fix:
closed combinations are now gated by tolerance × shift mass (IP
precursor-tolerance semantics); the mixed window applies only to SHIFT
combinations. After the fix: the fair-library leader becomes the
free-residual family with Phospho@88 as the robust anchor; after adding
Bromo, Oxidation+Bromo+SHIFT(28.08) wins with 53 ions and Bromo@88 —
in the same direction as E10's dual hypothesis (Br 113.8 vs phospho
21.4) and E46's family verdict. The 48 mDa difference between the
TopPIC frame 121.9846 and E10's calibrated frame 121.9569 is honestly
visible in the free value.

## E51 · Closing five engineering debts of the massshift skill (2026-08-22) — `confirmed`

The user named five questions; each was verified against the disk and
then handled:

1. **"events/research/adjudicate call the old prsm-refine-batch, ingest
   calls refine-shift-batch"** — **misreport**. The two are kernel
   commands with different semantics, not an old/new relationship:
   `refine-shift-batch` = feature level (mzML + RT window + composition
   decomposition calibration), `prsm-refine-batch` = PrSM level (msalign
   + scan + modification library + site-interval localization). ingest
   uses the former, routing/deep-dive the latter; each is correct.
2. **Python's second physics engine (real)**: all of it lives in
   `adjudicate.py`'s localize (localization-plan) — `fragment_mz()` +
   terminus tables (H2O/NH3/CO/z-dot/z-prime) + PROTON + a home-grown
   UniMod XML parser + hard-coded residue priors. **Killed**: the
   fragment m/z table is now generated once by the kernel's
   `fragment-theoretical` (Python only orchestrates "which bond
   separates the two sites" and does ±mass/charge bookkeeping);
   residue tables/modification matching moved to `unimod-residues` /
   `unimod-search`; residue priors moved to
   `references/residue-modification-prior.json` (data, not code).
   Diffing: kernel m/z vs the old formulas, over the full sequence,
   c/z-dot, all charges, max deviation 4.3e-6 Da (the proton/electron
   approximation level of the old constants) — the kernel is the
   authority.
3. **Six modules each shelling out to the CLI (real)**: `native.py`
   gained `run_json` (resolve + run + parse + loud error reporting,
   check=False for tolerable-failure call sites); the 12+ home-grown
   subprocess pipes across events/adjudicate/research/ingest/
   fragment_spectrum all converge here; `ingest._run_json` demoted to
   an alias.
4. **COMMON_STEPS/LADDER_STEPS hard-coding (real)**: the seeds keep
   only the UniMod record id (stable primary key; "Pyro-Glu" is really
   id 28 `Gln->pyro-Glu`, "Deamidation" is really `Deamidated` — the
   old names were simply wrong); deltas resolve at runtime via
   `unimod-get --id`, bit-equal to the old hard-coded values; ladder
   detection derives from the same resolution (unchanged after 0.1 Da
   rounding). propagate/order gained `--binary`; the chain passes
   resolved paths internally.
5. **Docs vs reality (real)**: SKILL.md's capability map gained the
   native gateway and localize's kernel dependency; the routing
   protocol now leads with the **census-first / family-ladder early
   anchor** principle (to prevent the Agent from being anchored by the
   top three of a candidate list: an isolated 121.98 invites
   Acetyl+Phospho self-confirmation, while a 0/+79/+158 same-protein
   family reframes the question as "which repeated composition explains
   the whole family", with Br and Phospho competing as equals).
   Singleton/cross-protein/source-inconsistent cases still go through
   single events.

**Verification (end-to-end, real data)**: chlamy-h4-live full chain
ingest build → run --fresh (assign/propagate/order/prsm-refine all
through the gateway): 177 events / 32 explained / 20 unimod_single /
11 library_combo / 1 family_propagation / 77 ranked; the prsm_refine
layer completed normally; deliberately feeding a wrong msalign
degrades recoverably as designed. `adjudicate localize` (H4 47
residues + 42.0106) outputs completely; `adjudicate graph` made 165
request round-trips (an empty library correctly rejected by the
kernel); both fragment_spectrum paths passed smoke tests. The old
script test file `tests/test_analysis_skill_scripts.py`'s 13 failures
all point at deleted scripts (mass_shift_analysis.py/
confidence_level.py, killed in the f30d132 merge) and a nonexistent
`toolkits/` default path — pre-existing breakage unrelated to this
round (that file belongs to the user's in-flight changes, untouched).

**Scope boundary (honestly recorded)**: `research.py hypotheses` still
reads `reference/unimod.xml` directly (`load_unimod`) — it is reference
data lookup for the candidate-generation layer (combination enumeration
needs the full table + neutral losses/curated evidence), computes no
physical quantity, and does not violate "physics authority lives in the
kernel"; but it and the kernel's unimod.sqlite are dual sources with
drift risk. Closure path: the kernel exposes output including neutral
losses (or unimod-solve results carry losses), and hypotheses migrates
with diffing per the consumer-migration protocol. Not touched this
round — that is a separate migration, not one of the five debts.

**Lesson**: when skill scripts are untracked and have no stash
baseline, equivalence verification goes by constructive proof — kernel-
resolved values bit-equal to the old hard-coded ones + independent
physical-layer diffing + the full chain running on real data; the three
together are the evidence of unchanged behavior.

## E52 · Symmetric model redo on speaking tools: capability confirmed + LGB3 blind-discovers the paper's own unattributed family (2026-08-31) — `confirmed`

Hypothesis: with verdicts handed off inside the tool interaction (rank-
deficiency digests that name the deficient totals and inline the merge
recipes, batch verdictNotes, ablation candidates, closure in selection
stdout), a "cheap" model completes the same anchor work as the strong
model; and blind symmetric running, scored against the literature gold
standard, surfaces real coverage facts rather than tier folklore.

Run: the 2026-08-28 anchor/reporter tier split was abolished (user decree:
same OpenSearch work for every model). DeepSeek-v4-flash ran the full
anchor trajectories — chlamy on the byte-exact frozen pair GLM-58 used
(strict head-to-head), soybean/mouse on new frozen natural pairs (blind
census → attention; t2 names the object explicitly after the v1 LGB3
object divergence taught the lesson). Gold-standard coarse scoring via
the codex coverage tool + session attribution faces.

Verdict: `confirmed`.
1. **Capability**: DeepSeek completed all three anchor trajectories
   (fails 0–1, discipline violations 0). Chlamy went DEEPER than GLM-58 —
   three sister series each with its own complete base (bare / 79:Methyl /
   79:Methyl+84:Oxidation = the paper's Table-2 meox frame): the only
   session covering all four gold-standard background components.
2. **Discovery**: the soybean v1 object divergence (DS followed LGB3_SOYBN
   P02237, a ~16 Da C-terminal ladder, W122/W130/H93/P101 window, candidate
   ceiling) reconciles with the gold standard: Zhou 2022 S1 rows LGB1_3065
   (+15.0191 @ SSA window) and LGB1_3071 (+31.0165) mass-match the ladder's
   L1/L2, the localization corridor [89–131] agrees, and the paper itself
   left both shifts unattributed — both sides stop at candidate, zero
   contradiction. The "wrong object" was a real, in-literature family.
3. **Generation-depth gaps (recorded, not folklore)**: soybean DS left
   +317.39 unassigned where GLM composed Myr+Palm; mouse DS's hypothesis
   space generated no Br family (brom/Y88 never appear, audit-confirmed)
   where GLM's space carried the full gold vocabulary. Errors 0 everywhere.

Owed: GLM soybean/mouse strict same-prompt reruns (optional completion of
strict symmetry); mouse Br-family generation gap as a tool/SKILL routing
question (combination search did not surface Br for DS); the quarantined
manual meox quantification (84.4% closure, paper-Table-2 frame) still
awaits a session-layer reproduction.
