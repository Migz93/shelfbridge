import assert from "node:assert/strict";
import test from "node:test";
import {
  newerSource,
  normalizeSeriesNumber,
  normalizeTitle,
  shouldGoodreadsOverwriteGrimmory
} from "../../src/server/sync/engine.js";
import { normalizeIsbn } from "../../src/server/identifiers.js";
import {
  cleanupDuplicateBlankHardcoverReads,
  hardcoverProgressPercent,
  latestHardcoverRead
} from "../../src/server/sync/sync-utils.js";
import {
  bookOwnsSharedHardcoverRecord,
  hasActiveOwningBook,
  isOwnedBySomeoneElse,
  resolveSharedHardcoverOwnership,
  sharedHardcoverRecordFor
} from "../../src/server/sync/hardcover-ownership.js";
import { hasKnownHardcoverIdentity } from "../../src/server/sync/chaptarr.js";
import { createTestDatabase } from "./test-db.js";
import { seedProfile } from "./test-helpers.js";

test("normalizeTitle strips parenthetical series info, case, and punctuation", () => {
  assert.equal(normalizeTitle("Dune (Dune, #1)"), "dune");
  assert.equal(normalizeTitle("The Hobbit: There and Back Again"), "the hobbit there and back again");
  assert.equal(normalizeTitle("  Extra   Spaces  "), "extra spaces");
});

test("normalizeTitle preserves non-Latin scripts instead of stripping them to an empty string", () => {
  assert.equal(normalizeTitle("Преступление и наказание"), "преступление и наказание");
  assert.equal(normalizeTitle("三体"), "三体");
});

test("normalizeSeriesNumber extracts the leading numeric portion", () => {
  assert.equal(normalizeSeriesNumber("Book 2.5"), "2.5");
  assert.equal(normalizeSeriesNumber(3), "3");
  assert.equal(normalizeSeriesNumber(null), null);
  assert.equal(normalizeSeriesNumber(undefined), null);
  assert.equal(normalizeSeriesNumber("  "), null);
  assert.equal(normalizeSeriesNumber("Prequel"), "prequel");
});

test("normalizeIsbn ignores conventional separators", () => {
  assert.equal(normalizeIsbn("978-1-4028-9462-6"), "9781402894626");
  assert.equal(normalizeIsbn("0 306 40615 2"), "0306406152");
  assert.equal(normalizeIsbn("12345"), null);
  assert.equal(normalizeIsbn("  "), null);
  assert.equal(normalizeIsbn("0-8044-2957-x"), "080442957X");
  assert.equal(normalizeIsbn("978–1–4028–9462–6"), "9781402894626");
  assert.equal(normalizeIsbn("978140289462"), null);
  assert.equal(normalizeIsbn("97814028AB626"), null);
});

test("normalizeIsbn rejects a well-formed ISBN with an invalid check digit", () => {
  // Same digits as the valid examples above with the final check digit changed.
  assert.equal(normalizeIsbn("978-1-4028-9462-9"), null);
  assert.equal(normalizeIsbn("0-306-40615-9"), null);
});

test("newerSource returns whichever timestamp is later, or null when either side is missing", () => {
  assert.equal(newerSource("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"), "hardcover");
  assert.equal(newerSource("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"), "grimmory");
  assert.equal(newerSource(null, "2026-01-01T00:00:00Z"), null);
  assert.equal(newerSource("2026-01-01T00:00:00Z", null), null);
  assert.equal(newerSource(null, null), null);
});

test("cleanupDuplicateBlankHardcoverReads keeps a read in memory when its remote deletion fails", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const runId = Number(db.prepare("INSERT INTO sync_runs (profile_id) VALUES (?)").run(profileId).lastInsertRowid);
    const bookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Book')").run().lastInsertRowid);

    const progressedRead = { id: 1, edition_id: 5, edition: null, progress: 40, progress_pages: null, progress_seconds: null, started_at: "2026-01-01", finished_at: null };
    const blankReadThatFailsToDelete = { id: 2, edition_id: 5, edition: null, progress: null, progress_pages: null, progress_seconds: null, started_at: "2026-01-01", finished_at: null };
    const hcBook = {
      id: 900, edition_id: 5, status_id: 2, rating: null, updated_at: null, first_started_reading_date: null, last_read_date: null,
      book: { id: 1, title: "Book", slug: null, image: null, contributions: null, default_physical_edition: null, default_ebook_edition: null, default_audio_edition: null, book_series: null },
      user_book_reads: [progressedRead, blankReadThatFailsToDelete]
    };

    await cleanupDuplicateBlankHardcoverReads({
      db, runId, profileId, title: "Book", bookId,
      hcBook: hcBook as Parameters<typeof cleanupDuplicateBlankHardcoverReads>[0]["hcBook"],
      hardcoverToken: "token", dryRun: false, counters: { written: 0, skipped: 0 },
      adapters: { deleteHardcoverUserBookRead: async () => { throw new Error("network error"); } } as Parameters<typeof cleanupDuplicateBlankHardcoverReads>[0]["adapters"]
    });

    // The delete failed, so the blank read must still be present in memory —
    // dropping it here would make later logic in the same run treat it as
    // already gone even though Hardcover still has it.
    assert.deepEqual(hcBook.user_book_reads.map((r) => r.id), [1, 2]);
  } finally { cleanup(); }
});

