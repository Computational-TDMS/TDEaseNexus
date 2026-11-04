# `_template` — copy this folder to add a node

A node is a directory under the node root (`<dataRoot>/nodes/<id>/`) whose
`rules.smk` declares its rules. Nothing else is required: no manifest, no
registry, no restart. Rename a copy to your tool's id and it is live on the
next catalog scan.

This template is for a tool that is **installed on the machine**, called from
its install directory. That is the alternative to the bundled nodes: the tool
stays where its vendor put it (installer, site licence, too large to ship), and
the node documents how to call it. `msconvert` shows the same pattern at the
other end of the range — it ships its binary *and* accepts a `bin_dir`
override in the Run config.

## Make a node in three edits

1. `cp -r _template ../mytool` (or copy the folder in Explorer), then rename
   the directory — the directory name **is** the node id.
2. In `rules.smk`: set `NODE_ID = "mytool"`, `EXE_NAME`, and `DEFAULT_BIN_DIR`
   to the tool's install directory, and rename `rule mytool` to the capability
   name you want the catalog to show.
3. Set the rule's `input` / `output` / `shell` to the tool's real contract.

Then point the Run config at a different install when needed, without editing
the node:

```yaml
mytool:
  bin_dir: 'D:\Other Install'
```

Single-quote Windows paths in YAML. A double-quoted `"C:\Users\..."` is an
invalid escape (`\U`) and the Run's config fails to load.

The Run's log records the command line that ran, so the binary — and the
parameters — are part of the result's provenance.

## Why `_template` does not appear in the catalog

The catalog treats every directory under the node root as a node package, so
names starting with `_` are reserved for templates and drafts and are skipped.
A copy under a normal name (`mytool`) is scanned; `_mytool` is not.

## Rules that keep nodes portable

- Resolve the binary from `bin_dir` first, the machine default second — never
  hard-code a path the Run config cannot override. Bundled nodes use the same
  key: `<tool>.bin_dir` replaces the directory their executables resolve from.
- Reference the node's own files **relative to the Run root** (the shell's
  working directory), never by absolute path: the same package must behave the
  same in the dev tree and in an installed app.
- Write outputs where the rule's `output:` says and nothing else; the Run's
  provenance and reuse checks read that contract.
