import assert from "node:assert/strict";
import test from "node:test";
import {
  pruneGoodreadsUserStatesMissingFromFetch,
  pruneGrimmorySourcesMissingFromFetch,
  pruneGrimmoryUserStatesMissingFromFetch,
  pruneHardcoverSourcesMissingFromFetch,
  pruneHardcoverUserStatesMissingFromFetch
} from "../../src/server/sync/engine.js";
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
  externalId: string
): void {
  db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id)
    VALUES (?, ?, ?, ?)
  `).run(bookId, sourceType, sourceInstanceId, externalId);
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

    pruneHardcoverSourcesMissingFromFetch(db, profileId, new Set([111]));

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

    pruneHardcoverSourcesMissingFromFetch(db, profileId, new Set([111]));

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

    pruneHardcoverUserStatesMissingFromFetch(db, profileId, new Set([111]));

    const remaining = db.prepare("SELECT book_id FROM user_book_states WHERE source_type = 'hardcover'").all() as { book_id: number }[];
    assert.deepEqual(remaining.map((r) => r.book_id), [kept]);
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

    pruneGrimmoryUserStatesMissingFromFetch(db, profileId, new Set([111]));
    pruneGrimmorySourcesMissingFromFetch(db, profileId, new Set([111]));

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

    pruneGoodreadsUserStatesMissingFromFetch(db, profileId, new Set(["gr-abc"]));

    const remaining = db.prepare("SELECT book_id FROM user_book_states WHERE source_type = 'goodreads'").all() as { book_id: number }[];
    assert.deepEqual(remaining.map((r) => r.book_id), [kept]);
  } finally {
    cleanup();
  }
});

test("an empty fetched-id set is a no-op (never wipes everything on a failed fetch)", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const bookId = insertBook(db, "Untouched");
    insertBookSource(db, bookId, "hardcover", profileId, "111");
    insertUserState(db, bookId, profileId, "hardcover");

    pruneHardcoverUserStatesMissingFromFetch(db, profileId, new Set());
    pruneHardcoverSourcesMissingFromFetch(db, profileId, new Set());

    const sources = db.prepare("SELECT COUNT(*) AS count FROM book_sources WHERE source_type = 'hardcover'").get() as { count: number };
    const states = db.prepare("SELECT COUNT(*) AS count FROM user_book_states WHERE source_type = 'hardcover'").get() as { count: number };
    assert.equal(sources.count, 1);
    assert.equal(states.count, 1);
  } finally {
    cleanup();
  }
});
