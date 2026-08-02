import { logger } from "../logger.js";
import { reconcileBookIdentities } from "../db/bookIdentity.js";
import { identifierVariants, normalizeExternalId, normalizeIsbn } from "../identifiers.js";
import { enqueueImageCacheTask } from "../image-cache.js";
import { GOODREADS_TO_GRIMMORY } from "./matcher.js";
import { normalizeTitle, normalizeSeriesNumber } from "./normalization.js";
export async function syncGoodreadsEnrichment(context: any): Promise<boolean> {
  const { db, profileId, runId, profile, adapters, counters, dryRun, grimmoryAvailable, hasGrimmory, baseUrl, grimmoryToken, recordEvent,
    pruneGoodreadsUserStatesMissingFromFetch, getUserState, hardcoverToGrimmoryRating, writeTagEnabled, taggedSourceGrimmoryIds, taggedSourceTitles,
    goodreadsSourceGrimmoryIds, hasMeaningfulGoodreadsChange, upsertBookSource, sqliteNow, cacheSourceCover,
    shouldGoodreadsOverwriteGrimmory, sameNumber, syncGoodreadsShelvesToGrimmory } = context;
// ── Phase H: Goodreads enrichment ────────────────────────────────────────
let grimmoryShelvesCleared = false;
const goodreadsUserId = profile["goodreads_user_id"] as string | null;
const goodreadsSyncShelfName = (profile["goodreads_sync_shelf_name"] as string | null)?.trim() || null;
const goodreadsConnectionEnabled = profile["goodreads_enabled"] as number | null;
const syncGoodreadsStatus = !!(profile["sync_goodreads_status_enabled"] as number | null);

if (goodreadsConnectionEnabled && goodreadsUserId?.trim()) {
  const goodreadsShelves = goodreadsSyncShelfName ? [goodreadsSyncShelfName] : undefined;
  logger.info("Fetching Goodreads library", { profileId, goodreadsUserId, shelfFilter: goodreadsSyncShelfName });
  try {
    const goodreadsBooks = await adapters.fetchAllGoodreadsBooks(goodreadsUserId, goodreadsShelves);
    logger.info("Goodreads library fetched", { profileId, count: goodreadsBooks.length, shelfFilter: goodreadsSyncShelfName });

    // A selected shelf is intentionally only a subset of the Goodreads library.
    // It may enrich the selected books, but it must never prune state for books
    // on the user's other shelves.
    pruneGoodreadsUserStatesMissingFromFetch(
      db,
      profileId,
      new Set(goodreadsBooks.map((b: any) => b.goodreadsId)),
      goodreadsSyncShelfName ? "partial" : "complete"
    );

    // Build lookup indexes from existing book_sources and user_book_states for matching
    type LinkLookup = { book_id: number; ustate_id: number | null };
    const existingByGoodreadsId: Record<string, LinkLookup> = {};
    const existingByIsbn13: Record<string, LinkLookup> = {};
    const existingByIsbn10: Record<string, LinkLookup> = {};
    const existingByTitle: Record<string, Array<LinkLookup & {
      author: string | null;
      seriesName: string | null;
      seriesNumber: string | null;
    }>> = {};

    // Look up across all book_sources (not just this profile) to find any matching book
    const allSources = db.prepare(`
      SELECT bs.book_id, bs.source_type, bs.external_id,
             bs.grimmory_goodreads_id, bs.source_goodreads_book_id,
             bs.source_goodreads_work_id, bs.source_goodreads_edition_id,
             bs.isbn13, bs.isbn10, bs.title,
             bs.author, bs.series_name, bs.series_number,
             ubs.id as ustate_id
      FROM book_sources bs
      LEFT JOIN user_book_states ubs ON ubs.book_id = bs.book_id AND ubs.profile_id = ? AND ubs.source_type = 'goodreads'
      WHERE bs.book_id IS NOT NULL
    `).all(profileId) as Array<{
      book_id: number; source_type: string; external_id: string;
      grimmory_goodreads_id: string | null; source_goodreads_book_id: string | null;
      source_goodreads_work_id: string | null; source_goodreads_edition_id: string | null;
      isbn13: string | null; isbn10: string | null;
      title: string | null; author: string | null; series_name: string | null; series_number: string | null;
      ustate_id: number | null;
    }>;

    const addGoodreadsLookup = (value: string | null | undefined, lookup: LinkLookup): void => {
      for (const id of identifierVariants(value)) {
        existingByGoodreadsId[id] ??= lookup;
      }
    };

    for (const src of allSources) {
      const lookup: LinkLookup = { book_id: src.book_id, ustate_id: src.ustate_id };
      if (src.source_type === "goodreads") {
        addGoodreadsLookup(src.external_id, lookup);
      }
      if (src.source_type === "grimmory" && src.grimmory_goodreads_id) {
        addGoodreadsLookup(src.grimmory_goodreads_id, lookup);
      }
      addGoodreadsLookup(src.source_goodreads_book_id, lookup);
      addGoodreadsLookup(src.source_goodreads_work_id, lookup);
      addGoodreadsLookup(src.source_goodreads_edition_id, lookup);
      const isbn13 = normalizeIsbn(src.isbn13);
      const isbn10 = normalizeIsbn(src.isbn10);
      if (isbn13) existingByIsbn13[isbn13] ??= lookup;
      if (isbn10) existingByIsbn10[isbn10] ??= lookup;
      const norm = src.title ? normalizeTitle(src.title) : "";
      if (norm) {
        const candidates = existingByTitle[norm] ?? [];
        candidates.push({
          ...lookup,
          author: src.author ? normalizeTitle(src.author) : null,
          seriesName: src.series_name ? normalizeTitle(src.series_name) : null,
          seriesNumber: normalizeSeriesNumber(src.series_number)
        });
        existingByTitle[norm] = candidates;
      }
    }

    let goodreadsMatched = 0;
    let goodreadsUnmatched = 0;

    for (const grBook of goodreadsBooks) {
      let matched: LinkLookup | undefined;
      let matchType: string | null = null;

      const normalizedGoodreadsId = normalizeExternalId(grBook.goodreadsId);
      const normalizedIsbn13 = normalizeIsbn(grBook.isbn13);
      const normalizedIsbn10 = normalizeIsbn(grBook.isbn10);
      if (normalizedGoodreadsId && existingByGoodreadsId[normalizedGoodreadsId]) {
        matched = existingByGoodreadsId[normalizedGoodreadsId];
        matchType = "goodreads_id";
      } else if (normalizedIsbn13 && existingByIsbn13[normalizedIsbn13]) {
        matched = existingByIsbn13[normalizedIsbn13];
        matchType = "isbn13";
      } else if (normalizedIsbn10 && existingByIsbn10[normalizedIsbn10]) {
        matched = existingByIsbn10[normalizedIsbn10];
        matchType = "isbn10";
      } else {
        const norm = normalizeTitle(grBook.title);
        const grAuthor = grBook.author ? normalizeTitle(grBook.author) : null;
        const grSeriesName = grBook.seriesName ? normalizeTitle(grBook.seriesName) : null;
        const grSeriesNumber = normalizeSeriesNumber(grBook.seriesNumber);
        const candidates = norm ? existingByTitle[norm] : undefined;
        const candidate = candidates?.find((existing) => {
          if (existing.author && grAuthor && existing.author !== grAuthor) return false;
          if (existing.seriesName && grSeriesName && existing.seriesName !== grSeriesName) return false;
          if (existing.seriesNumber && grSeriesNumber && existing.seriesNumber !== grSeriesNumber) return false;
          return true;
        });
        if (candidate) {
          matched = candidate;
          matchType = "title_author";
        }
      }

      // Load previous GR state for this book if it exists
      const prevGoState = matched ? getUserState(db, matched.book_id, profileId, "goodreads") : undefined;
      const previousShelf = prevGoState?.goodreads_shelf ?? null;
      const previousGoodreadsRating = prevGoState?.goodreads_rating ?? null;
      const targetGoodreadsRating = hardcoverToGrimmoryRating(grBook.rating);

      if (matched) {
        const bookId = matched.book_id;

        if (writeTagEnabled) {
          // Tag the Grimmory book for this profile
          const grSource = db.prepare(
            "SELECT CAST(external_id AS INTEGER) as grimmory_book_id FROM book_sources WHERE source_type='grimmory' AND source_instance_id = ? AND book_id=? LIMIT 1"
          ).get(profileId, bookId) as { grimmory_book_id: number } | undefined;
          if (grSource?.grimmory_book_id) {
            taggedSourceGrimmoryIds.add(grSource.grimmory_book_id);
            taggedSourceTitles.set(grSource.grimmory_book_id, grBook.title);
            goodreadsSourceGrimmoryIds.add(grSource.grimmory_book_id);
          }
        }

        const meaningfulGoodreadsChange = hasMeaningfulGoodreadsChange(prevGoState, {
          goodreadsShelf: grBook.shelf,
          goodreadsRating: grBook.rating,
          goodreadsReadAt: grBook.readAt
        });

        // Upsert GR book_source
        const goodreadsSourceId = upsertBookSource(db, "goodreads", profileId, grBook.goodreadsId, {
          book_id: bookId,
          title: grBook.title,
          author: grBook.author,
          cover_url: grBook.coverUrl ?? null,
          isbn13: grBook.isbn13 ?? null,
          isbn10: grBook.isbn10 ?? null,
          series_name: grBook.seriesName ?? null,
          series_number: grBook.seriesNumber ?? null,
          source_goodreads_book_id: grBook.goodreadsId,
          goodreads_book_link: grBook.bookLink ?? null,
          last_sync_at: sqliteNow()
        });
        if (grBook.coverUrl) {
          enqueueImageCacheTask(`cover:${goodreadsSourceId}`, async () => {
            await cacheSourceCover(db, goodreadsSourceId, "goodreads", grBook.coverUrl!);
          });
        }

        // Upsert GR user state
        db.prepare(`
          INSERT INTO user_book_states
            (book_id, profile_id, source_type, rating, sync_health,
             goodreads_shelf, goodreads_read_at, goodreads_updated_at,
             goodreads_match_type, goodreads_book_link,
             last_sync_at, last_sync_decision, last_modified_at)
          VALUES (?, ?, 'goodreads', ?, 'synced', ?, ?, ?, ?, ?, datetime('now'), 'goodreads_match', datetime('now'))
          ON CONFLICT(book_id, profile_id, source_type) DO UPDATE SET
            rating = excluded.rating,
            goodreads_shelf = excluded.goodreads_shelf,
            goodreads_read_at = excluded.goodreads_read_at,
            goodreads_updated_at = excluded.goodreads_updated_at,
            goodreads_match_type = excluded.goodreads_match_type,
            goodreads_book_link = excluded.goodreads_book_link,
            sync_health = 'synced',
            last_sync_at = datetime('now'),
            last_sync_decision = 'goodreads_match',
            last_modified_at = CASE WHEN ? THEN datetime('now') ELSE last_modified_at END
        `).run(
          bookId, profileId, grBook.rating,
          grBook.shelf, grBook.readAt, grBook.updatedAt,
          matchType, grBook.bookLink,
          meaningfulGoodreadsChange ? 1 : 0
        );

        // Sync Goodreads status → Grimmory when enabled and shelf changed
        const grSource = db.prepare(
          "SELECT CAST(external_id AS INTEGER) as grimmory_book_id FROM book_sources WHERE source_type='grimmory' AND source_instance_id = ? AND book_id=? LIMIT 1"
        ).get(profileId, bookId) as { grimmory_book_id: number } | undefined;
        const grimmoryBookId = grSource?.grimmory_book_id ?? null;

        if (syncGoodreadsStatus && hasGrimmory && grimmoryToken && grimmoryBookId && grBook.shelf !== previousShelf && previousShelf !== null) {
          const grimmoryStatus = await db.prepare(
            "SELECT status FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'"
          ).get(bookId, profileId) as { status: string | null } | undefined;
          const mappedStatus = GOODREADS_TO_GRIMMORY[grBook.shelf];
          if (mappedStatus && mappedStatus !== grimmoryStatus?.status) {
            const grLastReadTime = (db.prepare(
              "SELECT grimmory_last_read_time FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'"
            ).get(bookId, profileId) as { grimmory_last_read_time: string | null } | undefined)?.grimmory_last_read_time ?? null;
            const goodreadsIsLatest = shouldGoodreadsOverwriteGrimmory(grBook.updatedAt, grLastReadTime);
            if (!goodreadsIsLatest) {
              logger.info("Skipped Goodreads status write because Grimmory is newer", { profileId, bookId, previousShelf, newShelf: grBook.shelf, mappedStatus });
              recordEvent(db, runId, profileId, grBook.title, "skipped_no_change", "goodreads_to_grimmory", "grimmory_newer_than_goodreads", { mappedStatus });
              counters.skipped++;
            } else if (dryRun) {
              recordEvent(db, runId, profileId, grBook.title, "written", "goodreads_to_grimmory", "goodreads_latest_status", { previousShelf, newShelf: grBook.shelf, mappedStatus, dryRun });
              counters.written++;
            } else {
              try {
                await adapters.updateGrimmoryStatus(baseUrl, grimmoryToken, grimmoryBookId, mappedStatus);
                logger.info("Updated Grimmory status from Goodreads", { profileId, bookId, shelf: grBook.shelf, status: mappedStatus });
                db.prepare("UPDATE user_book_states SET status = ? WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'")
                  .run(mappedStatus, bookId, profileId);
                recordEvent(db, runId, profileId, grBook.title, "written", "goodreads_to_grimmory", "goodreads_latest_status", { previousShelf, newShelf: grBook.shelf, mappedStatus });
                counters.written++;
              } catch (err) {
                logger.warn("Failed to update Grimmory status from Goodreads", { profileId, bookId, error: err });
                recordEvent(db, runId, profileId, grBook.title, "api_failure", "goodreads_to_grimmory", "status_write_failed", { error: String(err) });
              }
            }
          }
        }

        // Sync Goodreads rating → Grimmory when enabled and rating changed
        if (syncGoodreadsStatus && hasGrimmory && grimmoryToken && grimmoryBookId && targetGoodreadsRating !== null) {
          const grimmoryRat = (db.prepare(
            "SELECT rating FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'"
          ).get(bookId, profileId) as { rating: number | null } | undefined)?.rating ?? null;
          const grLastReadTime2 = (db.prepare(
            "SELECT grimmory_last_read_time FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'"
          ).get(bookId, profileId) as { grimmory_last_read_time: string | null } | undefined)?.grimmory_last_read_time ?? null;

          if ((grBook.rating !== previousGoodreadsRating || !sameNumber(targetGoodreadsRating, grimmoryRat)) && !sameNumber(targetGoodreadsRating, grimmoryRat)) {
            const goodreadsIsLatest = shouldGoodreadsOverwriteGrimmory(grBook.updatedAt, grLastReadTime2);
            if (!goodreadsIsLatest) {
              recordEvent(db, runId, profileId, grBook.title, "skipped_no_change", "goodreads_to_grimmory", "grimmory_newer_than_goodreads_rating", { goodreadsRating: grBook.rating, targetRating: targetGoodreadsRating });
              counters.skipped++;
            } else if (dryRun) {
              recordEvent(db, runId, profileId, grBook.title, "written", "goodreads_to_grimmory", "goodreads_latest_rating", { goodreadsRating: grBook.rating, targetRating: targetGoodreadsRating, dryRun });
              counters.written++;
            } else {
              try {
                await adapters.updateGrimmoryRating(baseUrl, grimmoryToken, grimmoryBookId, targetGoodreadsRating);
                logger.info("Updated Grimmory rating from Goodreads", { profileId, bookId, goodreadsRating: grBook.rating, targetRating: targetGoodreadsRating });
                recordEvent(db, runId, profileId, grBook.title, "written", "goodreads_to_grimmory", "goodreads_latest_rating", { goodreadsRating: grBook.rating, targetRating: targetGoodreadsRating });
                counters.written++;
              } catch (err) {
                logger.warn("Failed to update Grimmory rating from Goodreads", { profileId, bookId, error: err });
                recordEvent(db, runId, profileId, grBook.title, "api_failure", "goodreads_to_grimmory", "rating_write_failed", { error: String(err) });
              }
            }
          }
        }

        goodreadsMatched++;
      } else {
        // No existing book found — create new GR source + user state
        if (hasGrimmory && !grimmoryAvailable) {
          logger.warn("Skipping new Goodreads-only book: Grimmory unavailable", { profileId, goodreadsId: grBook.goodreadsId, title: grBook.title });
          goodreadsUnmatched++;
          continue;
        }

        // Create GR book_source (book_id will be assigned by reconcile)
        const newSourceId = upsertBookSource(db, "goodreads", profileId, grBook.goodreadsId, {
          title: grBook.title,
          author: grBook.author,
          cover_url: grBook.coverUrl ?? null,
          isbn13: grBook.isbn13 ?? null,
          isbn10: grBook.isbn10 ?? null,
          series_name: grBook.seriesName ?? null,
          series_number: grBook.seriesNumber ?? null,
          source_goodreads_book_id: grBook.goodreadsId,
          goodreads_book_link: grBook.bookLink ?? null,
          last_sync_at: sqliteNow()
        });

        if (grBook.coverUrl) {
          enqueueImageCacheTask(`cover:${newSourceId}`, async () => {
            await cacheSourceCover(db, newSourceId, "goodreads", grBook.coverUrl!);
          });
        }

        // Reconcile to assign book_id, then write user state
        reconcileBookIdentities(db);
        const newSource = db.prepare("SELECT book_id FROM book_sources WHERE id = ?").get(newSourceId) as { book_id: number } | undefined;
        if (newSource?.book_id) {
          db.prepare(`
            INSERT OR IGNORE INTO user_book_states
              (book_id, profile_id, source_type, rating, sync_health,
               goodreads_shelf, goodreads_read_at, goodreads_updated_at,
               goodreads_match_type, goodreads_book_link,
               last_sync_at, last_sync_decision, last_modified_at)
            VALUES (?, ?, 'goodreads', ?, 'missing', ?, ?, ?, ?, ?, datetime('now'), 'goodreads_only', datetime('now'))
          `).run(
            newSource.book_id, profileId, grBook.rating,
            grBook.shelf, grBook.readAt, grBook.updatedAt,
            matchType, grBook.bookLink
          );
          logger.info("Created Goodreads-only book", { profileId, goodreadsId: grBook.goodreadsId, title: grBook.title, bookId: newSource.book_id });
        }
        goodreadsUnmatched++;
      }
    }

    // Reconcile to pick up new GR sources
    reconcileBookIdentities(db);
    logger.info("Goodreads enrichment complete", { profileId, goodreadsMatched, goodreadsUnmatched });

    if (grimmoryAvailable && hasGrimmory && grimmoryToken) {
      db.prepare("UPDATE user_book_states SET grimmory_shelves = NULL WHERE profile_id = ? AND source_type = 'grimmory'").run(profileId);
      grimmoryShelvesCleared = true;
      await syncGoodreadsShelvesToGrimmory(db, profileId, goodreadsUserId, baseUrl, grimmoryToken, dryRun, adapters);
    }
  } catch (err) {
    counters.sourceFailures++;
    logger.warn("Goodreads unavailable; preserving Goodreads data for this sync run", { profileId, error: err });
    recordEvent(db, runId, profileId, "Goodreads", "api_failure", "goodreads", "source_unavailable", { source: "goodreads", error: String(err) });
  }
  }
  return grimmoryShelvesCleared;
}
