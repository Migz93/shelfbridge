import { logger } from "../logger.js";
import { grimmoryRating, type GrimmoryBook } from "./grimmory.js";
import { getBookSource, getUserState } from "./repository.js";
import type { getDb } from "../db/index.js";
import type { SyncAdapters } from "./adapters.js";
import type {
  grimmoryToHardcoverRating,
  hardcoverFieldsFromGrimmory,
  hasGrimmoryUserActivity,
  hasMeaningfulGrChange,
  SyncCounters
} from "./sync-utils.js";
import { isOwnedBySomeoneElse, sharedHardcoverRecordFor, type SharedHardcoverOwnership } from "./hardcover-ownership.js";
import type { pruneGrimmorySourcesMissingFromFetch, pruneGrimmoryUserStatesMissingFromFetch, SourceSnapshotStatus } from "./pruning.js";

type Db = ReturnType<typeof getDb>;
type RecordEvent = (db: Db, runId: number, profileId: number, bookTitle: string, eventType: string, direction: string | null, decision: string, details: Record<string, unknown>) => void;

export interface GrimmoryStateContext {
  db: Db;
  profileId: number;
  runId: number;
  grimmoryBooks: GrimmoryBook[];
  grimmoryAvailable: boolean;
  counters: SyncCounters;
  recordEvent: RecordEvent;
  getUserState: typeof getUserState;
  hasMeaningfulGrChange: typeof hasMeaningfulGrChange;
  dryRun: boolean;
  hasGrimmoryUserActivity: typeof hasGrimmoryUserActivity;
  matchedGrimmoryIds: Set<number>;
  hardcoverFieldsFromGrimmory: typeof hardcoverFieldsFromGrimmory;
  grimmoryToHardcoverRating: typeof grimmoryToHardcoverRating;
  sharedHardcoverOwnership: SharedHardcoverOwnership;
  hasHardcover: boolean;
  profile: Record<string, unknown>;
  adapters: SyncAdapters;
  hardcoverToken: string;
  pruneGrimmoryUserStatesMissingFromFetch: typeof pruneGrimmoryUserStatesMissingFromFetch;
  pruneGrimmorySourcesMissingFromFetch: typeof pruneGrimmorySourcesMissingFromFetch;
  grimmorySnapshotStatus: SourceSnapshotStatus;
}

