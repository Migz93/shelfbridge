import assert from "node:assert/strict";
import test from "node:test";
import { reconcileBookIdentities } from "../../src/server/db/bookIdentity.js";
import { createTestDatabase } from "./test-db.js";

/** Inserts a book_sources row with book_id left NULL, as a fresh sync would. */
function insertSource(
  db: ReturnType<typeof createTestDatabase>["db"],
  fields: {
    sourceType: string;
    externalId: string;
    title: string;
    author?: string;
    isbn13?: string;
    sourceHardcoverBookId?: string;
  }
): void {
  db.prepare(`
    INSERT INTO book_sources (source_type, external_id, title, author, isbn13, source_media_type, source_hardcover_book_id)
    VALUES (@sourceType, @externalId, @title, @author, @isbn13, 'book', @sourceHardcoverBookId)
  `).run({
    sourceType: fields.sourceType,
    externalId: fields.externalId,
    title: fields.title,
    author: fields.author ?? "Author",
    isbn13: fields.isbn13 ?? null,
    sourceHardcoverBookId: fields.sourceHardcoverBookId ?? null
  });
}

function booksByTitle(db: ReturnType<typeof createTestDatabase>["db"]) {
  return db.prepare("SELECT id, title FROM books ORDER BY id").all() as { id: number; title: string }[];
}

test("reconcileBookIdentities merges two sources that share an ISBN13 into one book", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    insertSource(db, { sourceType: "hardcover", externalId: "hc-1", title: "Dune", isbn13: "9780441013593" });
    insertSource(db, { sourceType: "grimmory", externalId: "gr-1", title: "Dune", isbn13: "9780441013593" });

    reconcileBookIdentities(db);

    const books = booksByTitle(db);
    assert.equal(books.length, 1, "matching ISBN13 should merge into a single canonical book");

    const sources = db.prepare("SELECT source_type, book_id FROM book_sources").all() as
      { source_type: string; book_id: number }[];
    assert.equal(sources[0]!.book_id, books[0]!.id);
    assert.equal(sources[1]!.book_id, books[0]!.id);
  } finally {
    cleanup();
  }
});

test("reconcileBookIdentities keeps sources with conflicting hardcover_book_id as separate books", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    // Same title, but each row claims a different authoritative Hardcover book id —
    // a high-confidence conflict that must block an automatic merge.
    insertSource(db, { sourceType: "hardcover", externalId: "hc-1", title: "Same Title", sourceHardcoverBookId: "111" });
    insertSource(db, { sourceType: "goodreads", externalId: "gr-1", title: "Same Title", sourceHardcoverBookId: "222" });

    reconcileBookIdentities(db);

    const books = booksByTitle(db);
    assert.equal(books.length, 2, "conflicting authoritative identifiers must not be auto-merged");
  } finally {
    cleanup();
  }
});

test("reconcileBookIdentities is idempotent: running it twice does not duplicate books", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    insertSource(db, { sourceType: "hardcover", externalId: "hc-1", title: "Idempotent Book", isbn13: "9780000000001" });
    insertSource(db, { sourceType: "grimmory", externalId: "gr-1", title: "Idempotent Book", isbn13: "9780000000001" });

    reconcileBookIdentities(db);
    const firstPass = booksByTitle(db);

    reconcileBookIdentities(db);
    const secondPass = booksByTitle(db);

    assert.deepEqual(secondPass, firstPass);
  } finally {
    cleanup();
  }
});

test("reconcileBookIdentities deletes books left with no remaining book_sources rows", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    // A second, untouched source row keeps book_sources non-empty so reconcile's
    // full pass (and its stale-book cleanup) runs rather than taking the early-out
    // for an entirely empty book_sources table.
    insertSource(db, { sourceType: "hardcover", externalId: "hc-1", title: "Will Be Orphaned" });
    insertSource(db, { sourceType: "grimmory", externalId: "gr-keep", title: "Stays Around" });
    reconcileBookIdentities(db);
    assert.equal(booksByTitle(db).length, 2);

    db.prepare("DELETE FROM book_sources WHERE external_id = 'hc-1'").run();
    reconcileBookIdentities(db);

    const remaining = booksByTitle(db);
    assert.deepEqual(remaining.map((b) => b.title), ["Stays Around"], "a book with zero source rows must be cleaned up");
  } finally {
    cleanup();
  }
});
