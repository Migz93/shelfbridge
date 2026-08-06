<!-- shared: structure — headings kept in sync across Migz93 self-hosted apps, content is app-specific -->

# Testing

ShelfBridge uses Node's built-in [test runner](https://nodejs.org/api/test.html)
(`node:test` + `node:assert/strict`, run through `tsx`) for server-side tests —
no Jest/Vitest, no mocking library. Tests either exercise a real, isolated SQLite
database (via `tests/server/test-db.ts`) or run the sync engine with hand-rolled
fake adapters standing in for Hardcover/Grimmory/Goodreads/Chaptarr HTTP calls.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Runs the automated test suite (`tests/server/`). Also what CI runs. |
| `npm run check` | Runs TypeScript checks for client and server projects |
| `npm run build` | Builds the Vite client and TypeScript server |
| `npm audit --omit=dev` | Checks production dependency advisories |

## Server Tests

`npm test` sets `DATA_DIR=./.test-data` so tests never touch your real `./data`
directory; `.test-data/` is gitignored.

Most tests should use `createTestDatabase()` from `test-db.ts`, which spins up a
fresh temp-dir SQLite database with the current schema applied — no shared state
between tests.

`sync-engine.test.ts` is the one exception: `runSyncImpl` always operates on the
`db/index.ts` singleton rather than an injected database, so that file points
`DATA_DIR` at its own private temp dir before importing the engine, and every
test in it seeds its own profile and scopes assertions to that profile's id.

## Playwright End-To-End Tests

