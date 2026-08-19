import type { getDb } from "../db/index.js";
import { shouldMoveState, type UserBookStateMoveRow } from "../db/bookIdentity.js";
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
 * this cleanup can already have state stranded on the legacy row's own orphan
 * book_id from before those invariants held — potentially from more than one
 * profile, since a legacy row predates per-profile scoping entirely. Each
 * deletion below migrates any such state onto the matching live row's book, but
 * only once every profile with state on that orphan book has a live counterpart
 * to migrate onto — and only when every state on that book is Hardcover state
 * in the first place, since this function only knows how to migrate that one
 * source type. Otherwise the whole row is left alone for a later pass rather
 * than stranding whichever state has nowhere to go. Left in place, a
 * now-sourceless book with leftover state is never removed — neither this
 * sync's own reconcile nor the daily full reconcile touches a book that still
 * has user state.
 */
export function cleanupLegacyHardcoverSources(db: Db): { deleted: number; affectedBookIds: number[]; deletedSourceIds: number[] } {
  const legacyRows = db.prepare(`
    SELECT id, book_id, external_id FROM book_sources
    WHERE source_type = 'hardcover' AND source_instance_id IS NULL
  `).all() as { id: number; book_id: number | null; external_id: string }[];

  if (legacyRows.length === 0) return { deleted: 0, affectedBookIds: [], deletedSourceIds: [] };

  const liveCounterparts = db.prepare(`
    SELECT source_instance_id AS profile_id, book_id FROM book_sources
    WHERE source_type = 'hardcover' AND source_instance_id IS NOT NULL AND external_id = ?
  `);
  const stateProfilesOnBook = db.prepare(`
    SELECT DISTINCT profile_id FROM user_book_states WHERE book_id = ? AND source_type = 'hardcover'
  `);
  const nonHardcoverStateOnBook = db.prepare(`
    SELECT 1 FROM user_book_states WHERE book_id = ? AND source_type != 'hardcover' LIMIT 1
  `);
  const selectState = db.prepare(`
    SELECT * FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'
  `);
  const deleteUserState = db.prepare("DELETE FROM user_book_states WHERE id = ?");
  const updateUserStateBook = db.prepare("UPDATE user_book_states SET book_id = ? WHERE id = ?");
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
        // This function only knows how to migrate Hardcover state (onto a live
        // Hardcover counterpart's book) — a Grimmory or Goodreads state can also
        // be sitting on this orphan book_id (e.g. left behind by an unrelated
        // reconciliation split), and there is no live counterpart of that source
        // type available here to migrate it onto safely. Defer the whole row
        // rather than deleting its only source and leaving that other state
        // permanently stranded on a now-sourceless book.
        if (nonHardcoverStateOnBook.get(row.book_id)) {
          logger.warn("Deferred legacy Hardcover source cleanup: a non-Hardcover state exists on its orphan book", {
            legacySourceId: row.id, bookId: row.book_id
          });
          continue;
        }

        // Every profile with state stranded on this orphan book must have a live
        // row with a resolved book_id to migrate onto before the legacy row can
        // go — a legacy row can predate per-profile scoping and so have
        // accumulated state from more profiles than currently happen to have a
        // live counterpart for this external id. A live row can also exist yet
        // still have book_id NULL: this cleanup runs (see engine.ts) after that
        // profile's own source is upserted but before Phase D's reconcile has
        // had a chance to assign it a book id, which is the normal state for a
        // profile's first-ever scoped source row. Treat that the same as no live
        // row at all — deleting anyway would strand that profile's state with no
        // migration target, on a now-sourceless book that reconciliation will
        // never remove. Leave the whole row alone until every profile is
        // covered — it's retried on the next cleanup pass.
        const liveProfileIds = new Set(liveRows.filter((live) => live.book_id !== null).map((live) => live.profile_id));
        const stateProfileIds = (stateProfilesOnBook.all(row.book_id) as { profile_id: number }[]).map((r) => r.profile_id);
        const unmatchedProfileIds = stateProfileIds.filter((profileId) => !liveProfileIds.has(profileId));
        if (unmatchedProfileIds.length > 0) {
          logger.warn("Deferred legacy Hardcover source cleanup: a profile's state on its orphan book has no live counterpart yet", {
            legacySourceId: row.id, bookId: row.book_id, unmatchedProfileIds
          });
          continue;
        }

        // Moves a profile's stranded state onto the live row's book, resolving a
        // conflict with the live row's own state there the same way a book merge
        // does (see shouldMoveState in bookIdentity.ts): prefer whichever side has
        // meaningful progress, then whichever was modified more recently — never
        // unconditionally favor the live side, since the stranded state can be the
        // more current one.
        for (const live of liveRows) {
          if (live.book_id === null || live.book_id === row.book_id) continue;
          const stranded = selectState.get(row.book_id, live.profile_id) as UserBookStateMoveRow | undefined;
          if (!stranded) continue;
          const conflict = selectState.get(live.book_id, live.profile_id) as UserBookStateMoveRow | undefined;
          if (!conflict) {
            updateUserStateBook.run(live.book_id, stranded.id);
            migratedStates++;
          } else if (shouldMoveState(stranded, conflict)) {
            deleteUserState.run(conflict.id);
            updateUserStateBook.run(live.book_id, stranded.id);
            migratedStates++;
          } else {
            deleteUserState.run(stranded.id);
          }
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
  }

  return { deleted, affectedBookIds: Array.from(affectedBookIds), deletedSourceIds };
}
