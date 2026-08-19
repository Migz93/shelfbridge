import { getDb, getSetting } from "../db/index.js";
import { reconcileBookIdentities } from "../db/bookIdentity.js";
import { logger } from "../logger.js";
import { buildGrimmoryIndex } from "./matcher.js";
import { enqueueImageCacheTask } from "../image-cache.js";
import { defaultAdapters, type SyncAdapters } from "./adapters.js";
import { computeSyncDecision, type ConflictStrategy } from "./conflict-policy.js";
import {
  pruneGoodreadsUserStatesMissingFromFetch,
  pruneGrimmorySourcesMissingFromFetch,
  pruneGrimmoryUserStatesMissingFromFetch,
  pruneHardcoverSourcesMissingFromFetch,
  pruneHardcoverUserStatesMissingFromFetch,
  pruneOrphanedHardcoverUserStates
} from "./pruning.js";
import { cacheGrimmoryCover, cacheSourceCover, refreshStaleGrimmoryCovers } from "./covers.js";
import { syncGoodreadsShelvesToGrimmory, syncListsToShelves } from "./shelves.js";
import { normalizeTitle, normalizeSeriesNumber } from "./normalization.js";
import {
  getUserState,
  localGrimmoryBookForBookId,
  upsertBookSource
} from "./repository.js";
import { syncAudiobookshelfLibrary } from "./audiobookshelf-phase.js";
import { syncAudiobookshelfProgress } from "./audiobookshelf-progress.js";
import { syncHardcoverState } from "./hardcover-phase.js";
import { syncGrimmoryState } from "./grimmory-state.js";
import { syncGoodreadsEnrichment } from "./goodreads-phase.js";
import { fetchSourceSnapshots } from "./source-snapshots.js";
import { persistGrimmorySources } from "./grimmory-sources.js";
import { persistHardcoverSources } from "./hardcover-sources.js";
import { cleanupLegacyHardcoverSources } from "./hardcover-legacy-cleanup.js";
import { applySourceTags } from "./source-tags.js";
import { recordSyncEvent } from "./events.js";
import { getActiveSyncStatus, trackActiveSyncRun, untrackActiveSyncRun, runExclusiveOfSyncs } from "./sync-queue.js";

import * as syncUtils from "./sync-utils.js";

// Compatibility exports while callers migrate to the focused modules.
export { defaultAdapters, computeSyncDecision };
export { normalizeTitle, normalizeSeriesNumber };
export const newerSource = syncUtils.newerSource;
export const shouldGoodreadsOverwriteGrimmory = syncUtils.shouldGoodreadsOverwriteGrimmory;
export { refreshStaleGrimmoryCovers };
export type { SyncAdapters, ConflictStrategy };
export {
  pruneGoodreadsUserStatesMissingFromFetch,
  pruneGrimmorySourcesMissingFromFetch,
  pruneGrimmoryUserStatesMissingFromFetch,
  pruneHardcoverSourcesMissingFromFetch,
  pruneHardcoverUserStatesMissingFromFetch
};

interface SyncCounters {
  written: number;
  skipped: number;
  superseded: number;
  sourceFailures: number;
}

const { sameNumber, positiveRating, grimmoryToHardcoverRating, hardcoverToGrimmoryRating, hasMeaningfulHcChange, hasMeaningfulGrChange, hasMeaningfulGoodreadsChange, hardcoverDate, hardcoverPages, firstHardcoverSeries, latestHardcoverRead, cleanupDuplicateBlankHardcoverReads, meaningfulProgress, audiobookRuntimeForBook, hardcoverProgressPercent, effectiveAbsCurrentTimeSeconds, persistResolvedHardcoverAudioEdition, progressPagesFromPercent, todayDate, sqliteNow, sourceTagName, hardcoverFieldsFromGrimmory, normalizeEditionFormat, inferHardcoverMediaType, hasGrimmoryUserActivity, clampPercent } = syncUtils;

export { getActiveSyncStatus, runExclusiveOfSyncs };

export function runSync(profileId: number, runId: number, dryRun: boolean): Promise<void> {
  trackActiveSyncRun(runId, profileId);
  return runExclusiveOfSyncs(() => runSyncImpl(profileId, runId, dryRun).finally(() => {
    untrackActiveSyncRun(runId);
  }));
}

