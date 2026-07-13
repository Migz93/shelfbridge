# ShelfBridge Architecture Overview

## What ShelfBridge Is

ShelfBridge is a self-hosted LAN-only web app that bridges book-tracking and
download management services:

- **Grimmory** — a self-hosted ebook server; the "on disk" source. All books in
  the Grimmory catalog are imported into ShelfBridge regardless of reading activity.
  User-specific reading status, progress, and ratings from Grimmory are surfaced per
  profile but do not determine whether the book exists in ShelfBridge.
- **Hardcover** — an optional cloud-based reading tracker per profile; bidirectional
  sync target when configured
- **Goodreads** — read-only import source per profile; shelf data flows into Grimmory
  only, never back to Goodreads
- **Chaptarr** — optional book download manager (Readarr fork); source of truth
  for whether a book has been requested and downloaded. When configured, ShelfBridge
  runs a Chaptarr status pass after each sync to update download state and promote
  missing books to `pending_download` when they are in Chaptarr's queue
- **Audiobookshelf** — optional self-hosted audiobook server; per-user listening
  progress is synced three-way between ABS, Grimmory, and Hardcover using a
  latest-wins strategy. Only book-type ABS libraries (not podcast libraries) are
  imported

ShelfBridge requires a local admin password before the UI can be used. The
Express API and cached image routes are protected by signed, HTTP-only session
cookies after setup.

---

## Core Model

ShelfBridge operates as a three-phase ETL hub:

1. **Import** — all four systems are imported independently. Grimmory and Chaptarr
   contribute "on disk" book records; Hardcover and Goodreads contribute per-profile
   reading state. Every source produces a `book_sources` row (book-level, no profile
   attached); per-profile reading activity produces `user_book_states` rows.
2. **Match** — the reconciler clusters rows into canonical `books` records using
   shared identity keys (Hardcover book ID, Goodreads ID, ISBN-13, ISBN-10,
   ASIN, file path, title+author, and cross-system IDs stored in Grimmory metadata).
   Matching is media-type aware, so book/ebook rows and audiobook rows for the same
   work can become separate canonical ShelfBridge entries.
3. **Sync** — for matched Hardcover ↔ Grimmory pairs: bidirectional, latest-wins
   sync when a profile has a Hardcover API token. Goodreads → Grimmory: read-only
   import. Audiobookshelf ↔ Grimmory ↔ Hardcover: three-way listening progress sync
   when Audiobookshelf is configured per user. Nothing is ever written back to
   Goodreads or Chaptarr.

Other rules:
- Every sync write is timestamp-gated: if incoming `sourced_at` is older than the
  stored `last_modified_at`, the write is skipped and a `superseded` event is recorded
- Each user (profile) has its own Grimmory credentials, optional Hardcover API
  token, and optional Goodreads ID
- The global Grimmory base URL in Settings is a fallback used when a profile does
  not override it
- Chaptarr URL is stored globally in `app_settings` as `chaptarr.baseUrl`;
  the Chaptarr API key is stored encrypted in `app_settings` as
  `chaptarr.apiKey`
- Audiobookshelf base URL is stored globally in `app_settings` as
  `audiobookshelf.baseUrl`. Per-user API keys are stored encrypted in the
  `audiobookshelf_connections` table

---

## Deployment Model

ShelfBridge runs as a single self-hosted container:

- Express 5 backend and REST API
- React 19 + Vite frontend (served statically from the same process in production)
- Background sync engine (fire-and-forget, runs in the same process)
- SQLite database (WAL mode)
- Winston rotating log files

All persistent data lives in `/config` inside the container, bind-mounted from
`/opt/shelfbridge` on the host. This keeps backups simple and lets the user
inspect or restore the database directly.

Port: **9303** (configurable via `PORT` env var).

When ShelfBridge runs behind a reverse proxy, enable **Settings → General →
Network → Trust Proxy** and restart the container. This makes Express trust one
proxy hop so rate limiting uses the real client IP from `X-Forwarded-For`
headers without accepting arbitrary proxy chains.

---

## Database

ShelfBridge uses SQLite with WAL (Write-Ahead Logging) mode enabled at startup.

WAL mode matters here because the background sync worker writes concurrently with
the web server serving API reads. WAL prevents the sync worker from blocking HTTP
responses by allowing concurrent readers and a single writer.

