import { getDb, getSetting } from "../db/index.js";
import { reconcileBookIdentities } from "../db/bookIdentity.js";
import { logger } from "../logger.js";
import { buildGrimmoryIndex } from "./matcher.js";
import { enqueueImageCacheTask } from "../image-cache.js";
import type { SyncStatus } from "../../shared/types.js";
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
import { applySourceTags } from "./source-tags.js";
import { recordSyncEvent } from "./events.js";

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
// Serialise all profile syncs because identity reconciliation mutates shared state.
let syncQueue = Promise.resolve();
const activeSyncRuns = new Map<number, { profileId: number; startedAt: string }>();

export function getActiveSyncStatus(): SyncStatus {
  const rows = Array.from(activeSyncRuns.entries()).map(([runId, run]) => ({
    runId,
    ...run
  })).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId - b.runId);

  return {
    isRunning: rows.length > 0,
    runIds: rows.map((row) => row.runId),
    profileIds: Array.from(new Set(rows.map((row) => row.profileId))),
    startedAt: rows[0]?.startedAt ?? null
  };
}

export function runSync(profileId: number, runId: number, dryRun: boolean): Promise<void> {
  activeSyncRuns.set(runId, { profileId, startedAt: new Date().toISOString() });
  const result = syncQueue
    .then(() => runSyncImpl(profileId, runId, dryRun))
    .finally(() => {
      activeSyncRuns.delete(runId);
    });
  syncQueue = result.catch(() => {});
  return result;
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

    await syncAudiobookshelfProgress({
      db, profileId, runId, hasAbs, hasHardcover, grimmoryAvailable, adapters,
      absBaseUrl, absApiKey, profile, baseUrl, grimmoryToken, hardcoverToken,
      dryRun, counters, grimmoryBooks, grimmoryProgressById, hcBooks, recordEvent, getUserState, localGrimmoryBookForBookId,
      sameNumber, meaningfulProgress, effectiveAbsCurrentTimeSeconds,
      audiobookRuntimeForBook, hardcoverProgressPercent, progressPagesFromPercent,
      persistResolvedHardcoverAudioEdition, latestHardcoverRead, clampPercent,
      sharedHardcoverOwnership, hardcoverPages, todayDate
    });

    // ── Phase L: Reconcile Chaptarr writes ────────────────────────────────────
    // Chaptarr is the only phase after Phase D that writes book_sources rows
    // (Phase M's Audiobookshelf sync reconciles its own scope internally) — its
    // own matching resolves a book_id directly, but reconcileBookIdentities'
    // union-find still needs to run over exactly those rows to apply its
    // stronger conflict/file-path-bridge checks.
    if (chaptarrTouchedSourceIds.length > 0) {
      reconcileBookIdentities(db, { sourceIds: chaptarrTouchedSourceIds });
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
