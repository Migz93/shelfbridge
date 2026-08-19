# ShelfBridge Sync Model

## Data Flow

```
  Grimmory ──────────────────────────────────────────► ShelfBridge
 (all books, "on disk")                                (canonical books)
                                                             ▲
  Hardcover ──► (per-profile reading state) ─────────────────┤
                                                             │
  Goodreads ──► (per-profile reading state) ─────────────────┤
                                                             │
  Chaptarr  ──► (download state, read-only) ─────────────────┤
                                                             │
  Audiobookshelf ──► (per-profile audiobook progress) ────────┘

  ShelfBridge ◄──────────────────────────────────────► Hardcover
                       (bidirectional sync)

  ShelfBridge ──────────────────────────────────────► Grimmory
                  (status/rating/shelf writes)

  Audiobookshelf ◄────────────────────────────────── ShelfBridge
  Grimmory       ◄── (three-way audio progress sync, latest-wins)
```

- **Grimmory → ShelfBridge**: all books in the Grimmory catalog are imported as
  `book_sources(source_type='grimmory')` rows on every sync, regardless of user
  reading activity. Grimmory is the "on disk" source.
- **Hardcover → ShelfBridge**: per-profile import when a Hardcover API token is
  configured. Reading state is bidirectionally synced back to Hardcover.
- **Goodreads → ShelfBridge**: per-profile read-only import. Goodreads is never
  written to.
- **Chaptarr → ShelfBridge**: read-only. ShelfBridge fetches Chaptarr's monitored
  book list after each sync to update download state. Nothing is ever written to
  Chaptarr automatically.
