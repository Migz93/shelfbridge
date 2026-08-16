import type { getDb } from "../db/index.js";
import { logger } from "../logger.js";

type Db = ReturnType<typeof getDb>;
export type SourceSnapshotStatus = "complete" | "partial" | "failed";

/**
 * Removes records absent from a complete source snapshot. An empty, complete
 * snapshot is authoritative; partial and failed snapshots never permit pruning.
 */
export function pruneHardcoverUserStatesMissingFromFetch(db: Db, profileId: number, fetchedIds: Set<number>, snapshotStatus: SourceSnapshotStatus): void {
  pruneUserStates(db, profileId, "hardcover", fetchedIds, snapshotStatus, (alias) => `CAST(${alias}.external_id AS INTEGER)`, "HC");
}

export function pruneGrimmoryUserStatesMissingFromFetch(db: Db, profileId: number, fetchedIds: Set<number>, snapshotStatus: SourceSnapshotStatus): void {
  pruneUserStates(db, profileId, "grimmory", fetchedIds, snapshotStatus, (alias) => `CAST(${alias}.external_id AS INTEGER)`, "Grimmory");
}

export function pruneGoodreadsUserStatesMissingFromFetch(db: Db, profileId: number, fetchedIds: Set<string>, snapshotStatus: SourceSnapshotStatus): void {
  pruneUserStates(db, profileId, "goodreads", fetchedIds, snapshotStatus, (alias) => `${alias}.external_id`, "Goodreads");
}

function pruneUserStates(db: Db, profileId: number, sourceType: string, fetchedIds: Set<string | number>, snapshotStatus: SourceSnapshotStatus, qualifyId: (alias: "stale_source" | "live_source") => string, sourceName: string): void {
  if (!canPruneSnapshot(profileId, sourceName, fetchedIds.size, snapshotStatus)) return;
  stageFetchedIds(db, fetchedIds);
  const staleSourceIdSql = qualifyId("stale_source");
  const liveSourceIdSql = qualifyId("live_source");
  const result = db.prepare(`
    DELETE FROM user_book_states
    WHERE profile_id = ? AND source_type = ? AND book_id IN (
      SELECT book_id FROM book_sources AS stale_source
      WHERE stale_source.source_type = ? AND stale_source.source_instance_id = ?
        AND CAST(${staleSourceIdSql} AS TEXT) NOT IN (SELECT id FROM shelfbridge_fetched_ids)
        AND NOT EXISTS (
          SELECT 1 FROM book_sources AS live_source
          WHERE live_source.book_id = stale_source.book_id
            AND live_source.source_type = ? AND live_source.source_instance_id = ?
            AND CAST(${liveSourceIdSql} AS TEXT) IN (SELECT id FROM shelfbridge_fetched_ids)
        )
    )
  `).run(profileId, sourceType, sourceType, profileId, sourceType, profileId);
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
  stageFetchedIds(db, fetchedIds);
  // Scope both the source and its state guard to this profile's integration.
  const result = db.prepare(`
    DELETE FROM book_sources
    WHERE source_type = ? AND source_instance_id = ?
      AND CAST(external_id AS TEXT) NOT IN (SELECT id FROM shelfbridge_fetched_ids)
      AND NOT EXISTS (
        SELECT 1 FROM user_book_states
        WHERE book_id = book_sources.book_id AND source_type = ? AND profile_id = ?
      )
  `).run(sourceType, profileId, sourceType, profileId);
  if (result.changes > 0) logger.info(`Pruned ${sourceName} book_sources with no remaining user states`, { profileId, deleted: result.changes });
}

/** Stages ids into a temp table so a large id set can be joined against instead of built into an inline SQL list. */
export function stageFetchedIds(db: Db, ids: Set<string | number>): void {
  db.exec("CREATE TEMP TABLE IF NOT EXISTS shelfbridge_fetched_ids (id TEXT PRIMARY KEY)");
  db.prepare("DELETE FROM shelfbridge_fetched_ids").run();
  const insert = db.prepare("INSERT INTO shelfbridge_fetched_ids (id) VALUES (?)");
  const transaction = db.transaction(() => { for (const id of ids) insert.run(String(id)); });
  transaction();
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
