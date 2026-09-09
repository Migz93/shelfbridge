import assert from "node:assert/strict";
import test from "node:test";
import { hasIdentityReviewConflict } from "../../src/server/sync/identity-review.js";

test("flags a conflict when Grimmory's cross-reference ID disagrees with the source's own ID", () => {
  // Same profile, two rows for the same canonical book: one carries the
  // book's own Goodreads ID, the other carries Grimmory's cross-reference
  // Goodreads ID, and they disagree. Folding Grimmory's ID into the same
  // set it's compared against (the pre-fix bug) made this look consistent;
  // it must be reported as an actionable conflict.
  const rows = [
    { profile_id: 1, goodreads_book_id: "111", grimmory_goodreads_id: null, hardcover_book_id: null, grimmory_hardcover_book_id: null },
    { profile_id: 1, goodreads_book_id: null, grimmory_goodreads_id: "222", hardcover_book_id: null, grimmory_hardcover_book_id: null }
  ];
  assert.equal(hasIdentityReviewConflict(rows), true);
});

test("flags a Hardcover cross-reference conflict the same way", () => {
  const rows = [
    { profile_id: 1, goodreads_book_id: null, grimmory_goodreads_id: null, hardcover_book_id: 111, grimmory_hardcover_book_id: null },
    { profile_id: 1, goodreads_book_id: null, grimmory_goodreads_id: null, hardcover_book_id: null, grimmory_hardcover_book_id: "222" }
  ];
  assert.equal(hasIdentityReviewConflict(rows), true);
});

test("does not flag a conflict when Grimmory's cross-reference ID agrees with the source's own ID", () => {
  const rows = [
    { profile_id: 1, goodreads_book_id: "111", grimmory_goodreads_id: null, hardcover_book_id: null, grimmory_hardcover_book_id: null },
    { profile_id: 1, goodreads_book_id: null, grimmory_goodreads_id: "111", hardcover_book_id: null, grimmory_hardcover_book_id: null }
  ];
  assert.equal(hasIdentityReviewConflict(rows), false);
});

test("does not flag a conflict when a numeric Hardcover ID agrees with Grimmory's string cross-reference", () => {
  const rows = [
    { profile_id: 1, goodreads_book_id: null, grimmory_goodreads_id: null, hardcover_book_id: 111, grimmory_hardcover_book_id: null },
    { profile_id: 1, goodreads_book_id: null, grimmory_goodreads_id: null, hardcover_book_id: null, grimmory_hardcover_book_id: "111" }
  ];
  assert.equal(hasIdentityReviewConflict(rows), false);
});

test("does not flag a conflict across different profiles' own rows", () => {
  const rows = [
    { profile_id: 1, goodreads_book_id: "111", grimmory_goodreads_id: "111", hardcover_book_id: null, grimmory_hardcover_book_id: null },
    { profile_id: 2, goodreads_book_id: "222", grimmory_goodreads_id: "222", hardcover_book_id: null, grimmory_hardcover_book_id: null }
  ];
  assert.equal(hasIdentityReviewConflict(rows), false);
});
