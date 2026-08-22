import assert from "node:assert/strict";
import test from "node:test";
import { reconcileBookIdentities, expandScopeToRows } from "../../src/server/db/bookIdentity.js";
import { logger } from "../../src/server/logger.js";
import { createTestDatabase } from "./test-db.js";
import { seedProfile } from "./test-helpers.js";
import { validIsbn13 } from "./fixtures/library-fixture.js";

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
    sourceGoodreadsBookId?: string;
    seriesName?: string;
    seriesNumber?: string;
  }
): number {
  return Number(db.prepare(`
    INSERT INTO book_sources (source_type, external_id, title, author, isbn13, source_media_type, source_hardcover_book_id, source_goodreads_book_id, series_name, series_number)
    VALUES (@sourceType, @externalId, @title, @author, @isbn13, 'book', @sourceHardcoverBookId, @sourceGoodreadsBookId, @seriesName, @seriesNumber)
  `).run({
    sourceType: fields.sourceType,
    externalId: fields.externalId,
    title: fields.title,
    author: fields.author ?? "Author",
    isbn13: fields.isbn13 ?? null,
    sourceHardcoverBookId: fields.sourceHardcoverBookId ?? null,
    sourceGoodreadsBookId: fields.sourceGoodreadsBookId ?? null,
    seriesName: fields.seriesName ?? null,
    seriesNumber: fields.seriesNumber ?? null
  }).lastInsertRowid);
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

test("reconcileBookIdentities merges an ISBN match even when one row's format bucket is unresolved", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    // A Hardcover-only row with no edition_format/media_type data (as happens when
    // Hardcover hasn't resolved a default edition for the book) resolves to the
    // "unknown" format bucket. It must still merge with an existing canonical book
    // via a shared ISBN — ISBN identity should not be gated by format bucket.
    db.prepare(`
      INSERT INTO book_sources (source_type, external_id, title, author, isbn13, source_media_type, source_edition_format)
      VALUES ('hardcover', 'hc-1', 'Dune', 'Frank Herbert', '9780441013593', NULL, NULL)
    `).run();
    db.prepare(`
      INSERT INTO book_sources (source_type, external_id, title, author, isbn13, source_media_type)
      VALUES ('grimmory', 'gr-1', 'Dune', 'Frank Herbert', '9780441013593', 'book')
    `).run();

    reconcileBookIdentities(db);

    const books = booksByTitle(db);
    assert.equal(books.length, 1, "an unresolved-format Hardcover row sharing an ISBN should still merge into the canonical book");

    const sources = db.prepare("SELECT source_type, book_id FROM book_sources").all() as
      { source_type: string; book_id: number }[];
    assert.equal(sources.length, 2);
    for (const source of sources) assert.equal(source.book_id, books[0]!.id);
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

test("reconcileBookIdentities keeps a book and its audiobook sibling separate even when they share an ISBN", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    // A real, observed Grimmory/Hardcover data quirk: an audiobook edition can
    // report the exact same ISBN as its print/ebook counterpart. That must not
    // be treated as evidence they're the same canonical — book vs. audiobook
    // are deliberately kept apart everywhere else in this codebase (bucket-
    // prefixed hardcover_book_id keys, the Owned-list/shared-sibling dual-row
    // mechanism), so a same-ISBN, opposite-bucket pair must stay split.
    const sharedIsbn = "9780000000099";
    db.prepare(`
      INSERT INTO book_sources (source_type, external_id, title, author, isbn13, source_media_type, source_hardcover_book_id)
      VALUES ('grimmory', 'gr-book', 'Same ISBN Both Formats', 'Author', ?, 'ebook', '777')
    `).run(sharedIsbn);
    db.prepare(`
      INSERT INTO book_sources (source_type, external_id, title, author, isbn13, source_media_type, source_hardcover_book_id)
      VALUES ('grimmory', 'gr-audio', 'Same ISBN Both Formats', 'Author', ?, 'audiobook', '777')
    `).run(sharedIsbn);

    reconcileBookIdentities(db);

    const sources = db.prepare("SELECT source_type, external_id, book_id FROM book_sources ORDER BY external_id").all() as
      { source_type: string; external_id: string; book_id: number }[];
    const ebook = sources.find((s) => s.external_id === "gr-book")!;
    const audiobook = sources.find((s) => s.external_id === "gr-audio")!;
    assert.notEqual(ebook.book_id, audiobook.book_id, "a shared ISBN must not re-merge a book and its audiobook sibling");
    assert.equal(booksByTitle(db).length, 2);
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

test("reconcileBookIdentities preserves state when a Chaptarr path is shared across Grimmory profiles", () => {
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
    assert.equal(state.book_id, oldBookId);
    assert.equal(state.progress, 42);
    assert.notEqual(db.prepare("SELECT 1 FROM books WHERE id = ?").get(oldBookId), undefined);
  } finally {
    cleanup();
  }
});

test("reconcileBookIdentities does not reassign Chaptarr by a path shared across Grimmory profiles", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const firstProfile = seedProfile(db, "First");
    const secondProfile = seedProfile(db, "Second");
    const oldBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Chaptarr record')").run().lastInsertRowid);
    const firstBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('First profile record')").run().lastInsertRowid);
    const secondBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Second profile record')").run().lastInsertRowid);
    const path = "/library/shared-reassignment.epub";
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, grimmory_primary_file_path) VALUES (?, 'grimmory', ?, '1', 'First profile record', 'book', ?)").run(firstBookId, firstProfile, path);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, grimmory_primary_file_path) VALUES (?, 'grimmory', ?, '1', 'Second profile record', 'book', ?)").run(secondBookId, secondProfile, path);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, chaptarr_primary_file_path) VALUES (?, 'chaptarr', 0, 'chap', 'Chaptarr record', 'book', ?)").run(oldBookId, path);

    reconcileBookIdentities(db);

    const chaptarr = db.prepare("SELECT book_id FROM book_sources WHERE source_type = 'chaptarr'").get() as { book_id: number };
    assert.equal(chaptarr.book_id, oldBookId);
  } finally {
    cleanup();
  }
});