Schema version is tracked in the `schema_version` table. The current schema
version is defined in `src/server/db/schema.ts` as `CURRENT_SCHEMA_VERSION = 9`.

### Tables

| Table | Purpose |
|---|---|
| `app_settings` | Key-value store for all application settings |
| `auth_sessions` | Server-side ShelfBridge login sessions |
| `profiles` | One row per user; display name, enabled flag |
| `grimmory_connections` | Per-profile Grimmory credentials and connection status |
| `hardcover_connections` | Per-profile Hardcover API token, resolved username, and connection status |
| `goodreads_connections` | Per-profile Goodreads user ID, parsed RSS display name, enabled flag, and connection status |
| `audiobookshelf_connections` | Per-profile Audiobookshelf enabled flag, encrypted API key, and connection status |
| `sync_settings` | Per-profile sync toggles, source-tag setting, and schedule configuration |
| `shelf_mappings` | Maps Hardcover lists or Goodreads custom shelves to Grimmory shelves; `source` field distinguishes `'hardcover'` from `'goodreads'`; includes `source_list_id`, `source_list_name`, and cached `grimmory_shelf_id` |
| `books` | One row per canonical book variant; includes `media_type`, title, author, cover cache path, and last modified/sync timestamps |
| `book_sources` | One row per (book, source_type); book-level source data with no profile attached — stores external IDs, ISBNs, slugs, cross-system reference IDs, and Chaptarr monitored/has_file flags |
| `user_book_states` | One row per (book, profile, source_type); stores sync health, match confidence, `has_superseded` flag, reading status, rating, progress, shelves, and timestamps per user per source |
| `sync_runs` | One row per sync execution; counts written/skipped/superseded |
| `sync_events` | Per-book event rows recording what happened during a sync run |
| `image_cache` | One row per cached cover image; tracks source URL, local file path, cache freshness timestamps, and last error |
| `job_run_state` | Persists last-run timestamp and status for each background job across container restarts |

---

## Security Notes

ShelfBridge protects the web UI, REST API, and cached image route with a local
admin password. Password hashes are derived with `scrypt` and sessions are stored
server-side in `auth_sessions`; the browser receives a signed, HTTP-only,
SameSite cookie.

Grimmory passwords, Grimmory refresh tokens, Hardcover API tokens, and
Audiobookshelf per-user API keys are stored in the `encrypted_*` database columns
using an AES-256-GCM envelope. Chaptarr's global API key is stored with the same
envelope in `app_settings`. On startup, ShelfBridge migrates any older plaintext
values in those storage locations to encrypted storage. Runtime code decrypts
credentials only at the service-call boundary and does not store third-party
access tokens long term.

The encryption key is loaded from `SHELFBRIDGE_CREDENTIAL_KEY` when set. The
value must be a 32-byte key encoded as base64 or 64-character hex. If the
environment variable is not set, ShelfBridge generates `/config/credential-key`
with `0600` permissions and reuses it on later starts. Back up this key with the
database; losing it means encrypted credentials must be re-entered.

Logs pass through a redaction formatter that masks metadata keys containing
password, token, secret, credential, authorization, or API key. Do not expose
`/opt/shelfbridge`, database backups, logs, the generated credential key, or the
web UI to untrusted users.

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

## Major Subsystems

### Settings

Global configuration stored in the `app_settings` key-value table and served
through `GET /api/settings`. Covers:

- General: startup sync toggle, history retention period (days), conflict strategy
- Grimmory: global base URL
- Audiobookshelf: global base URL (shared by all profiles; per-user API keys live in `audiobookshelf_connections`)
- Download/Shelfmark: base URL

The sidebar refreshes when settings change and renders external links for
Grimmory, Shelfmark, and Chaptarr automatically whenever each service has a
base URL configured. No link appears for services with an empty base URL.

Timezone is **not** a settings field. It is controlled entirely by the `TZ`
environment variable passed to the container (e.g. `-e TZ=Europe/London`). The
Alpine image includes the `tzdata` package so named timezone values resolve
correctly. The logger formats timestamps as local ISO with UTC offset
(e.g. `2026-05-05T10:40:19+01:00`).

### User Profiles

Each user has their own set of credentials for each service. Profiles are
independent — syncing one user never affects another.

