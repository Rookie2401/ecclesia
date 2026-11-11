# Ecclesia Texts

Every text stored in the [Ecclesia](https://rookie2401.github.io/) theological library, kept apart from the app, free to download.

- **825 editions of 548 works**: Greek, Latin, Hebrew (with the Aramaic of the Hebrew Bible), English and Dutch.
- **Browse and download:** [the download page](https://rookie2401.github.io/ecclesia/).
- **Modern theology acquisition research:** [1900–1930 and CC-licensed 1931–2026 catalogue](https://rookie2401.github.io/ecclesia/twentieth-century.html), backed by [`twentieth-century-catalogue.json`](twentieth-century-catalogue.json). This is not yet imported into the text database.
- **One text:** `texts/<work>/<edition>.txt`. Plain UTF-8, with its credit, licence and source at the top.
- **Everything:** two SQLite databases, each complete on its own (GitHub takes no single file over 100 MB):
  - `ecclesia-texts-early.sqlite.gz`: Scripture, the Second Temple, the early Church and the Middle Ages (catalogue sections S, T, I–III; 663 editions, 50 MB to download, 239 MB unpacked).
  - `ecclesia-texts-reformation.sqlite.gz`: the Reformation and after (sections IV–VII; 162 editions, 57 MB to download, 276 MB unpacked).
- **The list:** `catalogue.json`, with each file's size and SHA-256.

## Rights

Each text keeps its own licence, stated at the top of its file and in the `editions` table. They are public domain, CC0 or CC BY-SA 4.0. CC BY-SA texts must be credited and shared alike under that licence.

Public-domain status is judged for the United States and for the specific edition. The `life70` field says whether the edition is also clear where copyright lasts for the author's life plus 70 years: `clear`, `unknown` or `not-clear`. If you are outside the United States, check that field and your own law.

Each database also lists the catalogue entries of its sections that have **no** text here (`works` with no row in `editions`). They are collections, or their rights are not yet verified, and they are not distributed.

## The text files

```
Title: …
Credit: …
Licence: …
Source: …
Changes from the source: …
========================================================================

## Division title

[1.3.1] The text of this passage.
```

Editorial notes and page breaks in the sources were not stored; each file says what was left out. Where words had to be left out of the text itself, each place is marked `[…]` and the header says so.

## The databases

Both have the same tables. Unpack one, then open it with any SQLite tool:

```
gzip -d ecclesia-texts-early.sqlite.gz
sqlite3 ecclesia-texts-early.sqlite
```

To query both at once, attach the second (`ATTACH 'ecclesia-texts-reformation.sqlite' AS reformation;`) and read its tables as `reformation.editions` and so on. An author whose works fall in both parts is listed in both.

| Table | Holds |
|---|---|
| `authors` | Name, dates, era |
| `works` | Every catalogue entry, with its rights status and the reason for it |
| `editions` | Each stored edition: credit, licence, source, SHA-256 of the source, path of its text file |
| `divisions` | The chapters of each edition, in order |
| `segments` | The text, one numbered passage per row |
| `texts` (view) | Segments joined to their work, author, licence and chapter |
| `meta` | The library commit this was built from, and which part and sections the file holds |

```sql
-- Which editions of Augustine are here?
SELECT e.id, e.language, e.licence FROM editions e JOIN works w ON w.id = e.work_id
JOIN authors a ON a.id = w.author_id WHERE a.name LIKE '%Augustine%';

-- Read one chapter.
SELECT ref, text FROM texts WHERE edition_id = 'civ-dei-dods-npnf2-wikisource' AND division = 0 ORDER BY position;

-- Add full-text search. This adds to the file, and takes a minute or so.
CREATE VIRTUAL TABLE search USING fts5(edition_id UNINDEXED, ref UNINDEXED, text);
INSERT INTO search SELECT edition_id, ref, text FROM segments;
SELECT edition_id, ref, snippet(search, 2, '[', ']', '…', 12) FROM search WHERE search MATCH 'predestination' LIMIT 10;
```

## How it is made

`tools/build.mjs` builds everything from the Ecclesia library store and stops if the catalogue does not clear any stored edition. `tools/verify.mjs` then reads the finished files and compares every passage with the store.
