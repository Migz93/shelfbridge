import assert from "node:assert/strict";
import test from "node:test";
import { cleanupLegacyHardcoverSources } from "../../src/server/sync/hardcover-legacy-cleanup.js";
import { reconcileBookIdentities } from "../../src/server/db/bookIdentity.js";
import { seedProfile } from "./test-helpers.js";
import { createTestDatabase } from "./test-db.js";

function insertBook(db: ReturnType<typeof createTestDatabase>["db"], title: string): number {
  return Number(db.prepare("INSERT INTO books (title) VALUES (?)").run(title).lastInsertRowid);
}

function insertHardcoverSource(
  db: ReturnType<typeof createTestDatabase>["db"],
  bookId: number,
  sourceInstanceId: number | null,
  externalId: string
): number {
  return Number(db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type)
    VALUES (?, 'hardcover', ?, ?, 'Book', 'book')
  `).run(bookId, sourceInstanceId, externalId).lastInsertRowid);
}

test("cleanupLegacyHardcoverSources deletes an instance-less row once a live counterpart exists", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const bookId = insertBook(db, "Book");
    const legacyId = insertHardcoverSource(db, bookId, null, "hc-1");
    insertHardcoverSource(db, bookId, 1, "hc-1");

    const result = cleanupLegacyHardcoverSources(db);

    assert.equal(result.deleted, 1);
    assert.deepEqual(result.affectedBookIds, [bookId]);
    const remaining = db.prepare("SELECT id FROM book_sources WHERE id = ?").get(legacyId);
    assert.equal(remaining, undefined);
  } finally {
    cleanup();
  }
});

test("cleanupLegacyHardcoverSources deletes an instance-less row even when it has already split into its own book", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    // Simulates the "No Exit" case: the legacy row and the live row have drifted
    // onto different books after the live row's identity resolved and merged
    // elsewhere, leaving the legacy row stranded as a single-source book.
    const orphanBookId = insertBook(db, "Orphan");
    const canonicalBookId = insertBook(db, "Canonical");
    const legacyId = insertHardcoverSource(db, orphanBookId, null, "hc-2");
    insertHardcoverSource(db, canonicalBookId, 1, "hc-2");

    const result = cleanupLegacyHardcoverSources(db);

    assert.equal(result.deleted, 1);
    assert.deepEqual(result.affectedBookIds, [orphanBookId]);
    const remaining = db.prepare("SELECT id FROM book_sources WHERE id = ?").get(legacyId);
    assert.equal(remaining, undefined);
  } finally {
    cleanup();
  }
});

test("cleanupLegacyHardcoverSources leaves an instance-less row alone when no live counterpart exists yet", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const bookId = insertBook(db, "Book");
    const legacyId = insertHardcoverSource(db, bookId, null, "hc-3");

    const result = cleanupLegacyHardcoverSources(db);

    assert.equal(result.deleted, 0);
    const remaining = db.prepare("SELECT id FROM book_sources WHERE id = ?").get(legacyId);
    assert.notEqual(remaining, undefined);
  } finally {
    cleanup();
  }
});

test("cleanupLegacyHardcoverSources never touches a live, profile-scoped row", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const bookId = insertBook(db, "Book");
    insertHardcoverSource(db, bookId, null, "hc-4");
    const liveId = insertHardcoverSource(db, bookId, 1, "hc-4");

    cleanupLegacyHardcoverSources(db);

    const remaining = db.prepare("SELECT id FROM book_sources WHERE id = ?").get(liveId);
    assert.notEqual(remaining, undefined);
  } finally {
    cleanup();
  }
});

// Reproduces a real production sequencing bug: a book's legacy (instance-less)
// Hardcover row is never touched by any sync, so it can still be sitting on a
// book's id — with a stale, unresolved format bucket — right when that book's
// LIVE row finally resolves its own format and needs to merge with its
// Grimmory/Chaptarr canonical (e.g. via a title/author/series bridge, once its
// bucket is no longer "unknown"). The legacy row can't join that same bridge
// (its bucket is still unresolved, so it generates no title/author key), so it
// ends up an isolated singleton group that claims the book id for itself
// before the real merge group is processed — leaving the live row's merge
// target's own book id "already claimed" and its book_sources/user_book_states
// stranded behind, unmigrated. Reconciling right after cleaning up the legacy
// row (what engine.ts now does before every Hardcover sync's own reconcile)
// avoids the conflict entirely, because the legacy row is gone before
// reconciliation ever runs.
function seedSplitScenario(db: ReturnType<typeof createTestDatabase>["db"]) {
  const liveBookId = insertBook(db, "Shared Title");
  const canonicalBookId = insertBook(db, "Shared Title");
  seedProfile(db, "Profile");

  // Inserted first so it's the lower book_sources id, matching production
  // (legacy rows predate their live per-profile counterparts).
  db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, author, source_media_type)
    VALUES (?, 'hardcover', NULL, 'hc-1', 'Shared Title', 'Shared Author', NULL)
  `).run(liveBookId);
  db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, author, series_name, series_number, source_media_type)
    VALUES (?, 'hardcover', 1, 'hc-1', 'Shared Title', 'Shared Author', 'Series X', '1', 'book')
  `).run(liveBookId);
  db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, author, series_name, series_number, source_media_type)
    VALUES (?, 'grimmory', 1, 'gr-1', 'Shared Title', 'Shared Author', 'Series X', '1', 'book')
  `).run(canonicalBookId);
  db.prepare(`
    INSERT INTO user_book_states (book_id, profile_id, source_type, status, rating)
    VALUES (?, 1, 'hardcover', 'READ', 5)
  `).run(liveBookId);

  return { liveBookId, canonicalBookId };
}