test("reconcileBookIdentities does not reassign Chaptarr by a path shared across Audiobookshelf profiles", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const firstProfile = seedProfile(db, "First");
    const secondProfile = seedProfile(db, "Second");
    const oldBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Chaptarr record')").run().lastInsertRowid);
    const firstBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('First profile record')").run().lastInsertRowid);
    const secondBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Second profile record')").run().lastInsertRowid);
    const path = "/library/shared-audio-path.m4b";
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, audiobookshelf_file_path) VALUES (?, 'audiobookshelf', ?, '1', 'First profile record', 'audiobook', ?)").run(firstBookId, firstProfile, path);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, audiobookshelf_file_path) VALUES (?, 'audiobookshelf', ?, '1', 'Second profile record', 'audiobook', ?)").run(secondBookId, secondProfile, path);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, chaptarr_primary_file_path) VALUES (?, 'chaptarr', 0, 'chap', 'Chaptarr record', 'audiobook', ?)").run(oldBookId, path);

    reconcileBookIdentities(db);

    const chaptarr = db.prepare("SELECT book_id FROM book_sources WHERE source_type = 'chaptarr'").get() as { book_id: number };
    assert.equal(chaptarr.book_id, oldBookId);
  } finally { cleanup(); }
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

test("the stale-Grimmory-ID escape hatch does not drag in an unrelated conflicting Hardcover record", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const path = "/books/Jennifer Hillier/Freak.epub";
    db.prepare(`
      INSERT INTO book_sources (source_type, external_id, title, author, isbn10, source_media_type, source_hardcover_book_id)
      VALUES ('goodreads', 'current-edition', 'Freak', 'Jennifer Hillier', '0143107275', 'book', 'hc-111')
    `).run();
    db.prepare(`
      INSERT INTO book_sources (source_type, external_id, title, author, source_media_type, source_goodreads_edition_id, chaptarr_primary_file_path)
      VALUES ('chaptarr', 'chaptarr-freak', 'Freak', 'Jennifer Hillier', 'book', 'old-edition', ?)
    `).run(path);
    db.prepare(`
      INSERT INTO book_sources (source_type, external_id, title, author, isbn10, source_media_type, grimmory_goodreads_id, grimmory_hardcover_id, grimmory_primary_file_path)
      VALUES ('grimmory', 'grimmory-freak', 'Freak', 'Laird Barron', '0143107275', 'book', 'old-edition', 'freak-hc', ?)
    `).run(path);
    // Shares only the Hardcover slug with the Grimmory row (so it still joins
    // that cluster before the ISBN pass), but carries its own conflicting
    // Hardcover book id — independent evidence the stale-Goodreads-ID escape
    // hatch must not paper over just because the Goodreads/Grimmory pair
    // itself is corroborated.
    db.prepare(`
      INSERT INTO book_sources (source_type, external_id, title, hardcover_slug, source_media_type)
      VALUES ('hardcover', 'hc-999', 'Freak', 'freak-hc', 'book')
    `).run();

    reconcileBookIdentities(db);

    const rows = db.prepare("SELECT source_type, book_id FROM book_sources ORDER BY id").all() as { source_type: string; book_id: number }[];
    const goodreadsBookId = rows.find((r) => r.source_type === "goodreads")!.book_id;
    const hardcoverBookId = rows.find((r) => r.source_type === "hardcover")!.book_id;
    assert.notEqual(goodreadsBookId, hardcoverBookId, "the unrelated Hardcover conflict must keep it out of the merged canonical");
  } finally {
    cleanup();
  }
});

