/**
 * The mutable local UniProt store (`<systemRoot>/reference/uniprot.sqlite`).
 *
 * Two tables carry the truth:
 *   - `remote_snapshots` — immutable, content-addressed by digest. Every fetch
 *     is recorded here exactly once; nothing the remote said is ever mutated or
 *     deleted by a re-fetch, so provenance is stable and a pinned snapshot can
 *     always be re-read.
 *   - `entries` — a rebuildable projection keyed by resource+id, pointing at the
 *     snapshot that backs it and caching the fields a read needs.
 *
 * The read-through layer (`uniprot-read-through.ts`) decides freshness and
 * whether to fetch; this module only persists and retrieves.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

export interface StoredSnapshot {
  digest: string
  resource: string
  requestId: string
  release: string | null
  retrievedAt: string
  etag: string | null
  lastModified: string | null
  mediaType: string
  payload: string
}

export interface StoredEntry {
  resource: string
  primaryId: string
  snapshotDigest: string
  reviewed: boolean | null
  organismId: string | null
  projectedAt: string
  release: string | null
}

export class UniprotStore {
  private readonly db
  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS schema_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS remote_snapshots (
        digest TEXT PRIMARY KEY,
        resource TEXT NOT NULL,
        request_id TEXT NOT NULL,
        authority TEXT NOT NULL DEFAULT 'uniprot.org',
        release TEXT,
        retrieved_at TEXT NOT NULL,
        etag TEXT,
        last_modified TEXT,
        media_type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        resource TEXT NOT NULL,
        primary_id TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL,
        reviewed INTEGER,
        organism_id TEXT,
        sequence_digest TEXT,
        normalized_json TEXT,
        projected_at TEXT NOT NULL,
        release TEXT,
        PRIMARY KEY (resource, primary_id),
        FOREIGN KEY (snapshot_digest) REFERENCES remote_snapshots(digest)
      );
      CREATE TABLE IF NOT EXISTS query_coverage (
        query_key TEXT PRIMARY KEY,
        resource TEXT NOT NULL,
        snapshot_digest TEXT,
        completed INTEGER NOT NULL DEFAULT 0,
        cursor_exhausted INTEGER NOT NULL DEFAULT 0,
        retrieved_at TEXT NOT NULL,
        release TEXT
      );
      CREATE TABLE IF NOT EXISTS user_assertions (
        id TEXT PRIMARY KEY,
        resource TEXT NOT NULL,
        primary_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        value TEXT NOT NULL,
        verdict TEXT NOT NULL,
        evidence_refs TEXT,
        based_on_snapshot TEXT,
        asserted_by TEXT,
        asserted_at TEXT NOT NULL,
        revised_at TEXT,
        comment TEXT,
        retracted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_assertions_entry ON user_assertions(resource, primary_id);
    `)
    this.migrateAssertionColumns()
  }

  private migrateAssertionColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(user_assertions)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'revised_at')) {
      this.db.exec('ALTER TABLE user_assertions ADD COLUMN revised_at TEXT')
    }
  }

  saveSnapshot(snapshot: Omit<StoredSnapshot, never>): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO remote_snapshots
        (digest, resource, request_id, authority, release, retrieved_at, etag, last_modified, media_type, payload)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      snapshot.digest, snapshot.resource, snapshot.requestId, 'uniprot.org',
      snapshot.release, snapshot.retrievedAt, snapshot.etag, snapshot.lastModified,
      snapshot.mediaType, snapshot.payload,
    )
  }

  getSnapshot(digest: string): StoredSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM remote_snapshots WHERE digest = ?').get(digest) as SnapshotRow | undefined
    return row ? toSnapshot(row) : undefined
  }

  saveEntry(entry: StoredEntry): void {
    this.db.prepare(
      `INSERT INTO entries
        (resource, primary_id, snapshot_digest, reviewed, organism_id, projected_at, release)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(resource, primary_id) DO UPDATE SET
         snapshot_digest=excluded.snapshot_digest,
         reviewed=excluded.reviewed,
         organism_id=excluded.organism_id,
         projected_at=excluded.projected_at,
         release=excluded.release`,
    ).run(
      entry.resource, entry.primaryId, entry.snapshotDigest,
      entry.reviewed === null ? null : entry.reviewed ? 1 : 0,
      entry.organismId, entry.projectedAt, entry.release,
    )
  }

  getEntry(resource: string, primaryId: string): StoredEntry | undefined {
    const row = this.db.prepare(
      'SELECT resource, primary_id, snapshot_digest, reviewed, organism_id, projected_at, release FROM entries WHERE resource = ? AND primary_id = ?',
    ).get(resource, primaryId) as EntryRow | undefined
    return row ? toEntry(row) : undefined
  }

  /** Insert a new note. Idempotent on id (re-inserting the same id is a no-op). */
  saveNote(note: StoredNote): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO user_assertions
        (id, resource, primary_id, subject, predicate, value, verdict, evidence_refs,
         based_on_snapshot, asserted_by, asserted_at, revised_at, comment, retracted)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?,0)`,
    ).run(
      note.id, note.resource, note.primaryId, note.subject,
      note.predicate, note.value, note.verdict,
      note.evidenceRefs ? JSON.stringify(note.evidenceRefs) : null,
      note.basedOnSnapshot ?? null, note.assertedBy ?? null,
      note.assertedAt, note.comment ?? null,
    )
  }

  /**
   * Revise a note: any combination of update value/verdict, replace or append
   * evidence, set comment, or retract. One entry point for everything that
   * happens to a note *after* it is created, because scientific knowledge
   * evolves — "I found more evidence", "I was wrong, retract", and "sharper
   * value now" are all the same act of revision, not three commands.
   *
   * `appendEvidence` (default true) adds to existing refs; false replaces.
   */
  reviseNote(id: string, revision: NoteRevision): { revised: boolean; note?: StoredNote } {
    const existing = this.noteById(id)
    if (!existing) return { revised: false }
    const sets: string[] = []
    const params: Array<string | number | null> = []
    if (revision.value !== undefined) { sets.push('value = ?'); params.push(revision.value) }
    if (revision.verdict !== undefined) { sets.push('verdict = ?'); params.push(revision.verdict) }
    if (revision.comment !== undefined) { sets.push('comment = ?'); params.push(revision.comment) }
    if (revision.evidenceRefs !== undefined) {
      const merged = revision.appendEvidence === false
        ? [...revision.evidenceRefs]
        : [...new Set([...(existing.evidenceRefs ?? []), ...revision.evidenceRefs])]
      sets.push('evidence_refs = ?'); params.push(merged.length ? JSON.stringify(merged) : null)
    }
    if (revision.retracted === true) { sets.push('retracted = 1') }
    sets.push('revised_at = ?'); params.push(new Date().toISOString())
    params.push(id)
    this.db.prepare(`UPDATE user_assertions SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    return { revised: true, note: this.noteById(id) }
  }

  noteById(id: string): StoredNote | undefined {
    const row = this.db.prepare(
      'SELECT id, resource, primary_id, subject, predicate, value, verdict, evidence_refs, based_on_snapshot, asserted_by, asserted_at, revised_at, comment, retracted FROM user_assertions WHERE id = ?',
    ).get(id) as unknown as AssertionRow | undefined
    return row ? toAssertion(row) : undefined
  }

  notesFor(resource: string, primaryId: string): StoredNote[] {
    const rows = this.db.prepare(
      'SELECT id, resource, primary_id, subject, predicate, value, verdict, evidence_refs, based_on_snapshot, asserted_by, asserted_at, revised_at, comment, retracted FROM user_assertions WHERE resource = ? AND primary_id = ? AND retracted = 0',
    ).all(resource, primaryId) as unknown as AssertionRow[]
    return rows.map(toAssertion)
  }

  /**
   * Record that a set query is fully cached locally. Without this, a reader can
   * never tell "12 results" from "only the first 12 were ever fetched" — the
   * whole point of `query_coverage` is making that distinction answerable.
   */
  saveQueryCoverage(queryKey: string, resource: string, snapshotDigest: string | null, completed: boolean, cursorExhausted: boolean, release: string | null): void {
    this.db.prepare(
      `INSERT INTO query_coverage (query_key, resource, snapshot_digest, completed, cursor_exhausted, retrieved_at, release)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(query_key) DO UPDATE SET
         resource=excluded.resource,
         snapshot_digest=excluded.snapshot_digest,
         completed=excluded.completed,
         cursor_exhausted=excluded.cursor_exhausted,
         retrieved_at=excluded.retrieved_at,
         release=excluded.release`,
    ).run(queryKey, resource, snapshotDigest, completed ? 1 : 0, cursorExhausted ? 1 : 0, new Date().toISOString(), release)
  }

  getQueryCoverage(queryKey: string): { resource: string; snapshotDigest: string | null; completed: boolean; cursorExhausted: boolean; retrievedAt: string; release: string | null } | undefined {
    const row = this.db.prepare(
      'SELECT resource, snapshot_digest, completed, cursor_exhausted, retrieved_at, release FROM query_coverage WHERE query_key = ?',
    ).get(queryKey) as {
      resource: string; snapshot_digest: string | null
      completed: number; cursor_exhausted: number; retrieved_at: string; release: string | null
    } | undefined
    if (!row) return undefined
    return {
      resource: row.resource,
      snapshotDigest: row.snapshot_digest,
      completed: row.completed === 1,
      cursorExhausted: row.cursor_exhausted === 1,
      retrievedAt: row.retrieved_at,
      release: row.release,
    }
  }

  close(): void {
    try { this.db.close() } catch { /* already closed */ }
  }
}