test("reconciling without cleaning up the legacy row first strands the merge (documents the bug)", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const { liveBookId } = seedSplitScenario(db);

    reconcileBookIdentities(db);

    const zombie = db.prepare("SELECT id FROM books WHERE id = ?").get(liveBookId);
    assert.notEqual(zombie, undefined, "without the cleanup, the original book id is left behind as a sourceless zombie");
    const orphanedState = db.prepare("SELECT rating FROM user_book_states WHERE book_id = ?").get(liveBookId) as { rating: number } | undefined;
    assert.ok(orphanedState, "and its user_book_states row is stranded on it rather than following the merge");
  } finally {
    cleanup();
  }
});

test("cleanupLegacyHardcoverSources migrates state already stranded on the legacy row's orphan book", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    // Simulates a database that already hit the "No Exit" split (see the test
    // above) before this cleanup existed: the profile's user_book_states row is
    // sitting on the legacy row's own orphan book_id, not the live row's book.
    const orphanBookId = insertBook(db, "Orphan");
    const canonicalBookId = insertBook(db, "Canonical");
    seedProfile(db, "Profile");
    insertHardcoverSource(db, orphanBookId, null, "hc-5");
    insertHardcoverSource(db, canonicalBookId, 1, "hc-5");
    db.prepare(`
      INSERT INTO user_book_states (book_id, profile_id, source_type, status, rating)
      VALUES (?, 1, 'hardcover', 'READ', 4)
    `).run(orphanBookId);

    cleanupLegacyHardcoverSources(db);

    const migrated = db.prepare("SELECT book_id, rating FROM user_book_states WHERE profile_id = 1 AND source_type = 'hardcover'").get() as
      { book_id: number; rating: number } | undefined;
    assert.ok(migrated, "the stranded state must survive the cleanup");
    assert.equal(migrated!.book_id, canonicalBookId, "it must follow the live row's book, not stay on the deleted orphan");
    assert.equal(migrated!.rating, 4);
  } finally {
    cleanup();
  }
});

test("cleanupLegacyHardcoverSources drops a stranded state duplicate instead of colliding with the live row's own state", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const orphanBookId = insertBook(db, "Orphan");
    const canonicalBookId = insertBook(db, "Canonical");
    seedProfile(db, "Profile");
    insertHardcoverSource(db, orphanBookId, null, "hc-6");
    insertHardcoverSource(db, canonicalBookId, 1, "hc-6");
    // The live row already has its own current state on the canonical book...
    db.prepare(`
      INSERT INTO user_book_states (book_id, profile_id, source_type, status, rating)
      VALUES (?, 1, 'hardcover', 'READ', 5)
    `).run(canonicalBookId);
    // ...while a stale duplicate is stranded on the orphan from before the fix.
    db.prepare(`
      INSERT INTO user_book_states (book_id, profile_id, source_type, status, rating)
      VALUES (?, 1, 'hardcover', 'READING', 2)
    `).run(orphanBookId);

    cleanupLegacyHardcoverSources(db);

    const states = db.prepare("SELECT book_id, rating FROM user_book_states WHERE profile_id = 1 AND source_type = 'hardcover'").all() as
      { book_id: number; rating: number }[];
    assert.equal(states.length, 1, "the stale stranded duplicate must be dropped rather than left behind or clobbering the live state");
    assert.equal(states[0]!.book_id, canonicalBookId);
    assert.equal(states[0]!.rating, 5, "the live row's own current state must be the one that survives");
  } finally {
    cleanup();
  }
});

