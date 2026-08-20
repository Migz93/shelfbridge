import { logger } from "../logger.js";
import type { getDb } from "../db/index.js";
import type { HardcoverEdition, HardcoverList, HardcoverUserBook } from "./hardcover.js";
import type { upsertBookSource } from "./repository.js";
import type { cacheSourceCover } from "./covers.js";
import type { enqueueImageCacheTask } from "../image-cache.js";
import type {
  firstHardcoverSeries,
  inferHardcoverMediaType,
  normalizeEditionFormat,
  sqliteNow
} from "./sync-utils.js";
import { formatBucket } from "./sync-utils.js";
import { bookOwnsSharedHardcoverRecord, absOwnsSharedHardcoverRecord, sharedHardcoverRecordFor, type SharedHardcoverOwnership } from "./hardcover-ownership.js";
import type { pruneHardcoverSourcesMissingFromFetch, pruneHardcoverUserStatesMissingFromFetch, SourceSnapshotStatus } from "./pruning.js";
import { getBookSource } from "./repository.js";

type Db = ReturnType<typeof getDb>;

export interface HardcoverSourcesContext {
  db: Db;
  profileId: number;
  hcBooks: HardcoverUserBook[];
  hcEditions: Map<number, HardcoverEdition>;
  hcLists: HardcoverList[];
  ownedImportEnabled: boolean;
  upsertBookSource: typeof upsertBookSource;
  cacheSourceCover: typeof cacheSourceCover;
  sqliteNow: typeof sqliteNow;
  hasHardcover: boolean;
  grimmoryAvailable: boolean;
  sharedHardcoverOwnership: SharedHardcoverOwnership;
  inferHardcoverMediaType: typeof inferHardcoverMediaType;
  firstHardcoverSeries: typeof firstHardcoverSeries;
  normalizeEditionFormat: typeof normalizeEditionFormat;
  enqueueImageCacheTask: typeof enqueueImageCacheTask;
  pruneHardcoverUserStatesMissingFromFetch: typeof pruneHardcoverUserStatesMissingFromFetch;
  pruneHardcoverSourcesMissingFromFetch: typeof pruneHardcoverSourcesMissingFromFetch;
  hardcoverSnapshotStatus: SourceSnapshotStatus;
}

export interface PersistHardcoverSourcesResult {
  /** book_sources ids deleted because their 'owned' or 'shared' secondary row was no longer justified this run — feed into cleanupAfterSourceRemoval, same as legacy-cleanup's deletions. */
  deletedSecondarySourceIds: number[];
  affectedBookIds: number[];
}

