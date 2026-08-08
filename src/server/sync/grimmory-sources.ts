import { grimmoryAuthorName, grimmoryCoverUrl } from "./grimmory.js";
import { logger } from "../logger.js";
export async function persistGrimmorySources(context: any): Promise<void> {
  const { db, profileId, grimmoryAvailable, grimmoryBooks, upsertBookSource, enqueueImageCacheTask, cacheSourceCover,
    sqliteNow, grimmoryToken, cacheGrimmoryCover, baseUrl } = context;
// ── Phase B: Write Grimmory book_sources ────────────────────────────────
// Grimmory books are written first so reconcileBookIdentities() can assign
// book_ids that HC can then look up when writing user_book_states.

if (grimmoryAvailable) {
  for (const grBook of grimmoryBooks) {
    const title = grBook.title ?? "";
    const author = grimmoryAuthorName(grBook) ?? null;
    const coverUrl = grimmoryCoverUrl(grBook) ?? null;

    const sourceId = upsertBookSource(db, "grimmory", profileId, grBook.id, {
      title,
      author,
      cover_url: coverUrl,
      isbn13: grBook.isbn13 ?? null,
      isbn10: grBook.isbn10 ?? null,
      series_name: grBook.seriesName ?? null,
      series_number: grBook.seriesNumber ?? null,
      source_media_type: grBook.mediaType ?? null,
      source_narrator: grBook.narrator ?? null,
      source_audible_asin: grBook.audibleAsin ?? null,
      source_hardcover_book_id: grBook.hardcoverBookId ?? null,
      source_hardcover_slug: grBook.hardcoverId ?? null,
      source_goodreads_book_id: grBook.goodreadsId ?? null,
      grimmory_hardcover_book_id: grBook.hardcoverBookId ?? null,
      grimmory_goodreads_id: grBook.goodreadsId ?? null,
      grimmory_hardcover_id: grBook.hardcoverId ?? null,
      grimmory_primary_file_path: grBook.primaryFilePath ?? null,
      last_sync_at: sqliteNow(),
      last_sync_decision: "grimmory_source"
    });

    if (coverUrl) {
      enqueueImageCacheTask(`cover:${sourceId}`, async () => {
        await cacheSourceCover(db, sourceId, "grimmory", coverUrl);
      });
    } else if (grimmoryToken) {
      enqueueImageCacheTask(`cover:${sourceId}`, async () => {
        await cacheGrimmoryCover(db, sourceId, baseUrl, grimmoryToken, grBook.id, grBook.mediaType ?? null);
      });
    }
  }

  logger.info("Grimmory book_sources written", { profileId, count: grimmoryBooks.length });
}

}
