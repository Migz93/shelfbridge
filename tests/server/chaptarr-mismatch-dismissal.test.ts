import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The Books route reads the db/index.ts singleton. Use an isolated data
// directory so this test exercises the actual dismissal endpoint and list
// query rather than reimplementing its JOIN locally.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "shelfbridge-chaptarr-dismissal-test-"));
process.env["DATA_DIR"] = dataDir;

const booksRouter = (await import("../../src/server/routes/books.js")).default;
const { getDb } = await import("../../src/server/db/index.js");
const { seedProfile } = await import("./test-helpers.js");

const db = getDb();

test.after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(booksRouter);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function fixChaptarrIdCount(baseUrl: string): Promise<number> {
  const response = await fetch(`${baseUrl}/?action=fix-chaptarr-id`);
  assert.equal(response.status, 200);
  const body = await response.json() as { facets: { fixChaptarrIdCount: number } };
  return body.facets.fixChaptarrIdCount;
}

test("a Chaptarr ID mismatch dismissal re-arms once the observed mismatch changes", async () => {
  const profileId = seedProfile(db);
  const bookId = Number(db.prepare("INSERT INTO books (title, media_type) VALUES ('Book', 'book')").run().lastInsertRowid);
  db.prepare("INSERT INTO user_book_states (book_id, profile_id, source_type, status) VALUES (?, ?, 'grimmory', 'UNREAD')")
    .run(bookId, profileId);
  db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title) VALUES (?, 'grimmory', ?, 'grim-1', 'Book')")
    .run(bookId, profileId);
  db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, chaptarr_id_mismatch, source_hardcover_book_id)
    VALUES (?, 'chaptarr', 0, 'chap-1', 'Book', 1, 'hc-old')
  `).run(bookId);

  await withServer(async (baseUrl) => {
    assert.equal(await fixChaptarrIdCount(baseUrl), 1, "the original mismatch must be actionable");

    const dismiss = await fetch(`${baseUrl}/${bookId}/chaptarr-id-mismatch/dismiss`, { method: "POST" });
    assert.equal(dismiss.status, 200);
    assert.equal(await fixChaptarrIdCount(baseUrl), 0, "the dismissal should suppress the mismatch it was raised against");

    // A later Chaptarr sync reports a different upstream Hardcover id.
    db.prepare("UPDATE book_sources SET source_hardcover_book_id = 'hc-new' WHERE external_id = 'chap-1'").run();
    assert.equal(await fixChaptarrIdCount(baseUrl), 1, "a changed upstream id must re-arm the mismatch instead of staying silently dismissed");
  });
});
