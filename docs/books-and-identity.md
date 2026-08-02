# Books And Identity

How ShelfBridge decides that two entries from different services are the same
book, how that canonical book is stored, and how the Books UI presents it.

Split out of `architecture.md` — that file describes the system shape, this one
describes the book model in detail.

---

## Match Confidence

When ShelfBridge links a Hardcover book entry to a Grimmory book, it assigns a
confidence level:

| Level | How matched |
|---|---|
| `high` | Grimmory-stored Hardcover book ID, Grimmory-stored Goodreads ID, Hardcover slug, ISBN-13, or ISBN-10 |
| `medium` | Normalised title + first author name match |
| `low` | Relaxed title + first author name match |
| `none` | No match found — book recorded as `missing` in Grimmory |

Matching runs durable external IDs first, then ISBN, then title+author. Relaxed
title matching removes common subtitle/sales-copy suffixes and is treated as
low confidence so it can be reviewed before any IDs are written back to Grimmory.
When a newly observed Hardcover book matches a Grimmory book by identity keys,
the `book_sources` rows for both sources are linked via the same `books.id`.

---

---

## Book Sources And User States

`books` is ShelfBridge's canonical book table. The source data sits in two
additional tables:

**`book_sources`** — one row per (book, source_type); contains book-level facts
that do not vary per user: external IDs, ISBNs, slugs, cross-system reference
IDs, Chaptarr monitored/has_file flags, series data, and the `cover_cache_path`
used by all profiles for that book. There is exactly one `book_sources` row per
source type per canonical book.

**`user_book_states`** — one row per (book, profile, source_type); contains
everything that varies per user: sync health, match confidence, `has_superseded`
flag, reading status, rating, progress, shelves, read dates, and per-source
timestamps. Rows only exist where the user has actual reading activity.

Book identity reconciliation (`src/server/db/bookIdentity.ts`) clusters
`book_sources` rows into canonical `books` records using a union-find algorithm:

- high-confidence identity keys (Hardcover book ID, Hardcover slug, Goodreads book
  ID, Grimmory-stored HC/GR IDs, Grimmory internal book ID) group rows immediately
- ISBN-13 and ISBN-10 group rows unless the clusters already have conflicting
  high-confidence IDs. A Goodreads/Grimmory ISBN match can still bridge that
  conflict when title matches and Grimmory shares an exact same-format path with
  Chaptarr; this handles stale Grimmory Goodreads IDs without writing externally
- a Goodreads edition can join a Chaptarr/Grimmory cluster only when the same
  Chaptarr row has that exact Goodreads edition ID and an exact, same-format
  file-path match to Grimmory; Chaptarr IDs alone never merge records
- exact normalised title + author groups remaining rows even when source identifiers
  differ; differing IDs remain visible as ID review work rather than creating
  separate book entries

Before those keys are generated, each source row is bucketed into `book`,
`audiobook`, or `unknown` using source media type, Hardcover edition format,
Grimmory/Chaptarr file paths, and narrator hints. For Hardcover rows, an
explicit `edition_format` now takes precedence over conflicting
`default_*_edition_id` pointers so a clearly-ebook edition is not misbucketed as
an audiobook when Hardcover exposes inconsistent defaults. Format buckets prefix
high-confidence identity keys (HC book ID, Grimmory ID, ISBNs) so that, for
example, separate HC library entries for the physical and audio editions of the
same work are not incorrectly merged. The **title+author key is format-agnostic**:
physical, ebook, and audiobook editions of the same work that share no common
high-confidence identifier are merged by normalised title+author rather than being
kept in separate canonical records — preventing duplicate `books` rows when a
user's HC edition points at the physical book but their ABS file was matched via
the audiobook edition.

Key `user_book_states` fields:

- `sync_health`: `synced | conflict | missing | pending_download | superseded | pending | error`
  where `missing` means the book has no Grimmory match; `pending_download` means
  Chaptarr has the book monitored but the file has not yet arrived
