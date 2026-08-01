# ShelfBridge REST API Reference

All routes are prefixed with `/api`. The server runs on port **9303** by default.

Except for `/api/health` and `/api/auth/*`, API routes require a valid
ShelfBridge session cookie. The first browser session must create the admin
password through `/api/auth/setup`; later sessions sign in through
`/api/auth/login`.

---

## Authentication

### `GET /api/auth/status`

Returns whether ShelfBridge has been configured and whether the current request
has a valid session.

```json
{ "configured": true, "authenticated": true }
```

### `POST /api/auth/setup`

Creates the initial admin password. Only works before authentication has been
configured.

```json
{ "password": "at least 8 characters" }
```

### `POST /api/auth/login`

Creates a signed session cookie for the admin password.

```json
{ "password": "string" }
```

### `POST /api/auth/logout`

Deletes the current server-side session and clears the browser cookie.

---

## Settings

### `GET /api/settings`

Returns the full application settings object.

**Response**
```json
{
  "general": {
    "trustProxy": false
  },
  "grimmory": { "baseUrl": "http://grimmory:8080", "addMenuLink": false },
  "download": { "baseUrl": "", "addMenuLink": false },
  "sync": {
    "startupSyncEnabled": false,
    "historyRetentionDays": 7,
    "conflictStrategy": "latest_wins"
  },
  "chaptarr": {
    "baseUrl": "http://chaptarr:8787",
    "apiKeyConfigured": true
  },
  "audiobookshelf": {
    "baseUrl": "http://abs:13378"
  }
}
```

The sidebar automatically shows links for Grimmory, Shelfmark, and Chaptarr
whenever their `baseUrl` values are set. The legacy `addMenuLink` fields may
still appear in the settings payload for compatibility, but the UI no longer
uses them to decide whether those links render.

### `PATCH /api/settings`

Updates one or more settings sections. Only the sections present in the body
are updated; others are untouched.

**Body** (all fields optional; include only the section(s) to update)
```json
{
  "general": {
    "trustProxy": false
  },
  "grimmory": { "baseUrl": "string", "addMenuLink": false },
  "download": { "baseUrl": "string", "addMenuLink": false },
  "sync": {
    "startupSyncEnabled": false,
    "historyRetentionDays": 7,
    "conflictStrategy": "latest_wins | grimmory_wins | hardcover_wins"
  },
  "chaptarr": {
    "baseUrl": "string",
    "apiKey": "string"
  },
  "audiobookshelf": {
    "baseUrl": "string"
  }
}
```

> **Note:** Timezone is not a settings field. Set the `TZ` environment variable
> on the container instead (e.g. `-e TZ=Europe/London`).

> **Reverse proxies:** Set `general.trustProxy` to `true` when ShelfBridge runs
> behind a reverse proxy that sends `X-Forwarded-For`. Restart the container
> after changing this setting.

### `POST /api/settings/grimmory/test`

Tests connectivity to the global Grimmory base URL.

**Body**
```json
{ "baseUrl": "http://grimmory:8080" }
```

**Response** — `TestResult`
```json
{ "ok": true, "message": "Grimmory server is reachable" }
```

### `GET /api/settings/jobs`

Returns the current state of all registered background jobs.

**Response** — `JobInfo[]`
```json
[
  {
    "id": "profile-sync",
    "name": "Sync",
    "intervalDescription": "Every hour",
    "nextRunAt": "2026-05-07T10:00:00.000Z",
    "lastRunAt": "2026-05-07T09:00:00.000Z",
    "lastRunStatus": "success",
    "isRunning": false
  },
  {
    "id": "maintenance",
    "name": "Maintenance",
    "intervalDescription": "Daily at 3:00 AM",
    "nextRunAt": "2026-05-08T03:00:00.000Z",
    "lastRunAt": null,
    "lastRunStatus": null,
    "isRunning": false
  },
  {
    "id": "image-cache-refresh",
    "name": "Image Cache Refresh",
    "intervalDescription": "Daily at 2:00 AM",
    "nextRunAt": "2026-05-08T02:00:00.000Z",
    "lastRunAt": null,
    "lastRunStatus": null,
    "isRunning": false
  }
]
```

