// Checks what build.mjs wrote against the library store, reading only the finished files. Exits non-zero on any difference.// usage: node tools/verify.mjs <path to the source's public/ folder>
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { userInfo } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"

const publicRoot = process.argv[2]
if (!publicRoot) throw new Error("usage: verify.mjs <public folder>")
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const library = path.join(publicRoot, "library")
const sha256 = (data) => createHash("sha256").update(data).digest("hex")
const json = (file) => JSON.parse(readFileSync(file, "utf8"))
const faults = []
const fault = (message) => { if (faults.push(message) <= 20) console.error(message) }

const listing = json(path.join(here, "catalogue.json"))
const packed = readFileSync(path.join(here, listing.database.path))
if (sha256(packed) !== listing.database.sha256 || packed.length !== listing.database.bytes) fault("catalogue.json disagrees with the database file")
if (packed.length >= 100_000_000) fault("the compressed database is over GitHub's 100 MB limit")
const unpacked = gunzipSync(packed)
if (sha256(unpacked) !== listing.database.unpackedSha256) fault("the compressed database does not unpack to the recorded file")
const rawFile = path.join(here, "ecclesia-texts.sqlite")
if (sha256(readFileSync(rawFile)) !== listing.database.unpackedSha256) fault("the local database is not the one that was compressed")

const database = new DatabaseSync(rawFile, { readOnly: true })
const integrity = database.prepare("PRAGMA integrity_check").get().integrity_check
if (integrity !== "ok") fault(`SQLite integrity: ${integrity}`)
const segmentsOf = database.prepare("SELECT division, position, ref, text FROM segments WHERE edition_id = ? ORDER BY division, position")
const editionOf = database.prepare("SELECT * FROM editions WHERE id = ?")

const cleared = new Map()
for (const work of json(path.join(library, "catalogue.json")).works) for (const edition of [work.original, work.english]) if (edition) cleared.set(`${work.id}/${edition.id}`, { work, edition })

let editions = 0, segments = 0, characters = 0
const seenTexts = new Set()
for (const entry of readdirSync(library, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const manifest = json(path.join(library, entry.name, "manifest.json"))
  for (const edition of manifest.editions) {
    editions += 1
    const label = `${manifest.workId}/${edition.editionId}`
    const clear = cleared.get(label)
    if (!clear || ["copyright_unverified", "copyright_restricted"].includes(clear.work.status) || !clear.edition.verified || !clear.edition.usPublicDomain) fault(`${label}: not cleared by the catalogue`)
    const row = editionOf.get(edition.editionId)
    if (!row) { fault(`${label}: not in the database`); continue }
    if (row.credit !== edition.credit || row.licence !== edition.licence || !row.credit || !row.licence) fault(`${label}: credit or licence differs`)
    const file = readFileSync(path.join(here, row.txt_path))
    seenTexts.add(row.txt_path)
    if (sha256(file) !== row.txt_sha256) fault(`${label}: text file hash differs`)
    const text = file.toString("utf8")
    if (!text.includes(`Credit: ${edition.credit}\n`) || !text.includes(`Licence: ${edition.licence}`)) fault(`${label}: the text file lacks its credit or licence`)
    const rows = segmentsOf.all(edition.editionId)
    let at = 0, cursor = text.indexOf("=".repeat(72))
    edition.divisions.forEach((division, position) => {
      const source = json(path.join(library, manifest.workId, edition.editionId, division.file))
      source.segments.forEach((segment, index) => {
        const stored = rows[at++]
        if (!stored || stored.division !== position || stored.position !== index || stored.ref !== segment.ref || stored.text !== segment.text) fault(`${label} ${segment.ref}: database differs from the store`)
        const line = `[${segment.ref}] ${segment.text}\n`
        const found = text.indexOf(line, cursor)
        if (found < 0) fault(`${label} ${segment.ref}: not found in order in the text file`)
        else cursor = found + line.length
        segments += 1; characters += segment.text.length
      })
    })
    if (rows.length !== at) fault(`${label}: database has ${rows.length} segments, the store ${at}`)
  }
}
const totals = database.prepare("SELECT (SELECT count(*) FROM editions) editions, (SELECT count(*) FROM segments) segments").get()
if (totals.editions !== editions || totals.segments !== segments) fault(`database totals ${totals.editions}/${totals.segments} against store ${editions}/${segments}`)
const blocked = database.prepare("SELECT count(*) n FROM editions e JOIN works w ON w.id = e.work_id WHERE w.status IN ('copyright_unverified','copyright_restricted')").get().n
if (blocked) fault(`${blocked} editions of blocked works are in the database`)

const walk = (dir, out = []) => { for (const item of readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, item.name); if (item.isDirectory()) { if (item.name !== ".git" && item.name !== "node_modules") walk(full, out) } else out.push(full) } return out }
const allTexts = walk(path.join(here, "texts")).map((file) => path.relative(here, file).replaceAll("\\", "/"))
for (const file of allTexts) if (!seenTexts.has(file)) fault(`${file}: a text file the store does not account for`)
for (const item of listing.works) for (const edition of item.editions) if (statSync(path.join(here, edition.path)).size !== edition.bytes) fault(`${edition.path}: size differs from catalogue.json`)

// Nothing of this PC in what would be published. VERIFY_ALSO names anything further to look for, so it need not be written here.
const LOCAL = new RegExp(["C:[\\\\/]+Users", userInfo().username, process.env.VERIFY_ALSO].filter(Boolean).join("|"), "i")
let local = 0
for (const file of walk(here)) { if (file.endsWith(".sqlite") || file.endsWith(".gz")) continue; if (LOCAL.test(readFileSync(file, "utf8"))) { local += 1; fault(`${path.relative(here, file)}: names this PC or an address`) } }
if (LOCAL.test(unpacked.toString("latin1"))) fault("the database names this PC or an address")

database.close()
console.log(JSON.stringify({ editions, segments, characters, textFiles: allTexts.length, sqliteIntegrity: integrity, filesNamingThisPC: local, faults: faults.length }))
process.exit(faults.length ? 1 : 0)