The add-user flow is a 4-step modal: Profile → Grimmory → Hardcover → Goodreads.
Hardcover and Goodreads can be skipped and configured later. Audiobookshelf is
enabled per user from the dedicated user detail page.
Editing happens on a dedicated user detail page at `/users/:id`, with top-level
tabs for General, Grimmory, Hardcover, Goodreads, and Audiobookshelf. The General tab shows
profile stats, last sync state, service connection status, and conflict strategy.
Dry run, Write Tag, and connection credentials live in the Grimmory tab. Write
Tag applies a `shelfbridge-<username>` Grimmory tag to matched books in the
profile's Hardcover or Goodreads source scope. Read-status sync, progress sync,
shelves sync, and Hardcover list ↔ Grimmory shelf mappings live in the Hardcover
tab; these Hardcover-specific features are skipped during sync until the profile
has a Hardcover API token (the list mapping section is hidden when
`syncShelvesEnabled` is disabled).
The Goodreads tab has Sync Read State and Sync Shelves toggles plus a custom
shelf ↔ Grimmory shelf mapping section that mirrors the Hardcover layout.

Connection test endpoints accept credentials in the request body so the UI can
test form values without requiring a save-first round trip. Successful Hardcover
tests store the resolved Hardcover username. Successful Goodreads tests attempt
to parse and store a display name from the public RSS channel title.

### Books UI And Identity

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

### Book Sources and User States

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
  high-confidence IDs and no overlapping title+author evidence
- exact normalized title + author groups remaining rows even when source identifiers
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
high-confidence identifier are merged by normalized title+author rather than being
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

### Image Cache

`src/server/image-cache.ts` — stale-while-refresh cover image caching.

Cached files are stored under `DATA_DIR/image-cache/` and served by an Express
static route at `/images`. The `image_cache` table tracks each entry:

| Column | Description |
|---|---|
| `id` | Auto-increment |
| `cache_key` | Logical key (e.g. `cover:<bookSourceId>`) |
| `entity_id` | The `book_sources.id` the entry belongs to |
| `source_url` | Original external URL (used for re-fetching public covers) |
| `local_file_path` | Absolute path to the file on disk |
| `local_web_path` | Web-accessible path returned to clients (e.g. `/images/<uuid>.jpg`) |
| `cached_at` | When the entry was first created |
| `last_refresh_at` | When the file was last successfully refreshed |
| `refresh_after` | Timestamp after which the entry is considered stale |
| `last_attempted_at` | Timestamp of the most recent fetch attempt |
| `last_error` | Error message from the last failed attempt (if any) |

**Two entry points:**

- `ensureCoverCached(bookSourceId, sourceUrl)` — used for public URLs (Hardcover,
  Goodreads). Cache key: `cover:<bookSourceId>`. Three states:
  - *Fresh*: refreshed within the last seven days → return `local_web_path` immediately
  - *Stale*: older than seven days → return existing path immediately and trigger a
    background refresh (stale-while-revalidate)
  - *Miss*: no entry → fetch inline, write file atomically, insert row
  - Validates that the response `Content-Type` starts with `image/`; enforces a
    20 MB size cap and a hard 15-second end-to-end timeout. A changed public
    source URL triggers an early background refresh because it is a strong signal
    that the upstream cover changed.

- `storeFetchedCover(bookSourceId, data)` — used for pre-fetched authenticated
  covers (Grimmory). Ordinary profile syncs reuse an existing on-disk cover and
  never re-download it. No source URL is stored; re-fetching is handled by the
  daily `image-cache-refresh` job via `refreshStaleGrimmoryCovers`.

All cover work discovered by a profile sync runs through a four-worker in-process
queue. Tasks are de-duplicated by cache key, have hard network deadlines, and do
not block identity reconciliation or status/progress sync. The daily refresh job
checks both public and authenticated covers and downloads them again only after
seven days, allowing ShelfBridge to detect changed upstream artwork without
re-fetching hundreds of images every few minutes.

**Atomic writes:** cover data is written to a temp file in the same directory,
then renamed into place with `fs.renameSync` to avoid partial reads. Background
refreshes replace the file with a new UUID filename and delete the old one after
the rename succeeds.

After identity reconciliation, ShelfBridge removes orphaned `image_cache` rows
whose `entity_id` no longer points at an existing `book_sources.id`. The cached
file is deleted only when no other cache row references it and the file path is
inside `DATA_DIR/image-cache/`.

