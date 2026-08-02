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

Not implemented yet. Tracked in
[#59](https://github.com/Migz93/shelfbridge/issues/59).

When Playwright is added, copy the setup from
[hubarr](https://github.com/Migz93/hubarr) — `playwright.config.ts`,
`.env.playwright.example`, `tests/playwright/auth.setup.ts`, and the `test:e2e`
scripts — and adjust for ShelfBridge: the session cookie is
`shelfbridge_session` and `BASE_URL` points at port `9303`. Then replace this
section with hubarr's Playwright section, modified to suit.

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
- No auth/session-expiry tests.

---

## Adding New Tests

Which layer to reach for — server test or Playwright — is covered in `AGENTS.md`
under Tests. Mechanically:

- **Server tests:** create a `*.test.ts` file under `tests/server/` and it is
  picked up automatically by `npm test`. Use `createTestDatabase()` from
  `test-db.ts` so each test gets a fresh isolated database.
- **Playwright:** not wired up yet — see
  [#59](https://github.com/Migz93/shelfbridge/issues/59). Say so rather than
  substituting a server test for a UI concern.

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
