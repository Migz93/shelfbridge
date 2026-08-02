import assert from "node:assert/strict";
import test from "node:test";
import { reconcileBookIdentities } from "../../src/server/db/bookIdentity.js";
import { createTestDatabase } from "./test-db.js";
import { seedProfile } from "./test-helpers.js";

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

test("reconcileBookIdentities bridges a Goodreads edition through corroborated Chaptarr and Grimmory evidence", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const sharedPath = "/books/Cheryl Fergison/Behind The Scenes.epub";
    db.prepare(`
      INSERT INTO book_sources (source_type, external_id, title, author, source_media_type)
      VALUES ('goodreads', '239822717', 'Behind The Scenes: My Secret Life Beyond EastEnders', 'Cheryl Fergison', 'book')
    `).run();
    db.prepare(`
      INSERT INTO book_sources (
        source_type, external_id, title, author, source_media_type,
        source_goodreads_edition_id, source_hardcover_book_id, chaptarr_primary_file_path
      ) VALUES ('chaptarr', '123', 'Behind The Scenes', 'Cheryl Fergison', 'book', '239822717', '999999', ?)
    `).run(sharedPath);
    db.prepare(`
      INSERT INTO book_sources (
        source_type, external_id, title, author, source_media_type,
        grimmory_goodreads_id, grimmory_primary_file_path
      ) VALUES ('grimmory', '456', 'Behind The Scenes', 'Cheryl Fergison', 'book', '243192893', ?)
    `).run(sharedPath);
    // Chaptarr's stale Hardcover ID must not pull this unrelated book into the bridge.
    db.prepare(`
      INSERT INTO book_sources (source_type, external_id, title, author, source_media_type, source_hardcover_book_id)
      VALUES ('hardcover', '999999', 'A Different Book', 'Different Author', 'book', '999999')
    `).run();

    reconcileBookIdentities(db);

    const sources = db.prepare("SELECT source_type, book_id FROM book_sources ORDER BY id").all() as { source_type: string; book_id: number }[];
    assert.equal(sources[0]!.book_id, sources[1]!.book_id, "Goodreads and Chaptarr should share a canonical book");
    assert.equal(sources[1]!.book_id, sources[2]!.book_id, "the corroborating Grimmory file path should join the same book");
    assert.notEqual(sources[2]!.book_id, sources[3]!.book_id, "a stale Chaptarr Hardcover ID must not merge an unrelated book");
    assert.equal(booksByTitle(db).length, 2);
  } finally {
    cleanup();
  }
});

test("reconcileBookIdentities keeps ebook and audiobook Chaptarr file-path matches in their own canonicals", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const ebookBookId = Number(db.prepare("INSERT INTO books (media_type, title) VALUES ('book', 'Dungeon Crawler Carl')").run().lastInsertRowid);
    const audiobookBookId = Number(db.prepare("INSERT INTO books (media_type, title) VALUES ('audiobook', 'Dungeon Crawler Carl')").run().lastInsertRowid);
    const ebookPath = "/books/Dungeon Crawler Carl.epub";
    const audiobookPath = "/audiobooks/Dungeon Crawler Carl.m4b";

    const insertAssignedSource = db.prepare(`
      INSERT INTO book_sources (book_id, source_type, external_id, title, author, source_media_type, grimmory_primary_file_path, chaptarr_primary_file_path)
      VALUES (?, ?, ?, 'Dungeon Crawler Carl', 'Matt Dinniman', ?, ?, ?)
    `);
    insertAssignedSource.run(ebookBookId, "grimmory", "gr-ebook", "ebook", ebookPath, null);
    insertAssignedSource.run(ebookBookId, "chaptarr", "chap-ebook", "ebook", null, ebookPath);
    insertAssignedSource.run(audiobookBookId, "grimmory", "gr-audio", "audiobook", audiobookPath, null);
    // Simulates the stale assignment seen in production: the audio Chaptarr row is
    // currently attached to the ebook canonical despite an exact .m4b match.
    insertAssignedSource.run(ebookBookId, "chaptarr", "chap-audio", "audiobook", null, audiobookPath);

    reconcileBookIdentities(db);

    const sources = db.prepare("SELECT external_id, book_id FROM book_sources ORDER BY external_id").all() as { external_id: string; book_id: number }[];
    const byExternalId = new Map(sources.map((row) => [row.external_id, row.book_id]));
    assert.equal(byExternalId.get("gr-ebook"), ebookBookId);
    assert.equal(byExternalId.get("chap-ebook"), ebookBookId);
    assert.equal(byExternalId.get("gr-audio"), audiobookBookId);
    assert.equal(byExternalId.get("chap-audio"), audiobookBookId);
    assert.equal(booksByTitle(db).length, 2, "ebook and audiobook canonicals must remain separate");
  } finally {
    cleanup();
  }
});

