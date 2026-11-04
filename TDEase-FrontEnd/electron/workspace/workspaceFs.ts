// Workspace file-operation algorithms, extracted from main.ts.
//
// Pure Node: every function receives the workspace root/relative pair plus a
// `resolvePath` callback and owns NO registry, containment or process state of
// its own. main.ts binds `resolvePath` to the registry gatekeeper
// (`workspacePath()` in workspaceRegistry.ts) so each IPC handler stays a
// one-line delegation with byte-identical evaluation order — validation that
// used to run before the path resolution still runs first inside these
// functions, and the resolver is consulted exactly where `workspacePath()`
// used to be called.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/** Binds (root, relative) to a contained absolute path. main.ts passes the
 *  registry-checking `workspacePath()`; tests pass a plain resolver. */
export type WorkspacePathResolver = (root: string, relative?: string) => string;

// Hard ceiling for ONE whole-file read crossing the IPC boundary. A
// multi-hundred-MB blob is structured-cloned into the renderer on top of the
// parse cost — the mzML/FASTA/large-table paths all stream byte ranges
// instead, so a whole read this large is a caller bug, not a use case. The
// typed error names the streaming alternative instead of freezing or OOMing
// the app on a pathological request.
export const WHOLE_FILE_READ_LIMIT_BYTES = 256 * 1024 * 1024;

// Ceiling for ONE byte-range read. The mzML/FASTA streamers pull 4 MiB
// chunks; a range wider than this is again a caller bug (e.g. start/end
// swapped with the whole file size) and would clone a giant buffer per call.
export const RANGE_READ_LIMIT_BYTES = 64 * 1024 * 1024;

export class FileTooLargeError extends Error {
  readonly size: number;
  readonly limit: number;
  constructor(size: number, limit: number) {
    super(
      `WORKSPACE_FILE_TOO_LARGE: ${size} bytes exceeds the ${limit} byte whole-read limit — `
      + `read it through workspace:read-byte-range chunks instead`,
    );
    this.name = "FileTooLargeError";
    this.size = size;
    this.limit = limit;
  }
}

/** Whole-file read with the IPC backpressure guard: stats first, refuses a
 *  file over WHOLE_FILE_READ_LIMIT_BYTES with a typed error, and only then
 *  reads — so an oversized blob is never materialized in main memory either. */
export async function readWorkspaceFileBounded(
  filePath: string,
  limit: number = WHOLE_FILE_READ_LIMIT_BYTES,
): Promise<Buffer> {  const { size } = await fsp.stat(filePath);
  if (size > limit) throw new FileTooLargeError(size, limit);
  return fsp.readFile(filePath);
}

// Random-access byte range [start, end) — lets the mzML preview stream and
// slice a large file without ever holding it whole in the renderer.
export async function readWorkspaceByteRange(
  root: string,
  relative: string,
  start: unknown,
  end: unknown,
  resolvePath: WorkspacePathResolver,
  rangeLimit: number = RANGE_READ_LIMIT_BYTES,
): Promise<Buffer> {
  const from = Number(start);
  const to = Number(end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new Error("read-byte-range requires finite numeric start/end");
  }
  const target = resolvePath(root, relative);
  const length = Math.max(0, Math.min(Math.floor(to), (await fsp.stat(target)).size) - Math.max(0, Math.floor(from)));
  if (length > rangeLimit) {
    throw new FileTooLargeError(length, rangeLimit);
  }
  const handle = await fsp.open(target, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, Math.floor(from)));
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// Recursive listing as POSIX-relative paths. Infrastructure directories that
// belong to git, package managers or TDEase's own metadata never surface.
export async function listWorkspaceFiles(root: string, resolvePath: WorkspacePathResolver): Promise<string[]> {
  const base = resolvePath(root);
  const files: string[] = [];
  async function walk(directory: string) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", ".tdease", ".snakemake"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(path.relative(base, absolute).split(path.sep).join("/"));
    }
  }
  await walk(base);
  return files.sort();
}

// Streamed digest — the file never sits whole in memory. `workspace:sha256`
// and `result-cache:sha256` share this one implementation so both storages
// backing PublishedResultCache hash identically.
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// Move every source (by workspace-relative path) into one destination
// directory, creating it when missing. Sources are resolved lazily INSIDE the
// loop, so a bad path fails mid-way exactly like the inline handler did —
// earlier renames stay applied rather than being rolled back or pre-empted.
export async function moveWorkspaceEntries(
  root: string,
  srcRels: string[],
  destDirRel: string,
  resolvePath: WorkspacePathResolver,
): Promise<void> {
  if (!Array.isArray(srcRels) || srcRels.length === 0) return;
  const destDir = resolvePath(root, destDirRel);
  await fsp.mkdir(destDir, { recursive: true });
  for (const srcRel of srcRels) {
    const src = resolvePath(root, srcRel);
    const dest = path.join(destDir, path.basename(src));
    await fsp.rename(src, dest);
  }
}

// Copy absolute host paths INTO the workspace (basename preserved, recursive,
// overwrite on collision). Sources are host paths by contract — only the
// destination goes through the resolver.
export async function copyIntoWorkspace(
  root: string,
  absSrcPaths: string[],
  destDirRel: string,
  resolvePath: WorkspacePathResolver,
): Promise<void> {
  if (!Array.isArray(absSrcPaths) || absSrcPaths.length === 0) return;
  const destDir = resolvePath(root, destDirRel);
  await fsp.mkdir(destDir, { recursive: true });
  for (const absSrc of absSrcPaths) {
    if (!path.isAbsolute(absSrc)) throw new Error("copy-into requires absolute source path");
    const dest = path.join(destDir, path.basename(absSrc));
    await fsp.cp(absSrc, dest, { recursive: true, force: true });
  }
}
