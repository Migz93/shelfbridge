import { logger } from "../logger.js";
import { grimmoryRating } from "./grimmory.js";
import { normalizeExternalId } from "../identifiers.js";
import { getBookSource } from "./repository.js";
export async function syncGrimmoryState(context: any): Promise<void> {
  const { db, profileId, runId, grimmoryBooks, grimmoryAvailable, counters, recordEvent,
    getUserState, hasMeaningfulGrChange, dryRun, hasGrimmoryUserActivity,
    matchedGrimmoryIds, hardcoverFieldsFromGrimmory, grimmoryToHardcoverRating,
    shouldBookProgressOwnSharedHardcover, absOwnedHardcoverBookIds, hasHardcover,
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
      const bookOwnsSharedHardcover = grBook.mediaType === "audiobook"
        && shouldBookProgressOwnSharedHardcover(grimmoryBooks, grBook.hardcoverBookId);
      // Print/ebook siblings of an ABS-owned audiobook must never push their
      // own status into the Hardcover book they share — that book's status
      // is owned entirely by Phase N's ABS-derived writes. Without this,
      // this print sibling (unmatched via the main HC loop because the
      // shared Hardcover book was routed to its audiobook sibling instead)
      // would insert/overwrite the shared user_book with the print's status,
      // fighting Phase N's audiobook progress on every run.
      const audiobookSiblingOwnsSharedHardcover = grBook.mediaType !== "audiobook"
        && absOwnedHardcoverBookIds.has(normalizeExternalId(grBook.hardcoverBookId) ?? "");
      if (bookOwnsSharedHardcover || audiobookSiblingOwnsSharedHardcover) {
        logger.info("Skipped Grimmory-to-Hardcover status write because a sibling edition owns shared Hardcover progress", {
          profileId,
          grimmoryBookId: grBook.id,
          hardcoverBookId: Number.isInteger(hardcoverBookId) ? hardcoverBookId : null
        });
        recordEvent(db, runId, profileId, grBook.title ?? "", "skipped_no_change", "grimmory_to_hardcover", "book_progress_wins_shared_hardcover", {
          grimmoryBookId: grBook.id,
          hardcoverBookId: Number.isInteger(hardcoverBookId) ? hardcoverBookId : null
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

  pruneGrimmoryUserStatesMissingFromFetch(db, profileId, new Set(grimmoryBooks.map((b: any) => b.id)), grimmorySnapshotStatus);
  // Source pruning preserves rows with a live state, so it must run second.
  pruneGrimmorySourcesMissingFromFetch(db, profileId, new Set(grimmoryBooks.map((b: any) => b.id)), grimmorySnapshotStatus);
  logger.info("Grimmory user_book_states written", { profileId, count: grimmoryBooks.length });
}

}