interface SnapshotRow {
  digest: string; resource: string; request_id: string; release: string | null
  retrieved_at: string; etag: string | null; last_modified: string | null
  media_type: string; payload: string
}
interface EntryRow {
  resource: string; primary_id: string; snapshot_digest: string
  reviewed: number | null; organism_id: string | null; projected_at: string; release: string | null
}
interface AssertionRow {
  id: string; resource: string; primary_id: string; subject: string; predicate: string
  value: string; verdict: string; evidence_refs: string | null; based_on_snapshot: string | null
  asserted_by: string | null; asserted_at: string; revised_at: string | null
  comment: string | null; retracted: number
}

/** A local note/annotation about a reference entry (the "assertion" overlay). */
export interface StoredNote {
  id: string
  resource: string
  primaryId: string
  subject: string
  predicate: string
  value: string
  verdict: 'confirmed' | 'rejected' | 'supplemented'
  evidenceRefs: string[] | null
  basedOnSnapshot: string | null
  assertedBy: string | null
  assertedAt: string
  /** When the note was last revised; null until the first revision. */
  revisedAt: string | null
  comment: string | null
  retracted: boolean
}

/** A partial update applied by `revise`. All fields optional; only set ones change. */
export interface NoteRevision {
  value?: string
  verdict?: 'confirmed' | 'rejected' | 'supplemented'
  evidenceRefs?: ReadonlyArray<string>
  /** Default true: append to existing evidence. false replaces it. */
  appendEvidence?: boolean
  comment?: string
  retracted?: boolean
}

