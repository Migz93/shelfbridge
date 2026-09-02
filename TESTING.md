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

`sync-engine.test.ts`, `auth.test.ts`, `settings.test.ts`, `covers-reconcile.test.ts`,
`chaptarr-orphan-cleanup.test.ts`, `covers-refresh-isolation.test.ts`,
`image-cache-refresh-propagation.test.ts`, and `profiles-hardcover-disable.test.ts`
are the exceptions: each operates on the
`db/index.ts` singleton rather than an injected database, so each points
`DATA_DIR` at its own private temp dir (via a dynamic `import()` of the
singleton after setting the env var — a static `import` would evaluate the
singleton too early, since ESM hoists imports ahead of the rest of the
importing module) instead of sharing `./.test-data` with each other. Node's test
runner runs each file in its own process, so two files racing to initialize the
same fresh `./.test-data/shelfbridge.db` — both seeing no pending migrations, both
running migration 1's non-`IF NOT EXISTS` `CREATE TABLE` statements — could
otherwise intermittently fail with `table already exists`; isolating each of
these files removes the shared state the race depends on. `sync-engine.test.ts`
additionally seeds its own profile per test and scopes assertions to that
profile's id, since it shares one database across many tests within the file.
Each of these eight files waits for the logger to flush (`logger.end()` +
`"finish"` event) before deleting its temp dir in `test.after`, since the
logger also writes into `DATA_DIR`.

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
| `runTransactionalStep` rollback | A newly-introduced `PRAGMA foreign_key_check` violation rolls back the entire step atomically — the violating row and everything else written in the same step, not just the violation itself |
| `runGuardedStep` abort-without-rollback | A newly-introduced violation is still detected and thrown, but since `step()` already committed on its own (no transaction), the violating row survives — the documented behavior for steps that can't be one transaction |
| Pre-existing violations don't block | A `runTransactionalStep` step that introduces no *new* foreign-key violations still commits even if pre-existing ones (unrelated historical data debt) remain — only newly-introduced violations are fatal |
| New violation alongside a pre-existing one | A step that introduces one new violation on top of a pre-existing, unrelated one still rolls back — the pre-existing violation doesn't mask a real new one, and survives the rollback untouched |
| `user_version` rollback | A violation introduced after `db.pragma('user_version = N')` inside a `runTransactionalStep` rolls back the pragma write too, not just table rows — proving the whole transaction is atomic, not just data changes |
| Fresh database applies migration 1 | `initSchema` on an empty DB reaches `LATEST_MIGRATION_VERSION` via `PRAGMA user_version`, never creates a `schema_version` table, with no foreign-key violations |
| Idempotent re-run | Running `initSchema` twice makes no further changes |
| Legacy handover | A pre-existing `schema_version` database is migrated to v14 via the preserved sequential logic, then handed over to `user_version = 1`; verifies `source_instance_id` is added, existing rows survive, Chaptarr is backfilled to instance `0`, per-profile sources are left unscoped, the per-instance unique constraint is enforced, exactly one pre-migration backup was written (not one per step), and the stale `schema_version` table is dropped |
| Handover atomicity | Injecting a failure between `DROP TABLE schema_version` and the `user_version = 1` bump rolls back cleanly (table still present, `user_version` still `0`), and a subsequent `initSchema` call recovers on its own |
| Handover is not re-run | A database already at `user_version >= 1` is left alone on a second `initSchema` call, and takes no redundant backup |
| Legacy v3 migration | Orphan books (empty title, Chaptarr-only source) are deleted; books with a real source survive |
| Legacy v7 migration atomicity | Injecting a failure before the version 7 bump rolls back the whole `book_sources`/`user_book_states` rebuild (no leftover `book_sources_v7` temp table, original data intact, version unchanged), and a subsequent `initSchema` call recovers on its own |
| Single failure log per handover error | A v7 sub-step failure during the legacy handover is logged exactly once, not once per guarding layer (`runTransactionalStep` around v7 itself, then `runGuardedStep` around the whole handover) it propagates through |
| Backstop check precedes the version bump | The legacy handover's outer `foreign_key_check` runs while `user_version` is still `0`, before the `DROP TABLE schema_version` + version bump commits — proving a caught violation leaves the handover retriable on the next restart instead of looking already-complete |
| Legacy v8/v9 migration atomicity | Injecting a failure before the version 8 bump rolls back the `ALTER TABLE ADD COLUMN` statements (column not present, version unchanged), and a subsequent `initSchema` call recovers through v9 as well |
| Legacy v13 migration | `book_sources` rows with the literal string `"datetime('now')"` as `last_sync_at` are repaired to `NULL` |
| Pre-migration backup | `backupBeforeMigrating` snapshots an already-populated database via `VACUUM INTO` into `<data dir>/backups/` before `runMigrations` applies a pending migration, and skips the backup for a brand-new database with nothing to protect |
| Backup retention | `backupBeforeMigrating` prunes `<data dir>/backups/` down to the 5 most recently created backups each time it runs |
| Backup directory permissions | `backupBeforeMigrating` locks `<data dir>/backups/` down to owner-only (`0o700`) even when the directory already existed with looser permissions from before this hardening shipped — `mkdirSync`'s `mode` alone is a no-op on an existing directory, so this is only correct if it's backed by an explicit `chmodSync` |
| Downgrade guard | `getPendingMigrations`/`runMigrations` reject a database whose `user_version` is newer than this build's `LATEST_MIGRATION_VERSION`, instead of silently seeing nothing pending and booting into an unknown schema |
| Schema equivalence | The flattened baseline (migration 1, a fresh install) and a full legacy `v3`→`v14` chain plus handover produce the same set of tables, columns (including primary-key ordinal), indexes (including implicit ones from inline `UNIQUE`/PK constraints, compared by shape rather than their creation-order-dependent name), foreign keys, and views/triggers — order-independent, so this catches the baseline silently drifting from what the legacy chain actually produces |

