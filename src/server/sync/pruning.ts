import type { getDb } from "../db/index.js";
import { logger } from "../logger.js";

type Db = ReturnType<typeof getDb>;
export type SourceSnapshotStatus = "complete" | "partial" | "failed";

/**
 * Removes records absent from a complete source snapshot. An empty, complete
 * snapshot is authoritative; partial and failed snapshots never permit pruning.
 */
export function pruneHardcoverUserStatesMissingFromFetch(db: Db, profileId: number, fetchedIds: Set<number>, snapshotStatus: SourceSnapshotStatus): void {
  pruneUserStates(db, profileId, "hardcover", fetchedIds, snapshotStatus, "CAST(external_id AS INTEGER)", "HC");
}

export function pruneGrimmoryUserStatesMissingFromFetch(db: Db, profileId: number, fetchedIds: Set<number>, snapshotStatus: SourceSnapshotStatus): void {
  pruneUserStates(db, profileId, "grimmory", fetchedIds, snapshotStatus, "CAST(external_id AS INTEGER)", "Grimmory");
}

export function pruneGoodreadsUserStatesMissingFromFetch(db: Db, profileId: number, fetchedIds: Set<string>, snapshotStatus: SourceSnapshotStatus): void {
  pruneUserStates(db, profileId, "goodreads", fetchedIds, snapshotStatus, "external_id", "Goodreads");
}

function pruneUserStates(db: Db, profileId: number, sourceType: string, fetchedIds: Set<string | number>, snapshotStatus: SourceSnapshotStatus, sourceIdSql: string, sourceName: string): void {
  if (!canPruneSnapshot(profileId, sourceName, fetchedIds.size, snapshotStatus)) return;
  const ids = Array.from(fetchedIds);
  const placeholders = ids.map(() => "?").join(",");
  const result = db.prepare(`
    DELETE FROM user_book_states
    WHERE profile_id = ? AND source_type = ? AND book_id IN (
      SELECT book_id FROM book_sources
      WHERE source_type = ? AND source_instance_id = ? AND ${sourceIdSql} NOT IN (${placeholders})
    )
  `).run(profileId, sourceType, sourceType, profileId, ...ids);
  if (result.changes > 0) logger.info(`Pruned ${sourceName} user states missing from fetched library`, { profileId, deleted: result.changes });
}

export function pruneHardcoverSourcesMissingFromFetch(db: Db, profileId: number, fetchedIds: Set<number>, snapshotStatus: SourceSnapshotStatus): void {
  pruneSources(db, profileId, "hardcover", fetchedIds, snapshotStatus, "HC");
}

export function pruneGrimmorySourcesMissingFromFetch(db: Db, profileId: number, fetchedIds: Set<number>, snapshotStatus: SourceSnapshotStatus): void {
  pruneSources(db, profileId, "grimmory", fetchedIds, snapshotStatus, "Grimmory");
}

function pruneSources(db: Db, profileId: number, sourceType: "hardcover" | "grimmory", fetchedIds: Set<number>, snapshotStatus: SourceSnapshotStatus, sourceName: string): void {
  if (!canPruneSnapshot(profileId, sourceName, fetchedIds.size, snapshotStatus)) return;
  const ids = Array.from(fetchedIds);
  const placeholders = ids.map(() => "?").join(",");
  // Scope both the source and its state guard to this profile's integration.
  const result = db.prepare(`
    DELETE FROM book_sources
    WHERE source_type = ? AND source_instance_id = ?
      AND CAST(external_id AS INTEGER) NOT IN (${placeholders})
      AND NOT EXISTS (
        SELECT 1 FROM user_book_states
        WHERE book_id = book_sources.book_id AND source_type = ? AND profile_id = ?
      )
  `).run(sourceType, profileId, ...ids, sourceType, profileId);
  if (result.changes > 0) logger.info(`Pruned ${sourceName} book_sources with no remaining user states`, { profileId, deleted: result.changes });
}

function canPruneSnapshot(profileId: number, sourceName: string, fetchedCount: number, snapshotStatus: SourceSnapshotStatus): boolean {
  if (snapshotStatus === "complete") return true;
  logger.warn(`Skipped ${sourceName} stale-record pruning because snapshot was not complete`, {
    profileId,
    snapshotStatus,
    fetchedCount
  });
  return false;
}
