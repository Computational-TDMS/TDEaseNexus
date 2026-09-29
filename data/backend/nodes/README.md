# Node packages (local deployment root)

This tree is **git-ignored by default** (`data/backend/*`): binaries stay out
of git, while the node definition layer (`rules.smk` / `README.md`, including
`_template/`) is tracked through explicit exceptions. Inventory, provenance,
usage and redeploy procedure live in the tracked document
[`docs/NODES.md`](../../../docs/NODES.md); current deployment state is recorded
in [`docs/STATUS.md`](../../../docs/STATUS.md).

If this directory is lost or partially deleted, do not guess: redeploy from
the source paths listed in `docs/NODES.md` § Provenance and re-verify file
counts and key executables before running any workflow.

## Adding a node

Every directory here containing a `rules.smk` is a node package — the
directory name is the node id, and its content digest pins the node at bind
time. To wrap a tool that is already installed on the machine, copy
`_template/` to `<your-id>/` and follow its README. Names starting with `_`
are templates/drafts and are skipped by the catalog scanner.
