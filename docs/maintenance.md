<!-- shared: structure — headings kept in sync across Migz93 self-hosted apps, content is app-specific -->

# Maintenance

## Current Housekeeping Responsibilities

ShelfBridge runs three scheduled housekeeping jobs, all registered in
`src/server/scheduler.ts`:

| Job | Schedule | What it does |
|---|---|---|
| `maintenance` | Daily at 03:00 | Prunes `sync_runs` rows older than the retention window |
| `image-cache-refresh` | Daily at 02:00 | Re-fetches stale cover images, including authenticated Grimmory covers that need a live token |
| `full-reconcile` | Daily at 04:00 | Runs a full, unscoped `reconcileBookIdentities()` pass over the whole catalog, with progress logged at each phase. Serialized against every profile sync via `runExclusiveOfSyncs` in `engine.ts` — it never runs while a sync is mid-flight, since a sync yields to the event loop between remote I/O calls and an unserialized reconcile could merge/reassign a book_id it's mid-write against |

Book identity reconciliation itself is not primarily a scheduled task: every
sync phase and book-mutating route reconciles just the records it touched, so
identities stay correct on the fly without scanning the whole catalog on
every write. The `full-reconcile` job exists as a periodic correction pass
for the narrow cases on-the-fly reconciliation can miss.

A related cleanup is not scheduled but runs inline: orphaned `image_cache`
rows are removed whenever a full reconciliation runs (startup, and the
`full-reconcile` job) or a book is deleted. It isn't run after every
write-triggered scoped reconcile, since it scans the whole `image_cache`
table and would defeat the point of scoping if it did.

## Data Retention

| Data | Retained | Controlled by |
|---|---|---|
| `sync_runs` | 7 days (default) | **Settings → General → History Retention** (`sync.historyRetentionDays`) |
| `sync_events` | Follows `sync_runs` | `ON DELETE CASCADE` — never pruned directly |
| `shelfbridge-*.log` | 7 days, 20 MB per file | `maxFiles` in `src/server/logger.ts` |
| `.machinelogs-*.json` | 3 days, 20 MB per file | `maxFiles` in `src/server/logger.ts` |

ShelfBridge does not currently prune `books`, `book_sources`, or
`user_book_states` on a schedule. Those are pruned reactively instead — see the
`prune*MissingFromFetch` helpers, which remove rows a source stopped reporting
only after a complete snapshot. A complete empty library is authoritative;
partial and failed snapshots never trigger pruning.

## Adding New Maintenance Work

When adding a new cleanup or consistency task:

1. Make it idempotent.
2. Prefer a dry-run or summary path for destructive actions.
3. Register it on the scheduler in `src/server/scheduler.ts` rather than running
   it inline, unless it genuinely belongs to another operation's lifecycle.
4. Keep subsystem-specific logic near the subsystem that owns the data — image
   cache cleanup belongs in `db/imageCacheMaintenance.ts`, not as raw SQL inside
   the scheduler registration.
5. Add structured logs around start, finish, skipped work, and failures, with
   counts for anything removed. Use `debug` when there was nothing to do.
6. Add focused server tests for the persistence invariants.
7. Update this doc, and `docs/sync.md` if the task is user-visible.

## Safety Rules

- Treat an empty fetch result as authority to delete only when its source
  snapshot is explicitly complete. A partial or failed fetch must never prune.
- Never prune a source row that still has live user state attached.
- Only ever prune the calling profile's own rows — cross-profile deletion is a
  bug, and `pruning.test.ts` exists to catch it.
- Treat failed Grimmory/Hardcover/Goodreads/Chaptarr calls as a reason to skip or
  warn, not as a reason to force cleanup.
- Maintenance is a bucket for scheduled housekeeping, not a place to hide
  unstructured miscellaneous logic. Each task should have one clear owner, an
  explicit scope, and tests where practical.