`nextRunAt` is `null` when the job is disabled. `lastRunAt` and `lastRunStatus`
are `null` until the job has run at least once. `isRunning` is `true` while the
job's async task is executing.

### `POST /api/settings/jobs/:id/run`

Triggers a job to run immediately in the background. The response returns as soon
as the job is dispatched, not when it completes.

Valid `id` values: `profile-sync`, `maintenance`, `image-cache-refresh`.

**Response**
```json
{ "triggered": true }
```

Returns `404` if the job ID is unknown. Returns `409` when that job is already
running; overlapping invocations are not queued.

### `PATCH /api/settings/jobs/:id`

Updates the schedule for a configurable job. Currently only `profile-sync`
accepts this endpoint.

**Body**
```json
{ "intervalMinutes": 60 }
```

Valid values for `intervalMinutes`: `0` (Disabled), `1`, `2`, `5`, `10`, `15`,
`30`, `60`, `120`, `240`, `360`, `720`, `1440`. A value of `0` disables the job
without removing it from the scheduler. The setting persists in `app_settings` as
`sync.scheduleIntervalMinutes` and takes effect immediately.

**Response**
```json
{ "updated": true }
```

### `GET /api/settings/about`

Returns build and runtime information.

**Response**
```json
{
  "version": "0.1.0",
  "buildChannel": "local",
  "commitSha": "local",
  "dataDir": "/config",
  "tz": "UTC",
  "dbVersion": 1
}
```

---

## Profiles (Users)

### `GET /api/profiles`

Returns a summary of all profiles.

**Response** — `ProfileSummary[]`

Each summary includes connection statuses, last sync timestamp/status, book count,
and missing count.

### `POST /api/profiles`

Creates a new profile. Also creates default sync settings for it.

**Body**
```json
{ "displayName": "Alice" }
```

**Response**
```json
{ "id": 1 }
```

### `GET /api/profiles/:id`

Returns the full profile including connection details and sync settings.

**Response** — `Profile`

Includes nested `grimmory`, `hardcover`, `goodreads`, and `syncSettings` objects.
Each connection object includes `status`, `lastTestedAt`, `lastSuccessAt`.
Hardcover connections also include `hardcoverUsername` when it has been resolved
by a successful token test, plus optional `syncListId` and `syncListName` fields
when the profile is scoped to a single Hardcover list. Goodreads connections
include `goodreadsUserId`, `goodreadsUsername`, and optional `syncShelfName`; the
username is parsed from the public RSS channel when available.

`syncSettings.syncWriteTagEnabled` controls the Grimmory-tab `Write Tag` setting.
When true, matched books from the profile's scoped Hardcover and/or Goodreads
source lists receive a Grimmory metadata tag named `shelfbridge-<username>`
during sync.

### `PATCH /api/profiles/:id`

Updates any combination of profile fields. Only keys present in the body are changed.
`hardcover.apiToken` is optional; profiles without a stored Hardcover token skip
Hardcover fetches and writes during sync.

**Body** (all keys optional)
```json
{
  "displayName": "string",
  "enabled": true,
  "grimmory": { "username": "string", "password": "string", "baseUrl": "string (optional)" },
  "hardcover": { "apiToken": "string", "syncListId": 123, "syncListName": "Want to Read" },
  "goodreads": { "goodreadsUserId": "string", "enabled": true, "syncShelfName": "want-on-kindle" },
  "syncSettings": {
    "syncStatusEnabled": true,
    "syncProgressEnabled": true,
    "syncShelvesEnabled": true,
    "syncGoodreadsEnabled": false,
    "syncGoodreadsStatusEnabled": false,
    "syncGoodreadsShelvesEnabled": false,
    "syncWriteTagEnabled": false,
    "conflictStrategy": "latest_wins | grimmory_wins | hardcover_wins",
    "scheduleEnabled": false,
    "scheduleCron": "0 * * * *",
    "dryRunDefault": true
  }
}
```