test("reconcileBookIdentities aggregates many ambiguous Chaptarr file-path skips into a single bounded warning", () => {
  const { db, cleanup } = createTestDatabase();
  const originalWarn = logger.warn.bind(logger);
  const warnCalls: Array<{ message: string; meta?: unknown }> = [];
  (logger as unknown as { warn: typeof logger.warn }).warn = ((message: string, meta?: unknown) => {
    warnCalls.push({ message, meta });
  }) as typeof logger.warn;
  try {
    const firstProfile = seedProfile(db, "First");
    const secondProfile = seedProfile(db, "Second");
    const ambiguousGroupCount = 8;
    const sampleLimit = 5;
    const chaptarrExternalIds: string[] = [];
    const originalChaptarrBookIds = new Map<string, number>();

    for (let i = 0; i < ambiguousGroupCount; i++) {
      const path = `/library/ambiguous-${i}.epub`;
      const firstBookId = Number(db.prepare("INSERT INTO books (title) VALUES (?)").run(`First ${i}`).lastInsertRowid);
      const secondBookId = Number(db.prepare("INSERT INTO books (title) VALUES (?)").run(`Second ${i}`).lastInsertRowid);
      const chaptarrBookId = Number(db.prepare("INSERT INTO books (title) VALUES (?)").run(`Chaptarr ${i}`).lastInsertRowid);
      db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, grimmory_primary_file_path) VALUES (?, 'grimmory', ?, ?, ?, 'book', ?)")
        .run(firstBookId, firstProfile, `first-${i}`, `First ${i}`, path);
      db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, grimmory_primary_file_path) VALUES (?, 'grimmory', ?, ?, ?, 'book', ?)")
        .run(secondBookId, secondProfile, `second-${i}`, `Second ${i}`, path);
      const chaptarrExternalId = `chap-${i}`;
      db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, chaptarr_primary_file_path) VALUES (?, 'chaptarr', 0, ?, ?, 'book', ?)")
        .run(chaptarrBookId, chaptarrExternalId, `Chaptarr ${i}`, path);
      chaptarrExternalIds.push(chaptarrExternalId);
      originalChaptarrBookIds.set(chaptarrExternalId, chaptarrBookId);
    }

    reconcileBookIdentities(db);

    const aggregatedWarnCalls = warnCalls.filter((call) => call.message === "Skipped Chaptarr file-path reassignment across scoped source profiles");
    assert.equal(aggregatedWarnCalls.length, 1, "a sync with many ambiguous paths must produce exactly one aggregated warning, not one per group");

    const meta = aggregatedWarnCalls[0]?.meta as { skippedGroups: number; sample: Array<{ path: string; instanceIds: Array<number | null> }> };
    assert.equal(meta.skippedGroups, ambiguousGroupCount);
    assert.ok(meta.sample.length > 0, "the warning must include a sample of affected paths");
    assert.ok(meta.sample.length <= sampleLimit, `the sample must be bounded to ${sampleLimit} entries, not one per skipped group`);
    for (const entry of meta.sample) {
      assert.ok(entry.path.startsWith("/library/ambiguous-"), "each sample entry must reference one of the ambiguous paths");
      assert.deepEqual(new Set(entry.instanceIds), new Set([firstProfile, secondProfile]), "each sample entry must identify the two colliding scoped profile instances");
    }

    for (const externalId of chaptarrExternalIds) {
      const chaptarrRow = db.prepare("SELECT book_id FROM book_sources WHERE source_type = 'chaptarr' AND external_id = ?").get(externalId) as { book_id: number };
      assert.equal(chaptarrRow.book_id, originalChaptarrBookIds.get(externalId), `Chaptarr row ${externalId} must keep its original canonical book, not the ambiguous cross-profile one`);
    }
  } finally {
    (logger as unknown as { warn: typeof logger.warn }).warn = originalWarn;
    cleanup();
  }
});

