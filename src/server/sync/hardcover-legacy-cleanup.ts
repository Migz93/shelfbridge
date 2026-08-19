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
 * Safe to delete unconditionally once a live counterpart exists: user_book_states
 * is keyed by (book_id, profile_id, source_type) with profile_id NOT NULL, so it
 * can never reference an instance-less book_sources row directly — only the live
 * row's own state is ever at risk, and that's left untouched here.
 */
export function cleanupLegacyHardcoverSources(db: Db): { deleted: number; affectedBookIds: number[] } {
  const legacyRows = db.prepare(`
    SELECT id, book_id, external_id FROM book_sources
    WHERE source_type = 'hardcover' AND source_instance_id IS NULL
  `).all() as { id: number; book_id: number | null; external_id: string }[];

  if (legacyRows.length === 0) return { deleted: 0, affectedBookIds: [] };

  const hasLiveCounterpart = db.prepare(`
    SELECT 1 FROM book_sources
    WHERE source_type = 'hardcover' AND source_instance_id IS NOT NULL AND external_id = ?
    LIMIT 1
  `);
  const deleteRow = db.prepare("DELETE FROM book_sources WHERE id = ?");

  const affectedBookIds = new Set<number>();
  const deletedSourceIds: number[] = [];
  let deleted = 0;

  db.transaction(() => {
    for (const row of legacyRows) {
      if (!hasLiveCounterpart.get(row.external_id)) continue;
      deleteRow.run(row.id);
      deleted++;
      deletedSourceIds.push(row.id);
      if (row.book_id !== null) affectedBookIds.add(row.book_id);
    }
  })();

  if (deleted > 0) {
    logger.info("Cleaned up legacy instance-less Hardcover sources", { deleted, affectedBookCount: affectedBookIds.size });
    try {
      cleanupImageCacheForSourceIds(db, deletedSourceIds);
    } catch (err) {
      logger.warn("Orphaned image-cache cleanup failed after legacy Hardcover source removal; continuing", { deletedSourceIds, error: err });
    }
  }

  return { deleted, affectedBookIds: Array.from(affectedBookIds) };
}
