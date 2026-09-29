# topindex

TopIndex is the database-indexing stage of the deployed TopPIC 1.8.0 suite.
It turns one FASTA file into the adjacent `<fasta>_idx/` directory before any
sample-level TopPIC search starts.

This is a separate Node because the index belongs to the Run-wide protein
database, while TopPIC jobs belong to individual samples. With the dependency
made explicit, Snakemake schedules one `topindex` job and then fans out to all
sample-level `toppic` jobs. TopPIC is no longer allowed to race while implicitly
creating the same directory from several processes.

## Runtime asset

The executable is part of the server's deployed `toppic` runtime suite and is
resolved as `nodes/toppic/topindex.exe` relative to the Run root. A workflow
using this Node binds both `topindex` and `toppic`, so the runtime suite and
this rule contract are both pinned by Backend Node digests.

## Contract

- Input: the Run's configured FASTA (`config.fasta`, default `database.fasta`).
- Native output: `<fasta>_idx/`.
- Declared completion output: `.tdease/topindex/<fasta>.complete`.
- Shared parameters: `toppic.fixed_mod`, `toppic.n_terminal_form`,
  `toppic.decoy`, and `toppic.mass_error_tolerance`.
- Node-only escape hatch: `topindex.extra`.

The completion marker is written only after `topindex.exe` exits successfully.
TopPIC consumes that marker as a normal Snakemake input, so filesystem state
remains the execution authority.

If a previous attempt stopped before writing the marker, the next attempt
removes the incomplete `<fasta>_idx/` and rebuilds it. The cleanup is scoped to
the Backend Run snapshot and never touches the Client Workspace FASTA.