ShelfBridge uses [Playwright](https://playwright.dev/) for end-to-end tests, mirroring
[hubarr](https://github.com/Migz93/hubarr)'s setup. Tests run against a **live, fully
set-up ShelfBridge instance** — there is no mocking or test database.

Tests are read-only unless a spec file's own doc comment says otherwise. The one
exception is `jobs.spec.ts`, which triggers the Maintenance job — safe because it
only prunes rows already past the retention window, with no external side
effects. Sync and Image Cache Refresh are never triggered this way, since they
write real data back to Hardcover/Audiobookshelf/Grimmory and to those services'
APIs respectively.

### First-time setup

1. Have a running instance. Docker serves on port `9303`. For a bare local run:
   ```bash
   npm run build
   NODE_ENV=production npm start   # serves on port 3000
   ```

2. Copy the env template:
   ```bash
   cp .env.playwright.example .env.playwright
   ```

3. Edit `.env.playwright` and set `BASE_URL` to your running instance.

4. Grab your session cookie from the browser:
   - Open your ShelfBridge instance in Chrome or Firefox and log in
   - DevTools → Application → Cookies → find `shelfbridge_session`
   - Copy the **Value** and paste it into `.env.playwright` as `SESSION_COOKIE`

5. Run the tests:
   ```bash
   npm run test:e2e
   ```

   The first run validates the cookie and saves the session to
   `tests/playwright/.auth/storageState.json` (gitignored). All subsequent runs
   reuse the saved session automatically.

### Re-authenticating

When your session expires, the auth setup will tell you. Clear the saved session
and re-run with a fresh cookie:

```bash
rm tests/playwright/.auth/storageState.json
# Update SESSION_COOKIE in .env.playwright with a fresh value, then:
npm run test:e2e
```

### Generated test files

Playwright-generated files are kept under `tests/` so the repo root stays tidy.
All are gitignored:

- `tests/playwright/.auth/storageState.json` — saved authenticated session state
- `tests/test-results/` — Playwright run artifacts
- `tests/playwright-report/` — Playwright HTML report output

### Commands

| Command | What it does |
|---|---|
| `npm run test:e2e` | Run all tests (auth check + full suite) |
| `npm run test:e2e:auth` | Run the auth setup step only |

If you rerun the suite again immediately after a previous run, you can trip
ShelfBridge's own rate limiter (600 requests/min globally, 300/min on `/api`) —
page loads and polling from both runs count against the same rolling window. If
several unrelated pages suddenly fail to render together, wait about 60 seconds
and rerun rather than assuming the tests themselves are broken.

### Auth note

ShelfBridge uses a local password login, so the cookie-paste step is simpler than
hubarr's Plex OAuth — but the mechanism is kept identical (`SESSION_COOKIE` env var
plus saved `storageState.json`) so the config stays comparable across the three apps.

### Adding new tests

Create a `*.spec.ts` file in `tests/playwright/` and it will be picked up
automatically. The saved session in `storageState.json` is loaded for every test,
so all tests start already authenticated.

---

## Test Suite

### `tests/server/schema-migrations.test.ts` — Schema & migrations

| Test | What it checks |
|---|---|
| Fresh database lands on the current schema version | `initSchema` on an empty DB reaches `CURRENT_SCHEMA_VERSION` with no foreign-key violations |
| Idempotent re-run | Running `initSchema` twice makes no further changes and never duplicates the `schema_version` row |
| v14 migration | Rebuilding `book_sources` with the per-instance unique constraint preserves existing rows, adds `source_instance_id`, and backfills Chaptarr's single global instance to `0` |
| v3 migration | Orphan books (empty title, Chaptarr-only source) are deleted; books with a real source survive |
| v13 migration | `book_sources` rows with the literal string `"datetime('now')"` as `last_sync_at` are repaired to `NULL` |

### `tests/server/book-identity.test.ts` — Identity reconciliation

| Test | What it checks |
|---|---|
| ISBN13 match | Two sources sharing an ISBN13 merge into one canonical book |
| Conflicting Hardcover book id | Two sources with the same title but different authoritative Hardcover ids stay separate books |
| Idempotency | Running `reconcileBookIdentities` twice doesn't duplicate books |
| Orphan cleanup | A book left with zero `book_sources` rows is deleted on the next reconcile pass |
| Corroborated Chaptarr bridge | A Goodreads edition joins a Chaptarr/Grimmory cluster only with matching edition-ID and same-format file-path evidence; a stale Chaptarr Hardcover ID cannot merge an unrelated book |
| File-path media separation | Ebook and audiobook Chaptarr path matches join only their matching format canonical |
| File-path ID precedence | An exact Grimmory/Chaptarr path keeps local records together after a Goodreads edition ID is repaired |
| Cross-profile path isolation | A shared global Chaptarr path cannot merge unrelated Grimmory instances from different profiles |
| Cross-profile Goodreads bridge isolation | Corroborated Chaptarr/Goodreads bridging is skipped when the same path belongs to multiple Grimmory instances |
| Cross-profile Chaptarr reassignment isolation | A global Chaptarr path cannot reassign to a canonical record when multiple Grimmory instances share that path |
| Cross-profile ABS reassignment isolation | A global Chaptarr path cannot reassign to a canonical record when multiple Audiobookshelf profiles share that path |
| Chaptarr reassignment state preservation | User state is retained when a cross-profile Chaptarr path makes reassignment unsafe |

### `tests/server/settings.test.ts` — App settings

`getSetting`/`setSetting` fallback and round-trip behaviour.

### `tests/server/auth.test.ts` — Authentication sessions

| Test | What it checks |
|---|---|
| Malformed cookie | Invalid percent-encoding is treated as unauthenticated input rather than throwing |
| Hashed session storage | The database contains only a SHA-256 session-token hash with a numeric expiry |
| Secure cookie | HTTPS requests receive a `Secure` session cookie |

### `tests/server/outbound.test.ts` — Outbound integration requests

| Test | What it checks |
|---|---|
| URL validation | HTTP/HTTPS LAN URLs work; relative URLs, non-HTTP schemes, and embedded credentials are rejected |
| Redirect handling | Integration requests disable automatic redirects |

### `tests/server/sync-decision.test.ts` — Sync decision table

Table-driven coverage of `computeSyncDecision` for every `conflict_strategy` (`latest_wins`, `grimmory_wins`, `hardcover_wins`) across: no Grimmory match, status sync disabled, already synced, one side changed, both sides changed, steady-state conflicts with and without timestamps, and one-sided statuses with/without a valid cross-source mapping.

### `tests/server/pruning.test.ts` — Pruning

Each `prune*UserStatesMissingFromFetch` / `prune*SourcesMissingFromFetch` helper, checked for: only pruning the calling profile's own rows (never another profile's), preserving state while a book still has another live source row, never pruning a source with live user state, pruning a complete empty snapshot, and preserving all rows for partial or failed snapshots.

### `tests/server/normalization.test.ts` — Title/date helpers

`normalizeTitle`, `normalizeSeriesNumber`, strict ISBN-10/ISBN-13 normalization, `newerSource`, selected-read Hardcover progress calculation, `shouldGoodreadsOverwriteGrimmory`.

### `tests/server/concurrency.test.ts` — Bounded work queues

| Test | What it checks |
|---|---|
| Large author list | The Chaptarr book-file request queue preserves all results while never exceeding its configured concurrency cap. |

### `tests/server/duplicate-review.test.ts` — Duplicate merge eligibility

| Test | What it checks |
|---|---|
| Live probable-duplicate guard | Only an undismissed title-and-author probable-duplicate pair is eligible for the destructive merge route; unrelated or dismissed pairs are rejected. |
| Partial duplicate-merge failure | A remote failure in a later merge plan retains each earlier plan already persisted locally. |

### `tests/server/logger.test.ts` — Recent log tail

| Test | What it checks |
|---|---|
| Oversized machine log | Only the recent bounded tail is parsed, malformed lines are skipped, and the requested newest entries are returned. |