### `tests/server/book-identity.test.ts` — Identity reconciliation

| Test | What it checks |
|---|---|
| ISBN13 match | Two sources sharing an ISBN13 merge into one canonical book |
| ISBN match despite an unresolved format bucket | A Hardcover row with no resolvable edition_format/media_type still merges with a canonical book via a shared ISBN |
| ISBN match blocked across a known format-bucket mismatch | A book/ebook row and an audiobook row that happen to share the exact same ISBN (a real Grimmory/Hardcover data quirk) stay separate canonicals — a shared ISBN never overrides a known book-vs-audiobook bucket disagreement |
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
| Scoped merge via shared ISBN | A scoped reconcile discovers an existing, unrelated-looking book through a shared ISBN and merges the new source into it |
| Scoped bridge across two existing books | A single new source that shares a key with each of two previously-separate existing books merges all three into one |
| Scoped isolation | A scoped reconcile touching one book does not merge or modify an unrelated existing book outside its scope |
| Empty scope no-op | `reconcileBookIdentities` with an empty `sourceIds` array makes no changes |
| Shared identity key, two owners | Two existing books that legitimately share an identity key (e.g. same title/author, kept separate by design) are each still discoverable — a scoped third row merges with the correct one, not the one that happened to claim the key first |
| Iteration-cap fallback | `expandScopeToRows` returns `null` (never a partial closure) when a chain of merges needs more hops than its iteration cap allows |
| Row-cap fallback | `expandScopeToRows` returns `null` when the final candidate-book fetch of a scoped expansion would exceed its row cap, even on the cap's very last allowed iteration |

### `tests/server/hardcover-legacy-cleanup.test.ts` — Legacy Hardcover source cleanup

