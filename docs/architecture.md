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
  the Chaptarr API key is stored in `app_settings` as `chaptarr.apiKey`
- Audiobookshelf base URL is stored globally in `app_settings` as
  `audiobookshelf.baseUrl`. Per-user API keys are stored in the
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

Schema version is tracked with SQLite's built-in `PRAGMA user_version`, driven by
a `Migration[]` array in `src/server/db/migrations.ts` — the same pattern Hubarr
and Pacearr use. Each migration is a `{ version, description, up(db) }` entry;
`runMigrations()` applies every migration newer than the database's current
`user_version`, in ascending order, and rejects a database whose `user_version`
is *newer* than this build's `LATEST_MIGRATION_VERSION` (a downgrade to an older
image) rather than silently booting into a schema it doesn't understand.
Migration 1 is a single flattened `CREATE TABLE` block, so a fresh install
reaches a correct schema in one migration. Implementation rationale (transaction
boundaries, pragma-timing constraints, backup permissions) lives in code
comments in `migrations.ts` and `schema.ts`, not here.

Before applying any pending migration to a database that already has tables,
`initSchema()` takes one `VACUUM INTO` snapshot into `<data dir>/backups/`,
attempts to restrict it to owner-only permissions (best-effort — a permissions
failure is logged and does not block the backup or startup), and shares the
resulting path with both the legacy handover and `runMigrations()`. Old backups
beyond the 5 most recent are pruned, also best-effort. `initSchema()` (in
`src/server/db/schema.ts`) wires the whole startup sequence together:
WAL/foreign-key pragmas, the backup, the legacy handover if needed,
`runMigrations()`, an expired-`auth_sessions` cleanup, then
`reconcileBookIdentities()`.

Two guard primitives apply a migration step and verify it with
`PRAGMA foreign_key_check`, raising a `ForeignKeyViolationError` only for
violations the step itself introduced — a database can carry pre-existing,
unrelated foreign-key inconsistencies that must not block every future
migration:

| Primitive | Behavior | Used by |
|---|---|---|
| `runTransactionalStep(db, label, backupPath, step)` | Wraps `step` and the check in one transaction — a violation rolls the whole step back | Every migration in `runMigrations()`; the legacy handover's v7/v8/v9/v14 sub-steps |
| `runGuardedStep(db, label, backupPath, step)` | Runs `step`, checks after — a violation can only abort startup, not undo `step` | `legacyMigrateToV14()` as a whole (can't be one transaction — see `schema.ts`) |

> **Handover from the old `schema_version` table.** Before this pattern, schema
> version lived in a `schema_version` table with a sequential run of
> version-guarded `ALTER TABLE` and table-rebuild blocks. Any database that still
> has that table is pre-migrations-pattern: `initSchema()` runs that old sequential
> logic once (preserved as `legacyMigrateToV14()` in `schema.ts`) to bring it to
> the v14 shape — which is exactly migration 1. Only once `runGuardedStep()`'s
> backstop check on that has passed does it drop `schema_version` and set
> `user_version = 1` — deliberately *after* the check, not inside the guarded
> step, so a violation the backstop catches leaves `user_version` at 0 and the
> next restart re-attempts the whole handover, rather than the handover looking
> already-complete on retry. A brand-new install has no `schema_version` table
> and skips straight to `runMigrations()`. Do not add new migrations to
> `legacyMigrateToV14()`; new schema changes are a new entry in the `migrations`
> array with `version > 1`.

### Tables

| Table | Purpose |
|---|---|
| `app_settings` | Key-value store for all application settings |
| `auth_sessions` | Server-side ShelfBridge login sessions |
| `profiles` | One row per user; display name, enabled flag |
| `grimmory_connections` | Per-profile Grimmory credentials and connection status |
| `hardcover_connections` | Per-profile Hardcover API token, resolved username, and connection status |
| `goodreads_connections` | Per-profile Goodreads user ID, parsed RSS display name, enabled flag, and connection status |
| `audiobookshelf_connections` | Per-profile Audiobookshelf enabled flag, API key, and connection status |
| `sync_settings` | Per-profile sync toggles, source-tag setting, and schedule configuration |
| `shelf_mappings` | Maps Hardcover lists or Goodreads custom shelves to Grimmory shelves; `source` field distinguishes `'hardcover'` from `'goodreads'`; includes `source_list_id`, `source_list_name`, and cached `grimmory_shelf_id` |
| `books` | One row per canonical book variant; includes `media_type`, title, author, cover cache path, and last modified/sync timestamps |
| `book_sources` | Uniquely identified by `source_type`, `source_instance_id`, `external_id`, and `source_bucket` for a normal row with a populated `source_instance_id` — `source_bucket` is `'primary'`, or `'owned'`/`'shared'` for a Hardcover book's optional second row (see [docs/sync.md](sync.md)'s Hardcover Owned-List Import section). A legacy pre-per-profile-scoping row (`source_instance_id IS NULL`) is exempt from that uniqueness, since SQLite's `UNIQUE` constraint never treats two `NULL`s as equal. `book_id` links each row to its canonical book, and a canonical can have more than one row per source type. Stores external IDs, ISBNs, slugs, cross-system reference IDs, and Chaptarr monitored/has_file flags |
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
stored as plaintext in the local application database. They are never returned
by the API and the logging formatter redacts credential-shaped metadata.

