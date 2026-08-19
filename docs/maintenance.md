<!-- shared: structure — headings kept in sync across Migz93 self-hosted apps, content is app-specific -->

# Maintenance

## Current Housekeeping Responsibilities

ShelfBridge runs three scheduled housekeeping jobs, all registered in
`src/server/scheduler.ts`:

| Job | Schedule | What it does |
|---|---|---|
| `maintenance` | Daily at 03:00 | Prunes `sync_runs` rows older than the retention window |
| `image-cache-refresh` | Daily at 02:00 | Re-fetches stale cover images, including authenticated Grimmory covers that need a live token |
| `full-reconcile` | Daily at 04:00 | First runs `cleanupLegacyHardcoverSources()` (`sync/hardcover-legacy-cleanup.ts`), then a full, unscoped `reconcileBookIdentities()` pass over the whole catalog, with progress logged at each phase. Serialized against every profile sync via `runExclusiveOfSyncs` in `engine.ts` — it never runs while a sync is mid-flight, since a sync yields to the event loop between remote I/O calls and an unserialized reconcile could merge/reassign a book_id it's mid-write against |

`cleanupLegacyHardcoverSources()` deletes instance-less (`source_instance_id
IS NULL`) `hardcover` `book_sources` rows once a live, profile-scoped row
exists for the same Hardcover book — a pre-per-profile-scoping artifact that
no sync path writes anymore, but that a fresh install migrated forward as a
duplicate of every currently-tracked Hardcover book. Safe unconditionally:
`user_book_states` is keyed by `(book_id, profile_id, source_type)` with
`profile_id NOT NULL`, so it can never reference an instance-less row.
Deleting one can leave its book sourceless (if the pair had already drifted
onto separate books), which the following full-reconcile pass cleans up in
the same run.

It also runs at the start of every Hardcover sync's own Phase D, in
`engine.ts`, before that sync's own scoped `reconcileBookIdentities()` call —
not just once a day. Leaving a legacy row in place is not just inert clutter:
if that book's live row resolves its format and needs to merge into its
Grimmory/Chaptarr canonical in this same sync, the still-present legacy row
(stuck at an unresolved format bucket, since nothing ever updates it) can
itself get treated as a distinct, already-claimed book id before the real
merge is processed — stranding the live row's `book_sources` and
`user_book_states` behind on that id instead of following the merge. Running
the cleanup immediately before every sync's reconcile, not just once a day,
means the legacy row is never there to cause that conflict.

Book identity reconciliation itself is not primarily a scheduled task: every
sync phase and book-mutating route reconciles just the records it touched, so
identities stay correct on the fly without scanning the whole catalog on
every write. The `full-reconcile` job exists as a periodic correction pass
for the narrow cases on-the-fly reconciliation can miss.

A related cleanup is not scheduled but runs inline, via two paths:

- A full-table scan whenever a full reconciliation runs (startup, and the
  `full-reconcile` job). It isn't run after every write-triggered scoped
  reconcile, since scanning the whole `image_cache` table would defeat the
  point of scoping.
- A targeted lookup by the specific `book_sources` ids just removed —
  cheap enough to run inline on every book deletion or source pruning pass
  (Chaptarr, Hardcover, Grimmory), without waiting for the next full
  reconciliation.

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
