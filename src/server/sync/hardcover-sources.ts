import { logger } from "../logger.js";
import { normalizeExternalId } from "../identifiers.js";
export async function persistHardcoverSources(context: any): Promise<void> {
  const { db, profileId, hcBooks, hcEditions, grimmoryAvailable, upsertBookSource, cacheSourceCover, sqliteNow,
    hasHardcover, activeGrimmorySiblingsForHardcover, hasActiveBookSiblingForSharedHardcover, grimmoryBooks, absOwnedHardcoverBookIds,
    inferHardcoverMediaType, firstHardcoverSeries, normalizeEditionFormat, enqueueImageCacheTask,
    pruneHardcoverUserStatesMissingFromFetch, pruneHardcoverSourcesMissingFromFetch, hardcoverSnapshotStatus } = context;
// ── Phase C: Write HC book_sources ─────────────────────────────────────
if (hasHardcover) {
  for (const hcBook of hcBooks) {
    const userEdition = hcBook.edition_id ? hcEditions.get(hcBook.edition_id) : null;
    const preferredSiblings = grimmoryAvailable
      ? activeGrimmorySiblingsForHardcover(grimmoryBooks, hcBook.book.id)
      : { book: null, audiobook: null };
    // A book owns a shared work regardless of whether its audiobook sibling is
    // active. Do not apply this to an ordinary book with no audio sibling.
    const bookOwnsSharedHardcover = hasActiveBookSiblingForSharedHardcover(grimmoryBooks, hcBook.book.id);
    const absOwnsThisHardcoverBook = preferredSiblings.book === null
      && absOwnedHardcoverBookIds.has(normalizeExternalId(hcBook.book.id) ?? String(hcBook.book.id));
    const inferredMediaType = inferHardcoverMediaType(hcBook, userEdition);
    // Hardcover uses one book ID for multiple active editions, while our
    // book_sources row is keyed by that book ID. Keep the row in the book
    // bucket and clear edition-specific fields so HC iteration order cannot
    // flip the local identity between book and audiobook.
    const mediaType = bookOwnsSharedHardcover
      ? "physical"
      : absOwnsThisHardcoverBook
        ? "audiobook"
      : inferredMediaType;
    // Only trust Hardcover's live "current edition" data for audio-specific
    // fields (edition id, format, audio seconds, ASIN) when the current
    // Hardcover edition is actually audio. Shared-book ownership is resolved
    // from active Grimmory siblings above; an inactive ABS sibling must not
    // rewrite the primary book record as audio.
    const trustCurrentEditionForAudio = mediaType !== "audiobook" || inferredMediaType === "audiobook";
    const edition = mediaType === "audiobook"
      ? hcBook.book.default_audio_edition
      : mediaType === "ebook"
        ? hcBook.book.default_ebook_edition
        : hcBook.book.default_physical_edition;
    const title = hcBook.book.title ?? "";
    const author = hcBook.book.contributions?.[0]?.author?.name ?? null;
    const coverUrl = userEdition?.image?.url ?? hcBook.book.image?.url ?? null;
    const hcIsbn13 = userEdition?.isbn_13
      ?? edition?.isbn_13
      ?? hcBook.book.default_audio_edition?.isbn_13
      ?? hcBook.book.default_ebook_edition?.isbn_13
      ?? null;
    const hcIsbn10 = userEdition?.isbn_10
      ?? edition?.isbn_10
      ?? hcBook.book.default_audio_edition?.isbn_10
      ?? hcBook.book.default_ebook_edition?.isbn_10
      ?? null;
    const hardcoverSlug = hcBook.book.slug ?? null;
    const series = firstHardcoverSeries(hcBook);
    const editionFormat = bookOwnsSharedHardcover ? null : normalizeEditionFormat(userEdition?.edition_format);
    const editionAsin = userEdition?.asin?.trim() || null;
    const ebookAsin = mediaType === "ebook"
      ? (editionAsin ?? hcBook.book.default_ebook_edition?.asin ?? null)
      : hcBook.book.default_ebook_edition?.asin ?? null;
    const audioAsin = mediaType === "audiobook"
      ? ((trustCurrentEditionForAudio ? editionAsin : null) ?? hcBook.book.default_audio_edition?.asin ?? null)
      : hcBook.book.default_audio_edition?.asin ?? null;
    const hcAudioSeconds = userEdition?.audio_seconds ?? null;
    // For shared Hardcover books, keep the row edition-neutral as well as
    // book-bucketed; otherwise whichever HC edition syncs last can flip the
    // identity fields for every local sibling.
    const sourceFields: Record<string, unknown> = {
      title,
      author,
      cover_url: coverUrl,
      isbn13: hcIsbn13,
      isbn10: hcIsbn10,
      series_name: series.name,
      series_number: series.number,
      source_hardcover_book_id: hcBook.book.id,
      source_hardcover_slug: hardcoverSlug,
      source_media_type: mediaType,
      source_asin: ebookAsin,
      source_audible_asin: audioAsin,
      hardcover_slug: hardcoverSlug,
      last_sync_at: sqliteNow()
    };
    if (bookOwnsSharedHardcover) {
      sourceFields.source_edition_id = null;
      sourceFields.source_edition_format = null;
      sourceFields.hardcover_audio_seconds = null;
    } else if (trustCurrentEditionForAudio) {
      // Hardcover's current edition data actually matches this row's
      // media type this run — safe to persist.
      sourceFields.source_edition_id = hcBook.edition_id ?? null;
      sourceFields.source_edition_format = editionFormat;
      // A partial edition-detail response must not erase a duration that was
      // already verified during an earlier complete fetch.
      if (userEdition) sourceFields.hardcover_audio_seconds = hcAudioSeconds;
    }
    // else: Hardcover's current edition has drifted away from this row's
    // (ABS-forced) media type — leave the previously persisted
    // edition id/format/audio_seconds alone rather than overwrite them
    // with mismatched data.
    const sourceId = upsertBookSource(db, "hardcover", profileId, hcBook.book.id, sourceFields);

    if (coverUrl) {
      enqueueImageCacheTask(`cover:${sourceId}`, async () => {
        await cacheSourceCover(db, sourceId, "hardcover", coverUrl);
      });
    }
  }

  // Prune states first: source pruning preserves rows with a live state.
  pruneHardcoverUserStatesMissingFromFetch(db, profileId, new Set(hcBooks.map((b: any) => b.book.id)), hardcoverSnapshotStatus);
  pruneHardcoverSourcesMissingFromFetch(db, profileId, new Set(hcBooks.map((b: any) => b.book.id)), hardcoverSnapshotStatus);
  logger.info("Hardcover book_sources written", { profileId, count: hcBooks.length });
}

}