| Test | What it checks |
|---|---|
| Deletes once a live counterpart exists | An instance-less `hardcover` row is deleted once a profile-scoped row with the same external id exists |
| Deletes even after already splitting into its own book | Still deleted when the instance-less row and its live counterpart have already drifted onto separate books |
| No live counterpart yet | An instance-less row with no live counterpart is left alone |
| Never touches the live row | A live, profile-scoped row is never deleted |
| Migrates state already stranded on the orphan | A profile's `user_book_states` row already sitting on the legacy row's own orphan book (from before this cleanup existed) is moved onto the live row's book, not left behind when the legacy row is deleted |
| Drops a stranded duplicate when the live state is more current | When the live row's own state was modified more recently, a conflicting stranded duplicate on the orphan is dropped rather than overwriting it |
| Keeps the stranded state when it is more current | Applies the same conflict rule the identity reconciler uses (meaningful progress, then newer timestamp — see `shouldMoveState`): a stranded state with more recent progress wins over a stale live-row state instead of always being discarded |
| Leaves the row alone when only some profiles are matched | A legacy row with state from two profiles on its orphan book, only one of which has a live counterpart, is left entirely undeleted — the unmatched profile's state is never stranded |
| Leaves the row alone when a non-Hardcover state is present | A Grimmory or Goodreads state on the orphan book is never stranded — this cleanup only knows how to migrate Hardcover state, so it defers deletion entirely rather than guess a target for a state type it can't migrate |
| Leaves the row alone when the matched counterpart has no book_id yet | A live counterpart that exists but hasn't been reconciled yet (book_id still NULL) doesn't count as a migration target — the legacy row is left alone rather than deleted with nowhere for its state to go |
| Reconciling without cleanup first strands the merge | Documents the underlying bug: a legacy row left in place when a book's live row needs to merge into its Grimmory canonical leaves the merge stranded — book_sources reassigned, but the book row and its user_book_states left behind |
| Cleaning up before reconciling merges cleanly | Verifies the fix: running the cleanup immediately before reconciling (what `engine.ts` now does on every Hardcover sync, not just the daily job) avoids the conflict entirely — sources and state both end up on the single surviving book |
| Ghost book removed immediately via `cleanupAfterSourceRemoval` | A book left with no sources and no state right after the legacy cleanup is removed in the same pass (what `engine.ts` now wires up), rather than lingering until the next daily full reconcile |

### `tests/server/hardcover-media-type.test.ts` — Hardcover media-type classification

| Test | What it checks |
|---|---|
| Resolves via `reading_format_id` | A blank/uninformative `edition_format` string doesn't block classification when `reading_format_id` is populated |
| Trusts `reading_format_id` over a mislabeled `edition_format` | `reading_format_id` wins when the two disagree |
| Format id mapping | `reading_format_id` 2 → audiobook, 4 → ebook |
| Dual-format ("Both") fallback | A `reading_format_id` of 3 falls through to the `default_*_edition_id` pointers instead of guessing |
| No edition data | Returns `null` when there's no edition and no matching default pointer |
| Never falls back to `edition_format` | Even with `reading_format_id` simply absent (not just disagreeing), a populated `edition_format` is still never trusted |

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
| Empty URL rejection | A blank configured URL cannot reach `fetch` |

### `tests/server/hardcover-auth.test.ts` — Hardcover authentication

| Test | What it checks |
|---|---|
| PAT and legacy authorization | Bare `hc_pat_` values are sent as Bearer tokens; existing JWT/header values remain unchanged; connection-test API errors remain useful without echoing the supplied token. |

### `tests/server/validation.test.ts` — Request validation and atomic replacements

| Test | What it checks |
|---|---|
| Settings, profiles, and sync request schemas | Invalid booleans, retention values, conflict strategies, malformed connections, and profile IDs are rejected before a route can access the database |
| Connection tests, job controls, and book actions | Malformed test payloads, schedule intervals, and external-ID write sources are rejected |
| Mutating route IDs | Book-action IDs must be complete positive integers, not permissive `parseInt` prefixes |
| Route validation contract | A malformed settings mutation returns the documented structured 400 response before database access |
| Mapping request schemas | Malformed Goodreads and Hardcover mappings are rejected before replacement |
| Failed mapping replacement | A failing insert rolls back the delete-and-reinsert transaction, retaining the prior mappings |
| Failed multi-setting update | A later settings write failure rolls back all earlier writes in the same patch |

### `tests/server/sync-decision.test.ts` — Sync decision table

Table-driven coverage of `computeSyncDecision` for every `conflict_strategy` (`latest_wins`, `grimmory_wins`, `hardcover_wins`) across: no Grimmory match, status sync disabled, already synced, one side changed, both sides changed, steady-state conflicts with and without timestamps, and one-sided statuses with/without a valid cross-source mapping.

### `tests/server/pruning.test.ts` — Pruning

Each `prune*UserStatesMissingFromFetch` / `prune*SourcesMissingFromFetch` helper, checked for: only pruning the calling profile's own rows (never another profile's), preserving state while a book still has another live source row, never pruning a source with live user state, pruning a complete empty snapshot, and preserving all rows for partial or failed snapshots.