### `DELETE /api/profiles/:id`

Removes the profile and all associated connections, sync settings, and book links.

### `GET /api/profiles/:id/hardcover/lists`

Fetches the profile's Hardcover lists using the stored API token.
Returns `400` when the profile has no stored Hardcover token.

**Response**
```json
{ "lists": [ { "id": 1, "name": "Currently Reading", "slug": "currently-reading" } ] }
```

### `GET /api/profiles/:id/grimmory/shelves`

Authenticates with Grimmory using the profile's stored credentials and returns the available shelves.

**Response**
```json
{ "shelves": [ { "id": 3, "name": "Want to Read" } ] }
```

### `GET /api/profiles/:id/list-mappings`

Returns the current Hardcover list ↔ Grimmory shelf mappings for the profile.
Mappings are additive during sync: matched books missing from either side are
added to the other side, and no removals are performed.

**Response**
```json
{
  "mappings": [
    {
      "id": 1,
      "hardcoverListId": 42,
      "hardcoverListName": "Currently Reading",
      "grimmoryShelfName": "Currently Reading",
      "grimmoryShelfId": 3,
      "enabled": true
    }
  ]
}
```

### `POST /api/profiles/:id/list-mappings`

Replaces all Hardcover list ↔ Grimmory shelf mappings for the profile. Performs a
full replace — all existing mappings are deleted and the new set is inserted.

**Body**
```json
{
  "mappings": [
    {
      "hardcoverListId": 42,
      "hardcoverListName": "Currently Reading",
      "grimmoryShelfName": "Currently Reading"
    }
  ]
}
```

**Response**
```json
{ "ok": true }
```

---

## Connection Tests

All test endpoints accept credentials in the request body. If body credentials are
provided they are used directly for the test — no save-first round trip is needed.
If a stored connection exists, its status is updated after a test regardless of
which credentials were used.

### `POST /api/profiles/:id/test/grimmory`

**Body** (all optional — falls back to stored values if omitted)
```json
{ "username": "string", "password": "string", "baseUrl": "string" }
```

**Response** — `TestResult`
```json
{ "ok": true, "message": "Logged in as alice" }
```

### `POST /api/profiles/:id/test/hardcover`

**Body** (optional — falls back to stored token if omitted)
```json
{ "apiToken": "string" }
```

**Response** — `TestResult`
```json
{ "ok": true, "message": "Connected as alice", "username": "alice" }
```

On success, ShelfBridge stores the resolved Hardcover username on the profile.
If no request token is supplied and no token is stored on the profile, the test
returns a failed `TestResult`.

### `POST /api/profiles/:id/test/goodreads`

**Body** (optional — falls back to stored user ID if omitted)
```json
{ "goodreadsUserId": "12345678-alice" }
```

**Response** — `TestResult`
```json
{ "ok": true, "message": "Goodreads profile found for Alice", "username": "Alice" }
```

`username` is included only when ShelfBridge can parse a display name from the
Goodreads RSS channel title. On success, the parsed value is stored on the
profile as `goodreadsUsername`.

### `POST /api/profiles/:id/test/audiobookshelf`

Tests the Audiobookshelf connection for a profile using the global base URL and the
supplied (or stored) API key. The test calls `GET /status` to verify server
reachability and `GET /api/me` to verify the API key.

**Body** (optional — falls back to stored API key if omitted)
```json
{ "apiKey": "string" }
```

**Response** — `TestResult`
```json
{ "ok": true, "message": "Connected to Audiobookshelf as alice" }
```

On a successful test the API key is saved to the profile and the connection status
is updated. If no API key is provided and none is stored, the test returns a failed
`TestResult`.

---

## Books

