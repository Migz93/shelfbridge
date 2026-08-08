import assert from "node:assert/strict";
import test from "node:test";
import { isLiveProbableDuplicatePair, writeAndPersistDuplicateMergePlan } from "../../src/server/routes/books.js";
import { createTestDatabase } from "./test-db.js";
import { seedProfile } from "./test-helpers.js";

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

test("a later duplicate-merge remote failure preserves earlier locally persisted plans", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const firstProfile = seedProfile(db, "First");
    const secondProfile = seedProfile(db, "Second");
    const firstBook = Number(db.prepare("INSERT INTO books (title) VALUES ('First')").run().lastInsertRowid);
    const secondBook = Number(db.prepare("INSERT INTO books (title) VALUES ('Second')").run().lastInsertRowid);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id) VALUES (?, 'grimmory', ?, '1')").run(firstBook, firstProfile);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id) VALUES (?, 'grimmory', ?, '2')").run(secondBook, secondProfile);
    await writeAndPersistDuplicateMergePlan(db, { bookId: firstBook, profileId: firstProfile, goodreadsId: "gr-1", hardcoverBookId: null, hardcoverId: null }, async () => {});
    await assert.rejects(
      writeAndPersistDuplicateMergePlan(db, { bookId: secondBook, profileId: secondProfile, goodreadsId: "gr-2", hardcoverBookId: null, hardcoverId: null }, async () => { throw new Error("remote failure"); })
    );
    const first = db.prepare("SELECT grimmory_goodreads_id FROM book_sources WHERE book_id = ?").get(firstBook) as { grimmory_goodreads_id: string };
    const second = db.prepare("SELECT grimmory_goodreads_id FROM book_sources WHERE book_id = ?").get(secondBook) as { grimmory_goodreads_id: string | null };
    assert.equal(first.grimmory_goodreads_id, "gr-1");
    assert.equal(second.grimmory_goodreads_id, null);
  } finally { cleanup(); }
});
