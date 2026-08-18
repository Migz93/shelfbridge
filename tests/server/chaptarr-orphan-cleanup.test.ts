import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// syncChaptarrStatus operates on the db/index.ts singleton (getDb()), not an
// instance a test can pass in directly, and makes real outbound HTTP requests
// via fetchIntegration — point DATA_DIR at a private temp dir before the first
// import of the singleton (matching books-detail-route.test.ts), and run a
// local Express server standing in for Chaptarr.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "shelfbridge-chaptarr-orphan-test-"));
process.env["DATA_DIR"] = dataDir;

const { getDb, setSetting } = await import("../../src/server/db/index.js");
const { syncChaptarrStatus } = await import("../../src/server/sync/chaptarr.js");
const { seedProfile } = await import("./test-helpers.js");
const { logger } = await import("../../src/server/logger.js");

const db = getDb();

test.after(async () => {
  await new Promise<void>((resolve) => {
    logger.once("finish", resolve);
    logger.end();
  });
  logger.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function withFakeChaptarr(
  handlers: { books: unknown[]; authors: unknown[] },
  run: () => Promise<void>
): Promise<void> {
  const app = express();
  app.get("/api/v1/book", (_req, res) => res.json(handlers.books));
  app.get("/api/v1/author", (_req, res) => res.json(handlers.authors));
  app.get("/api/v1/bookfile", (_req, res) => res.json([]));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const address = server.address() as AddressInfo;
    setSetting("chaptarr.baseUrl", `http://127.0.0.1:${address.port}`);
    setSetting("chaptarr.apiKey", "test-key");
    await run();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("syncChaptarrStatus deletes a canonical book left with no sources when its only Chaptarr row disappears", async () => {
  const profileId = seedProfile(db);

  const bookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Chaptarr Only Book')").run().lastInsertRowid);
  db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, chaptarr_monitored, chaptarr_has_file)
    VALUES (?, 'chaptarr', 0, '1', 'Chaptarr Only Book', 'book', 1, 1)
  `).run(bookId);

  // Chaptarr's fetched library is now empty — the book was removed upstream.
  await withFakeChaptarr({ books: [], authors: [] }, async () => {
    await syncChaptarrStatus(profileId);
  });

  const remainingSources = db.prepare("SELECT COUNT(*) AS count FROM book_sources WHERE book_id = ?").get(bookId) as { count: number };
  assert.equal(remainingSources.count, 0, "the stale Chaptarr source must be removed");

  const book = db.prepare("SELECT id FROM books WHERE id = ?").get(bookId);
  assert.equal(book, undefined, "a book left with no sources and no user state after losing its only Chaptarr source must be deleted, not left as a ghost canonical");
});

test("syncChaptarrStatus does not delete a book that still has other sources after losing its Chaptarr row", async () => {
  const profileId = seedProfile(db);

  const bookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Multi-Source Book') ").run().lastInsertRowid);
  db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type)
    VALUES (?, 'hardcover', 1, 'hc-1', 'Multi-Source Book', 'book')
  `).run(bookId);
  db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, chaptarr_monitored, chaptarr_has_file)
    VALUES (?, 'chaptarr', 0, '2', 'Multi-Source Book', 'book', 1, 1)
  `).run(bookId);

  await withFakeChaptarr({ books: [], authors: [] }, async () => {
    await syncChaptarrStatus(profileId);
  });

  const book = db.prepare("SELECT id FROM books WHERE id = ?").get(bookId) as { id: number } | undefined;
  assert.ok(book, "a book with a surviving Hardcover source must not be deleted just because its Chaptarr row went away");
  const remainingChaptarr = db.prepare("SELECT COUNT(*) AS count FROM book_sources WHERE book_id = ? AND source_type = 'chaptarr'").get(bookId) as { count: number };
  assert.equal(remainingChaptarr.count, 0, "the stale Chaptarr source itself must still be removed");
});

test("syncChaptarrStatus reconciles the survivor when a removed Chaptarr row was the only audiobook-format signal", async () => {
  const profileId = seedProfile(db);

  // The Hardcover row carries no format signal of its own (no edition format,
  // no media type) — the book's audiobook classification comes only from the
  // Chaptarr row's .m4b file path. books.media_type starts as 'audiobook',
  // simulating what a prior reconcile computed while the Chaptarr row existed.
  const bookId = Number(db.prepare("INSERT INTO books (title, media_type) VALUES ('Format Book', 'audiobook')").run().lastInsertRowid);
  db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title)
    VALUES (?, 'hardcover', 1, 'hc-3', 'Format Book')
  `).run(bookId);
  db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, chaptarr_monitored, chaptarr_has_file, chaptarr_primary_file_path)
    VALUES (?, 'chaptarr', 0, '3', 'Format Book', 1, 1, '/library/format-book.m4b')
  `).run(bookId);

  await withFakeChaptarr({ books: [], authors: [] }, async () => {
    await syncChaptarrStatus(profileId);
  });

  const book = db.prepare("SELECT media_type FROM books WHERE id = ?").get(bookId) as { media_type: string } | undefined;
  assert.ok(book, "the book must survive — it still has a Hardcover source");
  assert.notEqual(book.media_type, "audiobook", "media_type must be recomputed from the surviving Hardcover row, not left stale from the deleted Chaptarr row's format signal");
});

test("syncChaptarrStatus cleans up the removed source's orphaned image_cache row", async () => {
  const profileId = seedProfile(db);

  const bookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Chaptarr Cached Cover Book')").run().lastInsertRowid);
  const chaptarrSourceId = Number(db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, chaptarr_monitored, chaptarr_has_file)
    VALUES (?, 'chaptarr', 0, '4', 'Chaptarr Cached Cover Book', 'book', 1, 1)
  `).run(bookId).lastInsertRowid);
  // local_file_path left NULL — this test is about the row-level relationship
  // between a removed source and its cache row, not filesystem cleanup.
  db.prepare(`INSERT INTO image_cache (cache_key, entity_id) VALUES (?, ?)`)
    .run(`cover:${chaptarrSourceId}`, String(chaptarrSourceId));

  await withFakeChaptarr({ books: [], authors: [] }, async () => {
    await syncChaptarrStatus(profileId);
  });

  const cacheRow = db.prepare("SELECT id FROM image_cache WHERE entity_id = ?").get(String(chaptarrSourceId));
  assert.equal(cacheRow, undefined, "the removed Chaptarr source's image_cache row must be cleaned up, not left as a ghost referencing a deleted book_sources id");
});
