# Ecclesia Texts

Every text stored in the [Ecclesia](https://rookie2401.github.io/) theological library, kept apart from the app, free to download.

- **683 editions of 448 works**: Greek, Latin, Hebrew (with the Aramaic of the Hebrew Bible), English and Dutch.
- **Browse and download:** [the download page](https://rookie2401.github.io/ecclesia/).
- **One text:** `texts/<work>/<edition>.txt`. Plain UTF-8, with its credit, licence and source at the top.
- **Everything:** `ecclesia-texts.sqlite.gz`, a SQLite database (90 MB to download, 425 MB unpacked).
- **The list:** `catalogue.json`, with each file's size and SHA-256.

## Rights

Each text keeps its own licence, stated at the top of its file and in the `editions` table. They are public domain, CC0 or CC BY-SA 4.0. CC BY-SA texts must be credited and shared alike under that licence.

Public-domain status is judged for the United States and for the specific edition. The `life70` field says whether the edition is also clear where copyright lasts for the author's life plus 70 years: `clear`, `unknown` or `not-clear`. If you are outside the United States, check that field and your own law.

The database also lists catalogue entries that have **no** text here (`works` with no row in `editions`). They are collections, or their rights are not yet verified, and they are not distributed.

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

## The database

Unpack it, then open it with any SQLite tool:

```
gzip -d ecclesia-texts.sqlite.gz
sqlite3 ecclesia-texts.sqlite
```

| Table | Holds |
|---|---|
| `authors` | Name, dates, era |
| `works` | Every catalogue entry, with its rights status and the reason for it |
| `editions` | Each stored edition: credit, licence, source, SHA-256 of the source, path of its text file |
| `divisions` | The chapters of each edition, in order |
| `segments` | The text, one numbered passage per row |
| `texts` (view) | Segments joined to their work, author, licence and chapter |
| `meta` | The library commit this was built from |

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
