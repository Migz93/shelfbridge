import { logger } from "../logger.js";
import { grimmoryRating } from "./grimmory.js";
import { HARDCOVER_TO_GRIMMORY, matchHardcoverBook } from "./matcher.js";
import type { HardcoverReadFields } from "./hardcover.js";
import { getBookSource, getGoodreadsExternalId } from "./repository.js";

export async function syncHardcoverState(context: any): Promise<void> {
  const { db, profileId, runId, dryRun, adapters, counters, hcBooks,
    grimmoryBooks, grimmoryAvailable, hasGrimmory, baseUrl, grimmoryToken,
    hardcoverToken, profile, recordEvent, getUserState, localGrimmoryBookForBookId,
    computeSyncDecision, cleanupDuplicateBlankHardcoverReads,
    hasMeaningfulHcChange, sameNumber, grimmoryToHardcoverRating,
    hardcoverToGrimmoryRating, hardcoverFieldsFromGrimmory, progressPagesFromPercent,
    latestHardcoverRead, hardcoverPages, todayDate, conflictStrategy, grimmoryIndex,
    matchedGrimmoryIds, writeTagEnabled, taggedSourceGrimmoryIds, taggedSourceTitles,
    hardcoverSourceGrimmoryIds, audiobookRuntimeForBook, hardcoverProgressPercent,
    absOwnedBookIds, positiveRating, newerSource, meaningfulProgress, hardcoverDate,
    activeGrimmorySiblingsForHardcover, hasActiveBookSiblingForSharedHardcover } = context;
// ── Phase F: HC user states + API sync ───────────────────────────────────
// For each HC book, find its matching Grimmory book (via the in-memory index
// AND the book_sources reconciliation), then apply conflict resolution and
// write user_book_states.
for (const hcBook of hcBooks) {
  const hcSource = getBookSource(db, "hardcover", profileId, hcBook.book.id);
  if (!hcSource?.book_id) {
    // Should not happen after reconcile, but skip gracefully
    logger.warn("HC book source has no book_id after reconcile", { profileId, hardcoverBookId: hcBook.book.id });
    continue;
  }
  const bookId = hcSource.book_id;

  const preferredSiblings = grimmoryAvailable
    ? activeGrimmorySiblingsForHardcover(grimmoryBooks, hcBook.book.id)
    : { book: null, audiobook: null };
  const bookOwnsSharedHardcover = hasActiveBookSiblingForSharedHardcover(grimmoryBooks, hcBook.book.id);

  // Find matching Grimmory book via the in-memory matcher
  const match = bookOwnsSharedHardcover && preferredSiblings.book
    ? { grimmoryBook: preferredSiblings.book, confidence: "high" as const, matchType: "hardcover_book_id" as const }
    : grimmoryAvailable
    ? matchHardcoverBook(hcBook, grimmoryIndex, {
        goodreadsId: getGoodreadsExternalId(db, profileId, bookId),
        mediaTypeHint: (hcSource.source_media_type as "physical" | "ebook" | "audiobook" | null | undefined) ?? null
      })
    : null;
  const grBook = match?.grimmoryBook ?? null;
  const localIdentityGrimmoryBook = !grBook && grimmoryAvailable
    ? localGrimmoryBookForBookId(db, profileId, bookId, grimmoryBooks)
    : null;
  if (grBook) matchedGrimmoryIds.add(grBook.id);
  if (localIdentityGrimmoryBook) matchedGrimmoryIds.add(localIdentityGrimmoryBook.id);

  const title = hcBook.book.title ?? grBook?.title ?? localIdentityGrimmoryBook?.title ?? "";

  if (writeTagEnabled && grBook) {
    taggedSourceGrimmoryIds.add(grBook.id);
    taggedSourceTitles.set(grBook.id, title);
  }
  if (grBook) hardcoverSourceGrimmoryIds.add(grBook.id);

  // Load previous states for change detection and conflict resolution
  const prevHcState = getUserState(db, bookId, profileId, "hardcover");
  const prevGrState = grimmoryAvailable
    ? getUserState(db, bookId, profileId, "grimmory")
    : null;

  const hcStatusId = hcBook.status_id;
  const grStatus = grBook?.readStatus ?? null;
  const projectedHcStatus = grStatus
    ?? localIdentityGrimmoryBook?.readStatus
    ?? prevHcState?.status
    ?? null;
  const audiobookRuntimeSeconds = audiobookRuntimeForBook(db, profileId, bookId);

  const { decision, syncHealth, writeGrimmory, writeHardcover } = localIdentityGrimmoryBook
    ? {
        decision: "local_identity_has_grimmory_match",
        syncHealth: "synced",
        writeGrimmory: false,
        writeHardcover: false
      }
    : grimmoryAvailable
    ? computeSyncDecision({
        hcBook, grBook, conflictStrategy,
        syncStatusEnabled: profile["sync_status_enabled"] !== 0,
        previousGrimmoryStatus: prevGrState?.status ?? null,
        previousHardcoverStatusId: prevHcState?.hardcover_status_id ?? null
      })
    : {
        decision: "grimmory_unavailable",
        syncHealth: prevHcState?.sync_health ?? "pending",
        writeGrimmory: false, writeHardcover: false
      };

  if (hcBook.id && hardcoverToken) {
    await cleanupDuplicateBlankHardcoverReads({
      db,
      runId,
      profileId,
      title,
      bookId,
      hcBook,
      hardcoverToken,
      dryRun,
      counters,
      adapters
    });
  }

  // Use the persisted, stable edition id for this Hardcover row (set in
  // Phase C) rather than Hardcover's live per-run edition_id, so read
  // selection isn't thrown off by the same "current edition" drift that
  // Phase C already guards against.
  const persistedEditionId = hcSource.source_edition_id != null
    ? Number.parseInt(hcSource.source_edition_id, 10)
    : null;
  const readSelectionEditionId = Number.isFinite(persistedEditionId) ? persistedEditionId : null;
  const hcRead = latestHardcoverRead(hcBook, readSelectionEditionId);
  const hcProgress = hardcoverProgressPercent(hcBook, audiobookRuntimeSeconds, readSelectionEditionId);
  const hcPages = hardcoverPages(hcBook, hcRead);

  if (!prevHcState && hasGrimmory && !grimmoryAvailable) {
    recordEvent(db, runId, profileId, title, "skipped_no_change", null, "grimmory_unavailable_no_local_insert", {
      source: "grimmory", hardcoverBookId: hcBook.book.id
    });
    counters.skipped++;
    continue;
  }

  const meaningfulChange = hasMeaningfulHcChange(prevHcState, {
    hardcoverStatusId: hcStatusId ?? null,
    hardcoverRating: hcBook.rating ?? null,
    hardcoverProgress: hcProgress
  });

  // Upsert user_book_states (hardcover)
  const hcStateFields: Record<string, unknown> = {
    status: projectedHcStatus,
    rating: hcBook.rating ?? null,
    progress: hcProgress,
    progress_pages: hcRead?.progress_pages ?? null,
    progress_seconds: hcRead?.progress_seconds ?? null,
    last_read_date: hcBook.last_read_date ?? null,
    date_finished: null,
    sync_health: syncHealth,
    match_confidence: match?.confidence ?? (localIdentityGrimmoryBook ? "low" : "none"),
    match_type: match?.matchType ?? (localIdentityGrimmoryBook ? "local_identity" : null),
    last_sync_decision: decision,
    hardcover_status_id: hcStatusId ?? null,
    hardcover_user_book_id: hcBook.id ?? null,
    hardcover_read_id: hcRead?.id ?? null,
    hardcover_updated_at: hcBook.updated_at ?? null,
    hardcover_pages: hcPages
  };

  if (prevHcState) {
    const setClauses = Object.keys(hcStateFields).map((k) => `${k} = ?`).join(", ");
    db.prepare(`
      UPDATE user_book_states SET ${setClauses},
        last_sync_at = datetime('now'),
        last_modified_at = CASE WHEN ? THEN datetime('now') ELSE last_modified_at END
      WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'
    `).run(...Object.values(hcStateFields), meaningfulChange ? 1 : 0, bookId, profileId);
  } else {
    const cols = ["book_id", "profile_id", "source_type", ...Object.keys(hcStateFields)].join(", ");
    const placeholders = Array(Object.keys(hcStateFields).length + 3).fill("?").join(", ");
    db.prepare(`INSERT OR IGNORE INTO user_book_states (${cols}, last_sync_at) VALUES (${placeholders}, datetime('now'))`)
      .run(bookId, profileId, "hardcover", ...Object.values(hcStateFields));
  }

  // ── Apply writes ──────────────────────────────────────────────────────
  // Skip pushing Hardcover's status onto Grimmory for ABS-owned audiobooks —
  // Phase N derives and writes the correct status from actual ABS listening
  // progress instead, since Hardcover's status_id for these can be stale.
  if (writeGrimmory && grBook && grimmoryAvailable && grimmoryToken && hcStatusId !== null && !absOwnedBookIds.has(bookId)) {
    const targetStatus = HARDCOVER_TO_GRIMMORY[hcStatusId];
    if (targetStatus) {
      if (!dryRun) {
        try {
          await adapters.updateGrimmoryStatus(baseUrl, grimmoryToken, grBook.id, targetStatus);
          logger.info("Wrote status to Grimmory", { profileId, bookId: grBook.id, status: targetStatus });
        } catch (writeErr) {
          logger.warn("Failed to write status to Grimmory", { profileId, bookId: grBook.id, error: writeErr });
          recordEvent(db, runId, profileId, title, "api_failure", "hardcover_to_grimmory", "write_failed", { error: String(writeErr) });
          counters.skipped++;
          continue;
        }
      }
      recordEvent(db, runId, profileId, title, "written", "hardcover_to_grimmory", decision, { hcStatusId, targetStatus, dryRun });
      counters.written++;
    } else {
      counters.skipped++;
    }
  } else if (writeHardcover && grStatus) {
    const hardcoverFields = grBook ? hardcoverFieldsFromGrimmory(grBook) : null;
    if (hardcoverFields?.status_id) {
      if (!dryRun) {
        try {
          if (hcBook.id) {
            await adapters.updateHardcoverUserBook(hardcoverToken, hcBook.id, hardcoverFields);
            logger.info("Wrote status to Hardcover", { profileId, userBookId: hcBook.id, statusId: hardcoverFields.status_id });
          } else {
            const targetRating = grBook ? grimmoryToHardcoverRating(grimmoryRating(grBook)) : null;
            await adapters.insertHardcoverUserBook(hardcoverToken, {
              book_id: hcBook.book.id,
              ...hardcoverFields,
              ...(targetRating !== null ? { rating: targetRating } : {})
            });
            if (targetRating !== null) {
              db.prepare("UPDATE user_book_states SET rating = ? WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'")
                .run(targetRating, bookId, profileId);
            }
            logger.info("Inserted status for list-only Hardcover book", { profileId, bookId: hcBook.book.id, statusId: hardcoverFields.status_id });
          }
        } catch (writeErr) {
          logger.warn("Failed to write status to Hardcover", { profileId, userBookId: hcBook.id, bookId: hcBook.book.id, error: writeErr });
          recordEvent(db, runId, profileId, title, "api_failure", "grimmory_to_hardcover", "write_failed", { error: String(writeErr) });
          counters.skipped++;
          continue;
        }
      }
      recordEvent(db, runId, profileId, title, "written", "grimmory_to_hardcover", decision, { grStatus, targetStatusId: hardcoverFields.status_id, dryRun });
      counters.written++;
    } else {
      counters.skipped++;
    }
  } else if (syncHealth === "missing") {
    recordEvent(db, runId, profileId, title, "missing_match", null, "no_grimmory_match", {});
    counters.skipped++;
  } else if (!grimmoryAvailable && hasGrimmory) {
    recordEvent(db, runId, profileId, title, "skipped_no_change", null, "grimmory_unavailable_preserved", { source: "grimmory" });
    counters.skipped++;
  } else {
    recordEvent(db, runId, profileId, title, "skipped_no_change", null, decision, {});
    counters.skipped++;
  }

  // ── Rating sync ──────────────────────────────────────────────────────
  if (profile["sync_status_enabled"] !== 0 && grBook && grimmoryAvailable && grimmoryToken) {
    const grRating = positiveRating(grimmoryRating(grBook));
    const hcRating = positiveRating(hcBook.rating);
    const grAsHardcover = grimmoryToHardcoverRating(grRating);
    const hcAsGrimmory = hardcoverToGrimmoryRating(hcRating);
    const ratingsAlreadySynced = grAsHardcover !== null && hcRating !== null && sameNumber(grAsHardcover, hcRating);
    const grRatingChanged = prevGrState?.rating != null ? !sameNumber(grRating, prevGrState.rating) : false;
    const hcRatingChanged = prevHcState?.rating != null ? !sameNumber(hcRating, prevHcState.rating) : false;

    let ratingDirection: "grimmory_to_hardcover" | "hardcover_to_grimmory" | null = null;
    let ratingDecision = "rating_already_synced";

    if (!ratingsAlreadySynced) {
      if (grRating !== null && hcRating === null) {
        ratingDirection = "grimmory_to_hardcover";
        ratingDecision = "grimmory_only_rating";
      } else if (grRating === null && hcRating !== null) {
        ratingDirection = "hardcover_to_grimmory";
        ratingDecision = "hardcover_only_rating";
      } else if (grRating !== null && hcRating !== null) {
        if (conflictStrategy === "grimmory_wins") {
          ratingDirection = "grimmory_to_hardcover";
          ratingDecision = "grimmory_wins_rating";
        } else if (conflictStrategy === "hardcover_wins") {
          ratingDirection = "hardcover_to_grimmory";
          ratingDecision = "hardcover_wins_rating";
        } else if (grRatingChanged && !hcRatingChanged) {
          ratingDirection = "grimmory_to_hardcover";
          ratingDecision = "grimmory_rating_changed";
        } else if (hcRatingChanged && !grRatingChanged) {
          ratingDirection = "hardcover_to_grimmory";
          ratingDecision = "hardcover_rating_changed";
        } else {
          const latestRatingSource = newerSource(hcBook.updated_at ?? null, grBook.lastReadTime ?? null);
          if (latestRatingSource === "hardcover") {
            ratingDirection = "hardcover_to_grimmory";
            ratingDecision = "latest_rating_hardcover";
          } else if (latestRatingSource === "grimmory") {
            ratingDirection = "grimmory_to_hardcover";
            ratingDecision = "latest_rating_grimmory";
          } else {
            ratingDirection = "grimmory_to_hardcover";
            ratingDecision = !grRatingChanged && !hcRatingChanged
              ? "stored_rating_mismatch_no_timestamps_grimmory_preferred"
              : "initial_rating_grimmory_preferred";
          }
        }
      }
    }

    if (ratingDirection === "grimmory_to_hardcover" && grAsHardcover !== null) {
      if (dryRun) {
        recordEvent(db, runId, profileId, title, "written", "grimmory_to_hardcover", ratingDecision, { grimmoryRating: grRating, targetRating: grAsHardcover, dryRun });
        counters.written++;
      } else {
        try {
          if (hcBook.id) {
            await adapters.updateHardcoverUserBook(hardcoverToken, hcBook.id, { rating: grAsHardcover });
            logger.info("Wrote rating to Hardcover", { profileId, userBookId: hcBook.id, grimmoryRating: grRating, hardcoverRating: grAsHardcover });
          } else {
            await adapters.insertHardcoverUserBook(hardcoverToken, { book_id: hcBook.book.id, rating: grAsHardcover });
            logger.info("Inserted rating for list-only Hardcover book", { profileId, hardcoverBookId: hcBook.book.id, grimmoryRating: grRating, hardcoverRating: grAsHardcover });
          }
          db.prepare("UPDATE user_book_states SET rating = ?, last_sync_at = datetime('now'), last_sync_decision = ?, last_modified_at = datetime('now') WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'")
            .run(grAsHardcover, ratingDecision, bookId, profileId);
          recordEvent(db, runId, profileId, title, "written", "grimmory_to_hardcover", ratingDecision, { grimmoryRating: grRating, targetRating: grAsHardcover });
          counters.written++;
        } catch (writeErr) {
          logger.warn("Failed to write rating to Hardcover", { profileId, userBookId: hcBook.id, hardcoverBookId: hcBook.book.id, error: writeErr });
          recordEvent(db, runId, profileId, title, "api_failure", "grimmory_to_hardcover", "rating_write_failed", { error: String(writeErr) });
          counters.skipped++;
        }
      }
    } else if (ratingDirection === "hardcover_to_grimmory" && hcAsGrimmory !== null) {
      if (dryRun) {
        recordEvent(db, runId, profileId, title, "written", "hardcover_to_grimmory", ratingDecision, { hardcoverRating: hcRating, targetRating: hcAsGrimmory, dryRun });
        counters.written++;
      } else {
        try {
          await adapters.updateGrimmoryRating(baseUrl, grimmoryToken, grBook.id, hcAsGrimmory);
          db.prepare("UPDATE user_book_states SET rating = ?, last_sync_at = datetime('now'), last_sync_decision = ?, last_modified_at = datetime('now') WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'")
            .run(hcAsGrimmory, ratingDecision, bookId, profileId);
          recordEvent(db, runId, profileId, title, "written", "hardcover_to_grimmory", ratingDecision, { hardcoverRating: hcRating, targetRating: hcAsGrimmory });
          counters.written++;
          logger.info("Wrote rating to Grimmory", { profileId, grimmoryBookId: grBook.id, hardcoverRating: hcRating, grimmoryRating: hcAsGrimmory });
        } catch (writeErr) {
          logger.warn("Failed to write rating to Grimmory", { profileId, grimmoryBookId: grBook.id, error: writeErr });
          recordEvent(db, runId, profileId, title, "api_failure", "hardcover_to_grimmory", "rating_write_failed", { error: String(writeErr) });
          counters.skipped++;
        }
      }
    }
  }

  // ── Progress sync ────────────────────────────────────────────────────
  if (profile["sync_progress_enabled"] !== 0 && grBook && grimmoryAvailable && grimmoryToken && grBook.mediaType !== "audiobook") {
    const grProgress = meaningfulProgress(grBook.readProgress ?? null);
    const hcProgressNow = hcProgress;
    // 0.5% tolerance accounts for integer page-count rounding: converting a % to pages
    // and back can introduce up to 0.5/pages*100% error (e.g. 0.26% for a 196-page book).
    const progressAlreadySynced = grProgress !== null && hcProgressNow !== null && Math.abs(grProgress - hcProgressNow) < 0.5;
    const hadPreviousProgress = prevGrState?.progress != null || prevHcState?.progress != null;
    const grProgressChanged = prevGrState?.progress != null
      ? (grProgress === null || Math.abs(grProgress - prevGrState.progress) >= 0.1)
      : false;
    const hcProgressChanged = prevHcState?.progress != null
      ? (hcProgressNow === null || Math.abs(hcProgressNow - prevHcState.progress) >= 0.1)
      : false;

    let progressDirection: "grimmory_to_hardcover" | "hardcover_to_grimmory" | null = null;
    let progressDecision = "progress_already_synced";

    if (bookOwnsSharedHardcover && grProgress !== null && !progressAlreadySynced) {
      // Hardcover only exposes one current-progress slot per work. When a
      // book sibling is active, the book edition owns that slot even if the
      // profile's general conflict strategy is Hardcover-wins.
      progressDirection = "grimmory_to_hardcover";
      progressDecision = "book_progress_wins_shared_hardcover";
    } else if (!progressAlreadySynced) {
      const grTime = grBook.lastReadTime ?? null;
      const hcTime = hcBook.updated_at ?? null;
      const latestProgressSource = newerSource(hcTime, grTime);
      if (grProgress !== null && hcProgressNow === null) {
        if (conflictStrategy === "hardcover_wins" || (conflictStrategy === "latest_wins" && (hcProgressChanged || latestProgressSource === "hardcover"))) {
          progressDirection = "hardcover_to_grimmory";
          progressDecision = "hardcover_progress_cleared";
        } else {
          progressDirection = "grimmory_to_hardcover";
          progressDecision = "grimmory_only_progress";
        }
      } else if (grProgress === null && hcProgressNow !== null) {
        if (conflictStrategy === "grimmory_wins" || (conflictStrategy === "latest_wins" && (grProgressChanged || latestProgressSource === "grimmory"))) {
          progressDirection = "grimmory_to_hardcover";
          progressDecision = "grimmory_progress_cleared";
        } else {
          progressDirection = "hardcover_to_grimmory";
          progressDecision = "hardcover_only_progress";
        }
      } else if (grProgress !== null && hcProgressNow !== null) {
        if (conflictStrategy === "grimmory_wins") {
          progressDirection = "grimmory_to_hardcover";
          progressDecision = "grimmory_wins_progress";
        } else if (conflictStrategy === "hardcover_wins") {
          progressDirection = "hardcover_to_grimmory";
          progressDecision = "hardcover_wins_progress";
        } else if (grProgressChanged && !hcProgressChanged) {
          progressDirection = "grimmory_to_hardcover";
          progressDecision = "grimmory_progress_changed";
        } else if (hcProgressChanged && !grProgressChanged) {
          progressDirection = "hardcover_to_grimmory";
          progressDecision = "hardcover_progress_changed";
        } else if (latestProgressSource === "grimmory") {
          progressDirection = "grimmory_to_hardcover";
          progressDecision = "latest_progress_grimmory";
        } else if (latestProgressSource === "hardcover") {
          progressDirection = "hardcover_to_grimmory";
          progressDecision = "latest_progress_hardcover";
        } else if (!hadPreviousProgress) {
          progressDirection = "hardcover_to_grimmory";
          progressDecision = "initial_progress_hardcover_preferred";
        }
      }
    }

    // Lazy edition resolution: only for actively-reading books, cached permanently.
    // Fetches once when no edition is stored yet, and re-fetches if hcPages changes
    // (meaning the user switched editions or the file was replaced).
    let resolvedEditionId: number | null = prevHcState?.hardcover_edition_id ?? null;
    const storedEditionPages = prevHcState?.hardcover_edition_pages ?? null;
    const needsEditionResolution = hcProgress !== null
      && hcPages !== null
      && storedEditionPages !== hcPages;

    if (needsEditionResolution && hardcoverToken) {
      try {
        const editions = await adapters.fetchEditionsForBook(hardcoverToken, hcBook.book.id);
        const matched = editions.find((e: any) => e.pages === hcPages);
        if (matched) {
          resolvedEditionId = matched.id;
          db.prepare(`
            UPDATE user_book_states SET hardcover_edition_id = ?, hardcover_edition_pages = ?
            WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'
          `).run(resolvedEditionId, hcPages, bookId, profileId);
          logger.info("Resolved Hardcover edition for progress tracking", {
            profileId, bookId, editionId: resolvedEditionId, pages: hcPages
          });
        } else {
          // Keep the page count as a negative cache; resolve again only when it changes.
          resolvedEditionId = null;
          db.prepare(`
            UPDATE user_book_states SET hardcover_edition_id = NULL, hardcover_edition_pages = ?
            WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'
          `).run(hcPages, bookId, profileId);
          logger.warn("No Hardcover edition matched page count; edition will not be set on progress writes", {
            profileId, bookId, hcPages, available: editions.map((e: any) => e.pages)
          });
        }
      } catch (editionErr) {
        logger.warn("Failed to fetch editions for Hardcover book", { profileId, bookId, error: editionErr });
      }
    }

    if (progressDirection === "grimmory_to_hardcover" && grProgress !== null) {
      const progressPages = progressPagesFromPercent(grProgress, hcPages);
      if (!progressPages) {
        logger.warn("Skipping Grimmory progress write to Hardcover without page count", { profileId, bookId, grimmoryBookId: grBook.id });
      } else if (dryRun) {
        recordEvent(db, runId, profileId, title, "written", "grimmory_to_hardcover", progressDecision, { progress: grProgress, progressPages, dryRun });
        counters.written++;
      } else if (!hcRead?.id && !hcBook.id) {
        logger.warn("Skipping Hardcover progress write without a user-book record", { profileId, bookId });
        counters.skipped++;
      } else {
        try {
          const readFields: HardcoverReadFields = {
            ...(resolvedEditionId !== null ? { edition_id: resolvedEditionId } : {}),
            progress_pages: progressPages,
            started_at: hcRead?.started_at ?? todayDate(),
            finished_at: grBook.readStatus === "READ" ? hardcoverDate(grBook.dateFinished) : null
          };
          const hardcoverReadId = hcRead?.id ?? await adapters.insertHardcoverUserBookRead(hardcoverToken, hcBook.id, readFields);
          if (hcRead?.id) await adapters.updateHardcoverUserBookRead(hardcoverToken, hcRead.id, readFields);
          // Store the round-tripped percentage (pages / totalPages) rather than the raw
          // Grimmory %, so the next sync's hcProgressChanged comparison is stable and
          // doesn't re-trigger a write just from integer rounding.
          const storedProgress = hcPages && hcPages > 0 ? (progressPages / hcPages) * 100 : grProgress;
          db.prepare(`
            UPDATE user_book_states SET progress = ?, progress_pages = ?,
              last_sync_at = datetime('now'), last_sync_decision = ?, last_modified_at = datetime('now')
            WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'
          `).run(storedProgress, progressPages, progressDecision, bookId, profileId);
          // Track the HC read_id for future progress updates
          if (hardcoverReadId) {
            db.prepare("UPDATE user_book_states SET hardcover_read_id = ? WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'")
              .run(hardcoverReadId, bookId, profileId);
          }
          recordEvent(db, runId, profileId, title, "written", "grimmory_to_hardcover", progressDecision, { progress: grProgress, progressPages, editionId: resolvedEditionId });
          counters.written++;
          logger.info("Wrote progress to Hardcover", { profileId, userBookId: hcBook.id, progress: grProgress, progressPages, editionId: resolvedEditionId });
        } catch (writeErr) {
          logger.warn("Failed to write progress to Hardcover", { profileId, userBookId: hcBook.id, error: writeErr });
          recordEvent(db, runId, profileId, title, "api_failure", "grimmory_to_hardcover", "progress_write_failed", { error: String(writeErr) });
          counters.skipped++;
        }
      }
    } else if (progressDirection === "hardcover_to_grimmory" && hcProgressNow !== null) {
      const primaryFileId = grBook.primaryFileId;
      if (!primaryFileId) {
        logger.warn("Skipping Hardcover progress write to Grimmory without primary file ID", { profileId, bookId, grimmoryBookId: grBook.id });
      } else if (dryRun) {
        recordEvent(db, runId, profileId, title, "written", "hardcover_to_grimmory", progressDecision, { progress: hcProgressNow, dryRun });
        counters.written++;
      } else {
        try {
          await adapters.updateGrimmoryProgress(baseUrl, grimmoryToken, grBook.id, primaryFileId, hcProgressNow);
          db.prepare("UPDATE user_book_states SET progress = ?, last_sync_at = datetime('now'), last_sync_decision = ?, last_modified_at = datetime('now') WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'")
            .run(hcProgressNow, progressDecision, bookId, profileId);
          recordEvent(db, runId, profileId, title, "written", "hardcover_to_grimmory", progressDecision, { progress: hcProgressNow });
          counters.written++;
          logger.info("Wrote progress to Grimmory", { profileId, grimmoryBookId: grBook.id, progress: hcProgressNow });
        } catch (writeErr) {
          logger.warn("Failed to write progress to Grimmory", { profileId, grimmoryBookId: grBook.id, error: writeErr });
          recordEvent(db, runId, profileId, title, "api_failure", "hardcover_to_grimmory", "progress_write_failed", { error: String(writeErr) });
          counters.skipped++;
        }
      }
    } else if (progressDirection === "hardcover_to_grimmory" && hcProgressNow === null) {
      const primaryFileId = grBook.primaryFileId;
      if (!primaryFileId) {
        logger.warn("Skipping Grimmory progress clear without primary file ID", { profileId, bookId, grimmoryBookId: grBook.id });
        counters.skipped++;
      } else if (dryRun) {
        recordEvent(db, runId, profileId, title, "written", "hardcover_to_grimmory", progressDecision, { clearedProgress: true, grimmoryProgress: grProgress, dryRun });
        counters.written++;
      } else {
        try {
          await adapters.clearGrimmoryProgress(baseUrl, grimmoryToken, grBook.id, primaryFileId);
          db.prepare("UPDATE user_book_states SET progress = NULL, last_sync_at = datetime('now'), last_sync_decision = ?, last_modified_at = datetime('now') WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'")
            .run(progressDecision, bookId, profileId);
          recordEvent(db, runId, profileId, title, "written", "hardcover_to_grimmory", progressDecision, { clearedProgress: true, previousGrimmoryProgress: grProgress });
          counters.written++;
          logger.info("Cleared Grimmory progress from Hardcover source", { profileId, bookId, grimmoryBookId: grBook.id });
        } catch (writeErr) {
          logger.warn("Failed to clear Grimmory progress", { profileId, grimmoryBookId: grBook.id, error: writeErr });
          recordEvent(db, runId, profileId, title, "api_failure", "hardcover_to_grimmory", "progress_clear_failed", { error: String(writeErr) });
          counters.skipped++;
        }
      }
    } else if (progressDirection === "grimmory_to_hardcover" && grProgress === null) {
      logger.info("Skipped restoring cleared Grimmory progress", { profileId, bookId, grimmoryBookId: grBook.id, progressDecision });
      recordEvent(db, runId, profileId, title, "skipped_no_change", "grimmory_to_hardcover", progressDecision, { hardcoverProgress: hcProgressNow });
      counters.skipped++;
    }
  }
}

}
