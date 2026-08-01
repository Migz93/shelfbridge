<!-- shared: structure — headings kept in sync across Migz93 self-hosted apps, content is app-specific -->

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

---

## Database Migrations

ShelfBridge uses SQLite with WAL (Write-Ahead Logging) mode enabled at startup.

WAL mode matters here because the background sync worker writes concurrently with
the web server serving API reads. WAL prevents the sync worker from blocking HTTP
responses by allowing concurrent readers and a single writer.

Schema version is tracked in the `schema_version` table, with the current version
defined in `src/server/db/schema.ts` as `CURRENT_SCHEMA_VERSION`. `initSchema()`
creates every table, then applies a sequential run of version-guarded
`ALTER TABLE` and table-rebuild blocks in the same file.

> **This diverges from the sibling projects.** Hubarr and Pacearr use SQLite's
> built-in `PRAGMA user_version` with a `Migration[]` array in
> `src/server/db/migrations.ts`, where each migration runs inside its own
> transaction. Moving ShelfBridge onto that pattern is tracked in
> [#58](https://github.com/Migz93/shelfbridge/issues/58), together with
> [#32](https://github.com/Migz93/shelfbridge/issues/32) for the crash-safety
> properties it should deliver. Do not hardcode the current version number in
> this doc — it goes stale.

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

---

## Auth And Setup

ShelfBridge protects the web UI, REST API, and cached image route with a local
admin password. Password hashes are derived with `scrypt` and sessions are stored
server-side in `auth_sessions`; the browser receives a signed, HTTP-only,
SameSite cookie.

Third-party credentials — Grimmory passwords and refresh tokens, Hardcover API
tokens, Audiobookshelf per-user API keys, and Chaptarr's global API key — are
stored in `encrypted_*` columns using an AES-256-GCM envelope. Runtime code
decrypts them only at the service-call boundary and does not store third-party
access tokens long term.

> Key management is under review in
> [#55](https://github.com/Migz93/shelfbridge/issues/55) — the goal is for
> encryption to stay while the key stops being something the user has to know
> about. Don't document the current key lifecycle here until that lands.

Logs pass through a redaction formatter that masks metadata keys containing
password, token, secret, credential, authorization, or API key. Do not expose
`/opt/shelfbridge`, database backups, logs, or the web UI to untrusted users.

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

### Image Cache

`src/server/image-cache.ts` — stale-while-refresh cover image caching, backed by
the `image_cache` table and served from `/images`.

See [image-caching.md](image-caching.md) for the cache states, the table schema,
the two entry points, atomic-write behaviour, and orphan cleanup.

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

`src/server/sync/engine.ts` — the live implementation, run per profile.

The step-by-step behaviour, conflict resolution, status mapping, and per-source
passes are documented in [sync.md](sync.md). That file is the source of truth;
this section only records which module owns what.

| File | Role |
|---|---|
| `src/server/sync/engine.ts` | Orchestration, DB upserts, sync decisions |
| `src/server/sync/matcher.ts` | Index building, ISBN/title+author matching, status mapping tables |
| `src/server/sync/hardcover.ts` | Hardcover GraphQL client, library fetch, mutation helpers |
| `src/server/sync/grimmory.ts` | Grimmory REST client, library fetch, status/rating/tag write helpers |
| `src/server/sync/audiobookshelf.ts` | Audiobookshelf REST client, library/progress fetch, progress write helpers |

Grimmory and Hardcover connections are both optional. If either is unreachable or
unconfigured, the engine continues with the sources that remain and records
affected books as `missing`.

### Frontend

React 19 + React Router v7 SPA, built by Vite and served statically by Express
in production. Tailwind CSS v4 with a fixed dark-mode palette.

Pages that auto-refresh while open: Dashboard, Sync History, Users.

Polling cadence: 2.5 s while a sync is actively running, 15 s at idle.
Polling pauses in the background; a fast-refresh window exits as soon as the
running sync completes.

---

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
- Grimmory source-tag writes are serialised per Grimmory base URL and book ID in
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