function toAssertion(row: AssertionRow): StoredNote {
  return {
    id: row.id,
    resource: row.resource,
    primaryId: row.primary_id,
    subject: row.subject,
    predicate: row.predicate,
    value: row.value,
    verdict: row.verdict as 'confirmed' | 'rejected' | 'supplemented',
    evidenceRefs: row.evidence_refs ? safeParse(row.evidence_refs) : null,
    basedOnSnapshot: row.based_on_snapshot,
    assertedBy: row.asserted_by,
    assertedAt: row.asserted_at,
    revisedAt: row.revised_at,
    comment: row.comment,
    retracted: row.retracted === 1,
  }
}

function safeParse(text: string): string[] {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v.map(String) : [] } catch { return [] }
}

function toSnapshot(row: SnapshotRow): StoredSnapshot {
  return {
    digest: row.digest,
    resource: row.resource,
    requestId: row.request_id,
    release: row.release,
    retrievedAt: row.retrieved_at,
    etag: row.etag,
    lastModified: row.last_modified,
    mediaType: row.media_type,
    payload: row.payload,
  }
}

function toEntry(row: EntryRow): StoredEntry {
  return {
    resource: row.resource,
    primaryId: row.primary_id,
    snapshotDigest: row.snapshot_digest,
    reviewed: row.reviewed === null ? null : row.reviewed === 1,
    organismId: row.organism_id,
    projectedAt: row.projected_at,
    release: row.release,
  }
}

export function resolveUniprotDatabasePath(writableReferenceRoot: string): string {
  return path.join(writableReferenceRoot, 'uniprot.sqlite')
}
