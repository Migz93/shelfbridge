# Chaptarr Integration

## What Chaptarr Is

Chaptarr is a fork of Readarr (a book download manager). It handles discovering
and downloading ebooks automatically. A Hardcover account and a Goodreads
account can each be linked to Chaptarr as sources. Chaptarr downloads books
into a shared library folder that is also Grimmory's library location, so once
Chaptarr downloads a book, Grimmory automatically picks it up and displays it.

---

## How Chaptarr Fits Into The Stack

```
Hardcover / Goodreads → Chaptarr → downloads books → Grimmory library folder
                                                    ↓ Grimmory displays book
ShelfBridge → syncs reading status Grimmory ↔ Hardcover (unchanged)
           → Chaptarr status pass: writes chaptarr_* fields into book_sources
                                   promotes 'missing' → 'pending_download'
```

Both Chaptarr and Grimmory point at the same NAS ebook share. ShelfBridge
exploits this shared path to cross-match books that Chaptarr and Grimmory
couldn't otherwise link via ID or title.

---

## Chaptarr API Shape (Confirmed From Probe)

Chaptarr exposes a Readarr-compatible REST API at `/api/v1/`.
Authentication uses `X-Api-Key: <apiKey>` on every request.

### Book object — key identifier fields (`GET /api/v1/book`)

| Field | Format | Meaning |
|---|---|---|
| `id` | integer | Chaptarr's internal book ID |
| `foreignBookId` | `"550554"` | Hardcover book ID (numeric string, no prefix) |
| `hardcoverBookId` | `"hc:550554"` | Same ID with `hc:` prefix |
| `baseBookId` | `"hc:550554"` | Same as `hardcoverBookId` |
| `goodreadsWorkId` | `"gr:55016610"` | Goodreads **Work** ID with `gr:` prefix |
| `foreignEditionId` | `"gr:18892302-ebook"` / `"hc:edition:31501578-audiobook"` | Source-specific edition reference; for Hardcover audiobook imports the suffix often reveals the reading format |
| `titleSlug` | `"hell-bent-2022_2"` | Chaptarr-generated slug |
| `asin` | `"B09W14K6JB"` | Amazon ASIN |
| `authorId` | integer | Chaptarr author ID — **no author name on the book object** |
| `monitored` | boolean | Whether the book is monitored |
| `mediaType` | string | Chaptarr's own format classification, e.g. `audiobook` or `ebook` |
| `audiobookMonitored` / `ebookMonitored` | boolean | Per-format monitor flags |
| `hasFiles` | boolean | Whether a file has been downloaded |
| `statistics.bookFileCount` | integer | Number of files present |
| `editions[]` | array | Edition objects; each may carry `isbn13`, `isbn` (isbn10) |

### Important: author name resolution

Books only carry `authorId`, not a name. To resolve author names for title+author
matching, `/api/v1/author` must be fetched and an `authorId → name` map built.
Without this, title+author matching silently fails for all books.

### Book file paths (`GET /api/v1/bookfile?authorId=<id>`)

File paths are **not** included in the `/api/v1/book` response. They are on a
separate endpoint, queried per author:

| Field | Format | Meaning |
|---|---|---|
| `bookId` | integer | The Chaptarr book ID this file belongs to |
| `path` | string | Full on-disk path to the file |
| `mediaType` | string | File-level format classification |
| `narrator` | string | Narrator name for audiobook files |

Example path: `/mnt/user/media/Bookshelf/Books/Sarah J. Maas/Throne of Glass(5)/Throne of Glass.epub`

This is the same NAS mount Grimmory uses, so paths match `grimmory_primary_file_path`
exactly (no normalisation needed beyond `.trim()`).

### Goodreads Work ID vs edition ID