export async function persistHardcoverSources(context: HardcoverSourcesContext): Promise<PersistHardcoverSourcesResult> {
  const { db, profileId, hcBooks, hcEditions, hcLists, ownedImportEnabled, upsertBookSource, cacheSourceCover, sqliteNow,
    hasHardcover, grimmoryAvailable, sharedHardcoverOwnership,
    inferHardcoverMediaType, firstHardcoverSeries, normalizeEditionFormat, enqueueImageCacheTask,
    pruneHardcoverUserStatesMissingFromFetch, pruneHardcoverSourcesMissingFromFetch, hardcoverSnapshotStatus } = context;
  const deletedSecondarySourceIds: number[] = [];
  const affectedBookIds = new Set<number>();
  const ownedList = hcLists.find((list) => list.slug === "owned");
  const deleteBookSource = db.prepare("DELETE FROM book_sources WHERE id = ?");
// ── Phase C: Write HC book_sources ─────────────────────────────────────
if (hasHardcover) {
  for (const hcBook of hcBooks) {
    const userEdition = hcBook.edition_id ? hcEditions.get(hcBook.edition_id) : null;
    // A book owns a shared work regardless of whether its audiobook sibling is
    // active. Do not apply this to an ordinary book with no audio sibling.
    const bookOwnsSharedHardcover = bookOwnsSharedHardcoverRecord(sharedHardcoverOwnership, hcBook.book.id);
    const absOwnsThisHardcoverBook = absOwnsSharedHardcoverRecord(sharedHardcoverOwnership, hcBook.book.id);
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

    // Secondary-format signal: existence of a format the profile owns is
    // independent of which format currently wins Hardcover's write-back slot
    // (see hardcover-ownership.ts / docs/sync.md's "Existence vs. write
    // arbitration" section) — so this always runs, never gated on
    // bookOwnsSharedHardcover/absOwnsThisHardcoverBook.
    //
    // Two possible sources, in priority order:
    //  1. A real Grimmory sibling of the opposite format already exists
    //     (bucket 'shared') — its own data is more complete/accurate than a
    //     guessed Owned-list edition, so prefer it whenever present.
    //  2. Otherwise, a Hardcover Owned-list entry whose format disagrees with
    //     the primary edition (bucket 'owned', unchanged from before).
    const primaryBucket = formatBucket(mediaType);
    // An unresolved primary format (mediaType null — the "Needs Fix"/hidden
    // case) has no known bucket to compare against, so "disagreement" is
    // meaningless here: skip secondary-row reconciliation entirely this run
    // rather than silently treating the unknown primary as "book" (which the
    // ternaries below would otherwise do), which could wrongly create a
    // secondary row or wrongly delete an existing valid one. Any existing
    // secondary row is left untouched until the primary format resolves.
    if (primaryBucket === null) continue;
    const sharedRecord = sharedHardcoverRecordFor(sharedHardcoverOwnership, hcBook.book.id);
    const secondarySibling = primaryBucket === "audiobook" ? sharedRecord?.anyBook ?? null : sharedRecord?.anyAudiobook ?? null;

    if (secondarySibling) {
      const secondaryMediaType: "physical" | "ebook" | "audiobook" = primaryBucket === "audiobook"
        ? (secondarySibling.mediaType === "ebook" ? "ebook" : "physical")
        : "audiobook";
      const sharedSourceFields: Record<string, unknown> = {
        title,
        author,
        cover_url: null,
        // Deliberately not copying the sibling's own ISBN: it isn't needed to
        // reconcile onto the sibling's canonical (the bucket-prefixed
        // source_hardcover_book_id key below already does that), and an
        // audiobook edition can genuinely report the same ISBN as its print
        // counterpart — since ISBN identity keys are NOT bucket-prefixed
        // (see bookIdentity.ts's isbnIdentityKeys), copying it here would
        // union this row right back into the primary/print canonical,
        // undoing the split this mechanism exists to create.
        isbn13: null,
        isbn10: null,
        series_name: series.name,
        series_number: series.number,
        source_hardcover_book_id: hcBook.book.id,
        source_hardcover_slug: hardcoverSlug,
        source_media_type: secondaryMediaType,
        source_asin: null,
        source_audible_asin: null,
        source_edition_id: null,
        source_edition_format: null,
        hardcover_slug: hardcoverSlug,
        hardcover_audio_seconds: null,
        last_sync_at: sqliteNow()
      };
      upsertBookSource(db, "hardcover", profileId, hcBook.book.id, sharedSourceFields, "shared");
      // A real sibling now covers this format — remove a stale Owned-list row
      // rather than leave two secondary rows racing each other.
      const staleOwned = getBookSource(db, "hardcover", profileId, hcBook.book.id, "owned");
      if (staleOwned) {
        deleteBookSource.run(staleOwned.id);
        deletedSecondarySourceIds.push(staleOwned.id);
        if (staleOwned.book_id !== null) affectedBookIds.add(staleOwned.book_id);
      }
    } else {
      // Only remove a previously-justified 'shared' row when this run's
      // Grimmory data is actually trustworthy. When Grimmory is unavailable,
      // grimmoryBooks (and so sharedHardcoverOwnership) is empty for the
      // whole run — every secondarySibling above would resolve to null
      // regardless of whether the real sibling still exists, so deleting the
      // row here unconditionally would strip a still-valid 'shared' row (and
      // its canonical's local presence) on every transient Grimmory outage.
      // Left alone, it's correctly re-evaluated the next time Grimmory data
      // is actually available. The Owned-list handling below is independent
      // of Grimmory entirely and always runs regardless.
      if (grimmoryAvailable) {
        const existingShared = getBookSource(db, "hardcover", profileId, hcBook.book.id, "shared");
        if (existingShared) {
          deleteBookSource.run(existingShared.id);
          deletedSecondarySourceIds.push(existingShared.id);
          if (existingShared.book_id !== null) affectedBookIds.add(existingShared.book_id);
        }
      }

      const ownedEntry = ownedList?.entries.find((entry) => entry.book.id === hcBook.book.id);
      const ownedMediaType = ownedImportEnabled && ownedEntry
        ? inferHardcoverMediaType(hcBook, ownedEntry.edition, ownedEntry.editionId)
        : null;
      const ownedBucket = formatBucket(ownedMediaType);
      const justified = ownedImportEnabled && ownedBucket !== null && ownedBucket !== primaryBucket;

      if (justified && ownedEntry) {
        const ownedEdition = ownedEntry.edition;
        const ownedCoverUrl = ownedEdition?.image?.url ?? hcBook.book.image?.url ?? null;
        const ownedAsin = ownedEdition?.asin?.trim() || null;
        const ownedSourceFields: Record<string, unknown> = {
          title,
          author,
          cover_url: ownedCoverUrl,
          // Deliberately not copying the Owned-list edition's own ISBN — see
          // the identical comment on the 'shared' bucket row above: it isn't
          // needed for this row to reconcile onto its own canonical (the
          // bucket-prefixed source_hardcover_book_id key does that), and an
          // Owned-list edition can report the same ISBN as the primary
          // edition, which would incorrectly re-merge the two canonicals via
          // ISBN identity keys (not bucket-prefixed).
          isbn13: null,
          isbn10: null,
          series_name: series.name,
          series_number: series.number,
          source_hardcover_book_id: hcBook.book.id,
          source_hardcover_slug: hardcoverSlug,
          source_media_type: ownedMediaType,
          source_asin: ownedBucket === "book" ? ownedAsin : null,
          source_audible_asin: ownedBucket === "audiobook" ? ownedAsin : null,
          source_edition_id: ownedEntry.editionId,
          source_edition_format: normalizeEditionFormat(ownedEdition?.edition_format),
          hardcover_slug: hardcoverSlug,
          hardcover_audio_seconds: ownedEdition?.audio_seconds ?? null,
          last_sync_at: sqliteNow()
        };
        const ownedSourceId = upsertBookSource(db, "hardcover", profileId, hcBook.book.id, ownedSourceFields, "owned");
        if (ownedCoverUrl) {
          enqueueImageCacheTask(`cover:${ownedSourceId}`, async () => {
            await cacheSourceCover(db, ownedSourceId, "hardcover", ownedCoverUrl);
          });
        }
      } else {
        // Not (or no longer) justified — the setting was turned off, the Owned
        // entry/edition disappeared, or its format now matches the primary
        // edition. Remove any previously-written 'owned' row rather than
        // leaving it stranded on stale data forever (nothing else ever prunes
        // it: it shares its external_id with the primary row, which is always
        // still present in the fetch).
        const existingOwned = getBookSource(db, "hardcover", profileId, hcBook.book.id, "owned");
        if (existingOwned) {
          deleteBookSource.run(existingOwned.id);
          deletedSecondarySourceIds.push(existingOwned.id);
          if (existingOwned.book_id !== null) affectedBookIds.add(existingOwned.book_id);
        }
      }
    }
  }

  // Prune states first: source pruning preserves rows with a live state.
  pruneHardcoverUserStatesMissingFromFetch(db, profileId, new Set(hcBooks.map((b) => b.book.id)), hardcoverSnapshotStatus);
  pruneHardcoverSourcesMissingFromFetch(db, profileId, new Set(hcBooks.map((b) => b.book.id)), hardcoverSnapshotStatus);
  logger.info("Hardcover book_sources written", { profileId, count: hcBooks.length });
  if (deletedSecondarySourceIds.length > 0) {
    logger.info("Removed no-longer-justified Hardcover secondary (owned/shared) rows", { profileId, count: deletedSecondarySourceIds.length });
  }
}

return { deletedSecondarySourceIds, affectedBookIds: Array.from(affectedBookIds) };
}
