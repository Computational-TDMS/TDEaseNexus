# Fixture provenance

`pasavento-h4-ms2.mzML` is derived from `inst/extdata/Example.mzML` of the
IsoForma R package (Degnan et al. 2024, J. Proteome Res. 23, 3318-3321;
PNNL), which carries the Battelle Memorial Institute BSD-style license
(redistribution permitted with copyright notice retention — see the package's
`license.txt`).

Derivation (one-time, 2026-08-28): the 15 MS2 spectra in retention window
100–110 min whose precursor neutral mass (selected m/z × z − z·proton) falls
in 11385–11446 Da were copied verbatim into a plain mzML document (index and
chromatograms dropped). Five of them are the paper's H4 family
(N-terminal acetyl + one variable K-acetyl + K79 methyl + M84 oxidation,
monoisotopic 11433.38 Da) at selected isotope indices M+5..M+10; the rest are
same-window neighbours the selection gate must reject.
