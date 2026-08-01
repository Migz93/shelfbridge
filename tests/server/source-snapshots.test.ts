import assert from "node:assert/strict";
import test from "node:test";
import { fetchSourceSnapshots } from "../../src/server/sync/source-snapshots.js";
import { createTestDatabase } from "./test-db.js";
import { seedProfile } from "./test-helpers.js";

function context(db: ReturnType<typeof createTestDatabase>["db"], profileId: number, overrides: Record<string, unknown> = {}) {
  return { db, profileId, runId: 1, profile: {}, adapters: {}, counters: { sourceFailures: 0 }, recordEvent: () => {}, hasHardcover: false, hardcoverToken: "", baseUrl: "", username: null, password: null, hasGrimmory: false, ...overrides };
}

test("ABS ownership snapshots are scoped to the current profile", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const first = seedProfile(db, "First"); const second = seedProfile(db, "Second");
    const firstBook = Number(db.prepare("INSERT INTO books (title) VALUES ('First audio')").run().lastInsertRowid);
    const secondBook = Number(db.prepare("INSERT INTO books (title) VALUES ('Second audio')").run().lastInsertRowid);
    for (const [bookId, profileId, externalId, hardcoverId] of [[firstBook, first, "first", "101"], [secondBook, second, "second", "202"]] as const) {
      db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, audiobookshelf_runtime_validated) VALUES (?, 'audiobookshelf', ?, ?, 1)").run(bookId, profileId, externalId);
      db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, source_media_type, grimmory_hardcover_book_id) VALUES (?, 'grimmory', ?, ?, 'audiobook', ?)").run(bookId, profileId, `g-${externalId}`, hardcoverId);
    }
    const result = await fetchSourceSnapshots(context(db, first) as any);
    assert.deepEqual([...result.absOwnedBookIds], [firstBook]);
    assert.deepEqual([...result.absOwnedHardcoverBookIds], ["101"]);
  } finally { cleanup(); }
});

test("Hardcover detail fetch preserves list-only edition metadata", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const book = (id: number, title: string) => ({ id, title, slug: null, image: null, contributions: null, default_physical_edition: null, default_ebook_edition: null, default_audio_edition: null, book_series: null });
    const listEdition = { id: 10, edition_format: null, isbn_13: null, isbn_10: null, asin: null, pages: 100, audio_seconds: null, image: null };
    const fetchedEdition = { ...listEdition, id: 20, pages: 200 };
    const libraryBook = { id: 1, edition_id: 20, status_id: null, rating: null, updated_at: null, first_started_reading_date: null, last_read_date: null, book: book(1, "Library"), user_book_reads: null };
    const adapters = { fetchHardcoverUserId: async () => 1, fetchHardcoverLibrary: async () => [libraryBook], fetchHardcoverLists: async () => [{ id: 1, name: "List", slug: null, bookIds: [2], books: [book(2, "List only")], entries: [{ book: book(2, "List only"), editionId: 10, edition: listEdition }] }], fetchHardcoverEditions: async () => new Map([[20, fetchedEdition]]) };
    const result = await fetchSourceSnapshots(context(db, profileId, { hasHardcover: true, hardcoverToken: "token", adapters }) as any);
    assert.equal(result.hcEditions.get(10)?.pages, 100);
    assert.equal(result.hcEditions.get(20)?.pages, 200);
  } finally { cleanup(); }
});
