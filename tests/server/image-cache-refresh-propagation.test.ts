import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// refreshStaleCachedCovers (image-cache.ts) operates on the db/index.ts
// singleton via getDb() — point DATA_DIR at a private temp dir before the
// first import, matching covers-reconcile.test.ts.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "shelfbridge-image-cache-refresh-test-"));
process.env["DATA_DIR"] = dataDir;
const cacheDir = path.join(dataDir, "image-cache");
mkdirSync(cacheDir, { recursive: true });

const { getDb } = await import("../../src/server/db/index.js");
const { refreshStaleCachedCovers } = await import("../../src/server/image-cache.js");
const { setCoverFetchForTesting } = await import("../../src/server/security/outbound.js");
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

test("a background-refreshed public cover propagates its new path to book_sources and the canonical book, not just image_cache", async () => {
  const bookId = Number(db.prepare("INSERT INTO books (title, cover_cache_path) VALUES ('Refresh Propagation Book', '/images/old.jpg')").run().lastInsertRowid);
  const sourceId = Number(db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, cover_cache_path)
    VALUES (?, 'hardcover', 1, '777', 'Refresh Propagation Book', '/images/old.jpg')
  `).run(bookId).lastInsertRowid);

  // Baseline reconcile so the canonical book's cover_cache_path (already
  // seeded above to match, for realism) reflects this single source, the
  // same way an earlier sync's own reconcile pass would have left it.
  const { reconcileBookIdentities } = await import("../../src/server/db/bookIdentity.js");
  reconcileBookIdentities(db);

  const oldFilePath = path.join(cacheDir, "old.jpg");
  writeFileSync(oldFilePath, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  const sourceUrl = "https://covers.example.test/cover.jpg";
  db.prepare(`
    INSERT INTO image_cache (cache_key, entity_id, source_url, local_file_path, local_web_path, cached_at, last_refresh_at)
    VALUES (?, ?, ?, ?, '/images/old.jpg', datetime('now', '-30 days'), datetime('now', '-30 days'))
  `).run(`cover:${sourceId}`, String(sourceId), sourceUrl, oldFilePath);

  const originalLookup = dns.lookup;
  (dns as unknown as { lookup: typeof dns.lookup }).lookup = (async () => [{ address: "8.8.8.8", family: 4 }]) as typeof dns.lookup;
  const restoreCoverFetch = setCoverFetchForTesting((async () => new Response(Buffer.from([0xff, 0xd8, 0xff, 0x11]), {
    status: 200,
    headers: { "content-type": "image/jpeg" }
  })) as never);

  try {
    await refreshStaleCachedCovers();
  } finally {
    (dns as unknown as { lookup: typeof dns.lookup }).lookup = originalLookup;
    restoreCoverFetch();
  }

  const cache = db.prepare("SELECT local_web_path FROM image_cache WHERE cache_key = ?").get(`cover:${sourceId}`) as { local_web_path: string };
  assert.notEqual(cache.local_web_path, "/images/old.jpg", "the cache row itself must have been refreshed");

  const source = db.prepare("SELECT cover_cache_path FROM book_sources WHERE id = ?").get(sourceId) as { cover_cache_path: string };
  assert.equal(source.cover_cache_path, cache.local_web_path, "the source row must be updated to the newly refreshed path, not left pointing at the deleted old file");

  const book = db.prepare("SELECT cover_cache_path FROM books WHERE id = ?").get(bookId) as { cover_cache_path: string };
  assert.equal(book.cover_cache_path, cache.local_web_path, "the canonical book's cover must be updated too, not just book_sources");
});