export async function runSyncImpl(
  profileId: number,
  runId: number,
  dryRun: boolean,
  adapters: SyncAdapters = defaultAdapters
): Promise<void> {
  const db = getDb();

  try {
    logger.info("Sync started", { profileId, runId, dryRun });

    const profile = db.prepare(`
      SELECT p.*, g.username, g.password, g.base_url as grimmory_base_url,
             h.api_token as hardcover_token,
             h.sync_list_id as hardcover_sync_list_id,
             h.sync_list_name as hardcover_sync_list_name,
             h.target_shelf_name as hardcover_target_shelf_name,
             gr.goodreads_user_id, gr.enabled as goodreads_enabled,
             gr.sync_shelf_name as goodreads_sync_shelf_name,
             gr.target_shelf_name as goodreads_target_shelf_name,
             ss.sync_status_enabled, ss.sync_progress_enabled,
             ss.sync_shelves_enabled, ss.sync_goodreads_enabled,
             ss.sync_goodreads_status_enabled, ss.sync_goodreads_shelves_enabled,
             ss.sync_write_tag_enabled,
             ss.conflict_strategy,
             abs_conn.api_key as abs_api_key
      FROM profiles p
      LEFT JOIN grimmory_connections g ON g.profile_id = p.id
      LEFT JOIN hardcover_connections h ON h.profile_id = p.id
      LEFT JOIN goodreads_connections gr ON gr.profile_id = p.id
      LEFT JOIN sync_settings ss ON ss.profile_id = p.id
      LEFT JOIN audiobookshelf_connections abs_conn ON abs_conn.profile_id = p.id
      WHERE p.id = ?
    `).get(profileId) as Record<string, unknown> | undefined;

    if (!profile) throw new Error(`Profile ${profileId} not found`);

    const baseUrl = (profile["grimmory_base_url"] as string | null) || getSetting("grimmory.baseUrl", "");
    const username = profile["username"] as string | null;
    const password = (profile["password"] as string | null) ?? "";
    const hardcoverToken = (profile["hardcover_token"] as string | null) ?? "";
    const conflictStrategy = (profile["conflict_strategy"] as ConflictStrategy | null)
      ?? (getSetting("sync.conflictStrategy", "latest_wins") as ConflictStrategy);
    const writeTagEnabled = !!(profile["sync_write_tag_enabled"] as number | null);
    const writeTagName = sourceTagName(username, profile["display_name"] as string | null);

    const hasGrimmory = !!(baseUrl && username && password);
    const hasHardcover = !!hardcoverToken;

    const absBaseUrl = getSetting("audiobookshelf.baseUrl", "");
    const absApiKey = (profile["abs_api_key"] as string | null) ?? "";
    const hasAbs = !!(absBaseUrl && absApiKey);

    const counters: SyncCounters = { written: 0, skipped: 0, superseded: 0, sourceFailures: 0 };
    const recordEvent = recordSyncEvent;
    const { hcBooks, hcEditions, hcLists, hardcoverSnapshotStatus, grimmoryBooks, grimmoryAvailable, grimmorySnapshotStatus, grimmoryToken, absOwnedBookIds, sharedHardcoverOwnership, grimmoryProgressById } = await fetchSourceSnapshots({
      db, profileId, runId, profile, adapters, counters, recordEvent,
      hasHardcover, hardcoverToken, baseUrl, username, password, hasGrimmory
    });
    // Tracks every book_sources row upserted by the two persist calls below, so
    // Phase D's reconcile can be scoped to just what this profile's sync touched
    // instead of the whole catalog. upsertBookSource is injected as plain context
    // data by both persist* functions (see grimmory-sources.ts/hardcover-sources.ts),
    // so wrapping it here needs no changes to either.
    const phaseDTouchedSourceIds: number[] = [];
    const trackingUpsertBookSource: typeof upsertBookSource = (db, sourceType, instanceId, externalId, fields) => {
      const id = upsertBookSource(db, sourceType, instanceId, externalId, fields);
      phaseDTouchedSourceIds.push(id);
      return id;
    };

    await persistGrimmorySources({ db, profileId, grimmoryAvailable, grimmoryBooks, upsertBookSource: trackingUpsertBookSource, enqueueImageCacheTask, cacheSourceCover, sqliteNow, grimmoryToken, cacheGrimmoryCover, baseUrl });

    await persistHardcoverSources({ db, profileId, hcBooks, hcEditions, upsertBookSource: trackingUpsertBookSource, cacheSourceCover, sqliteNow,
      hasHardcover, sharedHardcoverOwnership,
      inferHardcoverMediaType, firstHardcoverSeries, normalizeEditionFormat, enqueueImageCacheTask,
      pruneHardcoverUserStatesMissingFromFetch, pruneHardcoverSourcesMissingFromFetch, hardcoverSnapshotStatus });

    // ── Phase D: Reconcile identities ────────────────────────────────────────
    // Cleaned up before reconciling, not just in the once-daily full-reconcile
    // job: a legacy instance-less row left in place can still be sitting on a
    // book's id when this sync's freshly-resolved live row needs to merge into
    // its canonical book, and reconciliation will (correctly, conservatively)
    // refuse to touch a book id it doesn't know is safe to reclaim — stranding
    // the real merge instead of completing it. Running the cleanup right here,
    // before every sync's own reconcile, means that stale row is never present
    // to cause the conflict in the first place.
    if (hasHardcover) cleanupLegacyHardcoverSources(db);

    // Now that both Grimmory and HC sources are written, reconcile so every
    // book_sources row gets a book_id. This is what links HC sources to
    // Grimmory sources for the HC sync loop below.
    reconcileBookIdentities(db, { sourceIds: phaseDTouchedSourceIds });
    if (hasHardcover) pruneOrphanedHardcoverUserStates(db, profileId);

    // ── Phase E: Build Grimmory in-memory match index (for HC loop) ─────────
    const grimmoryIndex = buildGrimmoryIndex(grimmoryBooks);
    const matchedGrimmoryIds = new Set<number>();
    const taggedSourceGrimmoryIds = new Set<number>();
    const hardcoverSourceGrimmoryIds = new Set<number>();
    const goodreadsSourceGrimmoryIds = new Set<number>();
    const taggedSourceTitles = new Map<number, string>();

    await syncHardcoverState({
      db, profileId, runId, dryRun, adapters, counters, hcBooks, hcEditions,
      grimmoryBooks, grimmoryAvailable, hasGrimmory, baseUrl, grimmoryToken,
      hardcoverToken, profile, recordEvent, getUserState, localGrimmoryBookForBookId,
      cacheSourceCover, cacheGrimmoryCover, computeSyncDecision, cleanupDuplicateBlankHardcoverReads,
      hasMeaningfulHcChange, hasMeaningfulGrChange, sameNumber, grimmoryToHardcoverRating,
      hardcoverToGrimmoryRating, hardcoverFieldsFromGrimmory, progressPagesFromPercent,
      latestHardcoverRead, hardcoverPages,
      persistResolvedHardcoverAudioEdition, todayDate, sqliteNow
      , conflictStrategy, grimmoryIndex, matchedGrimmoryIds, writeTagEnabled,
      taggedSourceGrimmoryIds, taggedSourceTitles, hardcoverSourceGrimmoryIds,
      audiobookRuntimeForBook, hardcoverProgressPercent, absOwnedBookIds,
      positiveRating, newerSource, meaningfulProgress, hardcoverDate,
      sharedHardcoverOwnership
    });

    await syncGrimmoryState({
      db, profileId, runId, grimmoryBooks, grimmoryAvailable, counters, recordEvent,
      getUserState, hasMeaningfulGrChange, dryRun, hasGrimmoryUserActivity,
      matchedGrimmoryIds, hardcoverFieldsFromGrimmory, grimmoryToHardcoverRating,
      sharedHardcoverOwnership, hasHardcover,
      profile, adapters, hardcoverToken, pruneGrimmoryUserStatesMissingFromFetch,
      pruneGrimmorySourcesMissingFromFetch, grimmorySnapshotStatus
    });

    const grimmoryShelvesCleared = await syncGoodreadsEnrichment({ db, profileId, runId, profile, adapters, counters, dryRun, grimmoryAvailable, hasGrimmory, baseUrl, grimmoryToken, recordEvent,
      pruneGoodreadsUserStatesMissingFromFetch, getUserState, hardcoverToGrimmoryRating, writeTagEnabled, taggedSourceGrimmoryIds, taggedSourceTitles,
      goodreadsSourceGrimmoryIds, hasMeaningfulGoodreadsChange, upsertBookSource, sqliteNow, cacheSourceCover,
      shouldGoodreadsOverwriteGrimmory, sameNumber, syncGoodreadsShelvesToGrimmory });

    await applySourceTags({ db, profileId, grimmoryAvailable, grimmoryBooks, taggedSourceGrimmoryIds, taggedSourceTitles, writeTagEnabled, hasGrimmory, grimmoryToken, writeTagName, dryRun, recordEvent, counters, adapters, baseUrl, runId, profile, hardcoverSourceGrimmoryIds, goodreadsSourceGrimmoryIds });

    // ── Phase J: Hardcover list → Grimmory shelf sync ────────────────────────
    if (hasHardcover && grimmoryAvailable && hasGrimmory && grimmoryToken) {
      await syncListsToShelves(db, profileId, baseUrl, grimmoryToken, hcLists, hardcoverToken, dryRun, !grimmoryShelvesCleared, adapters);
    }

    // ── Phase K: Chaptarr status pass ───────────────────────────────────────
    const chaptarrTouchedSourceIds = await adapters.syncChaptarrStatus(profileId);

    // ── Phase M: Audiobookshelf library sync ─────────────────────────────────
    await syncAudiobookshelfLibrary({
      db, profileId, runId, hasAbs, absBaseUrl, absApiKey, adapters, counters, recordEvent
    });

    const resolvedAudioEditionSourceIds = await syncAudiobookshelfProgress({
      db, profileId, runId, hasAbs, hasHardcover, grimmoryAvailable, adapters,
      absBaseUrl, absApiKey, profile, baseUrl, grimmoryToken, hardcoverToken,
      dryRun, counters, grimmoryBooks, grimmoryProgressById, hcBooks, recordEvent, getUserState, localGrimmoryBookForBookId,
      sameNumber, meaningfulProgress, effectiveAbsCurrentTimeSeconds,
      audiobookRuntimeForBook, hardcoverProgressPercent, progressPagesFromPercent,
      persistResolvedHardcoverAudioEdition, latestHardcoverRead, clampPercent,
      sharedHardcoverOwnership, hardcoverPages, todayDate
    });

    // ── Phase L: Reconcile Chaptarr writes and resolved audio editions ───────
    // Two things after Phase D can change a book_sources row's identity-format
    // bucket without going through a scoped reconcile of their own: Chaptarr's
    // own matching resolves a book_id directly but still needs union-find's
    // stronger conflict/file-path-bridge checks, and Phase N's
    // persistResolvedHardcoverAudioEdition flips an existing Hardcover row's
    // source_media_type to 'audiobook', which can change that row's identity
    // keys and the book's canonical media_type. (Phase M's Audiobookshelf
    // library sync reconciles its own scope internally.)
    const phaseLTouchedSourceIds = [...chaptarrTouchedSourceIds, ...resolvedAudioEditionSourceIds];
    if (phaseLTouchedSourceIds.length > 0) {
      reconcileBookIdentities(db, { sourceIds: phaseLTouchedSourceIds });
    }

    const summary = dryRun
      ? `Dry run: ${counters.written} would write, ${counters.skipped} skipped${counters.sourceFailures ? `, ${counters.sourceFailures} source unavailable` : ""}, ${grimmoryBooks.length ? `matched against ${grimmoryBooks.length} Grimmory books` : "no Grimmory connection"}`
      : `${counters.written} written, ${counters.skipped} skipped${counters.sourceFailures ? `, ${counters.sourceFailures} source unavailable` : ""}`;

    db.prepare(`
      UPDATE sync_runs
      SET status = 'success', finished_at = datetime('now'), summary = ?,
          changes_written = ?, changes_skipped = ?, changes_superseded = ?
      WHERE id = ?
    `).run(summary, counters.written, counters.skipped, counters.superseded, runId);

    logger.info("Sync completed", { profileId, runId, dryRun, ...counters, hcBooks: hcBooks.length, grBooks: grimmoryBooks.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Sync failed", { profileId, runId, error: message });
    recordSyncEvent(db, runId, profileId, "Sync", "api_failure", null, "source_unavailable", { error: message });
    db.prepare(`
      UPDATE sync_runs
      SET status = 'error', finished_at = datetime('now'),
          summary = 'Sync failed', error = ?
      WHERE id = ?
    `).run(message, runId);
  }
}

// ── Shelf sync helpers ────────────────────────────────────────────────────────