Configured integration URLs must use HTTP or HTTPS and cannot contain embedded
credentials. Outbound integration requests disable automatic redirects, so an
authenticated request cannot be redirected to another host. Untrusted cover
requests may follow redirects only after each destination is validated as a
public address. LAN-hosted services remain supported over HTTP or HTTPS.

Logs pass through a redaction formatter that masks metadata keys containing
password, token, secret, credential, authorization, or API key. Do not expose
`/opt/shelfbridge`, database backups, logs, or the web UI to untrusted users.

---

---

## Major Subsystems

### Sync composition

The sync engine is the workflow coordinator: it loads the profile, fetches
source snapshots, persists them, reconciles canonical identities, applies sync
decisions, and records the run outcome. Focused modules keep the decisions at
its boundaries independently testable:

- `sync/adapters.ts` is the typed boundary to Hardcover, Grimmory, Goodreads,
  Chaptarr, and Audiobookshelf. Tests can provide fixture-backed adapters rather
  than making network requests.
- `sync/conflict-policy.ts` contains the pure Hardcover ↔ Grimmory status
  decision policy. It has no database or network dependency.
- `sync/pruning.ts` owns removal of rows absent from a complete source snapshot.
  A complete empty snapshot is authoritative; partial and failed snapshots
  cannot trigger destructive pruning.

The engine re-exports these APIs temporarily for compatibility; new callers and
tests should import the focused module directly.

### Settings

Global configuration stored in the `app_settings` key-value table and served
through `GET /api/settings`. Covers:

- General: startup sync toggle, history retention period (days), conflict strategy
- Grimmory: global base URL
- Audiobookshelf: global base URL (shared by all profiles; per-user API keys live in `audiobookshelf_connections`)
- Download/Shelfmark: base URL

The sidebar refreshes when settings change and renders external links for
Grimmory, Shelfmark, Chaptarr, and Audiobookshelf whenever each service has a
base URL configured **and** that integration's "Show link in navigation"
toggle (`addMenuLink`, per integration, defaults to `true`) is enabled. No
link appears for services with an empty base URL or with the toggle turned
off.

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

### Books And Identity

`src/server/db/bookIdentity.ts` clusters `book_sources` rows into canonical
`books` records with a union-find pass over shared identity keys. The two source
tables are `book_sources` (one row per book+source, no profile attached) and
`user_book_states` (one row per book+profile+source).

See [books-and-identity.md](books-and-identity.md) for the match-confidence
levels, the identity key precedence, the media-type split between `/books` and
`/audiobooks`, cover precedence, and the Books page filter model.

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
- `coverUrl` in all API book responses is always a local `/images/<uuid>.jpg`
  path from `book_sources.cover_cache_path` or `null` — external cover URLs from
  Hardcover, Grimmory, or Goodreads are never forwarded to the browser
- Timezone is never stored in application settings; it is set via the `TZ`
  environment variable. The `tzdata` package in the Alpine image ensures named
  timezone strings (e.g. `Europe/London`) resolve correctly