`goodreadsWorkId` is a Goodreads **Work** ID. `grimmory_goodreads_id` (stored by
the Grimmory sync) is typically a Goodreads **edition/book** ID. These use
different numbering schemes and cannot be cross-matched reliably. The Hardcover ID
path (`foreignBookId` / `hardcoverBookId`) is the most reliable cross-match.

---

## Matching Strategy

When linking a Chaptarr book to a `book_sources` row, the following priority chain
is used (first match wins):

| Priority | Chaptarr field | How matched |
|---|---|---|
| 1 | `hardcoverBookId` (strip `hc:`) | → `hardcover` source `external_id` / `grimmory_hardcover_book_id` |
| 2 | `foreignBookId` (plain numeric) | → same as above (safe fallback) |
| 3 | `goodreadsWorkId` (strip `gr:`) | → `goodreads` source `external_id` / `grimmory_goodreads_id` |
| 4 | `titleSlug` | → `hardcover_slug` (lowercase) |
| 5 | ISBNs from `editions[]` | → `isbn13` / `isbn10` |
| 6 | title + resolved author name | exact normalised match |
| 7 | stripped title + resolved author name | relaxed match (removes subtitles) |
| 8 | on-disk file path | `chaptarrFilePathByBookId.get(id)` → `grimmory_primary_file_path` |

Steps 1–2 validate the matched title before accepting, because Chaptarr sometimes
stores an HC ID pointing at the wrong Hardcover book (metadata resolution failure).
When an ID match is rejected on title grounds, `chaptarr_id_mismatch = 1` is
stored and the book is surfaced in the "ID Review" filter.

Step 8 (file-path fallback) catches books where all ID/ISBN/title steps fail but
both systems have the same file. All author bookfiles are fetched in parallel at
the start of the pass (one `GET /api/v1/bookfile?authorId=<id>` per author), so
there are no per-book API calls in the matching loop.

Books that still fail after all eight steps are genuinely absent from `book_sources`
— typically books Chaptarr has that Grimmory/Hardcover don't track yet, or books
whose file hasn't been downloaded (no path to compare for step 8).

---

## Database Columns

### `book_sources` (one row per matched Chaptarr book, `source_type = 'chaptarr'`)

| Column | Type | Meaning |
|---|---|---|
| `external_id` | `TEXT` | Chaptarr's internal `id` for this book (as a string) |
| `chaptarr_monitored` | `INTEGER` | `1` if the book is monitored in Chaptarr |
| `chaptarr_has_file` | `INTEGER` | `1` if a file has been downloaded |
| `chaptarr_id_mismatch` | `INTEGER` | `1` if Chaptarr's HC ID pointed at the wrong book |
| `chaptarr_primary_file_path` | `TEXT` | On-disk path from `/api/v1/bookfile`; refreshed every sync |
| `source_media_type` | `TEXT` | Normalized format classification: `physical`, `ebook`, or `audiobook` |
| `source_edition_id` | `TEXT` | Source-provided edition identifier when present |
| `source_edition_format` | `TEXT` | Source-provided edition-format label when present |
| `source_narrator` | `TEXT` | Narrator name when the source exposes one |
| `title` / `author` | `TEXT` | Chaptarr title and resolved author name, used as weaker identity metadata |
| `series_name` / `series_number` | `TEXT` | Best-effort Chaptarr series fields when present on the API payload |

### `book_sources` (grimmory source row)

| Column | Type | Meaning |
|---|---|---|
| `grimmory_primary_file_path` | `TEXT` | On-disk path from Grimmory `primaryFile.filePath`; refreshed every grimmory sync |

Chaptarr credentials are stored globally (not per-profile) in `app_settings`:
- `chaptarr.baseUrl` — base URL of the Chaptarr instance
- `chaptarr.apiKey` — API key encrypted with the shared AES-256-GCM credential envelope

---

## Chaptarr Status Pass (Sync Engine)

`syncChaptarrStatus(profileId)` in `src/server/sync/chaptarr.ts` runs at the
end of every `runSync` call, after the Grimmory/Hardcover/Goodreads passes complete.

