import { reconcileBookIdentities } from "../db/bookIdentity.js";
import type { getDb } from "../db/index.js";
import { logger } from "../logger.js";
import type { SyncAdapters } from "./adapters.js";
import { audiobookCandidateWhereSql, upsertBookSource } from "./repository.js";

type Db = ReturnType<typeof getDb>;

type Counters = { sourceFailures: number };
type RecordEvent = (db: Db, runId: number, profileId: number, bookTitle: string, eventType: string, direction: string | null, decision: string, details: Record<string, unknown>) => void;

export interface AudiobookshelfLibraryContext {
  db: Db;
  profileId: number;
  runId: number;
  hasAbs: boolean;
  absBaseUrl: string;
  absApiKey: string | null;
  adapters: SyncAdapters;
  counters: Counters;
  recordEvent: RecordEvent;
}

/** Imports a complete Audiobookshelf book-library snapshot and reconciles it. */
export async function syncAudiobookshelfLibrary(context: AudiobookshelfLibraryContext): Promise<void> {
  const { db, profileId, runId, hasAbs, absBaseUrl, absApiKey, adapters, counters, recordEvent } = context;
// ── Phase M: Audiobookshelf library sync ─────────────────────────────────
if (hasAbs) {
  try {
    logger.info("Fetching Audiobookshelf libraries", { profileId });
    const absLibraries = await adapters.fetchAudiobookshelfLibraries(absBaseUrl, absApiKey!);
    const bookLibraries = absLibraries.filter((lib) => lib.mediaType === "book");
    const liveAbsIds = new Set<string>();
    let absSnapshotComplete = true;
    logger.info("Audiobookshelf libraries fetched", { profileId, total: absLibraries.length, bookLibraries: bookLibraries.length });

    for (const library of bookLibraries) {
      let items: Awaited<ReturnType<SyncAdapters["fetchAudiobookshelfLibraryItems"]>>;
      try {
        items = await adapters.fetchAudiobookshelfLibraryItems(absBaseUrl, absApiKey!, library.id);
      } catch (libraryErr) {
        absSnapshotComplete = false;
        counters.sourceFailures++;
        logger.warn("Audiobookshelf library items fetch failed; continuing with remaining libraries", {
          profileId,
          libraryId: library.id,
          libraryName: library.name,
          error: libraryErr
        });
        recordEvent(db, runId, profileId, library.name, "api_failure", "audiobookshelf", "library_items_unavailable", {
          libraryId: library.id,
          error: String(libraryErr)
        });
        continue;
      }
      logger.info("Audiobookshelf library items fetched", { profileId, libraryId: library.id, libraryName: library.name, count: items.length });

      for (const item of items) {
        liveAbsIds.add(item.id);
        const meta = item.media?.metadata;
        if (!meta) continue;

        const absDuration = meta.duration ?? item.media.duration ?? null;
        const absFilePath = item.libraryFiles?.[0]?.metadata?.path ?? item.path ?? null;
        const absAsin = meta.asin ?? null;
        const absIsbn = meta.isbn ?? null;
        const absNarrator = meta.narrator ?? meta.narratorName ?? null;

        // Try to find an existing book_id to link this ABS item to
        let linkedBookId: number | null = null;

        // Check if already stored with this ABS item ID, scoped to this profile's
        // own ABS instance — another profile's ABS server could reuse the same
        // local item id for an unrelated audiobook.
        const existing = db.prepare(
          "SELECT book_id FROM book_sources WHERE source_type = 'audiobookshelf' AND source_instance_id = ? AND external_id = ?"
        ).get(profileId, item.id) as { book_id: number | null } | undefined;

        if (existing?.book_id) {
          linkedBookId = existing.book_id;
        } else {
          // Match by file path against other audiobook-capable sources first.
          // This is the strongest ABS identity signal and avoids linking an
          // audiobook item onto an ebook/physical canonical row.
          if (absFilePath) {
            const fileMatch = db.prepare(`
              SELECT book_id FROM book_sources
              WHERE ${audiobookCandidateWhereSql()} AND (
                grimmory_primary_file_path = ? OR chaptarr_primary_file_path = ?
              )
                AND (source_instance_id = ? OR (source_type = 'chaptarr' AND source_instance_id = 0))
              LIMIT 1
            `).get(absFilePath, absFilePath, profileId) as { book_id: number } | undefined;
            if (fileMatch) linkedBookId = fileMatch.book_id;
          }

          // Match by audiobook ASIN only against audiobook-capable rows.
          // ABS exposes audiobook metadata, so using the dedicated audible
          // ASIN field is much safer than the generic ebook ASIN column.
          if (!linkedBookId && absAsin) {
            const asinMatch = db.prepare(`
              SELECT book_id FROM book_sources
              WHERE ${audiobookCandidateWhereSql()}
                AND (source_audible_asin = ? OR audiobookshelf_asin = ?)
                AND (source_instance_id = ? OR (source_type = 'chaptarr' AND source_instance_id = 0))
              LIMIT 1
            `).get(absAsin, absAsin, profileId) as { book_id: number } | undefined;
            if (asinMatch) linkedBookId = asinMatch.book_id;
          }

          // ISBN is a weaker fallback because many works share identifiers
          // across print, ebook, and audio variants. Restrict it to rows that
          // already look like audiobook records.
          if (!linkedBookId && absIsbn) {
            const isbnMatch = db.prepare(`
              SELECT book_id FROM book_sources
              WHERE ${audiobookCandidateWhereSql()} AND (isbn13 = ? OR isbn10 = ?)
                AND (source_instance_id = ? OR (source_type = 'chaptarr' AND source_instance_id = 0))
              LIMIT 1
            `).get(absIsbn, absIsbn, profileId) as { book_id: number } | undefined;
            if (isbnMatch) linkedBookId = isbnMatch.book_id;
          }
        }

        // A linked item is not necessarily runtime-validated: editions of the
        // same work can have materially different audiobook durations.
        const hardcoverAudioSeconds = linkedBookId === null ? null : (db.prepare(`
          SELECT hardcover_audio_seconds FROM book_sources
          WHERE book_id = ? AND source_type = 'hardcover' AND source_instance_id = ?
            AND hardcover_audio_seconds IS NOT NULL
          LIMIT 1
        `).get(linkedBookId, profileId) as { hardcover_audio_seconds: number } | undefined)?.hardcover_audio_seconds ?? null;
        const runtimeDelta = absDuration && hardcoverAudioSeconds && hardcoverAudioSeconds > 0
          ? Math.abs(absDuration - hardcoverAudioSeconds) / hardcoverAudioSeconds
          : null;
        const runtimeValidated = runtimeDelta !== null && runtimeDelta <= 0.05 ? 1 : null;

        const absFields: Record<string, unknown> = {
          title: meta.title ?? null,
          author: meta.authorName ?? null,
          series_name: meta.seriesName ?? null,
          source_media_type: "audiobook",
          source_narrator: absNarrator,
          audiobookshelf_duration: absDuration !== null ? Math.round(absDuration) : null,
          audiobookshelf_file_path: absFilePath,
          audiobookshelf_asin: absAsin,
          audiobookshelf_runtime_validated: runtimeValidated,
          audiobookshelf_runtime_delta: runtimeDelta
        };
        if (linkedBookId !== null) {
          absFields["book_id"] = linkedBookId;
        }

        upsertBookSource(db, "audiobookshelf", profileId, item.id, absFields);
      }
    }

    if (!absSnapshotComplete) {
      logger.warn("Skipped Audiobookshelf stale-state pruning because library snapshot was incomplete", {
        profileId,
        liveItemCount: liveAbsIds.size
      });
    } else if (liveAbsIds.size > 0) {
      db.exec("CREATE TEMP TABLE IF NOT EXISTS shelfbridge_live_abs_ids (id TEXT PRIMARY KEY)");
      db.prepare("DELETE FROM shelfbridge_live_abs_ids").run();
      const insertLiveAbsId = db.prepare("INSERT INTO shelfbridge_live_abs_ids (id) VALUES (?)");
      db.transaction(() => { for (const id of liveAbsIds) insertLiveAbsId.run(id); })();
      db.prepare(`
        DELETE FROM user_book_states
        WHERE profile_id = ?
          AND source_type = 'audiobookshelf'
          AND audiobookshelf_item_id IS NOT NULL
          AND audiobookshelf_item_id NOT IN (SELECT id FROM shelfbridge_live_abs_ids)
      `).run(profileId);
    } else {
      db.prepare(`
        DELETE FROM user_book_states
        WHERE profile_id = ?
          AND source_type = 'audiobookshelf'
          AND audiobookshelf_item_id IS NOT NULL
      `).run(profileId);
    }
    reconcileBookIdentities(db);
  } catch (err) {
    logger.warn("Audiobookshelf library sync failed; skipping ABS phase", { profileId, error: String(err) });
    recordEvent(db, runId, profileId, "Audiobookshelf", "api_failure", "audiobookshelf", "source_unavailable", { error: String(err) });
  }
}

}