### `tests/server/shelves.test.ts` — Shelf synchronization

| Test | What it checks |
|---|---|
| Large reverse shelf lookup | A 500-book Grimmory shelf is processed in SQLite-safe batches while preserving all membership and Hardcover-list updates. |

### `tests/server/sync-engine.test.ts` — Sync engine integration

Runs `runSyncImpl` end-to-end against a real (isolated) SQLite database with fake source adapters (`SyncAdapters` — see `src/server/sync/engine.ts`) instead of real HTTP calls.

| Test | What it checks |
|---|---|
| No connections configured | Completes successfully, writes nothing, never calls an adapter |
| Hardcover fetch failure | Skips book and library-data writes, records a `source_unavailable` sync event, and marks the run `error` |
| Hardcover-only sync | Writes `book_sources` + `user_book_states`; re-running with the same fetched data is idempotent (no duplicate rows) |
| Dry run | Computes and caches the resolved decision locally but never calls the Grimmory write adapter |
| Real run | Calls the Grimmory write adapter with the resolved status once conflict resolution picks a winner |
| Two profiles | Each profile's `book_sources` stay scoped to its own `source_instance_id` — no cross-profile leakage |
| Negative edition cache | An unchanged Hardcover page count with no matching edition only fetches editions once across syncs. |

Adapters not relevant to a given test are left unimplemented via `createFakeAdapters` (`test-helpers.ts`), which makes any unexpected call throw immediately instead of failing confusingly deep inside `runSyncImpl`.

### `tests/server/source-snapshots.test.ts` — Source snapshot isolation

| Test | What it checks |
|---|---|
| ABS ownership scope | Runtime-validated Audiobookshelf ownership and its Grimmory Hardcover IDs never leak between profiles. |
| Hardcover list editions | Partial edition-detail fetches preserve metadata already obtained for list-only books. |
| Selected Hardcover list snapshot | A list-filtered Hardcover fetch is marked partial, so it cannot prune records outside the list. |
| Large ABS ownership snapshot | Runtime ownership lookup batches a 500-book ABS library below SQLite's parameter limit. |
| ABS without Hardcover | An ABS audiobook linked to Grimmory remains runtime-validated when the optional Hardcover integration is absent. |

### `tests/server/goodreads-phase.test.ts` — Goodreads status sync

| Test | What it checks |
|---|---|
| Changed Goodreads shelf | A changed Goodreads shelf writes its mapped status to the matched Grimmory book and persists local state. |

### Known gaps

- No coverage yet for Goodreads/Chaptarr/Audiobookshelf sync paths or shelf/list syncing.
- The Grimmory cover-caching path (`cacheGrimmoryCover` in `engine.ts`) makes a real `fetch()` call outside the adapter seam — `sync-engine.test.ts` stubs `globalThis.fetch` globally so it never hits the network, but the cover-caching logic itself has no dedicated test coverage.
- No forced mid-transaction failure test for `reconcileBookIdentities`'s rollback behaviour.
- No expired-session cleanup or expiry-boundary coverage.

---

### `tests/playwright/pages.spec.ts` — Page smoke tests

Read-only. Safe to run against a live instance.

| Test | What it checks |
|---|---|
| Dashboard loads | Navigates to `/dashboard`, asserts the "Dashboard" heading is visible |
| Books loads | Navigates to `/books`, asserts the "Books" heading is visible |
| Audiobooks loads | Navigates to `/audiobooks`, asserts the "Audiobooks" heading is visible |
| Users loads | Navigates to `/users`, asserts the "Users" heading is visible |
| Sync History loads | Navigates to `/history`, asserts the "Sync History" heading is visible |
| Settings loads | Navigates to `/settings`, asserts the "Settings" heading is visible |
| Sidebar navigation links are present | On the dashboard, checks all five nav links exist inside `<nav>` |
| Sidebar navigation works | Clicks each sidebar link in turn and verifies the URL and page heading update correctly |
| Unauthenticated request redirects to login | Opens a fresh browser context with no session cookies, navigates to `/dashboard`, expects a redirect to `/login` |

### `tests/playwright/dashboard.spec.ts` — Dashboard UI

Read-only. Safe to run against a live instance.

| Test | What it checks |
|---|---|
| Stat chips are visible after load | Asserts the "Books Tracked", "Missing", "Pending Download", and "Needs Review" stat chips render |
| Books Tracked stat chip links to the books page | Asserts a link to `/books` is present |
| Missing stat chip links to the filtered books view | Asserts a link to `/books?health=missing` is present |
| Recently Added section heading is visible | Asserts the "Recently Added" heading renders |
| Recent Syncs panel is visible and links to history | Asserts the Recent Syncs panel (an `<a>` to `/history`) renders |
| Run Sync button is present | Asserts the button renders (not clicked — a real click would trigger a live sync) |