What it does each run:

1. Reads `chaptarr.baseUrl` and decrypts `chaptarr.apiKey` from `app_settings`.
   If either is blank, logs and exits immediately — Chaptarr is optional.
2. Fetches all books from `/api/v1/book`, filters to `monitored = true`.
3. Fetches `/api/v1/author` and builds an `authorId → name` map for title+author
   matching. Then fetches `/api/v1/bookfile?authorId=<id>` for **every author in
   parallel** and builds a `chaptarrBookId → filePath` map for file-path matching.
4. Loads all `book_sources` rows and builds lookup indexes (by HC ID, GR ID, ISBN,
   title+author, and Grimmory file path).
5. Matches each monitored Chaptarr book via the eight-step chain above.
6. Upserts a `book_sources(source_type='chaptarr')` row for each matched book,
   writing title, resolved author, best-effort series metadata,
   `chaptarr_monitored`, `chaptarr_has_file`, `chaptarr_id_mismatch`, and
   `chaptarr_primary_file_path`. Unmatched books are logged with `hasFilePath`
   so it is visible whether a file path was available for step 8.
7. Deletes `book_sources(source_type='chaptarr')` rows for books no longer in the
   monitored set.
8. Promotes `sync_health = 'missing'` to `'pending_download'` for rows where
   `chaptarr_monitored = 1` and `chaptarr_has_file = 0`.
9. Reverts `'pending_download'` back to `'missing'` for rows where the file has
   now arrived but Grimmory hasn't picked it up yet (so the next full sync can
   set it to `'synced'`).

---

## Sync Health States

With Chaptarr integrated, `sync_health` has three meaningful states for books
that exist in Hardcover/Goodreads but have no Grimmory match yet:

| State | Meaning |
|---|---|
| `missing` | Not in Chaptarr at all — nobody has requested this book |
| `pending_download` | In Chaptarr (monitored) but file not yet downloaded |
| `synced` | File downloaded, Grimmory has it, status synced with Hardcover |

---

## Settings UI

**Settings → Chaptarr** tab provides:

- Base URL + API key input fields (key is password-masked)
- **Test Connection** — calls `/api/v1/system/status`, shows app name and version
- **Run Probe** — full diagnostic tool that:
  - Fetches monitored books, authors, and book files
  - Extracts all identifier fields with coverage % and example values
  - Attempts to match every monitored book against `book_sources` using the
    eight-step chain, showing matched count / total and breakdown by match method
  - Lists unmatched books with their Hardcover ID, Goodreads Work ID, and title
    slug shown inline; each row is clickable to expand the full raw API payload

---

## Books UI

- **Book cards** — a clock icon appears on books with `sync_health = 'pending_download'`
- **Catalog anchoring** — Chaptarr rows never create catalog cards on their own.
  Books and dashboard queries anchor on Grimmory, Hardcover, and Goodreads
  sources, then join Chaptarr as download metadata. This prevents unmatched
  Chaptarr artifacts from appearing as blank books.
- **Presence chips** — **Chaptarr** chip on the Books page cycles through
  include → exclude → off on successive clicks. Presence is evaluated at the book
  level: a book is "in Chaptarr" if its `book_sources(source_type='chaptarr')`
  row has `chaptarr_monitored = 1`.
- **Action chips** — pipeline-gap shortcuts:
  - **Add to Chaptarr** — in Hardcover/Goodreads, not monitored in Chaptarr
  - **Grab in Chaptarr** — monitored but file not yet downloaded
  - **Review in Grimmory** — file downloaded but no Grimmory match
  - **ID Review** — conflicting external IDs detected by ShelfBridge

---

## What Is Not Yet Built

- **Per-instance Chaptarr connections** — currently one global Chaptarr instance.
  A `chaptarr_connections` table (per-profile, encrypted key) would be needed if
  multiple Chaptarr instances become necessary.