- `match_confidence`: `high | medium | low | none`
- `has_superseded`: 1 if any write to this book was ever blocked by the timestamp
  guard (stale incoming data)
- `last_modified_at`: the timestamp of the most recent data that was actually written
- `match_type`: `hardcover_book_id | hardcover_slug | goodreads_id | isbn13 |
  isbn10 | title_author | title_author_relaxed | null` — records how the
  Grimmory match was established
- `hardcover_user_book_id`: Hardcover's `user_books.id` for this profile's
  relationship — stored during Phase F-H; required by Phase N to insert/update
  `user_book_read` records when writing audiobook progress to Hardcover. If
  absent or zero (e.g., the book is only in the user's HC "Owned" list with no
  reading-status entry), Phase N auto-creates the `user_books` record using the
  edition pinned in the list entry, then stores the new ID here
- `progress_seconds`: Hardcover read-record `progress_seconds` (current playback
  position in seconds); used for audiobook progress sync via Hardcover's
  `insert_user_book_read` / `update_user_book_read` mutations

Key `book_sources` fields:

- `hardcover_slug`: the Hardcover URL slug for direct links to hardcover.app
- `isbn13`, `isbn10`: ISBNs from the source system
- `grimmory_hardcover_book_id`, `grimmory_goodreads_id`: external IDs read from
  Grimmory metadata; used as high-confidence identity keys
- `grimmory_primary_file_path`: on-disk file path from Grimmory's
  `primaryFile.filePath`; stored on the grimmory source row and refreshed every
  sync; used for file-path matching with Chaptarr
- `chaptarr_monitored`, `chaptarr_has_file`, `chaptarr_id_mismatch`: populated
  by the Chaptarr status pass; `chaptarr_id_mismatch` flags books where
  Chaptarr's HC ID pointed at the wrong Hardcover book
- `chaptarr_primary_file_path`: on-disk file path fetched from
  `/api/v1/bookfile?authorId=<id>` during the Chaptarr sync pass; stored on the
  chaptarr source row; used for file-path matching against Grimmory
- `series_name`, `series_number`: populated from Grimmory, Hardcover,
  Goodreads, and Chaptarr when those sources expose series metadata
- `audiobookshelf_duration`: total audiobook duration in seconds from the ABS
  library item or progress endpoint (used for currentTime↔percentage conversion)
- `audiobookshelf_file_path`: primary file path from the ABS library item
- `audiobookshelf_asin`: ASIN from ABS metadata (used as a high-confidence identity key when matching ABS items to Hardcover/Grimmory book sources)
- `audiobookshelf_runtime_validated`: 1 when the ABS item was successfully matched
  to an existing canonical book; progress sync is gated on this flag
- `audiobookshelf_runtime_delta`: reserved for future duration-comparison use
- `hardcover_audio_seconds`: `audio_seconds` from the user's selected Hardcover
  audiobook edition; stored during Phase C; compared against `audiobookshelf_duration`
  to detect wrong-edition links (>5% divergence triggers the ABS Runtime Mismatch filter)
- `cover_cache_path`: local web path (`/images/<uuid>.jpg`) for the cached cover
  image; the only cover path sent to clients

Cover priority when a canonical book cover is chosen:
**explicit Grimmory cover > Hardcover > Grimmory fallback cache > Goodreads**.
For books matched to both Hardcover and Grimmory, if the Grimmory API returns no
cover URL the authenticated `GET /api/v1/media/book/{bookId}/cover` endpoint is
used as a fallback cache path, but it does not outrank a specific Hardcover
edition cover. Hardcover cover caching now prefers the user's selected
`edition.image.url` when available, which is especially important for audiobook
canonicals where the edition art is often square and different from the generic
book-level cover.

---

## Books UI

The global Books page at `/books` is a filtered poster grid of canonical
ShelfBridge books. Each card links to a dedicated aggregate book detail page at
`/books/:id`; ShelfBridge no longer uses a modal or drawer for book details.