### `tests/playwright/books.spec.ts` — Books & Audiobooks filters

Read-only. Safe to run against a live instance.

| Test | What it checks |
|---|---|
| Status filter chips are all visible | Verifies the Books status row shows All, To Read, Reading, Read, and DNF |
| Reading status filter updates the URL | Clicks the Reading chip and verifies `?status=READING` appears in the URL |
| All status filter clears the status param | Clicks Reading then All, verifies the `status` param is removed |
| Audiobooks page shows its own status labels | Verifies the Audiobooks status row shows To Listen, Listening, Listened, and DNF |

### `tests/playwright/history.spec.ts` — Sync History filters

Read-only. Safe to run against a live instance.

| Test | What it checks |
|---|---|
| Status filter buttons are all visible | Verifies All, Running, Success, and Error render |
| Page size select is visible | Verifies the page-size selector renders |
| Success status filter updates the URL | Clicks Success and verifies `?status=success` appears in the URL |
| All status filter resets the status param to all | Clicks Success then All, verifies `?status=all` |

### `tests/playwright/settings.spec.ts` — Settings sections

Read-only. Safe to run against a live instance.

| Test | What it checks |
|---|---|
| Network section shows the Trust Proxy control and its save button | Asserts the section, control, and Save Network button render |
| Sync Behaviour section shows Startup Sync and conflict strategy controls | Asserts the section and both controls render |
| History Retention section shows the retention period field | Asserts the section, field, and Save History button render |

### `tests/playwright/api.spec.ts` — API smoke tests

Read-only. Safe to run against a live instance. Uses the `request` fixture (no
browser) with the stored session cookie applied automatically via
`storageState`.

| Test | What it checks |
|---|---|
| GET /api/health returns 200 | Asserts `{ ok: true }` |
| GET /api/auth/session returns authenticated session | Asserts `authenticated: true` |
| GET /api/dashboard returns expected shape | Asserts the response has `stats`, `recentlyAdded`, and `recentActivity`, and that `stats` has the four dashboard counters |

### `tests/playwright/images.spec.ts` — Image cache

Read-only. Safe to run against a live instance. Images are cached at sync time —
tests log and skip gracefully if nothing has been cached yet.

| Test | What it checks |
|---|---|
| /images/ route requires authentication | Opens a fresh context with no session and requests `/images/test.jpg` — expects `401` |
| Dashboard recently added covers all load | Checks every `img.object-cover[src*='/images/']` on the dashboard has loaded successfully |
| Books page covers all load | Same check on the Books grid |

### `tests/playwright/jobs.spec.ts` — Live refresh (Jobs)

**Not read-only.** Triggers the real Maintenance job via the API and verifies the
open Settings page reflects its completion without a reload. See the note at the
top of the Playwright section for why Maintenance specifically is safe to
trigger this way.

| Test | What it checks |
|---|---|
| Maintenance job runs via Run Now and the Jobs table updates without reload | Clicks Run Now for Maintenance, polls the API until the job completes, then asserts the Jobs table shows the updated status without a page reload |

---

## Adding New Tests

Which layer to reach for — server test or Playwright — is covered in `AGENTS.md`
under Tests. Mechanically:

- **Server tests:** create a `*.test.ts` file under `tests/server/` and it is
  picked up automatically by `npm test`. Use `createTestDatabase()` from
  `test-db.ts` so each test gets a fresh isolated database.
- **Playwright:** create a `*.spec.ts` file in `tests/playwright/` and it is picked
  up automatically. The saved session in `storageState.json` is loaded for every
  test, so all tests start already authenticated. Keep new tests read-only unless
  there's a specific, agreed reason not to — see the note at the top of the
  Playwright section.

When a test is agreed and written, add a row for it in the relevant table above.

## Manual Smoke Test

For a local Docker verification:

```bash
docker build -t shelfbridge .
docker stop shelfbridge && docker rm shelfbridge
docker run -d \
  --name shelfbridge \
  --network bridge \
  -p 9303:9303 \
  -v /opt/shelfbridge:/config \
  --restart unless-stopped \
  shelfbridge
docker logs shelfbridge 2>&1 | tail -5
```

Expected log line:

```text
ShelfBridge listening on port 9303
```

Then open `http://localhost:9303`, create or enter the ShelfBridge admin
password, and smoke-test:

- Dashboard loads after authentication
- Settings loads and the About tab reports version/build info
- Users can be created or opened
- Credential fields never echo stored secrets back to the browser
- `/api/settings` returns `401` from an unauthenticated browser/session
- `/images/...` returns `401` without a valid session

This section needs Docker. See "Where You're Running" in `AGENTS.md` — where it
is unavailable, say so rather than substituting a workspace check.
