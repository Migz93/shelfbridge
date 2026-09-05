import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// GET /api/books/:id and the merge/duplicate endpoints go through fetchRows(),
// which operates on the db/index.ts singleton (getDb()) rather than a db
// instance the test can pass in directly — point DATA_DIR at a private temp
// dir before the first import of the singleton, matching sync-engine.test.ts.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "shelfbridge-books-route-test-"));
process.env["DATA_DIR"] = dataDir;

const booksRouter = (await import("../../src/server/routes/books.js")).default;
const { getDb } = await import("../../src/server/db/index.js");
const { seedProfile } = await import("./test-helpers.js");
const { probableDuplicateTitleKey, probableDuplicateAuthorKey } = await import("../../src/server/db/duplicateKeys.js");

const db = getDb();

test.after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// duplicate_title_key/duplicate_author_key are normally populated by
// bookIdentity.ts's insertBook/updateBook whenever a books row is created —
// this test inserts rows directly, bypassing that path, so it must populate
// them itself to keep the same invariant real book rows always have.
function insertBook(title: string, author: string): number {
  return Number(db.prepare(`
    INSERT INTO books (title, author, duplicate_title_key, duplicate_author_key)
    VALUES (?, ?, ?, ?)
  `).run(title, author, probableDuplicateTitleKey(title), probableDuplicateAuthorKey(author)).lastInsertRowid);
}

function insertGrimmorySource(bookId: number, profileId: number, externalId: string): void {
  db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id)
    VALUES (?, 'grimmory', ?, ?)
  `).run(bookId, profileId, externalId);
}

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

test("GET /api/books/:id scopes fetchRows to the requested book and its duplicate candidates, not the whole catalog", async () => {
  const profileId = seedProfile(db);
  const target = insertBook("Dune", "Frank Herbert");
  const duplicate = insertBook("Dune", "Frank Herbert");
  const unrelated = insertBook("Neuromancer", "William Gibson");
  insertGrimmorySource(target, profileId, "100");
  insertGrimmorySource(duplicate, profileId, "101");
  insertGrimmorySource(unrelated, profileId, "102");

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/${target}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { id: number; duplicateCandidates: Array<{ id: number }> };
    assert.equal(body.id, target);
    assert.deepEqual(body.duplicateCandidates.map((c) => c.id), [duplicate]);
  });
});

test("DELETE /api/books/:id cleans up only the deleted book's own image_cache rows, not the whole cache", async () => {
  const profileId = seedProfile(db);
  const target = insertBook("Delete Target", "Delete Author");
  const survivor = insertBook("Delete Survivor", "Delete Author");
  insertGrimmorySource(target, profileId, "300");
  insertGrimmorySource(survivor, profileId, "301");

  const targetSourceId = Number((db.prepare("SELECT id FROM book_sources WHERE book_id = ?").get(target) as { id: number }).id);
  // A leftover image_cache row for a source id that never belonged to any
  // book — proves the scoped cleanup only touches the deleted book's own
  // source ids, not a full-table scan that would also catch this one.
  db.prepare("INSERT INTO image_cache (cache_key, entity_id) VALUES (?, ?)").run("cover:9999", "9999");
  db.prepare("INSERT INTO image_cache (cache_key, entity_id) VALUES (?, ?)").run(`cover:${targetSourceId}`, String(targetSourceId));

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/${target}`, { method: "DELETE" });
    assert.equal(res.status, 200);
  });

  const deletedBook = db.prepare("SELECT id FROM books WHERE id = ?").get(target);
  assert.equal(deletedBook, undefined, "the book must be deleted");

  const targetCacheRow = db.prepare("SELECT id FROM image_cache WHERE entity_id = ?").get(String(targetSourceId));
  assert.equal(targetCacheRow, undefined, "the deleted book's own image_cache row must be cleaned up");

  const unrelatedOrphanRow = db.prepare("SELECT id FROM image_cache WHERE entity_id = ?").get("9999");
  assert.ok(unrelatedOrphanRow, "an unrelated orphaned image_cache row must be left for the full reconcile job, not the scoped DELETE cleanup");

  const survivorBook = db.prepare("SELECT id FROM books WHERE id = ?").get(survivor);
  assert.ok(survivorBook, "an unrelated book must not be affected");
});

test("POST /api/books/:bookId/duplicates/:duplicateId/merge rejects a pair that is not a live probable duplicate", async () => {
  const profileId = seedProfile(db);
  const first = insertBook("Merge First", "Merge Author");
  const second = insertBook("Merge Second", "Merge Author");
  insertGrimmorySource(first, profileId, "200");
  insertGrimmorySource(second, profileId, "201");

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/${first}/duplicates/${second}/merge`, { method: "POST" });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /live probable-duplicate pair/);
  });
});
