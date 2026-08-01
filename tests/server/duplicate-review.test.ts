import assert from "node:assert/strict";
import test from "node:test";
import { isLiveProbableDuplicatePair } from "../../src/server/routes/books.js";

type ReviewRows = Parameters<typeof isLiveProbableDuplicatePair>[0];

function rowsForReview(...rows: Array<{
  id: number;
  title: string;
  author: string;
  seriesName?: string | null;
  seriesNumber?: string | null;
}>): ReviewRows {
  return rows.map((row) => ({
    book_id: row.id,
    book_title: row.title,
    book_author: row.author,
    book_series_name: row.seriesName ?? null,
    book_series_number: row.seriesNumber ?? null
  })) as ReviewRows;
}

test("only a live, undismissed probable duplicate pair is eligible for merge", () => {
  const rows = rowsForReview(
    { id: 1, title: "Dune", author: "Frank Herbert" },
    { id: 2, title: "Dune", author: "Frank Herbert" },
    { id: 3, title: "Neuromancer", author: "William Gibson" }
  );

  assert.equal(isLiveProbableDuplicatePair(rows, 1, 2, new Set()), true);
  assert.equal(isLiveProbableDuplicatePair(rows, 1, 3, new Set()), false);
  assert.equal(isLiveProbableDuplicatePair(rows, 1, 2, new Set(["1:2"])), false);
});
