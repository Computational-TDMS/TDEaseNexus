/**
 * Rebuilds the bundled `tdease-ai-capability/system/reference/unimod.sqlite` from the canonical
 * `unimod.xml`. The old shipped sqlite was a lossy flat projection — its
 * `residues` and `neutral_loss` columns were empty for every record, so
 * residue-aware queries silently lied (tdease-ai-capability/system/skills/ms-reference/
 * references/reference-data.md). This importer captures the full specificity,
 * alternate-name, and neutral-loss structure that the XML actually carries, and
 * records the XML digest + schema version so a reader can prove which source a
 * database was built from.
 *
 * No dependencies — Node's built-in `node:sqlite` + a small pull SAX parser.
 * Run: `node scripts/build-unimod-database.mjs`
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const refDir = path.join(repoRoot, 'tdease-ai-capability', 'system', 'reference')
const xmlPath = path.join(refDir, 'unimod.xml')
const dbPath = path.join(refDir, 'unimod.sqlite')

export const SCHEMA_VERSION = 2

/**
 * A minimal, dependency-free XML tokenizer that walks the whole document with a
 * cursor and emits start/self-close/end tags. Regex-only parsing failed here
 * because UniMod mixes self-closing and paired specificity tags and puts the
 * release version in a root element that a naive `indexOf('>')` lands on the
 * `<?xml?>` prolog of. A cursor tokenizer handles both shapes uniformly and
 * reads the real root attributes.
 */
export function parseUnimodXml(xml) {
  const elements = []
  const aminoAcids = []
  const mods = []
  let release = { majorVersion: null, minorVersion: null }

  // Stack-based walk. `tag()` finds the next tag from `pos`, classifying it as
  // self-closing `<x .../>`, paired-open `<x ...>`, or close `</x>`.
  let pos = 0
  const rootEl = findElement(xml, 'umod:unimod', pos)
  if (rootEl) {
    const attrs = parseAttrs(rootEl.attrs)
    release = {
      majorVersion: attrs.majorVersion ? Number(attrs.majorVersion) : null,
      minorVersion: attrs.minorVersion ? Number(attrs.minorVersion) : null,
    }
  }

  // Section elements (self-closing, flat).
  for (const found of findAllElements(xml, 'umod:elem')) elements.push(parseAttrs(found.attrs))
  for (const found of findAllElements(xml, 'umod:aa')) aminoAcids.push(parseAttrs(found.attrs))

  // Modifications: paired <umod:mod>...</umod:mod>, scanned left to right.
  for (const modEl of findAllElements(xml, 'umod:mod')) {
    const attrs = parseAttrs(modEl.attrs)
    const specificities = []
    const altNames = []
    let delta = null
    // Specificities may be self-closing OR paired (carrying neutral losses).
    for (const spec of findAllElements(modEl.inner, 'umod:specificity')) {
      const neutralLosses = []
      for (const nl of findAllElements(spec.inner, 'umod:neutralLoss')) {
        neutralLosses.push(parseAttrs(nl.attrs))
      }
      const a = parseAttrs(spec.attrs)
      specificities.push({
        site: a.site ?? '',
        position: a.position ?? '',
        classification: a.classification ?? '',
        specGroupId: a.spec_group ? Number(a.spec_group) : null,
        hidden: a.hidden === '1',
        neutralLosses,
      })
    }
    const deltaEl = findAllElements(modEl.inner, 'umod:delta')[0]
    if (deltaEl) delta = parseAttrs(deltaEl.attrs)
    for (const alt of findAllElements(modEl.inner, 'umod:alt_name')) {
      const text = stripTags(alt.inner).trim()
      if (text) altNames.push(text)
    }
    mods.push({
      recordId: attrs.record_id ? Number(attrs.record_id) : NaN,
      title: attrs.title ?? '',
      fullName: attrs.full_name ?? '',
      approved: attrs.approved === '1',
      usernameOfPoster: attrs.username_of_poster ?? '',
      groupOfPoster: attrs.group_of_poster ?? '',
      dateTimePosted: attrs.date_time_posted ?? '',
      dateTimeModified: attrs.date_time_modified ?? '',
      specificities,
      altNames,
      delta,
    })
  }

  return { release, elements, aminoAcids, mods }
}

function parseAttrs(text) {
  const out = {}
  for (const m of text.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2]
  return out
}

function stripTags(text) {
  return text.replace(/<[^>]*>/g, '')
}

