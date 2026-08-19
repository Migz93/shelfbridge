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