test("reconcileBookIdentities does not bridge one Chaptarr path across Grimmory profiles", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const firstProfile = seedProfile(db, "First");
    const secondProfile = seedProfile(db, "Second");
    const firstBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('First book')").run().lastInsertRowid);
    const secondBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Second book')").run().lastInsertRowid);
    const path = "/library/shared-path.epub";
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, author, source_media_type, chaptarr_primary_file_path) VALUES (?, 'chaptarr', 0, 'chap', 'First book', 'Author', 'book', ?)").run(firstBookId, path);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, author, source_media_type, grimmory_primary_file_path) VALUES (?, 'grimmory', ?, '1', 'First book', 'Author', 'book', ?)").run(firstBookId, firstProfile, path);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, author, source_media_type, grimmory_primary_file_path) VALUES (?, 'grimmory', ?, '1', 'Second book', 'Other author', 'book', ?)").run(secondBookId, secondProfile, path);

    reconcileBookIdentities(db);

    const secondGrimmory = db.prepare("SELECT book_id FROM book_sources WHERE source_type = 'grimmory' AND source_instance_id = ?").get(secondProfile) as { book_id: number };
    assert.equal(secondGrimmory.book_id, secondBookId);
  } finally {
    cleanup();
  }
});

test("reconcileBookIdentities does not use a Goodreads bridge across colliding Grimmory profiles", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const firstProfile = seedProfile(db, "First");
    const secondProfile = seedProfile(db, "Second");
    const firstBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('First book')").run().lastInsertRowid);
    const secondBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Second book')").run().lastInsertRowid);
    const path = "/library/colliding-path.epub";
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type) VALUES (?, 'goodreads', ?, 'edition', 'First book', 'book')").run(firstBookId, firstProfile);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, source_goodreads_edition_id, chaptarr_primary_file_path) VALUES (?, 'chaptarr', 0, 'chap', 'First book', 'book', 'edition', ?)").run(firstBookId, path);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, grimmory_primary_file_path) VALUES (?, 'grimmory', ?, '1', 'First book', 'book', ?)").run(firstBookId, firstProfile, path);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, grimmory_primary_file_path) VALUES (?, 'grimmory', ?, '1', 'Second book', 'book', ?)").run(secondBookId, secondProfile, path);

    reconcileBookIdentities(db);

    const secondGrimmory = db.prepare("SELECT book_id FROM book_sources WHERE source_type = 'grimmory' AND source_instance_id = ?").get(secondProfile) as { book_id: number };
    assert.equal(secondGrimmory.book_id, secondBookId);
  } finally {
    cleanup();
  }
});

test("reconcileBookIdentities moves state before deleting a reassigned Chaptarr-only book", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const firstProfile = seedProfile(db, "First");
    const secondProfile = seedProfile(db, "Second");
    const oldBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Old Chaptarr record')").run().lastInsertRowid);
    const targetBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Canonical record')").run().lastInsertRowid);
    const otherProfileBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Other profile record')").run().lastInsertRowid);
    const path = "/library/reassigned-path.epub";
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, author, source_media_type, grimmory_primary_file_path) VALUES (?, 'grimmory', ?, '10', 'Canonical record', 'Author', 'book', ?)").run(targetBookId, firstProfile, path);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, author, source_media_type, grimmory_primary_file_path) VALUES (?, 'grimmory', ?, '10', 'Other profile record', 'Other author', 'book', ?)").run(otherProfileBookId, secondProfile, path);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, author, source_media_type, chaptarr_primary_file_path) VALUES (?, 'chaptarr', 0, 'chap', 'Old Chaptarr record', 'Author', 'book', ?)").run(oldBookId, path);
    db.prepare("INSERT INTO user_book_states (book_id, profile_id, source_type, progress) VALUES (?, ?, 'grimmory', 42)").run(oldBookId, firstProfile);

    reconcileBookIdentities(db);

    const state = db.prepare("SELECT book_id, progress FROM user_book_states WHERE profile_id = ? AND source_type = 'grimmory'").get(firstProfile) as { book_id: number; progress: number };
    assert.equal(state.book_id, targetBookId);
    assert.equal(state.progress, 42);
    assert.equal(db.prepare("SELECT 1 FROM books WHERE id = ?").get(oldBookId), undefined);
  } finally {
    cleanup();
  }
});

test("reconcileBookIdentities bridges a Goodreads ISBN despite a stale Grimmory Goodreads ID when the local path corroborates it", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const path = "/books/Jennifer Hillier/Freak.epub";
    db.prepare(`
      INSERT INTO book_sources (source_type, external_id, title, author, isbn10, source_media_type)
      VALUES ('goodreads', 'current-edition', 'Freak', 'Jennifer Hillier', '0143107275', 'book')
    `).run();
    db.prepare(`
      INSERT INTO book_sources (source_type, external_id, title, author, source_media_type, source_goodreads_edition_id, chaptarr_primary_file_path)
      VALUES ('chaptarr', 'chaptarr-freak', 'Freak', 'Jennifer Hillier', 'book', 'old-edition', ?)
    `).run(path);
    db.prepare(`
      INSERT INTO book_sources (source_type, external_id, title, author, isbn10, source_media_type, grimmory_goodreads_id, grimmory_primary_file_path)
      VALUES ('grimmory', 'grimmory-freak', 'Freak', 'Laird Barron', '0143107275', 'book', 'old-edition', ?)
    `).run(path);

    reconcileBookIdentities(db);

    const sourceBookIds = db.prepare("SELECT book_id FROM book_sources ORDER BY id").all() as { book_id: number }[];
    assert.equal(new Set(sourceBookIds.map((row) => row.book_id)).size, 1, "the ISBN must bridge the Goodreads row despite the stale Grimmory ID when the local path corroborates it");
  } finally {
    cleanup();
  }
});