/** First occurrence of a named element, returning its raw attrs string. */
function findElement(xml, name, from) {
  const open = new RegExp(`<${escapeRegex(name)}\\b([^>]*)>`)
  const self = new RegExp(`<${escapeRegex(name)}\\b([^/>]*)/>`)
  const selfAt = self.exec(xml.slice(from))
  const openAt = open.exec(xml.slice(from))
  if (selfAt && (!openAt || selfAt.index <= openAt.index)) {
    return { attrs: selfAt[1], selfClosing: true }
  }
  return openAt ? { attrs: openAt[1], selfClosing: false } : null
}

/**
 * Every element named `name`, matched correctly as either self-closing or
 * paired. A paired element's `inner` is everything up to its matching close —
 * this is what makes nested specificity/neutralLoss parsing correct.
 */
function findAllElements(xml, name) {
  const out = []
  const tagRe = new RegExp(`<${escapeRegex(name)}\\b([^>]*?)(/>|>)`, 'g')
  let m
  while ((m = tagRe.exec(xml)) !== null) {
    const attrs = m[1]
    if (m[2] === '/>') {
      out.push({ attrs, inner: '' })
      continue
    }
    // Paired: find the matching close by counting nested same-name opens.
    const closeRe = new RegExp(`</${escapeRegex(name)}>`, 'g')
    const openRe = new RegExp(`<${escapeRegex(name)}\\b`, 'g')
    let depth = 1
    let scan = tagRe.lastIndex
    let matched = false
    while (depth > 0) {
      openRe.lastIndex = scan
      closeRe.lastIndex = scan
      const nextOpen = openRe.exec(xml)
      const nextClose = closeRe.exec(xml)
      if (!nextClose) break
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++
        scan = nextOpen.index + nextOpen[0].length
      } else {
        depth--
        if (depth === 0) {
          out.push({ attrs, inner: xml.slice(tagRe.lastIndex, nextClose.index) })
          tagRe.lastIndex = nextClose.index + nextClose[0].length
          matched = true
        } else {
          scan = nextClose.index + nextClose[0].length
        }
      }
    }
    if (!matched) break
  }
  return out
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Build the schema and return a prepared insert helper. */
function openDatabase(dbPath) {
  if (existsSync(dbPath)) writeFileSync(dbPath, Buffer.alloc(0))
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE reference_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE modifications (
      record_id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      full_name TEXT NOT NULL,
      approved INTEGER NOT NULL,
      delta_mono REAL NOT NULL,
      delta_average REAL NOT NULL,
      composition TEXT NOT NULL DEFAULT '',
      username_of_poster TEXT NOT NULL DEFAULT '',
      group_of_poster TEXT NOT NULL DEFAULT '',
      date_time_posted TEXT NOT NULL DEFAULT '',
      date_time_modified TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE modification_names (
      modification_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('title','full_name','alt_name')),
      FOREIGN KEY (modification_id) REFERENCES modifications(record_id)
    );
    CREATE INDEX idx_modification_names_name ON modification_names(name);
    CREATE TABLE specificities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      modification_id INTEGER NOT NULL,
      site TEXT NOT NULL,
      position TEXT NOT NULL,
      classification TEXT NOT NULL,
      spec_group_id INTEGER,
      hidden INTEGER NOT NULL,
      FOREIGN KEY (modification_id) REFERENCES modifications(record_id)
    );
    CREATE INDEX idx_specificities_mod ON specificities(modification_id);
    CREATE TABLE neutral_losses (
      specificity_id INTEGER NOT NULL,
      mono_mass REAL NOT NULL,
      average_mass REAL NOT NULL DEFAULT 0,
      composition TEXT NOT NULL DEFAULT '',
      is_monoisotopic INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (specificity_id) REFERENCES specificities(id)
    );
    CREATE TABLE amino_acids (
      title TEXT PRIMARY KEY,
      three_letter TEXT NOT NULL DEFAULT '',
      full_name TEXT NOT NULL DEFAULT '',
      mono_mass REAL NOT NULL,
      average_mass REAL NOT NULL
    );
    CREATE TABLE elements (
      title TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      avge_mass REAL NOT NULL,
      mono_mass REAL NOT NULL
    );
  `)
  return db
}

export function buildUnimodDatabase(xmlInput, dbPath) {
  // A string is treated as XML content; a path/URL/Blob is read as a file. This
  // matters because a filesystem path is itself a string — distinguish by
  // asking whether it is an existing file rather than by typeof.
  const xml = existsSync(String(xmlInput)) ? readFileSync(xmlInput, 'utf8') : String(xmlInput)
  const digest = createHash('sha256').update(xml).digest('hex')
  const parsed = parseUnimodXml(xml)
  const db = openDatabase(dbPath)
  const insertMod = db.prepare(
    `INSERT INTO modifications (record_id,title,full_name,approved,delta_mono,delta_average,composition,
       username_of_poster,group_of_poster,date_time_posted,date_time_modified)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  )
  const insertName = db.prepare(
    `INSERT INTO modification_names (modification_id,name,kind) VALUES (?,?,?)`,
  )
  const insertSpec = db.prepare(
    `INSERT INTO specificities (modification_id,site,position,classification,spec_group_id,hidden)
     VALUES (?,?,?,?,?,?)`,
  )
  const insertNL = db.prepare(
    `INSERT INTO neutral_losses (specificity_id,mono_mass,average_mass,composition,is_monoisotopic)
     VALUES (?,?,?,?,?)`,
  )

  db.exec('BEGIN')
  let specificityCount = 0
  let neutralLossCount = 0
  for (const mod of parsed.mods) {
    const delta = mod.delta ?? {}
    insertMod.run(
      mod.recordId, mod.title, mod.fullName, mod.approved ? 1 : 0,
      Number(delta.mono_mass ?? 0), Number(delta.avge_mass ?? 0), delta.composition ?? '',
      mod.usernameOfPoster, mod.groupOfPoster, mod.dateTimePosted, mod.dateTimeModified,
    )
    insertName.run(mod.recordId, mod.title, 'title')
    if (mod.fullName) insertName.run(mod.recordId, mod.fullName, 'full_name')
    for (const alt of mod.altNames) insertName.run(mod.recordId, alt, 'alt_name')
    for (const spec of mod.specificities) {
      const res = insertSpec.run(
        mod.recordId, spec.site ?? '', spec.position ?? '', spec.classification ?? '',
        spec.specGroupId, spec.hidden ? 1 : 0,
      )
      const specId = Number(res.lastInsertRowid)
      specificityCount++
      for (const nl of spec.neutralLosses) {
        insertNL.run(
          specId, Number(nl.mono_mass ?? 0), Number(nl.avge_mass ?? 0), nl.composition ?? '',
          nl.is_monoisotopic === '0' ? 0 : 1,
        )
        neutralLossCount++
      }
    }
  }
  const insertAA = db.prepare(
    `INSERT INTO amino_acids (title,three_letter,full_name,mono_mass,average_mass) VALUES (?,?,?,?,?)`,
  )
  for (const aa of parsed.aminoAcids) {
    insertAA.run(aa.title ?? '', aa.three_letter ?? '', aa.full_name ?? '',
      Number(aa.mono_mass ?? 0), Number(aa.avge_mass ?? 0))
  }
  const insertElem = db.prepare(
    `INSERT INTO elements (title,full_name,avge_mass,mono_mass) VALUES (?,?,?,?)`,
  )
  for (const el of parsed.elements) {
    insertElem.run(el.title ?? '', el.full_name ?? '', Number(el.avge_mass ?? 0), Number(el.mono_mass ?? 0))
  }

  const meta = db.prepare(`INSERT INTO reference_metadata (key,value) VALUES (?,?)`)
  meta.run('source_file', 'unimod.xml')
  meta.run('source_sha256', digest)
  meta.run('schema_version', String(SCHEMA_VERSION))
  meta.run('unimod_release_major', String(parsed.release.majorVersion ?? ''))
  meta.run('unimod_release_minor', String(parsed.release.minorVersion ?? ''))
  meta.run('record_count', String(parsed.mods.length))
  meta.run('specificity_count', String(specificityCount))
  meta.run('neutral_loss_count', String(neutralLossCount))
  meta.run('generated_at', new Date().toISOString())
  db.exec('COMMIT')
  db.close()
  return {
    digest,
    recordCount: parsed.mods.length,
    specificityCount,
    neutralLossCount,
    elementCount: parsed.elements.length,
    aminoAcidCount: parsed.aminoAcids.length,
    release: parsed.release,
  }
}

// When run directly, rebuild the shipped database.
const isMain = (() => {
  try {
    const invoked = path.resolve(process.argv[1])
    return fileURLToPath(import.meta.url) === invoked
  } catch { return false }
})()
if (isMain) {
  if (!existsSync(xmlPath)) {
    console.error(`unimod.xml not found at ${xmlPath}`)
    process.exit(1)
  }
  const summary = buildUnimodDatabase(xmlPath, dbPath)
  console.log('Rebuilt', path.relative(repoRoot, dbPath))
  console.log(JSON.stringify(summary, null, 2))
}