`cover_cache_path` in `book_sources` is the only cover path sent to API clients —
external source URLs are never exposed to the browser.

### Job Scheduler

`src/server/job-scheduler.ts` + `src/server/scheduler.ts` — background job runner.

ShelfBridge uses a lightweight in-process scheduler (ported from Hubarr) that
supports both interval-based and daily-at-time jobs. State persists across
container restarts in the `job_run_state` table. Jobs do not overlap: if a prior
invocation is still active when its next interval arrives, that occurrence is
logged and skipped. Profile sync also checks the sync engine before creating run
records, preventing scheduled work from accumulating behind a manual sync.

Three jobs are registered at startup:

| Job ID | Name | Schedule | Task |
|---|---|---|---|
| `profile-sync` | Sync | Configurable interval (1 min – 24 h) or Disabled | Syncs all profiles with `schedule_enabled = true` |
| `maintenance` | Maintenance | Daily at 3:00 AM | Prunes `sync_runs` (and cascading `sync_events`) older than the configured `historyRetentionDays` |
| `image-cache-refresh` | Image Cache Refresh | Daily at 2:00 AM | Re-fetches all stale cover images: public URL covers via HTTP, Grimmory covers via authenticated re-download |

**Sync job interval** is stored in `app_settings` as `sync.scheduleIntervalMinutes`. A value of `0` means Disabled — the job is registered but immediately disabled in the scheduler. The interval can be updated at runtime from the Jobs tab; the scheduler reschedules without a restart.

**Startup sync**: when `sync.startupSyncEnabled = true`, the scheduler fires the `profile-sync` job immediately after server init (only if the interval is not Disabled).

**Image cache refresh** handles both cover types after the shared seven-day
freshness window: `refreshStaleCachedCovers` (in `image-cache.ts`) re-fetches
entries where `source_url IS NOT NULL`; `refreshStaleGrimmoryCovers` (in
`engine.ts`) handles entries where `source_url IS NULL` (Grimmory authenticated
covers) by re-authenticating and re-downloading. It uses the selected profile's
Grimmory URL when present and otherwise falls back to the global Grimmory URL.

The `GET /api/settings/jobs` endpoint returns live state for all registered jobs. `POST /api/settings/jobs/:id/run` triggers an immediate run. `PATCH /api/settings/jobs/profile-sync` updates the interval.

### Sync Engine

`src/server/sync/engine.ts` — the live implementation. For each profile it:

1. Authenticates with Grimmory (`POST /api/v1/auth/login`) to get a JWT when
   Grimmory is configured
2. Fetches the complete Grimmory book library in paginated batches when Grimmory
   is configured and reachable (`GET /api/v1/books/page?page=N&size=250`),
   including physical-only books
3. If a Hardcover API token is configured, fetches the Hardcover user ID
   (`me { id }`) then the full library (`user_books` GraphQL query, batched 250
   at a time, deduplicated by `book.id`). If no token is configured, skips the
   Hardcover source pass.
4. Runs the matcher (`src/server/sync/matcher.ts`): builds external-ID, ISBN,
   exact title+author, and relaxed title+author indexes from Grimmory books, then
   matches each fetched Hardcover book against them
5. **Phase B+C — Upserts `book_sources` rows** for every source: one
   `source_type='hardcover'` row per fetched Hardcover book, one
   `source_type='grimmory'` row per Grimmory book, one `source_type='goodreads'`
   row per Goodreads book (during enrichment). These are book-level writes with
   no profile attached.
6. **Phase D — Reconciles book identities** (`reconcileBookIdentities`): clusters
   all `book_sources` rows into canonical `books` records using union-find over
   shared identity keys. This is a global pass, not per-profile.
7. **Phases F–H — Upserts `user_book_states` rows** for each profile using the
   assigned `book_id` from Phase D. One row per (book, profile, source_type)
   where the user has reading activity. Computes sync decisions using
   `conflictStrategy`, timestamp comparison, and adaptive rating normalisation.
8. Applies status and rating writes if `dryRun = false` — `PUT
   /api/v1/app/books/:id/status` and `PUT /api/v1/app/books/:id/rating` for
   Grimmory when available, `update_user_book` or `insert_user_book` mutations
   for Hardcover when configured
9. Applies progress writes when `syncProgressEnabled = true` — Grimmory receives
   a percentage write against `primaryFile.id` when available, while Hardcover
   receives `progress_pages` on a user-book read record when configured