### `GET /api/books`

Returns a paginated, filtered list of canonical ShelfBridge book summaries with
facet counts. Filters match books that have at least one per-user relationship
matching the selected criteria.

**Query parameters**

| Param | Type | Default | Description |
|---|---|---|---|
| `page` | number | 1 | Page number (1-based) |
| `pageSize` | number | 48 | Items per page |
| `profileId` | comma-separated numbers | — | Include only these profiles, and only when that profile has actual imported activity for the book |
| `excludeProfileId` | comma-separated numbers | — | Exclude these profiles |
| `status` | string | — | Aggregate reading-state filter: `UNREAD`, `READING`, `READ`, `ABANDONED` |
| `source` | comma-separated strings | — | Include sources: `hardcover`, `goodreads`, `on-disk` |
| `excludeSource` | comma-separated strings | — | Exclude sources: `hardcover`, `goodreads`, `on-disk` |
| `chaptarr` | string | — | Chaptarr presence filter: `in` or `out` |
| `action` | string | — | Shortcut filter: `add-to-chaptarr`, `grab-in-chaptarr`, `review-in-grimmory`, `fix-chaptarr-id`, `id-review`, `probable-duplicates`, `abs-runtime-mismatch` |
| `mediaType` | string | `book` | Canonical media bucket: `book`, `audiobook`, or `all` |
| `q` | string | — | Free-text search: case-insensitive substring match against `title` and `author` |
| `sortBy` | string | `updated-desc` | Sort order: `updated-desc`, `updated-asc`, `title-asc`, `title-desc` |

**Response**
```json
{
  "items": [ /* BookSummary[] — one row per canonical books.id */ ],
  "total": 42,
  "facets": {
    "status": { "UNREAD": 30, "READING": 5, "READ": 7, "ABANDONED": 0 },
    "statusAllCount": 42,
    "profiles": [ { "profileId": 1, "displayName": "Alice", "count": 42 } ],
    "allCount": 42,
    "sourceAllCount": 42,
    "hardcoverCount": 38,
    "goodreadsCount": 18,
    "onDiskCount": 25,
    "chaptarrInCount": 7,
    "chaptarrOutCount": 35,
    "addToChaptarrCount": 12,
    "grabInChaptarrCount": 2,
    "reviewInGrimmoryCount": 1,
    "fixChaptarrIdCount": 0,
    "idReviewCount": 3,
    "probableDuplicateCount": 1,
    "absRuntimeMismatchCount": 0
  }
}
```

`GET /api/books` now powers both catalog pages:

- `/books` calls it with the default `mediaType=book`
- `/audiobooks` calls it with `mediaType=audiobook`

Facet counts are computed after the media-type split, so the Books page excludes
audiobooks from its totals and the Audiobooks page excludes non-audiobook books.
Profile facet counts also use actual per-user relationships only; passive
catalog presence from shared sources like Grimmory and Chaptarr does not count
toward a user's chip total.

### `GET /api/books/:id`

Returns full detail for a canonical ShelfBridge book, including per-user
relationships for profiles that actually have imported activity for that book.

The `:id` path parameter is `books.id`.

**Response** — `BookDetail`

Extends aggregate `BookSummary` with canonical book identifiers plus
`relationships[]`. Each relationship covers one active profile view of the
book, aggregated from `book_sources` and `user_book_states` for that profile.
Profiles with no imported presence for the canonical book are omitted from this
array even though the server internally cross-joins profiles when building the
catalog query.

Audiobook import metadata is included in these responses so clients can inspect
which source thinks a record is a book versus an audiobook.

| Field | Description |
|---|---|
| `mediaType` | Aggregate format classification for the canonical book: `book`, `audiobook`, or `unknown` |
| `isbn13`, `isbn10` | ISBNs from whichever source provided them |
| `seriesName`, `seriesNumber` | Canonical series metadata selected from linked rows |
| `relationships` | Per-user book relationships (`BookRelationship[]`) |

