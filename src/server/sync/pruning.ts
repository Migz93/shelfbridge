import type { getDb } from "../db/index.js";
import { logger } from "../logger.js";
import { reconcileBookIdentities } from "../db/bookIdentity.js";

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

/**
 * Removes this profile's Hardcover user states left orphaned by reconciliation
 * (e.g. a book merge/split changing which book_id a state's book_sources row
 * now lives under). book_id is a global canonical record shared across
 * profiles, so the EXISTS check must also be qualified by this profile's own
 * source_instance_id — otherwise another profile's still-live Hardcover
 * book_sources row for the same book would suppress this profile's pruning.
 */
export function pruneOrphanedHardcoverUserStates(db: Db, profileId: number): void {
  const result = db.prepare(`
    DELETE FROM user_book_states
    WHERE profile_id = ?
      AND source_type = 'hardcover'
      AND NOT EXISTS (
        SELECT 1 FROM book_sources
        WHERE book_sources.book_id = user_book_states.book_id
          AND book_sources.source_type = 'hardcover'
          AND book_sources.source_instance_id = user_book_states.profile_id
      )
  `).run(profileId);
  if (result.changes > 0) logger.info("Pruned orphaned Hardcover user states after reconciliation", { profileId, deleted: result.changes });
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
  const whereClause = `
    source_type = ? AND source_instance_id = ?
    AND CAST(external_id AS TEXT) NOT IN (SELECT id FROM shelfbridge_fetched_ids)
    AND NOT EXISTS (
      SELECT 1 FROM user_book_states
      WHERE book_id = book_sources.book_id AND source_type = ? AND profile_id = ?
    )
  `;
  const params = [sourceType, profileId, sourceType, profileId];
  // Captured before the delete: a book left with a surviving source or with
  // zero remaining sources both need explicit handling afterward — see
  // cleanupAfterSourceRemoval.
  const staleBookIds = (db.prepare(`SELECT DISTINCT book_id FROM book_sources WHERE ${whereClause} AND book_id IS NOT NULL`).all(...params) as { book_id: number }[])
    .map((row) => row.book_id);
  const result = db.prepare(`DELETE FROM book_sources WHERE ${whereClause}`).run(...params);
  if (result.changes > 0) logger.info(`Pruned ${sourceName} book_sources with no remaining user states`, { profileId, deleted: result.changes });
  cleanupAfterSourceRemoval(db, staleBookIds);
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

const BATCH_SIZE = 500;

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

/**
 * Deletes any of the given book ids left with zero remaining book_sources
 * rows and zero user_book_states rows. Batched rather than one IN (...)
 * clause for every id, since a large upstream removal could otherwise exceed
 * SQLite's bound-parameter limit — the same reason the caller stages its own
 * ids into a temp table.
 */
function deleteOrphanedBooks(db: Db, bookIds: number[]): void {
  const orphaned: { id: number }[] = [];
  for (const batch of chunk(bookIds, BATCH_SIZE)) {
    const placeholders = batch.map(() => "?").join(",");
    orphaned.push(...(db.prepare(`
      SELECT b.id FROM books b
      WHERE b.id IN (${placeholders})
        AND NOT EXISTS (SELECT 1 FROM book_sources bs WHERE bs.book_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM user_book_states ubs WHERE ubs.book_id = b.id)
    `).all(...batch) as { id: number }[]));
  }
  if (orphaned.length === 0) return;
  const deleteBook = db.prepare("DELETE FROM books WHERE id = ?");
  for (const row of orphaned) deleteBook.run(row.id);
  logger.info("Removed canonical books left with no sources after pruning", {
    bookIds: orphaned.map((row) => row.id)
  });
}

/**
 * Handles both possible outcomes for a book that just lost one of its
 * sources (Chaptarr, Hardcover, or Grimmory pruning a stale row): if it now
 * has zero sources and zero user state, it's a ghost canonical — delete it.
 * If it still has other sources, those survivors may now need a different
 * canonical title/cover/identifier (the deleted row could have been the
 * preferred one) and book_identity_keys may still hold keys that only came
 * from the deleted row — reconcile scoped to the survivors so
 * reconcileBookIdentities recomputes both from what's actually left. Either
 * way, this book has nothing to do with what a scoped reconcile of the
 * *newly written* rows elsewhere in the same sync would already cover.
 */
export function cleanupAfterSourceRemoval(db: Db, affectedBookIds: number[]): void {
  if (affectedBookIds.length === 0) return;
  const survivorSourceIds: number[] = [];
  for (const batch of chunk(affectedBookIds, BATCH_SIZE)) {
    const placeholders = batch.map(() => "?").join(",");
    survivorSourceIds.push(...(db.prepare(`SELECT id FROM book_sources WHERE book_id IN (${placeholders})`).all(...batch) as { id: number }[])
      .map((row) => row.id));
  }
  deleteOrphanedBooks(db, affectedBookIds);
  if (survivorSourceIds.length > 0) {
    reconcileBookIdentities(db, { sourceIds: survivorSourceIds });
  }
}
