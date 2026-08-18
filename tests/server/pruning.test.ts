import assert from "node:assert/strict";
import test from "node:test";
import {
  pruneGoodreadsUserStatesMissingFromFetch,
  pruneGrimmorySourcesMissingFromFetch,
  pruneGrimmoryUserStatesMissingFromFetch,
  pruneHardcoverSourcesMissingFromFetch,
  pruneHardcoverUserStatesMissingFromFetch,
  pruneOrphanedHardcoverUserStates
} from "../../src/server/sync/pruning.js";
import { seedProfile } from "./test-helpers.js";
import { createTestDatabase } from "./test-db.js";

function insertBook(db: ReturnType<typeof createTestDatabase>["db"], title: string): number {
  return Number(db.prepare("INSERT INTO books (title) VALUES (?)").run(title).lastInsertRowid);
}

function insertBookSource(
  db: ReturnType<typeof createTestDatabase>["db"],
  bookId: number,
  sourceType: string,
  sourceInstanceId: number,
  externalId: string,
  title?: string
): void {
  db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type)
    VALUES (?, ?, ?, ?, ?, 'book')
  `).run(bookId, sourceType, sourceInstanceId, externalId, title ?? null);
}

function insertUserState(
  db: ReturnType<typeof createTestDatabase>["db"],
  bookId: number,
  profileId: number,
  sourceType: string
): void {
  db.prepare(`
    INSERT INTO user_book_states (book_id, profile_id, source_type, status)
    VALUES (?, ?, ?, 'reading')
  `).run(bookId, profileId, sourceType);
}

test("pruneHardcoverSourcesMissingFromFetch removes only this profile's stale HC book_sources", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const otherProfileId = seedProfile(db, "Other Profile");

    const kept = insertBook(db, "Kept Book");
    const stale = insertBook(db, "Stale Book");
    const otherProfilesBook = insertBook(db, "Other Profile's Book");

    // Hardcover external_id is the numeric HC book id, scoped to this profile's instance.
    insertBookSource(db, kept, "hardcover", profileId, "111");
    insertBookSource(db, stale, "hardcover", profileId, "222");
    // Different instance (another profile's connection) — must never be touched.
    insertBookSource(db, otherProfilesBook, "hardcover", otherProfileId, "222");

    pruneHardcoverSourcesMissingFromFetch(db, profileId, new Set([111]), "complete");

    const remaining = db.prepare("SELECT book_id FROM book_sources WHERE source_type = 'hardcover'").all() as { book_id: number }[];
    const remainingBookIds = remaining.map((r) => r.book_id).sort();
    assert.deepEqual(remainingBookIds, [kept, otherProfilesBook].sort());
  } finally {
    cleanup();
  }
});

test("pruneHardcoverSourcesMissingFromFetch does not delete a source still referenced by this profile's user_book_states", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const bookId = insertBook(db, "Still Has Progress");
    insertBookSource(db, bookId, "hardcover", profileId, "222");
    insertUserState(db, bookId, profileId, "hardcover");

    pruneHardcoverSourcesMissingFromFetch(db, profileId, new Set([111]), "complete");

    const remaining = db.prepare("SELECT COUNT(*) AS count FROM book_sources WHERE source_type = 'hardcover'").get() as { count: number };
    assert.equal(remaining.count, 1, "a source with live user state must survive even if missing from the fetch");
  } finally {
    cleanup();
  }
});

test("pruneHardcoverUserStatesMissingFromFetch removes this profile's stale HC user state", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const kept = insertBook(db, "Kept");
    const stale = insertBook(db, "Stale");
    insertBookSource(db, kept, "hardcover", profileId, "111");
    insertBookSource(db, stale, "hardcover", profileId, "222");
    insertUserState(db, kept, profileId, "hardcover");
    insertUserState(db, stale, profileId, "hardcover");

    pruneHardcoverUserStatesMissingFromFetch(db, profileId, new Set([111]), "complete");

    const remaining = db.prepare("SELECT book_id FROM user_book_states WHERE source_type = 'hardcover'").all() as { book_id: number }[];
    assert.deepEqual(remaining.map((r) => r.book_id), [kept]);
  } finally {
    cleanup();
  }
});

test("pruneHardcoverUserStatesMissingFromFetch preserves state when the same book has another live HC source", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const bookId = insertBook(db, "Multi-source book");
    insertBookSource(db, bookId, "hardcover", profileId, "111");
    insertBookSource(db, bookId, "hardcover", profileId, "222");
    insertUserState(db, bookId, profileId, "hardcover");

    pruneHardcoverUserStatesMissingFromFetch(db, profileId, new Set([111]), "complete");

    const remaining = db.prepare("SELECT COUNT(*) AS count FROM user_book_states WHERE book_id = ? AND source_type = 'hardcover'").get(bookId) as { count: number };
    assert.equal(remaining.count, 1);
  } finally {
    cleanup();
  }
});

test("pruneGrimmorySourcesMissingFromFetch and pruneGrimmoryUserStatesMissingFromFetch mirror the Hardcover behavior", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const kept = insertBook(db, "Kept");
    const stale = insertBook(db, "Stale");
    insertBookSource(db, kept, "grimmory", profileId, "111");
    insertBookSource(db, stale, "grimmory", profileId, "222");
    insertUserState(db, kept, profileId, "grimmory");
    insertUserState(db, stale, profileId, "grimmory");

    pruneGrimmoryUserStatesMissingFromFetch(db, profileId, new Set([111]), "complete");
    pruneGrimmorySourcesMissingFromFetch(db, profileId, new Set([111]), "complete");

    const remainingStates = db.prepare("SELECT book_id FROM user_book_states WHERE source_type = 'grimmory'").all() as { book_id: number }[];
    assert.deepEqual(remainingStates.map((r) => r.book_id), [kept]);

    const remainingSources = db.prepare("SELECT book_id FROM book_sources WHERE source_type = 'grimmory'").all() as { book_id: number }[];
    assert.deepEqual(remainingSources.map((r) => r.book_id), [kept]);
  } finally {
    cleanup();
  }
});

test("pruneGoodreadsUserStatesMissingFromFetch matches by raw external_id (not numeric)", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const kept = insertBook(db, "Kept");
    const stale = insertBook(db, "Stale");
    insertBookSource(db, kept, "goodreads", profileId, "gr-abc");
    insertBookSource(db, stale, "goodreads", profileId, "gr-xyz");
    insertUserState(db, kept, profileId, "goodreads");
    insertUserState(db, stale, profileId, "goodreads");

    pruneGoodreadsUserStatesMissingFromFetch(db, profileId, new Set(["gr-abc"]), "complete");

    const remaining = db.prepare("SELECT book_id FROM user_book_states WHERE source_type = 'goodreads'").all() as { book_id: number }[];
    assert.deepEqual(remaining.map((r) => r.book_id), [kept]);
  } finally {
    cleanup();
  }
});

test("a complete empty snapshot removes stale source rows and user states", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const bookId = insertBook(db, "Untouched");
    insertBookSource(db, bookId, "hardcover", profileId, "111");
    insertUserState(db, bookId, profileId, "hardcover");

    pruneHardcoverUserStatesMissingFromFetch(db, profileId, new Set(), "complete");
    pruneHardcoverSourcesMissingFromFetch(db, profileId, new Set(), "complete");

    const sources = db.prepare("SELECT COUNT(*) AS count FROM book_sources WHERE source_type = 'hardcover'").get() as { count: number };
    const states = db.prepare("SELECT COUNT(*) AS count FROM user_book_states WHERE source_type = 'hardcover'").get() as { count: number };
    assert.equal(sources.count, 0);
    assert.equal(states.count, 0);
  } finally {
    cleanup();
  }
});

test("pruneOrphanedHardcoverUserStates does not let another profile's live HC source suppress this profile's pruning", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const otherProfileId = seedProfile(db, "Other Profile");
    // A single canonical book both profiles' Hardcover instances have matched to.
    const bookId = insertBook(db, "Shared Book");

    // This profile's own Hardcover book_sources row is already gone (e.g. pruned
    // elsewhere, or never re-created after a reconcile), but the other profile's
    // Hardcover source for the same book_id is still live.
    insertBookSource(db, bookId, "hardcover", otherProfileId, "222");
    insertUserState(db, bookId, profileId, "hardcover");
    insertUserState(db, bookId, otherProfileId, "hardcover");

    pruneOrphanedHardcoverUserStates(db, profileId);

    const remaining = db.prepare("SELECT profile_id FROM user_book_states WHERE source_type = 'hardcover'").all() as { profile_id: number }[];
    assert.deepEqual(remaining.map((r) => r.profile_id), [otherProfileId], "this profile's orphaned state must be pruned even though another profile still has a live source for the same book");
  } finally {
    cleanup();
  }
});

test("pruneOrphanedHardcoverUserStates preserves state when this profile still has a live HC source for the book", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const bookId = insertBook(db, "Still Owned");
    insertBookSource(db, bookId, "hardcover", profileId, "111");
    insertUserState(db, bookId, profileId, "hardcover");

    pruneOrphanedHardcoverUserStates(db, profileId);

    const remaining = db.prepare("SELECT COUNT(*) AS count FROM user_book_states WHERE source_type = 'hardcover' AND profile_id = ?").get(profileId) as { count: number };
    assert.equal(remaining.count, 1);
  } finally {
    cleanup();
  }
});

test("partial and failed snapshots never prune, including when they are empty", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const bookId = insertBook(db, "Untouched");
    insertBookSource(db, bookId, "hardcover", profileId, "111");
    insertUserState(db, bookId, profileId, "hardcover");

    for (const snapshotStatus of ["partial", "failed"] as const) {
      pruneHardcoverUserStatesMissingFromFetch(db, profileId, new Set(), snapshotStatus);
      pruneHardcoverSourcesMissingFromFetch(db, profileId, new Set(), snapshotStatus);
    }

    const sources = db.prepare("SELECT COUNT(*) AS count FROM book_sources WHERE source_type = 'hardcover'").get() as { count: number };
    const states = db.prepare("SELECT COUNT(*) AS count FROM user_book_states WHERE source_type = 'hardcover'").get() as { count: number };
    assert.equal(sources.count, 1);
    assert.equal(states.count, 1);
  } finally {
    cleanup();
  }
});

test("pruneHardcoverSourcesMissingFromFetch deletes a book left with no sources and no user state", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const staleId = insertBook(db, "Hardcover Only Book");
    insertBookSource(db, staleId, "hardcover", profileId, "222");

    pruneHardcoverSourcesMissingFromFetch(db, profileId, new Set(), "complete");

    const book = db.prepare("SELECT id FROM books WHERE id = ?").get(staleId);
    assert.equal(book, undefined, "a book left with no sources and no user state after pruning its only Hardcover source must be deleted, not left as a ghost canonical");
  } finally {
    cleanup();
  }
});

test("pruneHardcoverSourcesMissingFromFetch does not delete a book that still has another source", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const bookId = insertBook(db, "Multi-Source Book");
    insertBookSource(db, bookId, "hardcover", profileId, "222");
    insertBookSource(db, bookId, "grimmory", profileId, "333");

    pruneHardcoverSourcesMissingFromFetch(db, profileId, new Set(), "complete");

    const book = db.prepare("SELECT id FROM books WHERE id = ?").get(bookId);
    assert.ok(book, "a book with a surviving Grimmory source must not be deleted just because its Hardcover source was pruned");
  } finally {
    cleanup();
  }
});

test("pruneGrimmorySourcesMissingFromFetch deletes a book left with no sources and no user state", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const staleId = insertBook(db, "Grimmory Only Book");
    insertBookSource(db, staleId, "grimmory", profileId, "222");

    pruneGrimmorySourcesMissingFromFetch(db, profileId, new Set(), "complete");

    const book = db.prepare("SELECT id FROM books WHERE id = ?").get(staleId);
    assert.equal(book, undefined, "a book left with no sources and no user state after pruning its only Grimmory source must be deleted, not left as a ghost canonical");
  } finally {
    cleanup();
  }
});

test("pruning a preferred source reconciles the survivor, updating the canonical title away from the stale value", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    // canonicalValues' bestRow() scores hardcover above grimmory when neither
    // has a cover, so the book's title starts out sourced from Hardcover —
    // simulating the state a prior reconcile would have left it in.
    const bookId = insertBook(db, "HC Title");
    insertBookSource(db, bookId, "hardcover", profileId, "111", "HC Title");
    insertBookSource(db, bookId, "grimmory", profileId, "222", "Grimmory Title");

    pruneHardcoverSourcesMissingFromFetch(db, profileId, new Set(), "complete");

    const remainingHc = db.prepare("SELECT COUNT(*) AS count FROM book_sources WHERE book_id = ? AND source_type = 'hardcover'").get(bookId) as { count: number };
    assert.equal(remainingHc.count, 0, "the stale Hardcover source must be removed");

    const book = db.prepare("SELECT title FROM books WHERE id = ?").get(bookId) as { title: string } | undefined;
    assert.ok(book, "the book must survive — it still has a Grimmory source");
    assert.equal(book.title, "Grimmory Title", "the canonical title must be recomputed from the surviving source, not left stale from the deleted Hardcover row");
  } finally {
    cleanup();
  }
});
