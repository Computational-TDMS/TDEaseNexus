#!/usr/bin/env python3
"""Fetch one file from a PRIDE Archive project.

Standard library only, so the node has no environment to provision.

The file is the result; the sidecar next to it is what lets a later conclusion
cite where the file came from without anyone remembering. Both are written
atomically: a partial download is never left at the output path, because in a
filesystem-as-truth pipeline a truncated file reads as a completed step.

    fetch.py --accession PXD014660 --file Sorghum-Histone0810162L01.raw \
             --out raw/Sorghum-Histone0810162L01.raw

Prints one JSON object on stdout.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# PRIDE's v2 file endpoints answer 200 with an empty body; v3 is the one that
# returns records. Checked 2026-07-26.
API = "https://www.ebi.ac.uk/pride/ws/archive/v3/projects/{accession}/files"
USER_AGENT = "TDEase-pride-node/1 (+https://tdease.dev)"
CHUNK = 1 << 20


def _get_json(url: str, timeout: int) -> object:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _records(payload: object) -> list[dict]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        embedded = payload.get("_embedded")
        if isinstance(embedded, dict) and isinstance(embedded.get("files"), list):
            return [item for item in embedded["files"] if isinstance(item, dict)]
        if isinstance(payload.get("content"), list):
            return [item for item in payload["content"] if isinstance(item, dict)]
    return []


def _https_location(record: dict) -> str | None:
    """PRIDE advertises ftp:// and Aspera. The FTP host also serves HTTPS."""
    for location in record.get("publicFileLocations") or []:
        value = location.get("value") or ""
        if value.startswith("https://"):
            return value
    for location in record.get("publicFileLocations") or []:
        value = location.get("value") or ""
        if value.startswith("ftp://ftp.pride.ebi.ac.uk/"):
            return "https://" + value[len("ftp://"):]
    return None


def _download(url: str, dest: Path, expected: int | None, timeout: int) -> tuple[int, str]:
    dest.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    written = 0
    started = time.monotonic()
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})

    handle, tmp_name = tempfile.mkstemp(dir=str(dest.parent), prefix=".pride-", suffix=".part")
    os.close(handle)
    tmp = Path(tmp_name)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response, tmp.open("wb") as out:
            while True:
                block = response.read(CHUNK)
                if not block:
                    break
                out.write(block)
                digest.update(block)
                written += len(block)
                if expected:
                    print(
                        f"\r  {written / 1e6:8.1f} / {expected / 1e6:.1f} MB",
                        end="",
                        file=sys.stderr,
                        flush=True,
                    )
        if expected is not None and written != expected:
            raise RuntimeError(
                f"size mismatch: server sent {written} bytes, PRIDE records {expected}"
            )
        shutil.move(str(tmp), str(dest))
    finally:
        if tmp.exists():
            tmp.unlink()
    if expected:
        print(f"  in {time.monotonic() - started:.0f}s", file=sys.stderr)
    return written, digest.hexdigest()


def _portable_path(dest: Path) -> str:
    """Relative to cwd when possible; the absolute path otherwise."""
    try:
        return dest.resolve().relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return dest.as_posix()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accession", required=True, help="PRIDE project, e.g. PXD014660")
    parser.add_argument("--file", required=True, help="Exact file name within the project")
    parser.add_argument("--out", required=True, help="Destination path")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--page-size", type=int, default=500)
    parser.add_argument(
        "--no-sidecar",
        action="store_true",
        help="Skip writing <out>.source.json",
    )
    args = parser.parse_args()

    dest = Path(args.out)
    url = f"{API.format(accession=args.accession)}?pageSize={args.page_size}"
    try:
        records = _records(_get_json(url, args.timeout))
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        print(json.dumps({"error": "PRIDE_QUERY_FAILED", "accession": args.accession,
                          "message": str(error)}), file=sys.stdout)
        return 1

    if not records:
        print(json.dumps({"error": "PRIDE_PROJECT_EMPTY", "accession": args.accession,
                          "message": "the project listing returned no files"}))
        return 1

    match = next((r for r in records if r.get("fileName") == args.file), None)
    if match is None:
        near = [r.get("fileName") for r in records if args.file.lower() in str(r.get("fileName")).lower()]
        print(json.dumps({
            "error": "PRIDE_FILE_NOT_FOUND",
            "accession": args.accession,
            "requested": args.file,
            "available_count": len(records),
            "similar": near[:10],
            "message": "no file in the project has that exact name",
        }))
        return 1

    source = _https_location(match)
    if not source:
        print(json.dumps({"error": "PRIDE_NO_HTTPS_LOCATION", "requested": args.file,
                          "message": "the record advertises no HTTPS or PRIDE FTP location"}))
        return 1

    expected = match.get("fileSizeBytes")
    expected = int(expected) if isinstance(expected, (int, float)) else None
    print(f"pride: {args.accession}/{args.file}", file=sys.stderr)
    try:
        size, sha256 = _download(source, dest, expected, args.timeout)
    except (urllib.error.URLError, TimeoutError, RuntimeError, OSError) as error:
        print(json.dumps({"error": "PRIDE_DOWNLOAD_FAILED", "requested": args.file,
                          "source": source, "message": str(error)}))
        return 1

    record = {
        "accession": args.accession,
        "file": args.file,
        # Workspace-relative when the destination is inside the working tree.
        # An absolute path in a provenance record stops being true the moment
        # the Workspace is moved, copied or opened on another machine, and the
        # whole point of the sidecar is that it survives that.
        "path": _portable_path(dest),
        "source": source,
        "bytes": size,
        "sha256": sha256,
        "retrieved_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "api": url,
    }
    if not args.no_sidecar:
        sidecar = dest.with_suffix(dest.suffix + ".source.json")
        sidecar.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        record["sidecar"] = str(sidecar)

    print(json.dumps(record, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