test("cleanupLegacyHardcoverSources leaves the legacy row alone when only some profiles on its orphan book have a live counterpart", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    // A legacy row predates per-profile scoping, so it can have accumulated
    // state from more profiles than currently happen to have re-synced (and so
    // gotten a live counterpart) since. Deleting it once *any* profile has a
    // live row would strand the unmatched profile's state permanently.
    const orphanBookId = insertBook(db, "Orphan");
    const canonicalBookId = insertBook(db, "Canonical");
    const matchedProfileId = seedProfile(db, "Matched Profile");
    const unmatchedProfileId = seedProfile(db, "Unmatched Profile");
    const legacyId = insertHardcoverSource(db, orphanBookId, null, "hc-7");
    insertHardcoverSource(db, canonicalBookId, matchedProfileId, "hc-7");
    db.prepare(`
      INSERT INTO user_book_states (book_id, profile_id, source_type, status, rating)
      VALUES (?, ?, 'hardcover', 'READ', 4)
    `).run(orphanBookId, matchedProfileId);
    db.prepare(`
      INSERT INTO user_book_states (book_id, profile_id, source_type, status, rating)
      VALUES (?, ?, 'hardcover', 'READING', 3)
    `).run(orphanBookId, unmatchedProfileId);

    const result = cleanupLegacyHardcoverSources(db);

    assert.equal(result.deleted, 0, "the legacy row must not be deleted while any profile's state has nowhere to go");
    const remaining = db.prepare("SELECT id FROM book_sources WHERE id = ?").get(legacyId);
    assert.notEqual(remaining, undefined);
    const matchedState = db.prepare("SELECT book_id FROM user_book_states WHERE profile_id = ?").get(matchedProfileId) as { book_id: number };
    assert.equal(matchedState.book_id, orphanBookId, "the matched profile's state is also left in place, since the row itself was not deleted");
    const unmatchedState = db.prepare("SELECT book_id FROM user_book_states WHERE profile_id = ?").get(unmatchedProfileId) as { book_id: number };
    assert.equal(unmatchedState.book_id, orphanBookId, "the unmatched profile's state must never be stranded");
  } finally {
    cleanup();
  }
});

test("cleanupLegacyHardcoverSources leaves the legacy row alone when the matched live counterpart has no book_id yet", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    // cleanupLegacyHardcoverSources runs (see engine.ts) right after this
    // sync's own Hardcover sources are upserted but before Phase D's reconcile
    // has run — so a profile's very first scoped source row can be live
    // (source_instance_id set) yet still have book_id NULL. That must not count
    // as "matched" coverage: there is no book to migrate the profile's stranded
    // state onto yet.
    const orphanBookId = insertBook(db, "Orphan");
    const profileId = seedProfile(db, "Profile");
    const legacyId = insertHardcoverSource(db, orphanBookId, null, "hc-8");
    db.prepare(`
      INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type)
      VALUES (NULL, 'hardcover', ?, 'hc-8', 'Book', 'book')
    `).run(profileId);
    db.prepare(`
      INSERT INTO user_book_states (book_id, profile_id, source_type, status, rating)
      VALUES (?, ?, 'hardcover', 'READ', 4)
    `).run(orphanBookId, profileId);

    const result = cleanupLegacyHardcoverSources(db);

    assert.equal(result.deleted, 0, "the legacy row must not be deleted while its only live counterpart has no book_id to migrate onto");
    const remaining = db.prepare("SELECT id FROM book_sources WHERE id = ?").get(legacyId);
    assert.notEqual(remaining, undefined);
    const state = db.prepare("SELECT book_id FROM user_book_states WHERE profile_id = ?").get(profileId) as { book_id: number };
    assert.equal(state.book_id, orphanBookId, "the profile's state must never be stranded on a now-sourceless book");
  } finally {
    cleanup();
  }
});

test("cleaning up legacy rows before reconciling merges cleanly (verifies the fix)", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    seedSplitScenario(db);

    cleanupLegacyHardcoverSources(db);
    reconcileBookIdentities(db);

    const survivors = db.prepare("SELECT id FROM books").all() as { id: number }[];
    assert.equal(survivors.length, 1, "both sides must merge into a single canonical book, with no zombie left behind");
    const survivorId = survivors[0]!.id;

    const sources = db.prepare("SELECT source_type, book_id FROM book_sources").all() as { source_type: string; book_id: number }[];
    assert.equal(sources.length, 2, "the live Hardcover row and the Grimmory row must both survive");
    for (const source of sources) assert.equal(source.book_id, survivorId);

    const state = db.prepare("SELECT book_id, rating FROM user_book_states").get() as { book_id: number; rating: number };
    assert.equal(state.book_id, survivorId, "the reading state must follow the merge to the surviving book");
    assert.equal(state.rating, 5);
  } finally {
    cleanup();
  }
});