test("reconcileBookIdentities does not let a single crossing path fill the aggregated warning's sample with duplicates", () => {
  const { db, cleanup } = createTestDatabase();
  const originalWarn = logger.warn.bind(logger);
  const warnCalls: Array<{ message: string; meta?: unknown }> = [];
  (logger as unknown as { warn: typeof logger.warn }).warn = ((message: string, meta?: unknown) => {
    warnCalls.push({ message, meta });
  }) as typeof logger.warn;
  try {
    const firstProfile = seedProfile(db, "First");
    const secondProfile = seedProfile(db, "Second");
    const path = "/library/duplicated-within-group.epub";
    // Inserted before the Grimmory rows so the reconciler's file-path union-find
    // pass picks one of these as the pivot for this path: the two Chaptarr rows
    // (matching title/author, no conflicting IDs) merge into a single group, while
    // the pivot's pairing with each ambiguous Grimmory row is independently
    // skipped. The group's file-path keys then contain this crossing path twice
    // before deduplication.
    db.prepare("INSERT INTO book_sources (source_type, external_id, title, author, source_media_type, chaptarr_primary_file_path) VALUES ('chaptarr', 'chap-1', 'Duplicated', 'Author', 'book', ?)").run(path);
    db.prepare("INSERT INTO book_sources (source_type, external_id, title, author, source_media_type, chaptarr_primary_file_path) VALUES ('chaptarr', 'chap-2', 'Duplicated', 'Author', 'book', ?)").run(path);
    const firstBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('First')").run().lastInsertRowid);
    const secondBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Second')").run().lastInsertRowid);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, grimmory_primary_file_path) VALUES (?, 'grimmory', ?, '1', 'First', 'book', ?)").run(firstBookId, firstProfile, path);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, grimmory_primary_file_path) VALUES (?, 'grimmory', ?, '1', 'Second', 'book', ?)").run(secondBookId, secondProfile, path);

    reconcileBookIdentities(db);

    const aggregatedWarnCalls = warnCalls.filter((call) => call.message === "Skipped Chaptarr file-path reassignment across scoped source profiles");
    assert.equal(aggregatedWarnCalls.length, 1);

    const meta = aggregatedWarnCalls[0]?.meta as { skippedGroups: number; sample: Array<{ path: string; instanceIds: unknown[] }> };
    assert.equal(meta.skippedGroups, 1);
    const samplesForPath = meta.sample.filter((entry) => entry.path === path);
    assert.equal(samplesForPath.length, 1, "a path shared by two rows within the same skipped group must appear once in the sample, not once per row");
  } finally {
    (logger as unknown as { warn: typeof logger.warn }).warn = originalWarn;
    cleanup();
  }
});