Each `BookRelationship` includes:

| Field | Description |
|---|---|
| `id` | `profile_id` — the profile this relationship belongs to |
| `profileId`, `profileName` | User/profile that owns this relationship |
| `grimmoryLastReadTime` | Grimmory `lastReadTime` timestamp |
| `grimmoryDateFinished` | Grimmory top-level `dateFinished`, present when current status is `READ` |
| `grimmoryProgress` | Grimmory read progress percentage (0–100), from the app progress endpoint |
| `grimmoryPrimaryFileId` | Grimmory primary file ID used for progress writes |
| `grimmoryPrimaryFilePath` | Grimmory `primaryFile.filePath`, used for file-path audiobook matching |
| `grimmoryMediaType` | Grimmory format inferred from metadata and/or the primary file path |
| `grimmoryBaseUrl` | Resolved Grimmory base URL (profile override → global setting) |
| `hardcoverMediaType` | Hardcover format inferred from the user's selected `edition_id` and edition metadata; explicit `edition_format` wins when Hardcover's default edition pointers disagree |
| `hardcoverEditionId` | Hardcover `user_books.edition_id` when available |
| `hardcoverEditionFormat` | Hardcover edition-format text for the selected edition when available |
| `chaptarrBookId` | Matched Chaptarr book ID for this canonical book |
| `chaptarrMediaType` | Chaptarr `mediaType` / monitored-format classification when known |
| `chaptarrPrimaryFilePath` | Downloaded Chaptarr file path when known |
| `hardcoverUpdatedAt` | Hardcover `user_books.updated_at` |
| `hardcoverLastReadDate` | Hardcover `last_read_date` |
| `hardcoverProgress` | Hardcover latest read-record progress percentage (0–100) |
| `hardcoverProgressPages` | Hardcover latest read-record page progress |
| `hardcoverPages` | Hardcover page count used for percentage/page conversion |
| `hardcoverSlug` | Hardcover book slug — construct link as `https://hardcover.app/books/{slug}` |
| `goodreadsReadAt` | Goodreads read-at date |
| `goodreadsBookId` | Goodreads numeric book ID (from enrichment), or `null` |
| `goodreadsIsbn13` | ISBN-13 as recorded by Goodreads, or `null` |
| `goodreadsIsbn10` | ISBN-10 as recorded by Goodreads, or `null` |
| `goodreadsMatchType` | How the Goodreads match was established: `goodreads_id \| isbn13 \| isbn10 \| title_author \| null` |
| `audiobookshelfItemId` | ABS library item ID (`libraryItemId`), or `null` when no ABS source is linked |
| `audiobookshelfDuration` | Total audiobook duration in seconds, or `null` |
| `audiobookshelfFilePath` | Primary file path in ABS, or `null` |
| `audiobookshelfAsin` | ASIN from ABS metadata, or `null` |
| `audiobookshelfRuntimeValidated` | Whether the ABS item was successfully matched and validated against a canonical book |
| `audiobookshelfProgress` | Listening progress percentage (0–100), or `null` |
| `audiobookshelfCurrentTime` | Current playback position in seconds, or `null` |
| `audiobookshelfIsFinished` | Whether listening progress is ≥ 99% |
| `audiobookshelfUpdatedAt` | ISO timestamp of the last ABS progress update, or `null` |
| `lastSyncDecision` | Human-readable decision string from the last sync run |
| `matchType` | How the Grimmory/Hardcover match was established |
| `shelfMemberships` | Grimmory shelf memberships recorded for this relationship |

> **`coverUrl`** in all book responses (`BookSummary` and `BookDetail`) is always
> a local `/images/<uuid>.jpg` path or `null`. External cover URLs from Hardcover,
> Grimmory, or Goodreads are never forwarded to the browser.

Canonical cover selection is reconciled server-side from `book_sources` rows.
Current priority:

