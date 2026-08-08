# Image Caching

Cover image caching for ShelfBridge, using a stale-while-refresh model.
Split out of `architecture.md` — that file describes the system shape, this one
describes the cache in detail.

## Overview

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

