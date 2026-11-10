// Builds the repository of texts from the Ecclesia library store: one plain-text file per edition, a SQLite database of
// everything, and the catalogue the download page reads. Only an edition the catalogue clears is taken; anything else stops the build.
// usage: node tools/build.mjs <path to the source's public/ folder> <source commit> <source commit date>
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

const [publicRoot, sourceCommit, sourceDate] = process.argv.slice(2)
if (!publicRoot || !sourceCommit || !sourceDate) throw new Error("usage: build.mjs <public folder> <source commit> <source commit date>")
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const library = path.join(publicRoot, "library")
const sha256 = (data) => createHash("sha256").update(data).digest("hex")
const json = (file) => JSON.parse(readFileSync(file, "utf8"))

const catalogue = json(path.join(library, "catalogue.json"))
const authors = new Map(catalogue.authors.map((author) => [author.id, author]))
const works = new Map(catalogue.works.map((work) => [work.id, work]))
const BLOCKED = new Set(["copyright_unverified", "copyright_restricted"])

// ── The rights gate: every stored edition must be cleared by the catalogue, or nothing is built. ──
const stored = []
const refused = []
// Folders of the store that are pages, not works (the Category II–IV candidates registry: names only, no texts).
const PAGES = new Set(["candidates"])
for (const entry of readdirSync(library, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  if (PAGES.has(entry.name)) {
    if (existsSync(path.join(library, entry.name, "manifest.json"))) refused.push(`${entry.name}: a page that holds a manifest.json`)
    continue
  }
  const manifest = json(path.join(library, entry.name, "manifest.json"))
  for (const edition of manifest.editions) {
    const work = works.get(manifest.workId)
    const record = work && [work.original, work.english].find((item) => item?.id === edition.editionId)
    const why = !work ? "no catalogue work" : !record ? "no catalogue edition" : BLOCKED.has(work.status) ? work.status
      : !record.verified ? "not verified" : !record.ingested ? "not ingested" : !record.usPublicDomain ? "not US public domain" : null
    if (why) refused.push(`${manifest.workId}/${edition.editionId}: ${why}`)
    else stored.push({ work, record, manifest, edition })
  }
}
if (refused.length) throw new Error(`The catalogue does not clear these editions:\n${refused.join("\n")}`)
stored.sort((a, b) => `${a.work.id}/${a.edition.editionId}`.localeCompare(`${b.work.id}/${b.edition.editionId}`))

// ── Start clean: only what this build writes. ──
const textsRoot = path.join(here, "texts")
rmSync(textsRoot, { recursive: true, force: true })
// ── The library is published as one database per part, so that no file passes GitHub's 100 MB limit for one file. ──
// Every catalogue section belongs to exactly one part; a section not named here stops the build.
const PARTS = [
  { id: "early", title: "Scripture, the Second Temple, the early Church and the Middle Ages", sections: ["S", "T", "I", "II", "III"] },
  { id: "reformation", title: "The Reformation and after", sections: ["IV", "V", "VI", "VII"] },
]
const fileOf = (part) => path.join(here, `ecclesia-texts-${part.id}.sqlite`)
for (const name of ["ecclesia-texts.sqlite", ...PARTS.map((part) => path.basename(fileOf(part)))]) {
  for (const suffix of ["", ".gz", "-journal"]) rmSync(path.join(here, name + suffix), { force: true })
}
const partOf = (section) => { const part = PARTS.find((item) => item.sections.includes(section)); if (!part) throw new Error(`section "${section}" belongs to no database part`); return part }
for (const work of catalogue.works) partOf(work.section)

// Rows are written edition by edition, children first; the links are all checked once at the end.
const value = (item) => item === undefined || item === null ? null : typeof item === "boolean" ? Number(item) : typeof item === "object" ? JSON.stringify(item) : item
for (const part of PARTS) {
  const db = new DatabaseSync(fileOf(part), { enableForeignKeyConstraints: false })
  db.exec(`
PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA page_size = 4096;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE authors (id TEXT PRIMARY KEY, name TEXT NOT NULL, dates TEXT, year INTEGER, era TEXT, kind TEXT, section TEXT);
CREATE TABLE works (id TEXT PRIMARY KEY, author_id TEXT REFERENCES authors(id), section TEXT, title TEXT NOT NULL, listed_as TEXT, kind TEXT, part_of TEXT, same_as TEXT,
  original_language TEXT, composed TEXT, status TEXT NOT NULL, status_basis TEXT, bilingual_complete INTEGER, incomplete TEXT, notes TEXT);
CREATE TABLE editions (id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), role TEXT, language TEXT, title TEXT, contained_in TEXT, editor TEXT, translator TEXT,
  publisher TEXT, place TEXT, year INTEGER, credit TEXT NOT NULL, licence TEXT NOT NULL, licence_url TEXT, attribution TEXT, us_public_domain INTEGER, life70 TEXT,
  source_url TEXT, retrieved_at TEXT, source_bytes INTEGER, source_sha256 TEXT, segment_refs TEXT, left_out TEXT, passages_left_out TEXT,
  divisions INTEGER, segments INTEGER, txt_path TEXT, txt_bytes INTEGER, txt_sha256 TEXT);
CREATE TABLE divisions (edition_id TEXT NOT NULL REFERENCES editions(id), position INTEGER NOT NULL, ref TEXT, title TEXT, PRIMARY KEY (edition_id, position)) WITHOUT ROWID;
CREATE TABLE segments (edition_id TEXT NOT NULL, division INTEGER NOT NULL, position INTEGER NOT NULL, ref TEXT, text TEXT NOT NULL,
  PRIMARY KEY (edition_id, division, position)) WITHOUT ROWID;
CREATE VIEW texts AS SELECT e.work_id, w.title AS work, a.name AS author, e.id AS edition_id, e.language, e.licence, s.division, d.title AS division_title, s.position, s.ref, s.text
  FROM segments s JOIN editions e ON e.id = s.edition_id JOIN works w ON w.id = e.work_id LEFT JOIN authors a ON a.id = w.author_id
  JOIN divisions d ON d.edition_id = s.edition_id AND d.position = s.division;
`)

  const insert = (table, count) => { const statement = db.prepare(`INSERT INTO ${table} VALUES (${Array(count).fill("?").join(",")})`); return (...row) => statement.run(...row.map(value)) }
  Object.assign(part, { db, editions: 0, segments: 0, addAuthor: insert("authors", 7), addWork: insert("works", 15), addEdition: insert("editions", 29), addDivision: insert("divisions", 4), addSegment: insert("segments", 5), addMeta: insert("meta", 2) })
  db.exec("BEGIN")
}

// Each part lists every catalogue entry of its sections, so it also says what it does NOT hold and why, and the authors of
// those entries (an author whose entries fall in both parts is in both). Only stored editions have text.
for (const part of PARTS) {
  const ids = new Set(catalogue.works.filter((work) => part.sections.includes(work.section)).map((work) => work.authorId))
  for (const a of catalogue.authors) if (ids.has(a.id) || part.sections.includes(a.section)) part.addAuthor(a.id, a.name, a.dates, a.year, a.era, a.kind, a.section)
}
for (const w of catalogue.works) partOf(w.section).addWork(w.id, w.authorId, w.section, w.title, w.listedAs, w.kind, w.partOf, w.sameAs, w.originalLanguage, w.composed, w.status, w.statusBasis, w.bilingualComplete, w.incomplete, w.notes)

const listing = new Map()
let totalSegments = 0, totalTxtBytes = 0
for (const { work, record, manifest, edition } of stored) {
  const author = authors.get(work.authorId)
  const part = partOf(work.section)
  const header = [
    `Title: ${record.title}`,
    `Work: ${work.title}`,
    author && `Author: ${author.name}${author.dates ? ` (${author.dates})` : ""}`,
    `Language: ${edition.language}`,
    `Credit: ${edition.credit}`,
    `Licence: ${edition.licence}${record.licenceUrl ? ` (${record.licenceUrl})` : ""}`,
    `Status: public domain in the United States or openly licensed, per the Ecclesia catalogue (${work.status}); life + 70 countries: ${record.life70}`,
    `Source: ${edition.sourceUrl}`,
    `Retrieved: ${edition.retrievedAt} (source file ${edition.sourceBytes} bytes, SHA-256 ${edition.sourceSha256})`,
    `Changes from the source: cut into numbered segments; these elements were not stored: ${JSON.stringify(edition.leftOut ?? {})}`,
    edition.passagesLeftOut && `Passages left out: ${edition.passagesLeftOut.segments} segments, ${edition.passagesLeftOut.words} words, each marked […]. ${edition.passagesLeftOut.reason}`,
    work.incomplete && `Incomplete: ${work.incomplete}`,
    `Ecclesia library, source ${sourceCommit}.`,
  ].filter(Boolean)
  const lines = [...header, "", "=".repeat(72), ""]
  let segments = 0
  edition.divisions.forEach((division, position) => {
    const file = json(path.join(library, manifest.workId, edition.editionId, division.file))
    if (file.segments.length !== division.segments) throw new Error(`${manifest.workId}/${edition.editionId}/${division.file}: manifest says ${division.segments} segments, the file has ${file.segments.length}`)
    part.addDivision(edition.editionId, position, division.ref, division.title)
    lines.push(`## ${division.title}`, "")
    file.segments.forEach((segment, at) => {
      part.addSegment(edition.editionId, position, at, segment.ref, segment.text)
      lines.push(`[${segment.ref}] ${segment.text}`, "")
      segments += 1
    })
  })
  const text = Buffer.from(lines.join("\n"), "utf8")
  const relative = `texts/${manifest.workId}/${edition.editionId}.txt`
  mkdirSync(path.join(here, "texts", manifest.workId), { recursive: true })
  writeFileSync(path.join(here, relative), text)
  const hash = sha256(text)
  part.addEdition(edition.editionId, manifest.workId, edition.role, edition.language, record.title, record.containedIn, record.editor, record.translator, record.publisher, record.place, record.year,
    edition.credit, edition.licence, record.licenceUrl, record.attribution, record.usPublicDomain, record.life70, edition.sourceUrl, edition.retrievedAt, edition.sourceBytes, edition.sourceSha256,
    edition.segmentRefs, edition.leftOut, edition.passagesLeftOut, edition.divisions.length, segments, relative, text.length, hash)
  totalSegments += segments; totalTxtBytes += text.length
  part.editions += 1; part.segments += segments
  if (!listing.has(work.id)) listing.set(work.id, { id: work.id, title: work.title, author: author?.name ?? "", dates: author?.dates ?? "", era: author?.era ?? "", section: work.section, database: part.id, status: work.status, incomplete: work.incomplete, editions: [] })
  listing.get(work.id).editions.push({ id: edition.editionId, role: edition.role, language: edition.language, title: record.title, year: record.year, credit: edition.credit, licence: edition.licence, licenceUrl: record.licenceUrl, life70: record.life70, divisions: edition.divisions.length, segments, leftOut: edition.passagesLeftOut ? edition.passagesLeftOut.words : 0, path: relative, bytes: text.length, sha256: hash })
}
const databases = []
for (const part of PARTS) {
  const meta = { source_commit: sourceCommit, built_from_date: sourceDate, part: part.title, sections: part.sections.join(" "), editions: part.editions, segments: part.segments, catalogue_entries: catalogue.works.filter((work) => part.sections.includes(work.section)).length }
  for (const [key, item] of Object.entries(meta)) part.addMeta(key, String(item))
  part.db.exec("COMMIT")
  const broken = part.db.prepare("PRAGMA foreign_key_check").all()
  if (broken.length) throw new Error(`${part.id}: ${broken.length} broken links, the first: ${JSON.stringify(broken[0])}`)
  part.db.exec("CREATE INDEX editions_work ON editions(work_id); CREATE INDEX works_author ON works(author_id); ANALYZE; VACUUM;")
  part.db.close()
  // The compressed file is what is published.
  const raw = readFileSync(fileOf(part))
  const packed = gzipSync(raw, { level: 9 })
  writeFileSync(`${fileOf(part)}.gz`, packed)
  databases.push({ id: part.id, title: part.title, sections: part.sections, editions: part.editions, segments: part.segments, path: `${path.basename(fileOf(part))}.gz`, bytes: packed.length, sha256: sha256(packed), unpackedBytes: raw.length, unpackedSha256: sha256(raw) })
}
writeFileSync(path.join(here, "catalogue.json"), JSON.stringify({
  source: sourceCommit, date: sourceDate,
  counts: { works: listing.size, editions: stored.length, segments: totalSegments, catalogueEntries: catalogue.works.length, withoutText: catalogue.works.length - listing.size },
  databases,
  works: [...listing.values()],
}) + "\n")
writeFileSync(path.join(here, ".nojekyll"), "")
const mib = (n) => `${(n / 1048576).toFixed(1)} MiB`
console.log(JSON.stringify({ works: listing.size, editions: stored.length, segments: totalSegments, texts: mib(totalTxtBytes), databases: databases.map((item) => `${item.id}: ${item.editions} editions, ${mib(item.unpackedBytes)}, ${mib(item.bytes)} gz`), gzOver100MB: databases.some((item) => item.bytes >= 100_000_000), largestTxt: mib(Math.max(...stored.map((item) => statSync(path.join(here, "texts", item.manifest.workId, `${item.edition.editionId}.txt`)).size))), exists: PARTS.every((part) => existsSync(fileOf(part))) }))
