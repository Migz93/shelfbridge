import assert from "node:assert/strict";
import test from "node:test";
import {
  newerSource,
  normalizeSeriesNumber,
  normalizeTitle,
  shouldGoodreadsOverwriteGrimmory
} from "../../src/server/sync/engine.js";
import { normalizeIsbn } from "../../src/server/identifiers.js";

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
  assert.equal(normalizeIsbn("  "), null);
});

test("newerSource returns whichever timestamp is later, or null when either side is missing", () => {
  assert.equal(newerSource("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"), "hardcover");
  assert.equal(newerSource("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"), "grimmory");
  assert.equal(newerSource(null, "2026-01-01T00:00:00Z"), null);
  assert.equal(newerSource("2026-01-01T00:00:00Z", null), null);
  assert.equal(newerSource(null, null), null);
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
