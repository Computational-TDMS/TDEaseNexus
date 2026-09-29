# IsoForma architecture

The implemented mzML route has four boundaries.

## Selection

For each declared occupancy, all positional configurations share one precursor composition and mass. When a feature scan map is supplied, the runner first takes the union of the MS2 scans linked to all features for that source and occupancy. This is the extraction boundary; the feature label does not change the occupancy or candidate model. The runner then filters that union by precursor neutral mass ±10 Da, the user RT bounds, and one activation method. Without a feature map, it uses the explicit scan set or RT window directly.

Rust `validate-precursor` then reads every candidate MS2 and its referenced parent MS1 in one batch. The theoretical precursor isotope profile comes from the complete ProForma and acquisition charge. Without a feature scan map, admission requires:

- at least three matched theoretical isotopes inside the recorded isolation window;
- total matches covering at least `floor(0.4 × theoretical profile size)` within 15 ppm.

This reproduces `pull_scan_numbers()` while using three matches as the inclusive paper threshold. Charge is never re-inferred. With a feature scan map, failed isotope checks are retained as warnings; feature membership, RT bounds, precursor mass, and activation remain the hard selection criteria.

## Pooling and measurement

Qualified MS2 scans are pooled once per source and occupancy. Rust removes raw peaks at or below 0.01% of the strongest input peak, clusters m/z values within a bounded 5 ppm span, sums intensity, and keeps the intensity-weighted m/z. A drifting chain cannot expand a cluster beyond the bound.

Every positional configuration is matched against this same pooled spectrum through `fragment --envelope-match`. The matcher uses theoretical fragment isotope envelopes, apex admission, Pearson filtering, one-to-one peak ownership, and integrated collected-isotope intensity corrected by the reported theoretical coverage. Simple nearest-peak intensity is absent.

## Estimation

At a shared ion series, cleavage, and charge, distinct modification states form conditional intensity ratios. Missing peaks do not become zero. States sharing observed peaks are excluded. Fractions are nonnegative and sum to one. Constrained ratio least squares supplies the beta initial estimate. Beta is the only formal estimator; if it is ineligible or fails, the least-squares value is returned as provisional diagnostic output. One qualified MS2 is sufficient to continue; the result still records the accepted scan count.

Configurations with identical response signatures and null-space coupling are exposed as `suggestedGroups`. The runner does not convert these suggestions into reported totals. Formal occupancy comparisons use the source paper's declared category model; the automatic result remains diagnostic evidence for deciding whether that model is supported.

A declared model is supplied as `occupancy,sites,category` CSV. The solver retains its member configurations, tests each declared category vector against the response null space, and reports the category sum only when that vector is identifiable. Automatic suggestions never rewrite the declared model. The Chlamydomonas paper model is frozen in `chlamy-paper-model.csv`; its recorded rerun outcomes are benchmark records, not part of this contract, and are cited only where a current test pins them.

## Output

The runner writes no report artifacts. Stdout contains the accepted scans, rejection counts, scan-count QC, fit quality, reportability, conditional fractions, and automatic grouping suggestions. Temporary full fragment evidence is deleted after solving.

The route does not estimate occupancy abundance across MS1 features. It quantifies positional configurations conditional on one declared occupancy and the union of its feature-linked MS2 scans. It declares the model space and returns `calibration.status=unassessed` until a source reference profile is supplied.