- **Audiobookshelf ↔ ShelfBridge**: per-profile audiobook progress import. When
  configured, listening progress is synced three-way between ABS, Grimmory, and
  Hardcover using a latest-wins strategy — see [Audiobookshelf](#audiobookshelf) below.

Goodreads data flows directly to Grimmory (not via Hardcover) because Grimmory
stores external IDs for Goodreads, ISBN, Hardcover, etc., making book matching
more reliable from that side.

## Per-Profile Source Filters

Each profile can optionally narrow a source before sync processing begins:

| Source | User setting | Behaviour |
|---|---|---|
| Hardcover | `Import List` | Optional. `Disabled` means all Hardcover user books. When a list is selected, ShelfBridge fetches the full library, fetches the user's lists, and only processes user books whose Hardcover book ID is present in that selected list. Local Hardcover-only rows outside the selected list are pruned so old full-library syncs do not keep those books visible. |
| Goodreads | `Import Shelf` | Optional. `Disabled` means the standard Goodreads shelves (`read`, `currently-reading`, `to-read`, `did-not-finish`). When a shelf is selected, ShelfBridge only fetches that RSS shelf and ignores books outside it during Goodreads enrichment/status sync. |

These filters are separate from mappings. An `Import List` or `Import Shelf`
controls which source books enter the sync at all. The optional `Send to Shelf`
setting adds every matched Grimmory book from that source to one Grimmory shelf,
while the per-list or per-shelf mappings mirror specific source collections into
specific Grimmory shelves.

## Disabling Sources

When Hardcover or Goodreads is disabled for a profile, ShelfBridge immediately
removes that source's `user_book_states` rows for that profile. `book_sources`
rows for the disabled source are left in place because they are book-level records
shared across profiles. Identity reconciliation is rerun after the cleanup.

Grimmory `user_book_states` rows are preserved during this cleanup because they
describe the user's Grimmory reading state, not the disabled source feed.

---

## Grimmory Source Tags

Each profile can enable `Write Tag` from the user detail Grimmory tab. When
enabled, ShelfBridge applies a Grimmory metadata tag named
`shelfbridge-<username>` to every matched Grimmory book that appears in that
profile's configured source scope:

- matched Hardcover books after the optional Hardcover `Sync List` filter
- matched Goodreads books after the optional Goodreads `Sync Shelf` filter

The username segment is based on the profile's Grimmory username, normalised to a
lowercase tag-safe value. Existing Grimmory tags are preserved; ShelfBridge reads
the current Grimmory metadata for each book and writes the merged tag list back.
Dry runs report the tag writes without changing Grimmory.

Tag writes are serialised per Grimmory base URL and book ID inside the ShelfBridge
process. This prevents concurrent profile syncs from racing on the same
read-merge-write metadata update and dropping another user's tag.

---

## Sync Runs

Each invocation of the sync engine creates a `sync_runs` row:

| Column | Description |
|---|---|
| `id` | Auto-increment run ID |
| `profile_id` | Which profile was synced (`NULL` = all profiles) |
| `started_at` | ISO timestamp when the run began |
| `finished_at` | ISO timestamp when the run completed (or NULL if still running) |
| `status` | `running | success | error` |
| `summary` | Human-readable one-line outcome |
| `error` | Error message if the run failed |
| `dry_run` | Whether this run was a preview-only pass |
| `changes_written` | Count of books actually updated |
| `changes_skipped` | Count of books skipped because data was already current |
| `changes_superseded` | Count of books where the incoming data was older than stored (write blocked) |

## Source Availability Guard

ShelfBridge treats each configured upstream source as authoritative only after it
can be reached for the current run. If a configured source is unavailable, the
sync records an error event for that source and skips any writes that depend on
that source's current data. An unconfigured optional source is simply skipped.

| Source unavailable | Run behaviour |
|---|---|
| Hardcover token not configured | Hardcover fetches, writes, list mappings, and Hardcover source tags are skipped. Grimmory and Goodreads processing can still run normally. |
| Hardcover configured but unavailable | The sync run fails before book data is written, because existing Hardcover-linked local rows should not be refreshed from stale Hardcover data. |
| Grimmory | Existing Grimmory data in `book_sources` and `user_book_states` is preserved, no Grimmory writes are attempted, the Grimmory source import pass is skipped (no `source_type='grimmory'` rows are created or updated), source tags and shelf sync are skipped, and new Hardcover-only `book_sources` rows are not inserted because they could be false "missing in Grimmory" matches. Existing Hardcover-linked rows may still refresh Hardcover-side fields. |
| Goodreads | Goodreads enrichment and Goodreads shelf sync are skipped. Existing Goodreads columns are left unchanged and no Goodreads-derived Grimmory writes are attempted. |

Configured source failures appear in sync history as `api_failure` or
`credential_failure` events with `decision = source_unavailable`. A run can still
finish with status `success` when a source is skipped safely; the run summary
includes the number of unavailable sources. An omitted Hardcover token is not
treated as a source failure.

---

## Sync Events

Each book-level decision during a run produces a `sync_events` row:

| Event type | Meaning |
|---|---|
| `written` | The book's data was updated in the target system |
| `skipped_no_change` | Incoming data matched stored data; no write needed |
| `superseded` | Incoming `sourced_at` was older than `last_modified_at`; write blocked |
| `conflict` | Both sides changed since last sync; flagged for review |
| `missing_match` | No book match could be found above the confidence threshold |
| `credential_failure` | Could not authenticate with the target service |
| `api_failure` | The target service returned an error |

---

## Timestamp Guard (Superseded Writes)

Every sync write passes a timestamp check before being applied:

```
if incoming.sourced_at <= stored.last_modified_at:
    record superseded event
    skip write
else:
    apply write
    update last_modified_at
```

This prevents a stale Goodreads import from overwriting a more recent
Hardcover-originated update that has already been applied to Grimmory.

When a `superseded` event is recorded:

- `sync_events.event_type = 'superseded'` is inserted
- `user_book_states.has_superseded` is set to `1` (visible in the book detail panel)

The `has_superseded` flag on `user_book_states` is cumulative — it is set to `1`
the first time a write is blocked and is never reset to `0` automatically. It is
a signal to the user that something tried to write older data to this book.

---

## Conflict Resolution

When both sides have changed since the last sync (neither is clearly newer), the
outcome depends on the configured `conflictStrategy`:

| Strategy | Behaviour |
|---|---|
| `latest_wins` | Whichever side has the more recent `sourced_at` is written |
| `grimmory_wins` | Grimmory's value is always kept; Hardcover is overwritten |
| `hardcover_wins` | Hardcover's value is always kept; Grimmory is overwritten |

The strategy is configured globally in Settings → General.

---

## Sync Health States

`user_book_states.sync_health` reflects the current state of a book for a given
profile and source type:

| State | Meaning |
|---|---|
| `synced` | Both sides agree; last sync succeeded |
| `conflict` | Both sides differ and require a strategy decision |
| `missing` | In Hardcover/Goodreads but no Grimmory match and not in Chaptarr's queue |
| `pending_download` | In Chaptarr (monitored) but file not yet downloaded |
| `superseded` | The most recent sync attempt was blocked by the timestamp guard |
| `pending` | Has not been synced yet |
| `error` | Last sync attempt encountered an API or credential error |

Books that exist only as "On Disk" records (a `book_sources(source_type='grimmory')`
row with no `user_book_states` reading activity) are not marked `missing` — they
are present in the file catalog and visible via the On Disk source filter. The
"Missing in Grimmory" concept (for Hardcover/Goodreads books not yet in Grimmory)
is reflected by the absence of a `book_sources(source_type='grimmory')` row for
that book.

`pending_download` is set by the Chaptarr status pass (runs after each sync) and
is reverted to `missing` once Chaptarr reports the file has landed — at that
point the next full sync will find the book in Grimmory and set it to `synced`.

---

## Dry Run Mode

When `dry_run = true` on a sync run, the engine reports what it _would_ do
without writing anything. Events are still recorded with their intended type so
the UI shows a realistic preview. `changes_written` will be 0 for a dry run.

Dry run is the default for manual syncs when `sync.dryRunDefault = true` in
global settings. A manual sync request can override dry-run mode for that run;
the user detail Grimmory tab also stores a profile-level `dryRunDefault` setting.

---

## Cover Download

Cover images are downloaded and cached during sync. The download step runs
fire-and-forget after `book_sources` rows are upserted, so it does not block
the sync decision or status-write steps.

**Priority: explicit Grimmory cover > Hardcover > Grimmory fallback cache > Goodreads**

Two code paths:

1. **Authenticated Grimmory cover endpoint** — used when a Grimmory match exists
   and the Grimmory API did not return a cover URL in the library response. The
   engine calls `GET /api/v1/media/book/{bookId}/cover` with the profile's JWT and
   passes the raw response bytes to `storeFetchedCover`, which writes the file and
   inserts an `image_cache` row with a seven-day freshness window. Ordinary
   profile syncs reuse the local file; the daily image refresh job performs the
   authenticated re-check after seven days. Grimmory may mislabel these image
   responses as `application/json`, so ShelfBridge validates the returned bytes
   as image data before caching. No source URL is stored because the endpoint
   requires authentication and cannot be re-fetched without it.

2. **Public URL caching** — used for Hardcover cover URLs and for Goodreads
   cover URLs during enrichment. Hardcover now prefers the user's specific
   `edition.image.url` when a selected edition exists; otherwise it falls back to
   the book-level Hardcover image. The engine calls
   `ensureCoverCached(bookSourceId, sourceUrl)`, which applies stale-while-refresh
   logic: fresh entries are returned immediately; stale entries are returned and
   refreshed in the background; misses are fetched inline. Network work uses a
   four-worker de-duplicating queue with a hard 15-second per-request deadline,
   and never blocks the status/progress sync.

The Goodreads cover (`book_large_image_url`) is applied only if the book has
neither a `cover_url` nor an existing `cover_cache_path` — it is a last resort.

During canonical cover selection, a Grimmory cached fallback image fetched from
`/api/v1/media/book/{bookId}/cover` does not outrank a specific Hardcover
edition cover. This prevents audiobook canonicals from being stuck on a generic
book-style Grimmory fallback when Hardcover has the correct square audiobook art.

`cover_cache_path` in `book_sources` is updated after a successful cache write
and is the only cover path returned to API clients.

ShelfBridge removes orphaned `image_cache` rows whose `entity_id` no longer
points at an existing `book_sources.id`. The cached file is deleted only when
no other cache row references it and the file path is inside
`DATA_DIR/image-cache/`. Two cleanup paths exist:

- A full-table scan, run after a full (unscoped) identity reconciliation — at
  startup and as part of the daily `full-reconcile` maintenance job
  (`docs/maintenance.md`). It does not run after the scoped reconciles that
  follow individual syncs and book writes (see below), since scanning the
  whole table on every write would defeat the point of scoping.
- A targeted cleanup for a known set of just-removed `book_sources` ids,
  looked up directly rather than scanned — run whenever a book is deleted
  (`DELETE /api/books/:id`) or a source is pruned (Chaptarr, Hardcover, or
  Grimmory rows falling out of a sync), immediately after the removal.

---

## Goodreads

Goodreads has no official API. ShelfBridge uses public RSS shelf feeds
(`https://www.goodreads.com/review/list_rss/{userId}?shelf={shelf}&per_page=200&page={page}`).
All access is read-only — nothing is ever written back to Goodreads.

Connection tests fetch the public RSS feed and, when the channel title exposes a
display name, store that parsed name on the Goodreads connection for display in
the user detail page. The supplied user ID or profile slug remains the stable
identifier used for future fetches.

### Goodreads Enrichment

The enrichment step runs at the end of each sync, after Grimmory-only book upserts.
It fetches all four mandatory shelves — `read`, `currently-reading`, `to-read`,
`did-not-finish` — paginated at 200 items per request.

Fields parsed from each RSS entry:

- `book_id`, `title`, `author_name`
- `isbn`, `isbn13`
- `user_shelves`, `user_rating`, `user_read_at`, `user_date_added`, `pubDate`
- `book_large_image_url`, `book_medium_image_url`, `book_small_image_url`

**Match priority** against existing `book_sources` rows (in order):

1. Grimmory-stored Goodreads ID
2. ISBN-13
3. ISBN-10
4. Normalised title

Numeric external IDs are canonicalised for matching, so source-decorated IDs such
as `22609522-red-notice` compare as `22609522`. ShelfBridge still stores the raw
source value in `book_sources` for traceability.

On a successful match the following columns are written to the
`book_sources(source_type='goodreads')` row:

- `external_id` (the Goodreads book ID)
- `isbn13`, `isbn10`
- `goodreads_match_type` — which of the four match strategies succeeded
- `goodreads_book_link` — the Goodreads book page URL

If the matched book has no cover, the Goodreads `book_large_image_url` is passed
to `ensureCoverCached` and `book_sources.cover_cache_path` is updated.

### Goodreads Status Sync

When `syncGoodreadsStatusEnabled` is on for a profile, the enrichment step also
maps the Goodreads shelf to a Grimmory read status and writes it to Grimmory when
the shelf changes. The mapping:

| Goodreads shelf | Grimmory ReadStatus |
|---|---|
| `to-read` | `UNREAD` |
| `currently-reading` | `READING` |
| `read` | `READ` |
| `did-not-finish` | `ABANDONED` |

The first time a book is enriched (baseline `goodreads_shelf` is null) no status
write is made — the shelf is stored as a baseline only. Subsequent enrichment runs
detect changes and write the new status to Grimmory.

If a Goodreads rating is present, differs from Grimmory, and Goodreads is not
older than Grimmory, it is also written to Grimmory via
`PUT /api/v1/app/books/:id/rating`. Goodreads uses a 5-point scale, which
matches Grimmory's current write API.

Goodreads status and rating writes are one-way, but still freshness-aware. When
Goodreads and Grimmory differ, ShelfBridge compares the Goodreads RSS update time
(`pubDate`, falling back to `user_read_at` or `user_date_added`) with Grimmory
`lastReadTime`. If Grimmory is newer, ShelfBridge skips the Goodreads write and
keeps the Grimmory value because there is no reverse write path back to Goodreads.

### Goodreads Shelf Discovery

Custom (non-mandatory) shelf names are discovered by fetching `shelf=all`, which
returns every book the user has shelved regardless of which exclusive shelf it is
on. The `user_shelves` field in each RSS item is split on commas to collect all
shelf names, and mandatory shelves are filtered out. If `shelf=all` returns no
books (not supported), the fallback fetches mandatory shelves instead.

Discovery is triggered from the Goodreads tab on the user detail page ("Refresh
Shelves"). The result is cached in React state for the duration of the page visit
and auto-loaded on mount if the profile has a Goodreads connection.

### Goodreads Shelf Mappings

Configured Goodreads custom shelf mappings are mirrored into Grimmory shelves.
For each mapping, ShelfBridge
fetches the Goodreads RSS shelf, matches those books to existing Grimmory-linked
`book_sources` rows by Goodreads ID, ISBN, or normalised title, resolves the mapped
Grimmory shelf by name, and creates it via `POST /api/v1/shelves` if it does not
already exist. The shelf is resolved or created even when no Goodreads books can
currently be matched to Grimmory books, so an empty mapped Grimmory shelf can be
established before book matches are available.

### ID Review And Manual Grimmory ID Writes

Some books have a Grimmory link but the external IDs stored in Grimmory do not
yet match the source IDs ShelfBridge knows about. Those rows are surfaced by
the Books page "Review" filter chip.

Rows need review when:

- Goodreads has a source book ID but Grimmory has a missing/different
  `goodreadsId`
- Hardcover has a source book ID but Grimmory has a missing/different
  `hardcoverBookId`

The book detail page exposes explicit write buttons for these cases. Clicking
"Write Goodreads ID" writes the source Goodreads ID into Grimmory metadata.
Clicking "Write Hardcover ID" writes both the source Hardcover numeric book ID
and the source Hardcover slug into Grimmory metadata. ShelfBridge never performs
these ID writes automatically during sync.

After a successful ID write, the book is immediately removed from the Review
filter when the Books page is next refreshed. The detail page refreshes the
book's identifiers immediately so the updated source provenance is visible.

---

## History And Events In The UI

The Sync History page (`/history`) shows sync runs in reverse-chronological order.

Expanding a run shows:

- Run metadata: started, finished, duration, dry-run flag, written/skipped/superseded counts
- Event groups: Errors (expanded by default), Warnings (superseded, conflicts,
  missing matches), Written (collapsed), Skipped (collapsed)

The Dashboard shows the 4 most recent runs as a compact summary strip linking to
the full history.

---

## What The Sync Engine Does (v1)

The engine is fully implemented for the Hardcover ↔ Grimmory sync path, while
also supporting Grimmory + Goodreads-only profiles. Each run:

1. **Authenticates** with Grimmory using the profile's stored credentials when
   Grimmory is configured.
2. **Fetches** the complete Grimmory book library from the admin page endpoint
   when Grimmory is configured and reachable (paginated, 250 books per request).
   This includes physical-only books that are omitted by Grimmory's app books
   endpoint.
3. **Fetches** the Hardcover library for the authenticated user when a Hardcover
   API token is configured (batched 250 at a time, deduplicated by `book.id` to
   handle multiple user-book entries per book). Without a token, the Hardcover
   source pass is skipped.
4. **Matches** each fetched Hardcover book against the Grimmory library:
   - First by Grimmory-stored Hardcover book ID
   - Then by Grimmory-stored Goodreads ID, when already enriched on the
     ShelfBridge row
   - Then by Grimmory-stored Hardcover slug
   - Then by ISBN-13 or ISBN-10 via Hardcover's `default_physical_edition`
   - Then by normalised title + first author name
   - Finally by relaxed title + first author name, which receives low confidence
     and appears in the "Needs ID Review" filter

Numeric Grimmory cross-reference IDs are canonicalised before comparison, so
decorated Goodreads or Hardcover IDs still match their plain numeric source IDs.
   - Title/author fallbacks use Hardcover `book_series` data as a guardrail
     when Grimmory has `seriesName` / `seriesNumber`; conflicting series names
     or numbers prevent a fallback match.
5. **Upserts `book_sources` rows** for every source (Phases B+C): one
   `source_type='hardcover'` row per fetched Hardcover book, one
   `source_type='grimmory'` row per Grimmory book. These are book-level writes
   with no profile attached. Hardcover, Grimmory, Goodreads, and Chaptarr source
   rows store normalised identity metadata when the upstream source provides it:
   title, author, ISBNs, cover, and series fields. Rows that share identity keys
   will be clustered in Phase D.
6. **Reconciles book identities** (Phase D): assigns canonical `books.id`
   values, scoped to just this profile sync's own changes plus anything else
   that could plausibly merge with them — not a scan of the whole catalog.
   Startup and the daily `full-reconcile` maintenance job (`docs/maintenance.md`)
   still run a full, unscoped pass. Exact source IDs and ISBNs remain the
   strongest joins. Title+author joins are allowed only when known series
   metadata is compatible, so `series_name` narrows candidates and
   `series_number` can prevent books in different series positions from
   collapsing together. Books with no HC/GR counterpart become standalone
   "On Disk" clusters.
   
   Canonical reconciliation is now format-aware. Each source row is first bucketed
   into `book`, `audiobook`, or `unknown` using, in order:
   - `source_media_type` — for Hardcover this is derived from the edition's
     structured `reading_format_id`, trusted over free-text formatting
   - the free-text `source_edition_format`, parsed as a fallback
   - Grimmory / Chaptarr file paths
   - narrator presence as an audiobook hint
   
   Identity keys are prefixed with that bucket, so a print/ebook record and an
   audiobook record for the same work no longer collapse into the same canonical
   `books.id` — except ISBN keys, which stay format-independent: an ISBN
   identifies a specific edition regardless of bucket, and a row's bucket is
   often unresolved for reasons unrelated to its actual format, so
   bucket-prefixing there would silently block a valid exact-ISBN match. The
   surviving canonical row writes `books.media_type`, which drives the Books
   vs Audiobooks split in the UI and API.
7. **Downloads covers** (fire-and-forget, after upsert): for each book with a
   Hardcover or Grimmory match, the appropriate cover source is selected and cached
   asynchronously — see [Cover Download](#cover-download) below
8. **Computes sync decisions** for each matched Hardcover + Grimmory pair and
   writes status and rating changes if needed
9. **Records `sync_events`** for every book-level outcome
10. **Goodreads enrichment** (after Grimmory source import, if a Goodreads connection
    is configured): fetches all four mandatory shelves (`read`, `currently-reading`,
    `to-read`, `did-not-finish`) via RSS, matches entries against existing `book_sources`
    rows, upserts `book_sources(source_type='goodreads')` rows, and applies Goodreads
    cover images as a last resort. When `syncGoodreadsStatusEnabled`, writes eligible
    status changes and ratings to Grimmory. Goodreads shelf → Grimmory shelf sync
    then runs automatically for configured mappings — see [Goodreads](#goodreads)
    below
11. **Applies source tags** (if `syncWriteTagEnabled` and Grimmory is available):
    tags each matched Grimmory book from the profile's scoped Hardcover and/or
    Goodreads source list as `shelfbridge-<username>` — see
    [Grimmory Source Tags](#grimmory-source-tags) above
12. **Hardcover shelf sync** (if a Hardcover token is configured and Grimmory is
    available): loads Hardcover list ↔ Grimmory shelf mappings from
    `shelf_mappings`, fetches the profile's Hardcover lists (with book IDs),
    resolves mapped Grimmory shelves, then additively syncs missing matched books
    in both directions — see [Shelf Sync](#shelf-sync) below
13. **Chaptarr status pass** (if Chaptarr is configured in Settings): fetches
    monitored books from Chaptarr, fetches book file paths per author through a
    bounded request pool, matches books via the eight-step chain (IDs → ISBNs → title+author
    → file-path fallback), upserts `book_sources(source_type='chaptarr')` rows
    with `chaptarr_monitored / chaptarr_has_file / chaptarr_primary_file_path`,
    and promotes `'missing'` → `'pending_download'` on `user_book_states` rows
    for books queued in Chaptarr without a file yet — see [Chaptarr](#chaptarr) below
14. **Updates the `sync_runs` record** with final written/skipped/superseded counts

If Grimmory is configured but unreachable or authentication fails, the engine
still fetches and stores Hardcover books when Hardcover is configured, marking
them as `sync_health = 'missing'` until a Grimmory match can be established in a
later run.

If Hardcover is not configured for the profile, the engine does not require a
Hardcover API token. It skips Hardcover library fetches and writes, then continues
with Grimmory-only upserts, Goodreads enrichment/status sync, Goodreads shelf sync,
and source tags for Goodreads-matched Grimmory books.

---

## Status Sync Decision Logic

For each matched Hardcover + Grimmory book pair, the engine decides what to write:

| Situation | Decision |
|---|---|
| Both sides agree (status already in sync) | `skipped_no_change` |
| Grimmory has no status, Hardcover does | Write Hardcover → Grimmory |
| Hardcover has no status, Grimmory does | Write Grimmory → Hardcover |
| Both differ, `hardcover_wins` strategy | Write Hardcover → Grimmory |
| Both differ, `grimmory_wins` strategy | Write Grimmory → Hardcover |
| Both differ, `latest_wins`, Hardcover newer | Write Hardcover → Grimmory |
| Both differ, `latest_wins`, Grimmory newer | Write Grimmory → Hardcover |
| Both differ, `latest_wins`, no timestamps | Write Hardcover → Grimmory (default) |

Timestamps compared: Hardcover `user_books.updated_at` vs Grimmory `lastReadTime`.
Because Grimmory status-only changes do not always update a timestamp, ShelfBridge
also compares the freshly fetched Grimmory `readStatus` against the previously
stored `user_book_states.grimmory_status`. When that value changed and maps to a
Hardcover action, Grimmory is treated as the source for the next write.

---

## Status Mapping

| Hardcover status_id | Grimmory ReadStatus |
|---|---|
| 1 — Want to Read | `UNREAD` |
| 2 — Currently Reading | `READING` |
| 3 — Read | `READ` |
| 4 — Paused | `PAUSED` |
| 5 — Did Not Finish | `ABANDONED` |
| 6 — Ignored | `WONT_READ` |

Mapping is bidirectional; the reverse table is used when writing Grimmory → Hardcover.
Grimmory has two additional active-reading states that collapse to Hardcover's
current API status for "Currently Reading":

| Grimmory ReadStatus | Hardcover status_id |
|---|---|
| `READING` | 2 — Currently Reading |
| `RE_READING` | 2 — Currently Reading |
| `PARTIALLY_READ` | 2 — Currently Reading |
| `READ` | 3 — Read |
| `PAUSED` | 4 — Paused |
| `ABANDONED` | 5 — Did Not Finish |
| `WONT_READ` | 6 — Ignored |

`PAUSED` and `WONT_READ` are both supported by the Hardcover API even though the
Hardcover website UI may not surface them.

`UNSET` and `UNREAD` are intentionally ignored as Grimmory → Hardcover sources.
Grimmory often stores newly added books as `UNREAD`, and ShelfBridge should not
force those books into the Hardcover library as "Want to Read" unless the user
has chosen a more actionable reading state in Grimmory.

When Grimmory status is `READ`, the engine also stores top-level
`dateFinished` and writes it to Hardcover `last_read_date` when present.

---

## Rating Sync

Rating sync is controlled by the same profile toggle as status sync and uses the
same matched Hardcover/Grimmory book pair.

Grimmory uses 10-point personal ratings. Hardcover and Goodreads use 5-point
personal ratings. ShelfBridge normalises ratings at the sync boundary and writes
Grimmory ratings through `PUT /api/v1/books/personal-rating` with
`{ ids: [bookId], rating }`:

| Direction | Conversion |
|---|---|
| Grimmory → Hardcover | `grimmory_rating / 2` |
| Hardcover → Grimmory | `hardcover_rating * 2` |
| Goodreads → Grimmory | `goodreads_rating * 2` |

Decision rules:

| Situation | Decision |
|---|---|
| Both sides agree after conversion | Skip |
| Only Grimmory has a rating | Write Grimmory → Hardcover |
| Only Hardcover has a rating | Write Hardcover → Grimmory |
| Both differ and one side changed since the previous sync | Write the changed side to the other |
| Both differ and both have timestamps | Newer timestamp wins (`lastReadTime` vs `user_books.updated_at`) |
| Both differ with no previous baseline | Prefer Grimmory |

Ratings are synced only when a positive rating is present. ShelfBridge does not
clear a rating on the other service when one side has no rating, because the
clear semantics differ by API and would be unexpectedly destructive.

---

## Progress Sync

Progress sync is controlled by `syncProgressEnabled` on each profile and uses the
same mapped Hardcover/Grimmory book pair as status sync.

Observed source shapes:

- Grimmory progress is fetched from `GET /api/v1/app/books/{bookId}/progress`.
  It returns `readProgress` as a 0-100 percentage and `lastReadTime` as the
  progress timestamp. The admin book endpoint may not include current progress.
- Grimmory progress writes use `PUT /api/v1/app/books/{bookId}/progress`.
  Percentage writes send `fileProgress.bookFileId`,
  `fileProgress.progressPercent`, and `progressValid: true`. Clear writes send
  `progressValid: false` with the file progress marked null when the primary
  file ID is known. The `bookFileId` comes from the admin book's
  `primaryFile.id`.
- Hardcover progress is read from the latest `user_book_reads` record. Hardcover
  returns both `progress` as a 0-100 percentage and `progress_pages`. For
  audiobooks, ShelfBridge also falls back to `progress_seconds` plus the known
  audio runtime when the percentage field is missing or inconsistent.
- Hardcover progress writes use `insert_user_book_read` or `update_user_book_read`.
  For regular books: `progress_pages` (converted from percentage using HC page count).
  For audiobooks: `progress_seconds` (converted from percentage using ABS duration, or
  taken directly from ABS `currentTime`). The `hardcover_user_book_id` stored in
  `user_book_states` is required for these mutations; it is populated after the first
  HC sync run for a given book.

Decision rules:

| Situation | Decision |
|---|---|
| Both sides agree within 0.1 percentage points | Skip |
| Only Grimmory has progress | Write Grimmory → Hardcover |
| Only Hardcover has progress | Write Hardcover → Grimmory |
| Hardcover progress was cleared and Hardcover is newer | Clear Grimmory progress |
| Both differ and one side changed since the previous sync | Write the changed side to the other |
| Both differ and both have timestamps | Newer timestamp wins (`lastReadTime` vs `user_books.updated_at`) |
| Both differ with no previous baseline | Prefer Hardcover to avoid overwriting website-entered progress |

Progress sync is intentionally percentage-based at the sync boundary. Page counts
can differ by edition between Grimmory and Hardcover, so ShelfBridge stores both
the source percentage and Hardcover page count/page progress for auditability.

---

## Grimmory Connection Is Optional

If a profile has no Grimmory credentials configured (or the global base URL is
unset), the engine still runs. When Hardcover is configured, it stores Hardcover
books as `sync_health = 'missing'`. No Grimmory writes are attempted and no
Grimmory-only books are upserted.

---

## Hardcover Connection Is Optional

If a profile has no Hardcover API token configured, the engine skips Hardcover
library fetches, Hardcover writes, Hardcover list mappings, and Hardcover list
source tags. Grimmory and Goodreads can still sync for that profile.

Hardcover-specific settings remain saved on the profile. They take effect if a
Hardcover token is added later.

---

## Shelf Sync

Hardcover lists and Grimmory shelves can be mirrored on a per-profile basis when
the profile has a Hardcover API token.
Mappings are configured on the user detail page under the Hardcover tab.

**How it works:**

1. The engine loads all `shelf_mappings` rows for the profile where
   `source = 'hardcover'` and `source_list_id IS NOT NULL`.
2. It fetches the profile's Hardcover lists (with their book IDs) in a single
   GraphQL query.
3. For each mapping, it resolves Hardcover book IDs to Grimmory book IDs using
   the local `book_sources` table, matching either `external_id` on the Hardcover
   source row or `grimmory_hardcover_book_id` on Grimmory source rows — no
   additional API calls are needed.
4. It calls `ensureGrimmoryShelf` which finds the shelf by name (case-insensitive)
   or creates it via `POST /api/v1/shelves` if it does not exist. The resolved
   shelf ID is cached in `shelf_mappings.grimmory_shelf_id`.
5. It fetches the current Grimmory shelf members and adds any Hardcover-list
   books that are missing from the shelf.
6. It resolves the shelf members back to Hardcover book IDs using
   `book_sources.external_id` (hardcover row) or `book_sources.grimmory_hardcover_book_id`
   (grimmory row), then adds any missing books to the mapped Hardcover list with
   `insert_list_book`.

This sync is bidirectional and additive only — books are never removed from
either side by this process. Shelf sync respects `dry_run`: no shelf creates or
book additions are made in dry-run mode.

---

## Sync Serialisation

All profile syncs are serialised via a module-level promise queue in
`src/server/sync/engine.ts`. At most one `runSyncImpl` call executes at a time,
regardless of whether the trigger was the scheduler, a manual UI request, or
startup. This prevents concurrent `reconcileBookIdentities` calls from producing
orphan book records or duplicate `book_sources` rows through mid-sync identity
remapping.

---

## Scheduled Sync

The `profile-sync` background job runs on a configurable interval. It is
controlled entirely from **Settings → Jobs**:

- **Interval** — preset options from 1 minute to 24 hours, plus Disabled. Stored
  as `sync.scheduleIntervalMinutes` in `app_settings`. A value of `0` disables the
  job without removing it from the scheduler.
- **Startup sync** — when `sync.startupSyncEnabled = true` (Settings → General),
  the sync job also fires once immediately on server startup, as long as the
  interval is not Disabled.

At run time the job queries all profiles where:

- `profiles.enabled = 1`
- `sync_settings.schedule_enabled = 1`

Only those profiles are synced. The per-profile `schedule_enabled` toggle (on the
user detail page, Sync Settings section) is what opts each user in to scheduled
runs. The dry-run behaviour follows the global `sync.dryRunDefault` setting.

Each scheduled run creates `sync_runs` rows and `sync_events` rows exactly as a
manual run does, so scheduled run history appears in the Sync History page
alongside manual runs.

### History Retention

The `maintenance` job runs daily at 3:00 AM and prunes `sync_runs` rows older
than `sync.historyRetentionDays` (default 7). `sync_events` rows are deleted
automatically via `ON DELETE CASCADE`. The retention period is configurable in
**Settings → General → History Retention**.

---

## Chaptarr

Chaptarr is an optional global integration (one instance shared across all
profiles). It is configured in **Settings → Chaptarr** with a base URL and API
key. The sync engine calls `syncChaptarrStatus(profileId)` after the main
Grimmory/Hardcover/Goodreads passes complete.

### What the Chaptarr pass does

1. Reads `chaptarr.baseUrl` and decrypts `chaptarr.apiKey` from `app_settings`.
   If either is blank the pass exits immediately — Chaptarr is fully optional.
2. Fetches `/api/v1/book` and filters to `monitored = true`.
3. Fetches `/api/v1/author` to build an `authorId → name` map (books carry only
   `authorId`, not a name, so this is required for title+author matching). Then
   fetches `/api/v1/bookfile?authorId=<id>` for every author with at most five
   concurrent requests (set `CHAPTARR_BOOKFILE_CONCURRENCY`, capped at 10, to
   adjust this) to
   build a `chaptarrBookId → filePath` map used for file-path matching (step 8).
4. Matches each monitored Chaptarr book to a canonical `book_id` using this chain
   against `book_sources` rows:
   - `hardcoverBookId` (strip `hc:`) → `source_type='hardcover'` `external_id` / `grimmory_hardcover_book_id`
   - `foreignBookId` (plain numeric) → same
   - `goodreadsBookId` (strip `gr:`) → source-provided Goodreads book IDs
   - `goodreadsWorkId` (strip `gr:`) → `source_type='goodreads'` `external_id` / `grimmory_goodreads_id`
   - `foreignEditionId` (strip `gr:` and media suffix) → source-provided Goodreads edition IDs
   - `titleSlug` → `hardcover_slug`
   - ISBNs from `editions[]` → `isbn13` / `isbn10`
   - title + resolved author name (exact normalised)
   - stripped title + resolved author name (relaxed)
   - on-disk file path → `grimmory_primary_file_path` on the grimmory source row

Numeric Goodreads/Hardcover identifiers are canonicalised during Chaptarr lookup
too, matching source-decorated values by their numeric core while preserving the
original API value in the stored source row.
5. Upserts a `book_sources(source_type='chaptarr')` row for each matched book,
   writing title, resolved author, best-effort series metadata, source-provided
   Hardcover/Goodreads/ASIN identifiers,
   `chaptarr_monitored`, `chaptarr_has_file`, `chaptarr_id_mismatch`, and
   `chaptarr_primary_file_path` (the on-disk path from step 3).
6. Deletes `book_sources(source_type='chaptarr')` rows for books no longer in the
   monitored set.
7. Promotes `sync_health = 'missing'` → `'pending_download'` on `user_book_states`
   rows where `chaptarr_monitored = 1` and `chaptarr_has_file = 0`.
8. Reverts `'pending_download'` → `'missing'` where the file has now landed
   (`chaptarr_has_file = 1`) so the next full sync can set it to `'synced'`
   once Grimmory picks up the file.

### Matching notes

- `goodreadsWorkId` in Chaptarr is a Goodreads **Work** ID. `grimmory_goodreads_id`
  is typically an edition/book ID — different numbering, cannot reliably cross-match.
  Hardcover ID matching is the most reliable path.
- The file-path fallback (step 8) catches books where Chaptarr's metadata is stale
  or its HC IDs point at the wrong book. Both Chaptarr and Grimmory point at the
  same NAS share, so a matching `chaptarr_primary_file_path` ↔
  `grimmory_primary_file_path` is an unambiguous identity signal. The global
  identity reconciler also uses matching file paths as high-confidence identity
  keys, so later reconciliation keeps those source rows together.
- Chaptarr may return combined series labels such as `Series Name #1` in
  `seriesTitle` without a separate series-position field. ShelfBridge parses the
  trailing `#<number>` into `series_number` when no dedicated number field exists.
- Books that don't match after all eight steps are genuinely absent from
  `book_sources` — usually books Chaptarr has that Grimmory/Hardcover don't track
  yet, or books whose file hasn't been downloaded yet (no path to compare).

### Settings and probe tool

The Settings → Chaptarr tab provides:

- **Test Connection** — verifies the URL and API key against `/api/v1/system/status`
- **Run Probe** — diagnostic tool that shows identifier field coverage across the
  full Chaptarr library, runs the eight-step match chain against `book_sources`, and
  reports matched/unmatched counts broken down by match method. Each unmatched book
  is clickable to reveal the full raw Chaptarr API payload for inspection.

---

## Audiobookshelf

Audiobookshelf is an optional per-user integration. The global base URL is set in
**Settings → Audiobookshelf**; each user supplies their own API key on the user
detail page under the Audiobookshelf tab. Connection can be tested from the user
detail page without requiring a save-first round trip.

### Library sync (Phase M)

Phase M fetches all ABS libraries for the configured server and filters to
`mediaType = 'book'` entries (audiobook libraries only; podcast libraries are
explicitly excluded). For each item in those libraries, ShelfBridge attempts to
link the ABS item to an existing canonical book using this priority chain:

1. Existing `book_sources(source_type='audiobookshelf')` row with a matching `external_id`
2. `libraryFiles[0].metadata.path` matched against `grimmory_primary_file_path` or `chaptarr_primary_file_path`
3. `metadata.asin` matched against audiobook-capable source rows using audiobook ASIN fields
4. `metadata.isbn` matched against audiobook-capable rows using `isbn13` or `isbn10`

Audiobook-capable means the candidate row's own format metadata already points to
audio, for example:

- `source_media_type = 'audiobook'`
- a known audiobook file path (`.m4b`, `.mp3`, `.m4a`, `.aac`)
- Hardcover `audio_seconds`
- an ABS ASIN already attached to that canonical row

ShelfBridge no longer treats stray audio-adjacent identifiers on ebook rows as
enough evidence to match an ABS item onto them.

When a match is found, the ABS item is stored as a `book_sources(source_type='audiobookshelf')`
row with `external_id = libraryItemId`, `audiobookshelf_duration`, `audiobookshelf_file_path`,
`audiobookshelf_asin`, and `audiobookshelf_runtime_validated = 1`.

### Progress sync (Phase N)

Phase N treats **Audiobookshelf as the source of truth** for audiobook listening
progress. It reads the current ABS position and pushes that progress outward to
Grimmory and Hardcover whenever either target differs meaningfully.

Listening progress from each source:

| Source | How progress is read | Unit |
|---|---|---|
| Audiobookshelf | `GET /api/me` → `mediaProgress[]` (filtered to `episodeId = null`) | 0–1 fraction |
| Grimmory | `GET /api/v1/app/books/{id}/progress` | 0–100 percentage |
| Hardcover | `user_book_reads[].progress` | 0–100 percentage |

After fetching ABS progress and consulting the in-memory Grimmory progress map
(built in Phase A) and the Hardcover `user_book_states` row, ShelfBridge compares
each target to the ABS percentage:

- **Target has no progress yet**: write if ABS progress is greater than 0%
- **Target has progress**: write if it differs from ABS by ≥ 0.1 percentage points

| Write direction | API call | Notes |
|---|---|---|
| ABS → Grimmory | `PUT /api/v1/app/books/{id}/progress` with `progressPercent` | Requires `primaryFile.id` from Grimmory book data. Audiobooks read back from Grimmory via `audiobookProgress.percentage`, while ebooks/files use the older generic progress fields. |
| ABS → Hardcover | `insert_user_book_read` / `update_user_book_read` with `progress_seconds`, `progress_pages = 0`, and `edition_id` | `progress_seconds` uses ABS `currentTime`, but falls back to `progress × duration` when ABS reports a broken zero current time or when `currentTime` materially disagrees with ABS's own percentage. Sending `progress_pages = 0` mirrors Hardcover's own web app payload and triggers percentage recalculation for audiobooks. |

Progress sync for a given ABS item is gated on `audiobookshelf_runtime_validated = 1`
(the item was successfully matched to a canonical book) and a known duration
greater than zero.

**HC user_book auto-creation**: when the Hardcover match has no `user_books` entry
(i.e., `hardcover_user_book_id` is null or zero — common when the book lives only
in a user's "Owned" list with a specific audio edition pinned but has never been
set to a reading status), Phase N automatically calls `insert_user_book` to create
the entry, using the resolved audiobook `edition_id` (prefer the stored Hardcover
edition, then the current Hardcover user-book edition, then the book's default
audio edition). The new `user_books.id` is stored back into
`user_book_states.hardcover_user_book_id`, and progress is written immediately in
the same run. Status is set to "Currently Reading" (2) or "Read" (3) based on
whether progress has reached 98%.

### HC edition mismatch detection

When an ABS item is matched to a book that also has a Hardcover audiobook edition,
ShelfBridge compares `audiobookshelf_duration` (from the ABS file) against
`hardcover_audio_seconds` (from the HC edition). If they differ by more than **5%**,
the book is flagged in the **ABS Runtime Mismatch** filter on the Audiobooks page.
This indicates the HC edition may be linked to a different recording than the file
you actually have — go to Hardcover and switch to the correct audio edition.

The `hardcover_audio_seconds` field is stored per book in `book_sources` during
Phase C and populated from the user's selected `edition_id` when that edition
has `audio_seconds > 0`.

### Shared Hardcover Books (Print + Audiobook Editions)

Hardcover gives one `user_books` row per (user, book) pair, not per edition —
so when a title exists in both a print/ebook Grimmory record and a separate
audiobook Grimmory record, both point at the **same** Hardcover book ID and
the same underlying `user_books` row, even though they are two distinct
canonical ShelfBridge books.

**Routing.** ShelfBridge decides which Grimmory sibling "owns" that shared
Hardcover book using a signal it controls, not Hardcover's own live data:

- If the audiobook sibling has a runtime-validated Audiobookshelf link
  (`book_sources.audiobookshelf_runtime_validated = 1`), the shared Hardcover
  book is always routed to the audiobook sibling — regardless of which
  edition Hardcover's API currently reports as the book's "current" edition
  for that user. This matters because editing *any* read record on a shared
  Hardcover book appears to retarget that pointer on Hardcover's side, which
  would otherwise cause the routing to flip between audiobook and print from
  one sync to the next depending on unrelated activity (e.g. a manually
  edited print read date).
- This ABS-ownership signal is computed once at the start of each sync run,
  anchored via the Grimmory audiobook row's own `grimmory_hardcover_book_id`
  field joined to its Audiobookshelf sibling's `book_id` — not via the
  `hardcover` source row's own `book_id`, because that is the value that
  drifts when the routing goes wrong; anchoring off it would prevent the
  signal from ever self-correcting after a bad run.
- If both the print/ebook sibling and the audiobook sibling are simultaneously
  `READING`/`RE_READING`/`PARTIALLY_READ` in Grimmory (i.e. the user is
  actively reading and listening to the same book at once), the shared
  Hardcover book is instead routed to the print/ebook sibling for that run
  (`book_progress_wins_shared_hardcover`). Audiobookshelf progress and status
  still sync normally to Grimmory and to ShelfBridge's own state in this case
  — only the Hardcover-side write is deferred to the print side, to avoid the
  two editions fighting over the one shared Hardcover progress/status field.

**Non-owning sibling writes are suppressed.** Whichever Grimmory sibling does
*not* currently own the shared Hardcover book must not push its own
status/progress into it — this applies both to the main Hardcover↔Grimmory
sync loop and to the fallback path that pushes unmatched Grimmory books into
Hardcover (Phase G). Without this, the non-owning sibling would be treated as
"a Grimmory book with no Hardcover match yet" and insert/overwrite the shared
`user_books` row on every run.

**Read record selection.** When ShelfBridge writes audiobook progress to
Hardcover, it targets a specific `user_book_reads` row. Two related pitfalls:

- A cached `hardcover_read_id` can go stale (Hardcover can delete or
  supersede a read independently of ShelfBridge). ShelfBridge verifies the
  cached ID is still present in the freshly fetched read list before reusing
  it, falling back to an existing open read on the target edition, then to
  inserting a new one.
- Hardcover returns each book's most recent reads ordered by database ID, not
  by which edition they belong to. On a shared book, a read that was simply
  edited more recently (e.g. a manually corrected print read date) can have a
  higher ID than the actively-tracked audiobook read despite being for an
  unrelated, already-finished period. ShelfBridge's own read/progress
  selection logic (`latestHardcoverRead`) is edition-aware for this reason:
  when a persisted target edition ID is known for the book, it prefers a read
  on that specific edition over whichever read merely has the highest ID.
- Hardcover also tracks a single "current edition" pointer on the shared
  `user_books` row itself, independent of which reads exist. This pointer can
  drift on its own (edited by Hardcover in response to read edits) even when
  the underlying read data is untouched. ShelfBridge checks this pointer
  against the persisted target edition on every sync — independently of
  whether progress or status also need a write — and re-patches it back when
  it has drifted, so a stale "current edition" pointer doesn't stay wrong
  indefinitely underneath otherwise-correct read data. See the comment next
  to the edition re-patch write for a note on a related Hardcover UI quirk.