test("scoped reconcileBookIdentities merges a newly-scoped source into an existing, unrelated-looking book via a shared ISBN", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    // Establish an existing canonical book from a prior (unscoped) reconcile —
    // this is the "unrelated-looking" existing catalog the scoped call must
    // still be able to find and merge into, without scanning it.
    insertSource(db, { sourceType: "hardcover", externalId: "hc-1", title: "Dune", isbn13: "9780441013593" });
    reconcileBookIdentities(db);
    const existingBooks = booksByTitle(db);
    assert.equal(existingBooks.length, 1);
    const existingBookId = existingBooks[0]!.id;

    // A fresh sync discovers a Grimmory row sharing that ISBN. Only this new
    // source id is in scope — the scoped call must still find and merge into
    // the existing book via the shared ISBN key, not create a duplicate.
    const newSourceId = insertSource(db, { sourceType: "grimmory", externalId: "gr-1", title: "Dune", isbn13: "9780441013593" });
    reconcileBookIdentities(db, { sourceIds: [newSourceId] });

    const booksAfter = booksByTitle(db);
    assert.equal(booksAfter.length, 1, "scoped reconcile must merge the new source into the existing book, not create a duplicate");
    assert.equal(booksAfter[0]!.id, existingBookId);
    const newSourceRow = db.prepare("SELECT book_id FROM book_sources WHERE id = ?").get(newSourceId) as { book_id: number };
    assert.equal(newSourceRow.book_id, existingBookId);
  } finally {
    cleanup();
  }
});

test("scoped reconcileBookIdentities bridges two previously-separate existing books when a new source shares a key with each", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    insertSource(db, { sourceType: "hardcover", externalId: "hc-1", title: "Book A", isbn13: "9780000000019" });
    insertSource(db, { sourceType: "goodreads", externalId: "gr-1", title: "Book B", sourceGoodreadsBookId: "gr-1" });
    reconcileBookIdentities(db);
    const before = booksByTitle(db);
    assert.equal(before.length, 2, "the two books must start out separate");

    // A new Grimmory row corroborates both: it shares Book A's ISBN and also
    // carries Book B's Goodreads id. Discovering this requires pulling in ALL
    // of Book A's and Book B's existing rows (not just the ones with a
    // directly-matching key) so the real merge algorithm has full context.
    const bridgeSourceId = insertSource(db, {
      sourceType: "grimmory", externalId: "gr-bridge", title: "Book A", isbn13: "9780000000019", sourceGoodreadsBookId: "gr-1"
    });
    reconcileBookIdentities(db, { sourceIds: [bridgeSourceId] });

    const after = booksByTitle(db);
    assert.equal(after.length, 1, "scoped reconcile must bridge both existing books through the new corroborating row");
  } finally {
    cleanup();
  }
});