10. Records a `sync_events` row for every book-level decision
11. Enriches matched rows from Goodreads when configured, including optional
    Goodreads status/rating writes and optional Goodreads shelf writes to Grimmory
12. Applies Grimmory source tags when `syncWriteTagEnabled` is true, using a
    per-book metadata lock around the tag read-merge-write operation
13. **Hardcover shelf sync** (if a Hardcover token is configured and
    `syncShelvesEnabled`): loads Hardcover list ↔ Grimmory shelf mappings,
    fetches the profile's Hardcover lists in one GraphQL query, resolves Grimmory
    book IDs via `book_sources`, ensures each mapped shelf exists in Grimmory
    (creating it if absent), then additively syncs matched membership in both
    directions
14. **Chaptarr status pass** (if `chaptarr.baseUrl` and `chaptarr.apiKey` are
    set in `app_settings`): fetches monitored books from Chaptarr, fetches book
    file paths per author in parallel, matches each book to `book_sources` rows
    via an eight-step chain (IDs → ISBNs → title+author → file-path fallback),
    upserts `book_sources(source_type='chaptarr')` with `chaptarr_monitored /
    chaptarr_has_file / chaptarr_primary_file_path`, and promotes
    `sync_health = 'missing'` to `'pending_download'` on `user_book_states` rows
    for books in Chaptarr's queue that have no file yet
15. **Phase M — Audiobookshelf library sync** (if `audiobookshelf.baseUrl` is set
    globally and the profile has an ABS API key): fetches all ABS libraries,
    filters to `mediaType = 'book'` (audiobook libraries only, excluding podcasts),
    then for each item attempts to match by: existing ABS source row, file path vs
    audiobook-capable Grimmory/Chaptarr rows, audiobook ASIN vs audiobook-capable
    rows, or ISBN vs audiobook-capable rows. Upserts
    `book_sources(source_type='audiobookshelf')` with duration, file path, ASIN,
    and sets `audiobookshelf_runtime_validated = 1` for matched items. Rows are
    only treated as audiobook-capable when their own format/path metadata says so;
    stray audio-adjacent identifiers on ebook rows are not enough
16. **Phase N — Audiobookshelf progress sync** (if ABS is configured and at least
    one of Grimmory or Hardcover is available): fetches all ABS listening progress
    (`/api/me`, filtered to non-podcast items), then performs a three-way
    latest-wins comparison across ABS, Grimmory, and Hardcover. Writes the winning
    progress to every source that needs it — either because the source has no
    progress yet or because its progress differs from the winner by ≥ 0.1
    percentage points. ABS is updated via `PATCH /api/me/progress/{itemId}`;
    Grimmory via percentage progress write; Hardcover via `progress_seconds` on
    `insert_user_book_read` / `update_user_book_read` (audiobook editions use
    `progress_seconds` instead of `progress_pages`). When a Hardcover match exists
    but no `user_books` entry does (e.g., the book is in the user's "Owned" list
    with a specific edition but has never been marked as reading), Phase N
    automatically creates the `user_books` entry using the edition pinned in the
    list before writing progress. Logs a mismatch warning when ABS duration differs
    from HC `audio_seconds` by more than 5% — visible in the Books page ABS
    Runtime Mismatch filter
17. Updates the `sync_runs` record with final counts and `status = 'success'`

### Status Mapping

Hardcover exposes six current API statuses. Grimmory exposes those concepts plus
`UNSET`, `RE_READING`, and `PARTIALLY_READ`. ShelfBridge keeps the original source
status values in `user_book_states`, but groups some Grimmory states into the same
Hardcover write action.

Hardcover to Grimmory:

| Hardcover status_id | Grimmory ReadStatus |
|---|---|
| 1 — Want to Read | `UNREAD` |
| 2 — Currently Reading | `READING` |
| 3 — Read | `READ` |
| 4 — Paused | `PAUSED` |
| 5 — Did Not Finish | `ABANDONED` |
| 6 — Ignored | `WONT_READ` |

Grimmory to Hardcover:

| Grimmory ReadStatus | Hardcover status_id | Notes |
|---|---|---|
| `UNSET` | none | Ignored; no actionable reading state |
| `UNREAD` | none | Ignored to avoid adding default Grimmory books to Hardcover as Want to Read |
| `READING` | 2 — Currently Reading | Direct active-reading match |
| `RE_READING` | 2 — Currently Reading | Preserved locally, collapsed for Hardcover writes |
| `PARTIALLY_READ` | 2 — Currently Reading | Preserved locally, collapsed for Hardcover writes |
| `READ` | 3 — Read | Writes Grimmory `dateFinished` to Hardcover `last_read_date` when present |
| `PAUSED` | 4 — Paused | Hardcover API supports this status even if the website UI may hide it |
| `ABANDONED` | 5 — Did Not Finish | Direct match |
| `WONT_READ` | 6 — Ignored | Hardcover API supports this status even if the website UI may hide it |

Key files:

| File | Role |
|---|---|
| `src/server/sync/engine.ts` | Orchestration, DB upserts, sync decisions |
| `src/server/sync/matcher.ts` | Index building, ISBN/title+author matching, status mapping tables |
| `src/server/sync/hardcover.ts` | Hardcover GraphQL client, library fetch, mutation helpers |
| `src/server/sync/grimmory.ts` | Grimmory REST client, library fetch, status/rating/tag write helpers |
| `src/server/sync/audiobookshelf.ts` | Audiobookshelf REST client, library/progress fetch, progress write helpers |

Grimmory connection is optional — if Grimmory is unreachable or credentials fail,
the engine still fetches and stores Hardcover books when Hardcover is configured,
recording them as `missing`.
Hardcover connection is optional too — without a token, Hardcover fetches/writes
and list mappings are skipped while Grimmory and Goodreads processing continues.

### Frontend

React 19 + React Router v7 SPA, built by Vite and served statically by Express
in production. Tailwind CSS v4 with a fixed dark-mode palette.

Pages that auto-refresh while open: Dashboard, Sync History, Users.

Polling cadence: 2.5 s while a sync is actively running, 15 s at idle.
Polling pauses in the background; a fast-refresh window exits as soon as the
running sync completes.

---

## Important Invariants

- Only enabled profiles participate in syncing
- A sync write is only applied if `sourced_at` > `last_modified_at`; otherwise the
  event is recorded as `superseded` and the stored value is kept
- Dry run mode lets the sync engine report what it _would_ do without writing
  anything. Manual sync uses the global default unless the request supplies a
  `dryRun` override; profile-level `dryRunDefault` is stored with the user's sync
  settings.
- Profile syncs are serialised via a module-level promise queue in `engine.ts` —
  only one `runSync` call executes at a time. `reconcileBookIdentities` mutates
  global shared state (`books` and `book_sources`) and concurrent runs produce
  merge/remap collisions
- Grimmory source-tag writes are serialized per Grimmory base URL and book ID in
  the running ShelfBridge process so concurrent profile syncs do not overwrite
  each other's tags during metadata read-merge-write updates
- The "Superseded" filter on the Books page shows books where at least one write
  has been blocked by the timestamp guard — useful for diagnosing cases where a
  Goodreads import tried to overwrite a newer Hardcover-originated update
- Connection test endpoints always return a `TestResult` (`{ ok, message }`) and
  never throw — the UI can display the message directly
- The Books page source filters (`?source=hardcover`, `?source=goodreads`,
  `?source=on-disk`) are evaluated at the book level using pre-computed
  `Set<number>` of `book_id` values — not row-level field checks. This ensures
  include/exclude filters apply to the entire book cluster: excluding "On Disk"
  hides a book even if only the `book_sources(source_type='grimmory')` row
  triggers the match
- Catalog and dashboard queries anchor on `grimmory`, `hardcover`, and
  `goodreads` sources only. `chaptarr` and `audiobookshelf` sources are joined as
  supplemental metadata so unmatched artifacts from those sources do not appear as
  blank catalog books.
- Schema version is tracked in `schema_version`; the current version is
  `CURRENT_SCHEMA_VERSION = 9` in `src/server/db/schema.ts`
- `coverUrl` in all API book responses is always a local `/images/<uuid>.jpg`
  path from `book_sources.cover_cache_path` or `null` — external cover URLs from
  Hardcover, Grimmory, or Goodreads are never forwarded to the browser
- Timezone is never stored in application settings; it is set via the `TZ`
  environment variable. The `tzdata` package in the Alpine image ensures named
  timezone strings (e.g. `Europe/London`) resolve correctly
