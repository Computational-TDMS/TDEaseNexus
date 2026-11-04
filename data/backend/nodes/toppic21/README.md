# toppic21

TopPIC Suite **2.1** — the version-pinned sibling of the [`toppic`](../toppic/README.md)
node (1.8). Both nodes are deployed side by side; a workflow binds exactly one
of them. Nothing here is shared with the 1.8 package: separate binaries,
separate resources, separate rule file.

Built from the upstream source at tag `v2.1.0` (CLI only — the Qt GUI tools
are not built and not shipped). The suite has no official Linux binary; the
upstream download page offers Windows binaries and Linux source only.

## What differs from the 1.8 node

| area | 1.8 | 2.1 |
|---|---|---|
| deconvolution | `-n` toggles MS-Deconv | `-p/--ms1-deconv`, `-q/--ms2-deconv` (default `greedy`) |
| `topfd -g` | skip HTML | `--ms2-envcnn-cutoff` (takes a value) |
| spectra database | none | `topfd` writes `<sample>.sqlite`; **required** by toppic's post mass matching |
| error tolerance | one `-e` | `-e` fragment + `-E` precursor |
| result tables | `<s>_ms2_toppic_prsm.tsv` | `<s>_post_ms2_toppic_prsm.tsv` (+ proteoform/protein) |
| result columns | legacy | ProForma and proteoform-classification columns; PTMs use Unimod names |

`topfd` still writes the 1.8-style `_ms1/_ms2.feature`, `_ms1/_ms2.msalign`
and `_feature.xml` files next to the database, so downstream readers that only
need the msalign files keep working.

## Package layout (flat)

```
toppic21/
  topfd  toppic  topindex     # 2.1.0 CLI binaries (no Qt, no GUI)
  res/                        # the suite's resource directory name in 2.1
    envcnn_models/  base_data/  ecscore_models/
  lib/libonnxruntime.so.1     # loaded through LD_LIBRARY_PATH by rules.smk
  rules.smk
  README.md
```

## Rules

- **topfd** — `{sample}.mzML` → msalign/feature/XML + `{sample}.sqlite`.
- **toppic** — msalign + topfd database + `database.fasta` →
  `{sample}_post_ms2_toppic_{prsm,proteoform,protein}.tsv`.
  Runs with `-z` (no toppic SQLite database): the TSV tables are the product,
  and post mass matching only reads topfd's database.
- **topindex** — `database.fasta` → `database.fasta_idx/` (compressed index)
  plus `.tdease/topindex/<fasta>.complete`.

## Parameters

Config blocks are the same `topfd:`, `toppic:`, `topindex:` keys the 1.8 node
uses, so a run config can be pointed at either node by changing the binding:

```yaml
nodes:
  toppic21: /srv/tdease/nodes/toppic21
fasta: database.fasta
topfd:
  activation: FILE
  max_charge: 30
  ms1_envcnn_cutoff: 0      # optional, -f
  ms2_envcnn_cutoff: 0      # optional, -g
  msdeconv: false           # legacy shorthand -> -p msdeconv -q msdeconv
toppic:
  mass_error_tolerance: 10  # fragment and precursor (-e / -E)
  proteoform_error_tolerance: 1.2   # cluster tolerance (-p)
  n_terminal_form: NONE,NME,NME_ACETYLATION,M_ACETYLATION
  rescore: false            # -q, rank PrSMs by the SVM rescore
```

The old `lookup_table` and `skip_html` knobs have no 2.1 equivalent and are
ignored; `topfd.disable_frag` now means "do not pass `-j`" (2.1 enables
fragment-number filtering with a flag, 1.8 disabled it with one).