export async function syncGrimmoryState(context: GrimmoryStateContext): Promise<void> {
  const { db, profileId, runId, grimmoryBooks, grimmoryAvailable, counters, recordEvent,
    getUserState, hasMeaningfulGrChange, dryRun, hasGrimmoryUserActivity,
    matchedGrimmoryIds, hardcoverFieldsFromGrimmory, grimmoryToHardcoverRating,
    sharedHardcoverOwnership, hasHardcover,
    profile, adapters, hardcoverToken, pruneGrimmoryUserStatesMissingFromFetch,
    pruneGrimmorySourcesMissingFromFetch, grimmorySnapshotStatus } = context;
// ── Phase G: Grimmory user states ────────────────────────────────────────
// Only keep per-profile Grimmory rows when the user actually has Grimmory
// activity on that book. Passive "on disk" catalog presence comes from
// book_sources and should not create a user relationship by itself.
if (grimmoryAvailable) {
  for (const grBook of grimmoryBooks) {
    const grSource = getBookSource(db, "grimmory", profileId, grBook.id);
    if (!grSource?.book_id) {
      logger.warn("Grimmory source has no book_id after reconcile", { profileId, grimmoryBookId: grBook.id });
      continue;
    }
    const bookId = grSource.book_id;

    const grReadStatus = grBook.readStatus ?? null;
    const grRat = grimmoryRating(grBook) ?? null;
    const grProgress = grBook.readProgress ?? null;
    const grLastReadTime = grBook.lastReadTime ?? null;
    const grDateFinished = grBook.dateFinished ?? null;
    const grPrimaryFileId = grBook.primaryFileId ?? null;

    const prevGrState = getUserState(db, bookId, profileId, "grimmory");
    const hasActivity = hasGrimmoryUserActivity(grBook);
    if (!hasActivity) {
      if (prevGrState) {
        db.prepare(
          "DELETE FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'"
        ).run(bookId, profileId);
      }
      continue;
    }
    const meaningfulChange = hasMeaningfulGrChange(prevGrState, {
      status: grReadStatus,
      rating: grRat,
      progress: grProgress
    });

    db.prepare(`
      DELETE FROM user_book_states
      WHERE profile_id = ?
        AND source_type = 'grimmory'
        AND grimmory_book_id = ?
        AND book_id <> ?
    `).run(profileId, grBook.id, bookId);

    db.prepare(`
      INSERT INTO user_book_states
        (book_id, profile_id, source_type, status, rating, progress,
         last_read_date, date_finished, sync_health,
         grimmory_book_id, grimmory_last_read_time, grimmory_primary_file_id,
         last_sync_at, last_sync_decision, last_modified_at)
      VALUES (?, ?, 'grimmory', ?, ?, ?, ?, ?, 'synced', ?, ?, ?, datetime('now'), 'grimmory_source', datetime('now'))
      ON CONFLICT(book_id, profile_id, source_type) DO UPDATE SET
        status = excluded.status,
        rating = excluded.rating,
        progress = excluded.progress,
        last_read_date = excluded.last_read_date,
        date_finished = excluded.date_finished,
        sync_health = 'synced',
        grimmory_book_id = excluded.grimmory_book_id,
        grimmory_last_read_time = excluded.grimmory_last_read_time,
        grimmory_primary_file_id = excluded.grimmory_primary_file_id,
        last_sync_at = datetime('now'),
        last_sync_decision = 'grimmory_source',
        last_modified_at = CASE WHEN ? THEN datetime('now') ELSE last_modified_at END
    `).run(
      bookId, profileId,
      grReadStatus, grRat, grProgress,
      grLastReadTime, grDateFinished,
      grBook.id,
      grLastReadTime, grPrimaryFileId,
      meaningfulChange ? 1 : 0
    );

    // If Grimmory has a Hardcover book ID stored and HC is configured,
    // sync status into Hardcover for books not matched via HC import loop.
    if (!matchedGrimmoryIds.has(grBook.id)) {
      const hardcoverBookId = grBook.hardcoverBookId ? Number.parseInt(grBook.hardcoverBookId, 10) : NaN;
      const hardcoverFields = hardcoverFieldsFromGrimmory(grBook);
      const hardcoverRat = grimmoryToHardcoverRating(grimmoryRating(grBook));
      if (isOwnedBySomeoneElse(sharedHardcoverOwnership, grBook)) {
        const ownerReason = sharedHardcoverRecordFor(sharedHardcoverOwnership, grBook.hardcoverBookId)?.owner.reason ?? "no_active_owner";
        logger.info("Skipped Grimmory-to-Hardcover status write because another sibling owns the shared Hardcover record", {
          profileId,
          grimmoryBookId: grBook.id,
          hardcoverBookId: Number.isInteger(hardcoverBookId) ? hardcoverBookId : null,
          reason: ownerReason
        });
        recordEvent(db, runId, profileId, grBook.title ?? "", "skipped_no_change", "grimmory_to_hardcover", "shared_hardcover_owned_by_sibling", {
          grimmoryBookId: grBook.id,
          hardcoverBookId: Number.isInteger(hardcoverBookId) ? hardcoverBookId : null,
          reason: ownerReason
        });
        counters.skipped++;
        continue;
      }
      if (hasHardcover && profile["sync_status_enabled"] !== 0 && Number.isInteger(hardcoverBookId) && hardcoverFields?.status_id) {
        const title = grBook.title ?? "";
        if (dryRun) {
          recordEvent(db, runId, profileId, title, "written", "grimmory_to_hardcover", "would_insert_hardcover_user_book", {
            grStatus: grBook.readStatus, hardcoverBookId, targetStatusId: hardcoverFields.status_id,
            ...(hardcoverRat !== null ? { targetRating: hardcoverRat } : {}), dryRun
          });
          counters.written++;
        } else {
          try {
            await adapters.insertHardcoverUserBook(hardcoverToken, {
              book_id: hardcoverBookId,
              ...hardcoverFields,
              ...(hardcoverRat !== null ? { rating: hardcoverRat } : {})
            });
            recordEvent(db, runId, profileId, title, "written", "grimmory_to_hardcover", "inserted_hardcover_user_book", {
              grStatus: grBook.readStatus, hardcoverBookId, targetStatusId: hardcoverFields.status_id,
              ...(hardcoverRat !== null ? { targetRating: hardcoverRat } : {})
            });
            counters.written++;
            logger.info("Inserted Grimmory-only book into Hardcover", {
              profileId, grimmoryBookId: grBook.id, hardcoverBookId, statusId: hardcoverFields.status_id, rating: hardcoverRat
            });
          } catch (writeErr) {
            logger.warn("Failed to insert Grimmory-only book into Hardcover", { profileId, grimmoryBookId: grBook.id, hardcoverBookId, error: writeErr });
            recordEvent(db, runId, profileId, title, "api_failure", "grimmory_to_hardcover", "insert_hardcover_user_book_failed", { error: String(writeErr) });
            counters.skipped++;
          }
        }
      }
    }
  }

  pruneGrimmoryUserStatesMissingFromFetch(db, profileId, new Set(grimmoryBooks.map((b) => b.id)), grimmorySnapshotStatus);
  // Source pruning preserves rows with a live state, so it must run second.
  pruneGrimmorySourcesMissingFromFetch(db, profileId, new Set(grimmoryBooks.map((b) => b.id)), grimmorySnapshotStatus);
  logger.info("Grimmory user_book_states written", { profileId, count: grimmoryBooks.length });
}

}