test("newerSource does not order unparseable timestamps as strings", () => {
  // A valid ISO timestamp lexicographically follows a garbage string, which
  // used to make the garbage value win under plain string comparison.
  assert.equal(newerSource("not-a-date", "2026-01-01T00:00:00Z"), "grimmory");
  assert.equal(newerSource("2026-01-01T00:00:00Z", "not-a-date"), "hardcover");
  assert.equal(newerSource("not-a-date", "also-not-a-date"), null);
});

test("hardcoverProgressPercent uses the selected read's page count", () => {
  const book = {
    user_book_reads: [
      { id: 1, edition_id: 1, progress_pages: 25, progress: null, progress_seconds: null, edition: { pages: 100 } },
      { id: 2, edition_id: 2, progress_pages: 100, progress: null, progress_seconds: null, edition: { pages: 200 } }
    ],
    book: { default_physical_edition: null, pages: null }
  };
  assert.equal(hardcoverProgressPercent(book as any, null, 2), 50);
});

test("latestHardcoverRead prefers a progressed read over a blank duplicate on the selected edition", () => {
  const book = {
    user_book_reads: [
      { id: 2, edition_id: 7, progress: null, progress_pages: null, progress_seconds: null, started_at: "2026-08-11", finished_at: null },
      { id: 1, edition_id: 7, progress: 19.7, progress_pages: null, progress_seconds: 8132, started_at: "2026-08-10", finished_at: null }
    ]
  };
  assert.equal(latestHardcoverRead(book as any, 7)?.id, 1);
});

test("shared Hardcover progress gives an active book sibling precedence over Audiobookshelf", () => {
  const book = { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READING" };
  const inactiveAudio = { id: 2, hardcoverBookId: "42", mediaType: "audiobook", readStatus: "UNREAD" };
  const activeAudio = { ...inactiveAudio, readStatus: "READING" };

  const completedBook = { ...book, readStatus: "READ" };
  const noAbsOwnership = new Set<string>();
  const absOwnership = new Set(["42"]);

  assert.equal(isOwnedBySomeoneElse(resolveSharedHardcoverOwnership([completedBook, activeAudio] as any, noAbsOwnership), completedBook as any), true);
  assert.equal(isOwnedBySomeoneElse(resolveSharedHardcoverOwnership([completedBook, activeAudio] as any, noAbsOwnership), activeAudio as any), false);
  assert.equal(isOwnedBySomeoneElse(resolveSharedHardcoverOwnership([completedBook, inactiveAudio] as any, absOwnership), completedBook as any), true);
  assert.equal(isOwnedBySomeoneElse(resolveSharedHardcoverOwnership([book, inactiveAudio] as any, absOwnership), book as any), false);
  assert.equal(hasActiveOwningBook(resolveSharedHardcoverOwnership([book, inactiveAudio] as any, noAbsOwnership), "42"), true);
  assert.equal(hasActiveOwningBook(resolveSharedHardcoverOwnership([inactiveAudio] as any, noAbsOwnership), "42"), false);
  assert.equal(bookOwnsSharedHardcoverRecord(resolveSharedHardcoverOwnership([book] as any, noAbsOwnership), "42"), false);
  assert.equal(bookOwnsSharedHardcoverRecord(resolveSharedHardcoverOwnership([book, inactiveAudio] as any, noAbsOwnership), "42"), true);
  assert.equal(sharedHardcoverRecordFor(resolveSharedHardcoverOwnership([book, activeAudio] as any, noAbsOwnership), "42")?.activeBook?.id, 1);
});

test("a shared Hardcover work ID is valid across separate local media identities", () => {
  const identities = new Map<number, ReadonlySet<string>>([[10, new Set(["42"])]]);
  assert.equal(hasKnownHardcoverIdentity(identities, 10, "42"), true);
  assert.equal(hasKnownHardcoverIdentity(identities, 10, "99"), false);
});

test("shouldGoodreadsOverwriteGrimmory overwrites when Grimmory has no timestamp to conflict with", () => {
  assert.equal(shouldGoodreadsOverwriteGrimmory("2026-01-01T00:00:00Z", null), true);
});

test("shouldGoodreadsOverwriteGrimmory never overwrites when Goodreads has no timestamp", () => {
  assert.equal(shouldGoodreadsOverwriteGrimmory(null, "2026-01-01T00:00:00Z"), false);
});

test("shouldGoodreadsOverwriteGrimmory otherwise overwrites only when Goodreads is at least as new", () => {
  assert.equal(shouldGoodreadsOverwriteGrimmory("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"), true);
  assert.equal(shouldGoodreadsOverwriteGrimmory("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"), false);
});