There are now two catalog views over the same canonical table:

- `/books` — defaults to canonical `mediaType=book`
- `/audiobooks` — defaults to canonical `mediaType=audiobook`

The split is canonical, not just presentational. If ShelfBridge sees both a
book-ish variant and an audiobook variant for the same underlying work, they can
exist as two separate `books.id` rows rather than one mixed record.

Catalog rows are anchored from `book_sources` rows with `source_type` in
`grimmory`, `hardcover`, or `goodreads`. Chaptarr rows are deliberately excluded
from the catalog anchor because Chaptarr is download-state metadata, not a
library/catalog source. A Chaptarr-only row should never create a blank book card;
instead, Chaptarr fields are left-joined onto canonical books that already have a
real catalog source.

The Books page has four filter rows:

- **Sources** — **Hardcover**, **Goodreads**, **Audiobookshelf**, and **On Disk** chips cycle through
  include (blue) → exclude (red) → off on successive clicks. Source filters are
  evaluated at the book level: a book is "in Hardcover" if it has a `book_sources`
  row with `source_type='hardcover'`; "in Goodreads" if it has a `goodreads_book_link`;
  "On Disk" if it has a `book_sources` row for `grimmory` or `chaptarr`. Include
  and exclude filters therefore apply to the entire book cluster, not just individual rows.
- **Profile** — narrows to one user's books, but only when that profile has an
  actual imported relationship for the canonical book. Shared catalog presence
  from Grimmory or Chaptarr alone is not enough to make a book appear for a
  user. Profile chip counts follow the same rule and are based on active
  per-user relationships only.
- **Presence** — **Chaptarr** chip cycles through three states: include (blue) →
  exclude (red) → off. Chaptarr "in" means the book is monitored in Chaptarr.
  Presence is evaluated at the book level: a book is "in Chaptarr" if its
  `book_sources(source_type='chaptarr')` row has `chaptarr_monitored = 1`.
- **Actions** — pre-composed pipeline-gap shortcuts. Each chip answers one step
  in the download pipeline and tells you what to do next:
  - **Add to Chaptarr** — in Hardcover/Goodreads but not monitored in Chaptarr
  - **Grab in Chaptarr** — monitored in Chaptarr but file not yet downloaded
  - **Review in Grimmory** — file downloaded in Chaptarr but no Grimmory match (likely a wrong ID)
  - **ID Review** — ShelfBridge detected conflicting external IDs for this book
  - **ABS Runtime Mismatch** — ABS item duration does not match the expected Grimmory/Hardcover runtime
- **Status** — reading state (All / Want to Read / Reading / Read / Did Not Finish)

Poster aspect ratio is media-type specific:

- Books keep the original `2:3` card and detail-cover layout
- Audiobooks use `1:1` cards on `/audiobooks` and a `1:1` primary cover on the
  audiobook detail page

Both the Dashboard and Books pages include a search bar that queries books by
title or author. As the user types, a live dropdown appears showing up to 8
matching books (cover thumbnail, title, author). Clicking a dropdown result
navigates directly to `/books/:id`. Pressing Enter with no result highlighted
commits the search: on the Dashboard this navigates to `/books?q=<term>`; on the
Books page it immediately applies the query as an in-place filter. The `q` URL
parameter is supported by `GET /api/books` via a case-insensitive SQL `LIKE`
match against `title` and `author`; it stacks with all other filter parameters
and does not affect facet counts.

The `:id` segment is `books.id`. Relationship-scoped actions such as ID review
writes are scoped by `profile_id`, passed as a URL segment.

The book detail page shows canonical book metadata in the hero, aggregate source
presence, aggregate sync health, unified identifiers, and optional Shelfmark
search when the download setting is enabled. User-specific status, ratings,
progress, shelves, last sync decision, source links, and manual ID review actions
are shown in one relationship card per active profile. Profiles with no imported
presence for that book are omitted instead of rendering placeholder pending rows.
