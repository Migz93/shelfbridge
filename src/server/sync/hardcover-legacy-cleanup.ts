import type { getDb } from "../db/index.js";
import { cleanupImageCacheForSourceIds } from "../db/imageCacheMaintenance.js";
import { logger } from "../logger.js";

type Db = ReturnType<typeof getDb>;

/**
 * Deletes legacy Hardcover book_sources rows with no source_instance_id — a
 * pre-per-profile-scoping artifact. Every current Hardcover row is written
 * with a real profileId (see hardcover-sources.ts's upsertBookSource call),
 * so an instance-less row is never touched by any sync path again once a
 * live, profile-scoped row exists for the same Hardcover book. Left in
 * place, a stale legacy row can silently drift out of sync with the live
 * one and split off into its own orphan book once identities diverge
 * enough — e.g. the live row picks up a newly-resolved edition and merges
 * into its canonical book, leaving the untouched legacy row behind to be
 * reconciled into a stray single-source book of its own on the next pass.
 *
 * Safe to delete once a live counterpart exists: going forward, user_book_states
 * is keyed by (book_id, profile_id, source_type) with profile_id NOT NULL, so a
 * fresh instance-less row can never pick up its own state — only the live row's
 * state is ever at risk under current invariants. But a database that predates
 * this cleanup can already have a profile's state stranded on the legacy row's
 * own orphan book_id from before those invariants held, so each deletion below
 * first migrates any such state onto the matching live row's book — otherwise
 * it's left on a now-sourceless book that neither this sync's own reconcile nor
 * the daily full reconcile will ever remove (both explicitly preserve books that
 * still have user state, so it would strand there permanently).
 */
export function cleanupLegacyHardcoverSources(db: Db): { deleted: number; affectedBookIds: number[] } {
  const legacyRows = db.prepare(`
    SELECT id, book_id, external_id FROM book_sources
    WHERE source_type = 'hardcover' AND source_instance_id IS NULL
  `).all() as { id: number; book_id: number | null; external_id: string }[];

  if (legacyRows.length === 0) return { deleted: 0, affectedBookIds: [] };

  const liveCounterparts = db.prepare(`
    SELECT source_instance_id AS profile_id, book_id FROM book_sources
    WHERE source_type = 'hardcover' AND source_instance_id IS NOT NULL AND external_id = ?
  `);
  // Moves a profile's stranded Hardcover state onto the live row's book, unless
  // that profile already has its own (correct, current) state there — in which
  // case the stranded row is just a stale duplicate of it, dropped below instead.
  const migrateUserState = db.prepare(`
    UPDATE user_book_states
    SET book_id = ?
    WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'
      AND NOT EXISTS (
        SELECT 1 FROM user_book_states existing
        WHERE existing.book_id = ? AND existing.profile_id = ? AND existing.source_type = 'hardcover'
      )
  `);
  const dropStrandedUserState = db.prepare(`
    DELETE FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'
  `);
  const deleteRow = db.prepare("DELETE FROM book_sources WHERE id = ?");

  const affectedBookIds = new Set<number>();
  const deletedSourceIds: number[] = [];
  let deleted = 0;
  let migratedStates = 0;

  db.transaction(() => {
    for (const row of legacyRows) {
      const liveRows = liveCounterparts.all(row.external_id) as { profile_id: number; book_id: number | null }[];
      if (liveRows.length === 0) continue;

      if (row.book_id !== null) {
        for (const live of liveRows) {
          if (live.book_id === null || live.book_id === row.book_id) continue;
          const result = migrateUserState.run(live.book_id, row.book_id, live.profile_id, live.book_id, live.profile_id);
          if (result.changes > 0) migratedStates += result.changes;
          else dropStrandedUserState.run(row.book_id, live.profile_id);
        }
      }

      deleteRow.run(row.id);
      deleted++;
      deletedSourceIds.push(row.id);
      if (row.book_id !== null) affectedBookIds.add(row.book_id);
    }
  })();

  if (deleted > 0) {
    logger.info("Cleaned up legacy instance-less Hardcover sources", { deleted, migratedStates, affectedBookCount: affectedBookIds.size });
    try {
      cleanupImageCacheForSourceIds(db, deletedSourceIds);
    } catch (err) {
      logger.warn("Orphaned image-cache cleanup failed after legacy Hardcover source removal; continuing", { deletedSourceIds, error: err });
    }
  }

  return { deleted, affectedBookIds: Array.from(affectedBookIds) };
}
