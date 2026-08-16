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
  activeGrimmorySiblingsForHardcover,
  hardcoverProgressPercent,
  latestHardcoverRead,
  shouldActiveSiblingOwnSharedHardcover,
  shouldBookProgressOwnSharedHardcover
} from "../../src/server/sync/sync-utils.js";
import { hasKnownHardcoverIdentity } from "../../src/server/sync/chaptarr.js";

test("normalizeTitle strips parenthetical series info, case, and punctuation", () => {
  assert.equal(normalizeTitle("Dune (Dune, #1)"), "dune");
  assert.equal(normalizeTitle("The Hobbit: There and Back Again"), "the hobbit there and back again");
  assert.equal(normalizeTitle("  Extra   Spaces  "), "extra spaces");
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

test("newerSource returns whichever timestamp is later, or null when either side is missing", () => {
  assert.equal(newerSource("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"), "hardcover");
  assert.equal(newerSource("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"), "grimmory");
  assert.equal(newerSource(null, "2026-01-01T00:00:00Z"), null);
  assert.equal(newerSource("2026-01-01T00:00:00Z", null), null);
  assert.equal(newerSource(null, null), null);
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

test("shared Hardcover progress belongs to an active book sibling only when the audiobook is active too", () => {
  const book = { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READING" };
  const inactiveAudio = { id: 2, hardcoverBookId: "42", mediaType: "audiobook", readStatus: "UNREAD" };
  const activeAudio = { ...inactiveAudio, readStatus: "READING" };

  assert.equal(shouldBookProgressOwnSharedHardcover([book, inactiveAudio] as any, "42"), false);
  assert.equal(shouldBookProgressOwnSharedHardcover([book, activeAudio] as any, "42"), true);
  const completedBook = { ...book, readStatus: "READ" };
  assert.equal(shouldActiveSiblingOwnSharedHardcover([completedBook, activeAudio] as any, completedBook as any), true);
  assert.equal(shouldActiveSiblingOwnSharedHardcover([completedBook, activeAudio] as any, activeAudio as any), false);
  assert.equal(activeGrimmorySiblingsForHardcover([book, activeAudio] as any, "42").book?.id, 1);
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
