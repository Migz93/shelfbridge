import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// cacheSourceCover/cacheGrimmoryCover (covers.ts) and ensureCoverCached/
// getCachedCoverPath (image-cache.ts) all operate on the db/index.ts
// singleton via getDb(), not a db instance a test can pass in directly —
// point DATA_DIR at a private temp dir before the first import, matching
// books-detail-route.test.ts.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "shelfbridge-covers-reconcile-test-"));
process.env["DATA_DIR"] = dataDir;

const { getDb } = await import("../../src/server/db/index.js");
const { cacheSourceCover } = await import("../../src/server/sync/covers.js");
const { storeFetchedCover } = await import("../../src/server/image-cache.js");
const { reconcileBookIdentities } = await import("../../src/server/db/bookIdentity.js");
const { logger } = await import("../../src/server/logger.js");

const db = getDb();
const cacheDir = path.join(dataDir, "image-cache");
mkdirSync(cacheDir, { recursive: true });

test.after(async () => {
  await new Promise<void>((resolve) => {
    logger.once("finish", resolve);
    logger.end();
  });
  logger.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("a cover finishing to cache after Phase D's own reconcile still propagates to the canonical book, not just book_sources", async () => {
  const bookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Cover Test Book')").run().lastInsertRowid);
  const hcSourceId = Number(db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type)
    VALUES (?, 'hardcover', 1, '555', 'Cover Test Book', 'book')
  `).run(bookId).lastInsertRowid);

  // Simulates Phase D's own reconcile having already run before the cover
  // finished caching — books.cover_cache_path starts out null.
  reconcileBookIdentities(db);
  const before = db.prepare("SELECT cover_cache_path FROM books WHERE id = ?").get(bookId) as { cover_cache_path: string | null };
  assert.equal(before.cover_cache_path, null);

  // Pre-seed a fresh, on-disk cache entry so ensureCoverCached takes its
  // cache-hit path and returns immediately — no real network fetch — exactly
  // like a background cover task finding the cover already cached.
  const localFilePath = path.join(cacheDir, `${hcSourceId}.jpg`);
  writeFileSync(localFilePath, Buffer.from([0xff, 0xd8, 0xff]));
  const localWebPath = `/image-cache/${hcSourceId}.jpg`;
  db.prepare(`
    INSERT INTO image_cache (cache_key, entity_id, source_url, local_file_path, local_web_path, cached_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(`cover:${hcSourceId}`, String(hcSourceId), "https://example.com/cover.jpg", localFilePath, localWebPath);

  // This is what a background cover-cache worker does once its task
  // completes — entirely decoupled from any sync's own reconcile phases.
  await cacheSourceCover(db, hcSourceId, "hardcover", "https://example.com/cover.jpg");

  const sourceRow = db.prepare("SELECT cover_cache_path FROM book_sources WHERE id = ?").get(hcSourceId) as { cover_cache_path: string | null };
  assert.equal(sourceRow.cover_cache_path, localWebPath, "the source row itself must have the cached path");

  const after = db.prepare("SELECT cover_cache_path FROM books WHERE id = ?").get(bookId) as { cover_cache_path: string | null };
  assert.equal(after.cover_cache_path, localWebPath, "the canonical book's cover must be updated as soon as the cover finishes caching, not left stale until the next unrelated reconcile");
});

test("a replaced Grimmory cover retains its old file until path propagation succeeds", () => {
  const sourceId = 9876;
  const oldFilePath = path.join(cacheDir, "old-grimmory-cover.jpg");
  writeFileSync(oldFilePath, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  db.prepare(`
    INSERT INTO image_cache (cache_key, entity_id, local_file_path, local_web_path, cached_at, last_refresh_at)
    VALUES (?, ?, ?, ?, datetime('now', '-8 days'), datetime('now', '-8 days'))
  `).run(`cover:${sourceId}`, String(sourceId), oldFilePath, "/images/old-grimmory-cover.jpg");

  const stored = storeFetchedCover(sourceId, Buffer.from([0xff, 0xd8, 0xff, 0x01]));
  assert.ok(stored);
  assert.equal(stored.previousFilePath, oldFilePath);
  assert.ok(existsSync(oldFilePath), "the old file must remain available until the caller commits path propagation");
});