1. Grimmory row with an explicit `cover_url`
2. Hardcover row (including the user's specific Hardcover edition cover when available)
3. Grimmory fallback cached cover
4. Other source covers

Within the same priority, cached local files win over remote URLs, and newer
rows win ties.

### `POST /api/books/:bookId/relationships/:linkId/write-grimmory-id`

Writes one reviewed external ID from the ShelfBridge source row into Grimmory
metadata for a user relationship that is already linked to Grimmory.

**Body**
```json
{ "source": "goodreads" }
```

`source` may be:

- `goodreads` — writes `goodreads_book_id` into Grimmory `metadata.goodreadsId`
- `hardcover` — writes `hardcover_book_id` into Grimmory
  `metadata.hardcoverBookId` and `hardcover_slug` into
  `metadata.hardcoverId`

The endpoint authenticates to Grimmory using the linked profile's credentials,
updates Grimmory with `replaceMode=REPLACE_WHEN_PROVIDED`, then updates the local
`grimmory_*` external-ID columns. Grimmory v3.0.3 requires the metadata wrapper
shape with an explicit empty `clearFlags` object for these targeted ID writes;
without `clearFlags`, Grimmory returns a 500. Sync never calls this endpoint
automatically; it is intended for explicit user review actions from the book
detail page.

## Dashboard

### `GET /api/dashboard`

Returns everything needed to render the dashboard in a single request.

**Response**
```json
{
  "stats": {
    "linkedProfiles": 2,
    "totalBooks": 150,
    "missingInGrimmory": 5,
    "needsReview": 3
  },
  "recentlyAdded": [ /* BookSummary[] — up to 20 */ ],
  "recentActivity": [ /* SyncRun[] — up to 10 */ ],
  "profileSummaries": [ /* ProfileSummary[] */ ]
}
```

---

## Sync History

### `GET /api/history`

Returns a paginated list of sync runs.

**Query parameters**

| Param | Type | Default | Description |
|---|---|---|---|
| `page` | number | 1 | Page number |
| `pageSize` | number | 10 | Items per page |
| `status` | string | — | Filter: `running`, `success`, `error` |

**Response**
```json
{
  "results": [ /* SyncRun[] */ ],
  "pageInfo": { "page": 1, "pageSize": 10, "total": 42, "pages": 5 }
}
```

### `GET /api/history/:id`

Returns a sync run with its full event list.

**Response** — `SyncRunDetail`

Extends `SyncRun` with an `events: SyncEvent[]` array. Each event includes
`bookTitle`, `eventType`, `direction`, `decision`, and `details`.

---

## Sync

### `POST /api/sync/run`

Triggers a sync run in the background. Returns immediately with the run ID(s).

**Body** (all optional)
```json
{ "profileId": 1, "dryRun": true }
```

- `profileId`: sync a specific profile only; omit to sync all enabled profiles
- `dryRun`: override dry-run mode for this request; when omitted, the route uses
  the global `sync.dryRunDefault` setting

Sync runs are started in the background and the response returns immediately with
the created run IDs. When multiple profile syncs overlap, Grimmory source-tag
writes are serialised per Grimmory book inside the ShelfBridge process so
read-merge-write tag updates do not drop another user's tag.

**Response**
```json
{ "ok": true, "runIds": [7] }
```

---

## Image Cache

### `GET /images/:filename`

Serves a cached cover image file. This is a static file route, not prefixed with
`/api`. Files are served from `DATA_DIR/image-cache/` inside the container.

`filename` is a UUID-based filename assigned at cache time (e.g.
`3f2a1b4c-….jpg`). The path is stored in `book_sources.cover_cache_path` and
returned as `coverUrl` in book API responses.

Clients should treat these URLs as opaque — do not construct them manually.
Request the book record from the API and use the `coverUrl` field directly.
Cached image URLs can be removed after identity reconciliation if their backing
`book_sources` row no longer exists.

---

## Health

### `GET /api/health`

Simple liveness check.

**Response**
```json
{ "ok": true }
```