test("scoped reconcileBookIdentities does not touch or merge an unrelated existing book outside the scope", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    insertSource(db, { sourceType: "hardcover", externalId: "hc-1", title: "Book A", isbn13: "9780000000019" });
    insertSource(db, { sourceType: "hardcover", externalId: "hc-2", title: "Book B", isbn13: "9780000000026" });
    reconcileBookIdentities(db);
    const before = db.prepare("SELECT id, title, last_modified_at FROM books ORDER BY id").all() as
      { id: number; title: string; last_modified_at: string }[];
    assert.equal(before.length, 2);
    const bookB = before.find((b) => b.title === "Book B")!;
    // datetime('now') has one-second resolution, so a same-second rewrite
    // would be invisible against bookB's own last_modified_at. Pin a sentinel
    // value that a rewrite would have to overwrite.
    const sentinelTimestamp = "2000-01-01 00:00:00";
    db.prepare("UPDATE books SET last_modified_at = ? WHERE id = ?").run(sentinelTimestamp, bookB.id);

    // Only Book A gets a new, unrelated source. Book B must be left completely
    // alone — both as a correctness guard (no accidental merge) and as proof
    // the scoped pass isn't rewriting rows it has no reason to touch.
    const newSourceId = insertSource(db, { sourceType: "grimmory", externalId: "gr-1", title: "Book A", isbn13: "9780000000019" });
    reconcileBookIdentities(db, { sourceIds: [newSourceId] });

    const after = db.prepare("SELECT id, title, last_modified_at FROM books ORDER BY id").all() as
      { id: number; title: string; last_modified_at: string }[];
    assert.equal(after.length, 2, "unrelated books must not be merged");
    const bookBAfter = after.find((b) => b.id === bookB.id)!;
    assert.equal(bookBAfter.title, bookB.title);
    assert.equal(bookBAfter.last_modified_at, sentinelTimestamp, "an out-of-scope book must not be rewritten");
  } finally {
    cleanup();
  }
});

test("reconcileBookIdentities with an empty scope is a no-op", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    insertSource(db, { sourceType: "hardcover", externalId: "hc-1", title: "Dune", isbn13: "9780441013593" });
    reconcileBookIdentities(db);
    const before = booksByTitle(db);

    reconcileBookIdentities(db, { sourceIds: [] });

    assert.deepEqual(booksByTitle(db), before);
  } finally {
    cleanup();
  }
});

test("scoped reconcileBookIdentities discovers the correct canonical when two existing books legitimately share a key value", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    // book_identity_keys allows only one row per (book_id, key_type, key_value) —
    // not one row per (key_type, key_value) globally — specifically so that two
    // canonicals which share a title/author key but were correctly kept separate
    // (no series overlap here) can each still be found by candidate expansion.
    // Book A is inserted first so its title_author key would be the one to "win"
    // under the old, buggy global-uniqueness constraint.
    insertSource(db, { sourceType: "hardcover", externalId: "hc-a", title: "Same Title", author: "Shared Author" });
    insertSource(db, {
      sourceType: "goodreads", externalId: "gr-b", title: "Same Title", author: "Shared Author",
      seriesName: "Series X", seriesNumber: "2"
    });
    reconcileBookIdentities(db);
    const before = booksByTitle(db);
    assert.equal(before.length, 2, "the two books must start out separate (no series overlap between them)");

    // A new row shares Book B's title/author *and* series — this should merge
    // with B specifically, discoverable only via the shared title_author key
    // (no ISBN or high-confidence id ties it to either book directly).
    const newSourceId = insertSource(db, {
      sourceType: "grimmory", externalId: "gr-new", title: "Same Title", author: "Shared Author",
      seriesName: "Series X", seriesNumber: "2"
    });
    reconcileBookIdentities(db, { sourceIds: [newSourceId] });

    const after = booksByTitle(db);
    assert.equal(after.length, 2, "the new row must merge into Book B, not create a third book because Book B's key was undiscoverable");

    const newSourceRow = db.prepare("SELECT book_id FROM book_sources WHERE id = ?").get(newSourceId) as { book_id: number };
    // The merged-into book must specifically carry the series data — i.e. it's
    // Book B, not Book A and not a spurious third canonical.
    const mergedBook = db.prepare("SELECT series_name FROM books WHERE id = ?").get(newSourceRow.book_id) as { series_name: string | null };
    assert.equal(mergedBook.series_name, "Series X", "the new row must have merged with Book B (the series-bearing book), not Book A");
  } finally {
    cleanup();
  }
});