Also covers `cleanupAfterSourceRemoval` (shared with Chaptarr's own source removal in `chaptarr.ts`): a book left with zero sources and zero user state after pruning is deleted rather than left as a ghost canonical; a book that still has another source is left alone; pruning a preferred source (e.g. Hardcover) reconciles the surviving source so the canonical title is recomputed rather than left stale; and a pruned source's own orphaned `image_cache` row (which doesn't cascade away with the source, since it's keyed by `book_sources.id`) is cleaned up too, scoped to just the deleted source ids rather than a full-table scan.

### `tests/server/normalization.test.ts` — Title/date helpers

`normalizeTitle`, `normalizeSeriesNumber`, strict ISBN-10/ISBN-13 normalization, `newerSource`, selected-read Hardcover progress calculation (including duplicate blank reads), shared Hardcover book/audiobook precedence (including preventing inactive siblings from overwriting the active record without affecting ordinary books), cross-media Hardcover identity validation, `shouldGoodreadsOverwriteGrimmory`.

### `tests/server/repository.test.ts` — Source persistence

| Test | What it checks |
|---|---|
| Source upsert timestamps | An unchanged source refreshes `last_sync_at` without changing `last_modified_at`; a changed source advances both. |

### `tests/server/audiobookshelf-progress.test.ts` — Audiobookshelf progress propagation

| Test | What it checks |
|---|---|
| Blank live Hardcover read | Audiobookshelf repairs a selected live Hardcover read at 0% even when the cached Hardcover progress is non-zero. |
| Chaptarr-only shared work | A Chaptarr shared Hardcover ID lets an audiobook create its Hardcover user book and read without a direct Hardcover or Grimmory source row. |
| Resolved audio edition ids returned | `syncAudiobookshelfProgress` returns the `book_sources.id` of every Hardcover row it resolved an audio edition for, so the caller can reconcile it — verified against the actual persisted `source_media_type`/`source_edition_id`. |

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
| Missing machine log file | A missing machine log file falls back to the in-memory ring buffer instead of throwing. |

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
| Hardcover-only sync | Writes `book_sources` + `user_book_states`; re-running with the same fetched data is idempotent (no duplicate rows or modification-time bump) |
| Dry run | Computes and caches the resolved decision locally but never calls the Grimmory write adapter |
| Real run | Calls the Grimmory write adapter with the resolved status once conflict resolution picks a winner |
| Two profiles | Each profile's `book_sources` stay scoped to its own `source_instance_id` — no cross-profile leakage |
| Negative edition cache | An unchanged Hardcover page count with no matching edition only fetches editions once across syncs. |
| Queue ordering | `runExclusiveOfSyncs` (used by the daily full-reconcile job and cover-cache reconciliation) never runs concurrently with a queued sync — it deterministically waits for the sync ahead of it in the shared queue to settle first, proven by promise-chaining order rather than real timing. |
| Owned-list import off by default | With `owned_import_enabled = 0`, a disagreeing Owned-list edition is ignored — only the primary `book_sources` row is written. |
| Owned-list import creates a second row | With the setting on, an Owned-list edition whose format disagrees with the current edition writes a second `book_sources` row (`source_bucket = 'owned'`) that reconciles into its own canonical book (opposite `media_type` from the primary); the primary canonical keeps its normal Hardcover-sourced state, and the owned canonical gets its own local-only state (`owned_list_local_only`, never write-back-eligible, no live Hardcover read id). |
| Owned-list import removes a stale row | Once a previously-written `'owned'` row is no longer justified (entry removed or formats now agree), it's deleted and the primary row is unaffected; if that was the canonical's only source, the canonical itself is deleted too rather than surviving as a ghost book. |
| A legacy instance-less row's stranded state survives an unrelated ghost-canonical cleanup | The ghost-canonical cleanup's prune is scoped to just the books affected by this run's owned/shared row removals — a profile-wide sweep at that point would also delete state stranded on an unrelated legacy (`source_instance_id IS NULL`) Hardcover row before `cleanupLegacyHardcoverSources` gets its own, later chance to migrate it safely. |
| The ghost-canonical prune is a no-op when a legacy row shares the same canonical as the removed owned row | Even when the just-deleted owned row's book still has a legacy (`source_instance_id IS NULL`) Hardcover row on it, the book isn't actually orphaned (a real `book_sources` row remains) — the early prune requires zero `book_sources` rows of any kind before touching a book's state, so it never interferes here. |
| Genuinely shared book gives the non-owning sibling local presence | A Hardcover book with real Grimmory book and audiobook siblings (no Owned-list involvement) — the actively-reading sibling keeps the normal primary write-back row; the non-owning sibling gets its own `'shared'`-bucket `book_sources` row (reconciled onto its own canonical) and a local-only state (`shared_sibling_local_only`) with no live Hardcover read id. |
| Owned-list-only book with no real Hardcover library entry still gets a real status | A book present only via the Owned list (no `fetchHardcoverLibrary` entry) enters as a normal primary `book_sources` row (not a synthetic secondary bucket), gets Hardcover's "want to read" `status_id` instead of the generic list-only stub's `null`, and — since nothing on the Grimmory side has a status either — that status_id flows into the displayed status and gets written back to the matching Grimmory record. |
| A non-owning sibling with its own real Grimmory status is not overwritten | When the non-owning sibling of a genuinely shared book has its own real, differing Grimmory status (e.g. finished the audiobook while still partway through the print book), its local-only Hardcover state leaves `status`/`rating` `null` rather than mirroring the owning sibling's status — its own Grimmory-sourced state stands alone, unaffected. |
| A non-owning sibling with no activity of its own defaults to UNREAD, never the owning sibling's status | A real Grimmory sibling nobody's opened/listened to yet (e.g. a book finished in print, audiobook never started) shows as `UNREAD` on its own local-only Hardcover state — never mirrors the actively-reading/finished status of the *other* format. |
| Two finished siblings with no active owner never both attempt to write Hardcover | When both siblings of a shared Hardcover book are finished (neither actively reading, so there's no active write-back owner), the unmatched sibling still defers to the matched one rather than reaching the Grimmory-only-book-into-Hardcover fallback — `insertHardcoverUserBook`/`updateHardcoverUserBook` calls are recorded and asserted empty, and the run's `sync_runs.status` is asserted `'success'`, since `runSyncImpl` catches and swallows adapter errors rather than rethrowing them (an unstubbed-adapter throw alone would NOT fail the test). |
| A duplicate untouched sibling must not mask a different sibling's real activity | With two ebook entries sharing one Hardcover book (one untouched, one genuinely finished) plus a finished audiobook sibling, the no-active-owner write-suppression check looks at every ebook sibling's activity, not just the deterministic tie-break representative — which in this setup lands on the untouched one — so the finished audiobook's competing write is still correctly suppressed (`tests/server/hardcover-ownership.test.ts`). |
| A `'shared'` row survives a Grimmory outage | When a run's Grimmory fetch fails, `grimmoryBooks` (and so the shared-ownership map) is empty for that entire run — a previously-written `'shared'` row must not be treated as "its sibling is gone" and deleted just because this run has no Grimmory data to confirm it with; it's left untouched, to be re-evaluated once Grimmory data is actually available again. |
| A Grimmory outage defers Owned-list handling only when a `'shared'` row is being preserved | With a preserved `'shared'` row in play, a Grimmory outage that also surfaces a would-be-justified Owned-list entry must not create a competing `'owned'` row alongside it (primary + shared + owned all at once) — Owned-list handling is deferred for that book until Grimmory data is trustworthy again. A profile with no Grimmory connection at all is unaffected, since it never has a `'shared'` row to defer around. |
| A Grimmory outage does not flip an already-deferred local-only state back to UNREAD | `upsertLocalOnlyHardcoverState`'s `hasOwnActivity` is forced `false` for the whole run whenever Grimmory is unreachable, which is indistinguishable from "genuinely no activity" — without a direct `grimmoryAvailable` check, a finished sibling correctly showing `status = null` (deferring to its own real Grimmory activity) would get flipped to `UNREAD` on every transient outage. An existing state is now left untouched during an outage instead. |

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
| Matched-book ISBN update reconciled | A matched Goodreads book's newly-reported ISBN — not just newly-created sources — is reconciled, merging it with the existing book that now shares that ISBN. |

### `tests/server/chaptarr-orphan-cleanup.test.ts` — Chaptarr source removal cleanup

| Test | What it checks |
|---|---|
| Orphan deletion | A book left with no sources after its only Chaptarr row disappears upstream is deleted, not left as a ghost canonical. |
| Survivor preserved | A book with a surviving Hardcover source is not deleted just because its Chaptarr row went away; the stale Chaptarr source itself is still removed. |
| Survivor reconciled | Removing a Chaptarr row that was the only audiobook-format signal reconciles the surviving Hardcover source, updating the book's canonical `media_type` rather than leaving it stale. |
| Orphaned image cache cleaned up | A removed Chaptarr source's `image_cache` row is cleaned up, not left referencing a deleted `book_sources` id. |

### `tests/server/covers-reconcile.test.ts` — Cover-cache reconciliation

| Test | What it checks |
|---|---|
| Delayed cache propagation | A cover that finishes caching (via `cacheSourceCover`, the same path a background cover-cache task uses) after a book's own reconcile has already run still updates the canonical `books.cover_cache_path`, instead of only `book_sources.cover_cache_path`. |

### `tests/server/covers-refresh-isolation.test.ts` — Scheduled Grimmory cover refresh

| Test | What it checks |
|---|---|
| Per-source failure isolation | A failure updating one stale Grimmory cover's `book_sources` row does not abort the rest of that instance's refresh batch — later sources still get refreshed and reconciled, and the failing source is left uncached rather than silently skipping its siblings. |

### `tests/server/image-cache-refresh-propagation.test.ts` — Background public-cover refresh

| Test | What it checks |
|---|---|
| Refreshed path propagation | `ensureCoverCached` returns a cover's existing (old) local path immediately and refreshes a stale one in the background; once that background refresh completes and deletes the old file, `book_sources.cover_cache_path` and the canonical `books.cover_cache_path` are updated to the new path too, not left pointing at the now-deleted file. |

### `tests/server/books-detail-route.test.ts` — Book detail/merge/delete routes

| Test | What it checks |
|---|---|
| Scoped duplicate lookup | `GET /api/books/:id` scopes `fetchRows` to the requested book and its duplicate candidates, not the whole catalog. |
| Merge validation | The merge endpoint rejects a pair that isn't a live probable-duplicate match. |
| Scoped delete cleanup | `DELETE /api/books/:id` cleans up only the deleted book's own `image_cache` rows (via `cleanupImageCacheForSourceIds`), leaving unrelated orphaned rows for the daily full reconcile rather than scanning the whole cache table on the request's hot path. |

### `tests/server/profiles-hardcover-disable.test.ts` — Hardcover connection disable

| Test | What it checks |
|---|---|
| Batched detach, scoped correctly | `PATCH /api/profiles/:id` with `hardcover.enabled: false` deletes the profile's Hardcover state and marks exactly its previously-matched Grimmory rows `sync_health: 'missing'` — verified across 1200 matched books (forcing the detach `UPDATE` over multiple 500-row batches, since SQLite's bound-parameter limit made an earlier unbatched version fail on large libraries), leaves a Grimmory-only (never Hardcover-matched) book untouched, and leaves a different profile's Hardcover and Grimmory state completely unaffected. |

### `tests/server/bookIdentity.bench.test.ts` — Reconciliation benchmarks

Informational timing at small/medium/large synthetic library sizes (documents reconciliation cost, not a hard pass/fail gate), plus one scaling assertion: a scoped reconcile against a large pre-reconciled catalog completes well under the cost of a full reconcile of that catalog, with a generous margin to avoid flaking on a slow runner.

### Known gaps

- No coverage yet for Goodreads/Chaptarr/Audiobookshelf sync paths or shelf/list syncing.
- The Grimmory cover-caching path (`cacheGrimmoryCover` in `covers.ts`) makes a real `fetch()` call outside the adapter seam — `sync-engine.test.ts` stubs `globalThis.fetch` globally so it never hits the network. `covers-reconcile.test.ts` covers the reconcile-on-cache-completion behavior directly (via the cache-hit path, no network involved), and `covers-refresh-isolation.test.ts` covers `refreshStaleGrimmoryCovers`'s network fetch/store path (via a local Express server standing in for Grimmory) — but `cacheGrimmoryCover`'s own live network path still has no dedicated test.
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
