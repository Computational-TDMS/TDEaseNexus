# pride

Fetch declared files from a [PRIDE Archive](https://www.ebi.ac.uk/pride/)
(ProteomeXchange) project by accession.

Standard library only — no environment to provision.

> **Calibrated against `python fetch.py` argparse (2026-07-27)**. Every
> documented parameter is wired in `rules.smk`, the Node's only contract.

## Layout

```
pride/
  fetch.py      # stdlib downloader, one JSON object on stdout
  rules.smk     # rule pride_fetch
  README.md
```

## Parameters

| param      | default | type | description                                  |
|------------|---------|------|----------------------------------------------|
| accession  | —       | str  | PRIDE project, e.g. `PXD014660` (required)   |
| files      | —       | list | Exact file names to fetch (required)         |
| dest       | `raw`   | str  | Workspace-relative destination directory (rules.smk only; not a fetch.py flag) |
| timeout    | 120     | int  | Per-request timeout, seconds (`--timeout`)   |
| page_size  | 500     | int  | PRIDE v3 page size for the file listing (`--page-size`); raise only if a project lists more files than one page returns |
| no_sidecar | false   | bool | Skip `<file>.source.json` (`--no-sidecar`)   |

`dest` is a rules.smk-level concept baked into the output path; `fetch.py`
itself takes `--out <path>`. The other three map 1:1 to fetch.py flags.

## Example config.yaml

```yaml
pride:
  accession: PXD014660
  dest: raw
  files:
    - Sorghum-Histone0810162L01.raw
    - Sorghum-Histone0810162L01_IcTsv.zip
```

Then depend on `raw/Sorghum-Histone0810162L01.raw` from any downstream rule —
msconvert will pick it up as `{prefix}.raw` and produce the mzML.

## Direct use

```bash
python fetch.py --accession PXD014660 \
                --file Sorghum-Histone0810162L01.raw \
                --out raw/Sorghum-Histone0810162L01.raw
```

## Why `files` must be declared

The rule's wildcard is constrained to exactly the listed names. Without that,
Snakemake would offer to satisfy *any* missing file under `dest` by asking
PRIDE for it, and a typo in a downstream rule would become a download attempt
rather than an error. Declaring the files is what keeps a missing-file error a
missing-file error.

With no `files` declared the constraint is `$^`, which matches nothing, so an
unused node is inert rather than greedy.

## What it verifies, and what it does not

- **Byte count** is checked against the PRIDE record; a mismatch fails the rule.
- **Atomic landing** — the transfer goes to a temporary path in the same
  directory and is moved into place on success. A truncated raw file is still a
  file, and every downstream rule would read the step as complete.
- **SHA-256** is computed during the transfer and written to the sidecar.
- PRIDE does **not** publish per-file checksums, so the digest records what was
  received; it is not an independent integrity check against the submitter's
  original.

## The sidecar

`<file>.source.json` next to each fetched file:

```json
{
  "accession": "PXD014660",
  "file": "Sorghum-Histone0810162L01.raw",
  "path": "raw/Sorghum-Histone0810162L01.raw",
  "source": "https://ftp.pride.ebi.ac.uk/pride/data/archive/2019/10/PXD014660/...",
  "bytes": 1039253504,
  "sha256": "…",
  "retrieved_at": "2026-07-26T15:00:00Z",
  "api": "https://www.ebi.ac.uk/pride/ws/archive/v3/projects/PXD014660/files?pageSize=500"
}
```

This is what lets a conclusion cite where a measurement came from without
anyone having to remember. Keep it beside the file.

## API note

PRIDE's **v2** file endpoints answer HTTP 200 with an empty body. `fetch.py`
uses **v3**:

```
https://www.ebi.ac.uk/pride/ws/archive/v3/projects/{accession}/files?pageSize=500
```

Records advertise `ftp://` and Aspera locations; the same host serves HTTPS, so
`fetch.py` rewrites the FTP URL rather than requiring an FTP client.

Checked 2026-07-26.

## Sibling archives

MassIVE (`MSV…`), jPOST and iProX are different APIs. Add a sibling node rather
than widening this one, so each keeps one host and one failure mode.

## Errors

Structured codes on stdout, non-zero exit:

| code                     | meaning                                        |
|--------------------------|------------------------------------------------|
| `PRIDE_QUERY_FAILED`     | project listing unreachable or unparseable     |
| `PRIDE_PROJECT_EMPTY`    | listing returned no files                      |
| `PRIDE_FILE_NOT_FOUND`   | no exact name match (reports similar names)    |
| `PRIDE_NO_HTTPS_LOCATION`| record advertises no HTTPS or PRIDE FTP URL    |
| `PRIDE_DOWNLOAD_FAILED`  | transfer or byte-count verification failed     |