test("expandScopeToRows returns null (never a partial closure) when a chain needs more hops than the iteration cap allows", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    // Directly constructs already-reconciled DB state (bypassing reconcileBookIdentities,
    // which would just merge the whole chain in one unbounded pass) to exercise
    // expandScopeToRows' own hop-by-hop discovery in isolation. Each Chain Book i has
    // an "entry" row indexed under isbn(i) (so a prior hop's discovered key finds it)
    // and an "exit" row whose own isbn13 column is isbn(i+1) — a key only revealed once
    // this book's full row set is pulled in, forcing genuine multi-iteration discovery.
    const chainLength = 6;
    for (let i = 1; i <= chainLength; i++) {
      const bookId = Number(db.prepare("INSERT INTO books (title) VALUES (?)").run(`Chain Book ${i}`).lastInsertRowid);
      const insertRow = db.prepare(`
        INSERT INTO book_sources (book_id, source_type, external_id, title, author, isbn13, source_media_type)
        VALUES (?, 'hardcover', ?, ?, 'Author', ?, 'book')
      `);
      insertRow.run(bookId, `chain-${i}-entry`, `Chain ${i} Entry`, validIsbn13(i));
      insertRow.run(bookId, `chain-${i}-exit`, `Chain ${i} Exit`, validIsbn13(i + 1));
      db.prepare(`INSERT INTO book_identity_keys (book_id, key_type, key_value) VALUES (?, 'book.isbn13', ?)`)
        .run(bookId, validIsbn13(i));
    }

    const touchedId = Number(db.prepare(`
      INSERT INTO book_sources (source_type, external_id, title, author, isbn13, source_media_type)
      VALUES ('grimmory', 'new-touch', 'New Touch', 'Author', ?, 'book')
    `).run(validIsbn13(1)).lastInsertRowid);

    const withLowCap = expandScopeToRows(db, [touchedId], { iterationCap: 3 });
    assert.equal(withLowCap, null, "a chain longer than the iteration cap must return null, not a truncated closure");

    const withEnoughCap = expandScopeToRows(db, [touchedId], { iterationCap: chainLength + 1 });
    assert.notEqual(withEnoughCap, null, "the same chain must fully resolve given enough iterations");
    assert.equal(withEnoughCap!.length, 1 + chainLength * 2, "a sufficient cap must discover every book in the chain, not stop partway");
  } finally {
    cleanup();
  }
});

test("expandScopeToRows returns null when the final candidate-book fetch would exceed the row cap", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const isbn = validIsbn13(1);
    const bookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Big Book')").run().lastInsertRowid);
    const insertRow = db.prepare(`
      INSERT INTO book_sources (book_id, source_type, external_id, title, author, isbn13, source_media_type)
      VALUES (?, 'hardcover', ?, 'Big Book', 'Author', ?, 'book')
    `);
    for (let i = 0; i < 3; i++) insertRow.run(bookId, `big-${i}`, isbn);
    db.prepare(`INSERT INTO book_identity_keys (book_id, key_type, key_value) VALUES (?, 'book.isbn13', ?)`).run(bookId, isbn);

    const touchedId = Number(db.prepare(`
      INSERT INTO book_sources (source_type, external_id, title, author, isbn13, source_media_type)
      VALUES ('grimmory', 'new-touch', 'Big Book', 'Author', ?, 'book')
    `).run(isbn).lastInsertRowid);

    // The touched row alone (1 row) is under the cap; only the candidate book's
    // full row set (3 more rows), pulled in during the loop, pushes past it.
    // iterationCap: 1 pins this as the loop's only iteration, so there is no
    // next iteration left to catch the overflow the way the original
    // implementation's once-per-iteration check happened to — this must be
    // caught immediately, at that final fetch itself.
    const result = expandScopeToRows(db, [touchedId], { rowCap: 2, iterationCap: 1 });
    assert.equal(result, null, "exceeding the row cap on the final candidate fetch must return null, not a truncated result");
  } finally {
    cleanup();
  }
});
