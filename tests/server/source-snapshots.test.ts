import assert from "node:assert/strict";
import test from "node:test";
import { fetchSourceSnapshots, type SnapshotContext } from "../../src/server/sync/source-snapshots.js";
import { syncAudiobookshelfLibrary } from "../../src/server/sync/audiobookshelf-phase.js";
import { createTestDatabase } from "./test-db.js";
import { createFakeAdapters, seedProfile } from "./test-helpers.js";
import type { SyncAdapters } from "../../src/server/sync/adapters.js";

function context(
  db: ReturnType<typeof createTestDatabase>["db"],
  profileId: number,
  overrides: Partial<Omit<SnapshotContext, "adapters">> & { adapters?: Partial<SnapshotContext["adapters"]> } = {}
): SnapshotContext {
  const { adapters, ...rest } = overrides;
  return {
    db, profileId, runId: 1, profile: {}, counters: { sourceFailures: 0 }, recordEvent: () => {},
    hasHardcover: false, hardcoverToken: "", baseUrl: "", username: null, password: null, hasGrimmory: false,
    ...rest,
    adapters: createFakeAdapters(adapters ?? {})
  };
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
      db.prepare("INSERT INTO user_book_states (book_id, profile_id, source_type, progress) VALUES (?, ?, 'audiobookshelf', 10)").run(bookId, profileId);
    }
    const result = await fetchSourceSnapshots(context(db, first));
    assert.deepEqual([...result.absOwnedBookIds], [firstBook]);
    assert.deepEqual([...result.absOwnedHardcoverBookIds], ["101"]);
  } finally { cleanup(); }
});

test("a runtime-validated ABS link with no listening activity does not claim ownership", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const bookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Unstarted audio')").run().lastInsertRowid);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, audiobookshelf_runtime_validated) VALUES (?, 'audiobookshelf', ?, 'abs-1', 1)").run(bookId, profileId);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, source_media_type, grimmory_hardcover_book_id) VALUES (?, 'grimmory', ?, 'g-1', 'audiobook', '303')").run(bookId, profileId);
    const result = await fetchSourceSnapshots(context(db, profileId));
    assert.deepEqual([...result.absOwnedBookIds], []);
    assert.deepEqual([...result.absOwnedHardcoverBookIds], []);
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
    const result = await fetchSourceSnapshots(context(db, profileId, { hasHardcover: true, hardcoverToken: "token", adapters }));
    assert.equal(result.hcEditions.get(10)?.pages, 100);
    assert.equal(result.hcEditions.get(20)?.pages, 200);
  } finally { cleanup(); }
});

test("a selected Hardcover list produces a partial snapshot", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const book = { id: 1, title: "Selected", slug: null, image: null, contributions: null, default_physical_edition: null, default_ebook_edition: null, default_audio_edition: null, book_series: null };
    const libraryBook = { id: 1, edition_id: null, status_id: null, rating: null, updated_at: null, first_started_reading_date: null, last_read_date: null, book, user_book_reads: null };
    const adapters = {
      fetchHardcoverUserId: async () => 1,
      fetchHardcoverLibrary: async () => [libraryBook],
      fetchHardcoverLists: async () => [{ id: 7, name: "Selected", slug: null, bookIds: [1], books: [book], entries: [] }],
      fetchHardcoverEditions: async () => new Map()
    };
    const result = await fetchSourceSnapshots(context(db, profileId, {
      profile: { hardcover_sync_list_id: "7", hardcover_sync_list_name: "Selected" },
      hasHardcover: true, hardcoverToken: "token", adapters
    }));
    assert.equal(result.hardcoverSnapshotStatus, "partial");
  } finally { cleanup(); }
});

test("ABS ownership snapshot batches a large audiobook library", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const insert = db.transaction(() => {
      for (let id = 1; id <= 500; id++) {
        const bookId = Number(db.prepare("INSERT INTO books (title) VALUES (?)").run(`Audio ${id}`).lastInsertRowid);
        db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, audiobookshelf_runtime_validated) VALUES (?, 'audiobookshelf', ?, ?, 1)").run(bookId, profileId, `abs-${id}`);
        db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, source_media_type, grimmory_hardcover_book_id) VALUES (?, 'grimmory', ?, ?, 'audiobook', ?)").run(bookId, profileId, `grim-${id}`, String(id));
        db.prepare("INSERT INTO user_book_states (book_id, profile_id, source_type, progress) VALUES (?, ?, 'audiobookshelf', 10)").run(bookId, profileId);
      }
    });
    insert();

    const result = await fetchSourceSnapshots(context(db, profileId));
    assert.equal(result.absOwnedHardcoverBookIds.size, 500);
  } finally { cleanup(); }
});

test("an ABS item linked to Grimmory is runtime-validated without Hardcover", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const bookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Audio')").run().lastInsertRowid);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, source_media_type, grimmory_primary_file_path) VALUES (?, 'grimmory', ?, 'grim-1', 'audiobook', '/library/audio.m4b')").run(bookId, profileId);
    const adapters: Partial<SyncAdapters> = {
      fetchAudiobookshelfLibraries: async () => [{ id: "library", name: "Books", mediaType: "book" }],
      fetchAudiobookshelfLibraryItems: async () => [{
        id: "abs-1", ino: "1", libraryId: "library", mediaType: "book", path: "/library/audio.m4b",
        media: { metadata: { title: "Audio", authorName: null, seriesName: null, asin: null, isbn: null, duration: 3600 }, duration: 3600 }
      }]
    };
    await syncAudiobookshelfLibrary({ db, profileId, runId: 1, hasAbs: true, absBaseUrl: "https://abs.example", absApiKey: "key", adapters: createFakeAdapters(adapters), counters: { sourceFailures: 0 }, recordEvent: () => {} });
    const row = db.prepare("SELECT book_id, audiobookshelf_runtime_validated FROM book_sources WHERE source_type = 'audiobookshelf' AND source_instance_id = ?").get(profileId) as { book_id: number; audiobookshelf_runtime_validated: number };
    assert.equal(row.book_id, bookId);
    assert.equal(row.audiobookshelf_runtime_validated, 1);
  } finally { cleanup(); }
});
