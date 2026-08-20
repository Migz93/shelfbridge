import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { HardcoverUserBook } from "../../src/server/sync/hardcover.js";
import type { GrimmoryBook } from "../../src/server/sync/grimmory.js";
import {
  createFakeAdapters,
  insertSyncRun,
  seedGrimmoryConnection,
  seedHardcoverConnection,
  seedProfile,
  seedSyncSettings
} from "./test-helpers.js";

// runSyncImpl always operates on the db/index.ts singleton (getDb()), not on a
// db instance passed in by the caller — unlike the DB-layer tests elsewhere in
// this suite, which use test-db.ts's isolated temp-dir database directly. To
// keep this file's runs off the shared ./.test-data database (and off any other
// test file that touches the singleton, e.g. settings.test.ts), point DATA_DIR
// at a private temp dir before the very first import of the singleton module.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "shelfbridge-sync-engine-test-"));
process.env["DATA_DIR"] = dataDir;

// Cover caching (cacheGrimmoryCover / fetchGrimmoryCoverFromPath in engine.ts) calls
// the global fetch() directly — it isn't part of the SyncAdapters seam (see
// TESTING.md's "Known gaps"). It's queued as a fire-and-forget background task
// whenever a synced Grimmory book exists, so every test with a Grimmory fixture
// would otherwise make a real, slow (15s-timeout) network attempt against a
// nonexistent host. Stub it globally for this file so nothing here touches the
// network, regardless of which test triggers the queue.
globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;

const { runSyncImpl, runSync, runExclusiveOfSyncs } = await import("../../src/server/sync/engine.js");
const { getDb } = await import("../../src/server/db/index.js");
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

function hcBook(overrides: Partial<HardcoverUserBook> = {}): HardcoverUserBook {
  return {
    id: 10,
    edition_id: null,
    status_id: 2,
    rating: null,
    updated_at: null,
    first_started_reading_date: null,
    last_read_date: null,
    book: {
      id: 555,
      title: "Integration Test Book",
      slug: "integration-test-book",
      image: null,
      contributions: null,
      default_physical_edition: null,
      default_ebook_edition: null,
      default_audio_edition: null,
      book_series: null
    },
    user_book_reads: null,
    ...overrides
  } as HardcoverUserBook;
}

function grBook(overrides: Partial<GrimmoryBook> = {}): GrimmoryBook {
  // Matches production shape (grimmory.ts always normalizes these with `?? null`,
  // never leaves them undefined), so activity-dependent assertions here exercise
  // the same field shapes hasGrimmoryUserActivity sees in production.
  return {
    id: 1,
    title: "Integration Test Book",
    readStatus: null,
    readProgress: null,
    lastReadTime: null,
    dateFinished: null,
    ...overrides
  };
}

test("a profile with no connections configured completes without touching any Hardcover/Grimmory/Goodreads adapter", async () => {
  const profileId = seedProfile(db);
  const runId = insertSyncRun(db, profileId);
  // Chaptarr is a single global connection, so syncChaptarrStatus runs on every
  // sync regardless of per-profile configuration (see createFakeAdapters) — track
  // it explicitly instead of leaving it an implicit, easy-to-miss exception to
  // this test's name.
  let chaptarrCalls = 0;
  const adapters = createFakeAdapters({
    syncChaptarrStatus: async () => { chaptarrCalls++; return []; }
  });

  await runSyncImpl(profileId, runId, false, adapters);

  const run = db.prepare("SELECT status, changes_written FROM sync_runs WHERE id = ?").get(runId) as
    { status: string; changes_written: number };
  assert.equal(run.status, "success");
  assert.equal(run.changes_written, 0);
  assert.equal(chaptarrCalls, 1, "syncChaptarrStatus is expected to run unconditionally");
});

test("a Hardcover fetch failure aborts the run and is recorded as a source failure", async () => {
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId);
  const runId = insertSyncRun(db, profileId);
  const adapters = createFakeAdapters({
    fetchHardcoverUserId: async () => { throw new Error("Hardcover API is down"); }
  });

  await runSyncImpl(profileId, runId, false, adapters);

  const run = db.prepare("SELECT status FROM sync_runs WHERE id = ?").get(runId) as { status: string };
  assert.equal(run.status, "error");

  const events = db.prepare("SELECT event_type, direction, decision FROM sync_events WHERE sync_run_id = ?").all(runId) as
    { event_type: string; direction: string | null; decision: string | null }[];
  assert.ok(
    events.some((e) => e.event_type === "api_failure" && e.direction === "hardcover" && e.decision === "source_unavailable"),
    `expected a hardcover source_unavailable event, got ${JSON.stringify(events)}`
  );
});

test("a Hardcover-only sync writes book_sources and user_book_states, and re-running is idempotent", async () => {
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId);
  seedSyncSettings(db, profileId);
  const adapters = createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [hcBook()],
    fetchHardcoverLists: async () => []
  });

  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, adapters);

  const sourcesAfterFirst = db.prepare(
    "SELECT external_id, source_instance_id FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ?"
  ).all(profileId) as { external_id: string; source_instance_id: number }[];
  assert.equal(sourcesAfterFirst.length, 1);
  assert.equal(sourcesAfterFirst[0]!.external_id, "555");

  const statesAfterFirst = db.prepare(`
    SELECT COUNT(*) AS count FROM user_book_states
    WHERE source_type = 'hardcover' AND profile_id = ?
  `).get(profileId) as { count: number };
  assert.equal(statesAfterFirst.count, 1);

  db.prepare("UPDATE book_sources SET last_modified_at = '2020-01-01 00:00:00' WHERE source_type = 'hardcover' AND source_instance_id = ?").run(profileId);
  db.prepare("UPDATE books SET last_modified_at = '2020-01-01 00:00:00'").run();
  db.prepare("UPDATE user_book_states SET last_modified_at = '2020-01-01 00:00:00' WHERE source_type = 'hardcover' AND profile_id = ?").run(profileId);

  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, adapters);

  const sourcesAfterSecond = db.prepare(
    "SELECT COUNT(*) AS count FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ?"
  ).get(profileId) as { count: number };
  assert.equal(sourcesAfterSecond.count, 1, "re-syncing the same library must not duplicate book_sources rows");

  const statesAfterSecond = db.prepare(`
    SELECT COUNT(*) AS count FROM user_book_states WHERE source_type = 'hardcover' AND profile_id = ?
  `).get(profileId) as { count: number };
  assert.equal(statesAfterSecond.count, 1, "re-syncing the same library must not duplicate user_book_states rows");

  const timestamps = db.prepare(`
    SELECT
      (SELECT last_modified_at FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ?) AS source_modified_at,
      (SELECT last_modified_at FROM books LIMIT 1) AS book_modified_at,
      (SELECT last_modified_at FROM user_book_states WHERE source_type = 'hardcover' AND profile_id = ?) AS state_modified_at
  `).get(profileId, profileId) as { source_modified_at: string; book_modified_at: string; state_modified_at: string };
  assert.deepEqual(timestamps, {
    source_modified_at: "2020-01-01 00:00:00",
    book_modified_at: "2020-01-01 00:00:00",
    state_modified_at: "2020-01-01 00:00:00"
  }, "an unchanged sync must not make the book appear newly modified");
});

test("Owned-list import is off by default: a disagreeing Owned-list edition is ignored", async () => {
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId);
  seedSyncSettings(db, profileId);
  const book = hcBook({ edition_id: 100 }).book;
  const adapters = createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [hcBook({ edition_id: 100 })],
    fetchHardcoverEditions: async () => new Map([[100, { id: 100, edition_format: "Hardcover", reading_format_id: 1, isbn_13: null, isbn_10: null, asin: null, pages: null, audio_seconds: null, image: null }]]),
    fetchHardcoverLists: async () => [{
      id: 1, name: "Owned", slug: "owned", bookIds: [book.id], books: [book],
      entries: [{
        book,
        editionId: 200,
        edition: { id: 200, edition_format: "Audible", reading_format_id: 2, isbn_13: null, isbn_10: null, asin: "AUDIO-ASIN", pages: null, audio_seconds: 36000, image: null }
      }]
    }]
  });

  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, adapters);

  const sources = db.prepare(
    "SELECT source_bucket, source_media_type FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ?"
  ).all(profileId) as { source_bucket: string; source_media_type: string }[];
  assert.equal(sources.length, 1, "owned_import_enabled defaults to off, so the Owned-list edition must not produce a second row");
  assert.equal(sources[0]!.source_bucket, "primary");
});

test("Owned-list import is skipped when the primary edition's own format is unresolved", async () => {
  // A book with no current edition and no resolvable default edition
  // pointers has an unknown primary format bucket. "Disagrees with the
  // primary format" is meaningless without a known primary bucket to
  // compare against — this must not fall through to treating unknown as
  // "book" and creating a bogus 'owned' row from an otherwise-valid
  // Owned-list audiobook entry.
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId, "hc-test-token", true);
  seedSyncSettings(db, profileId);
  const book = hcBook({ edition_id: null }).book;
  const adapters = createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [hcBook({ edition_id: null })],
    fetchHardcoverEditions: async () => new Map(),
    fetchHardcoverLists: async () => [{
      id: 1, name: "Owned", slug: "owned", bookIds: [book.id], books: [book],
      entries: [{
        book,
        editionId: 200,
        edition: { id: 200, edition_format: "Audible", reading_format_id: 2, isbn_13: null, isbn_10: null, asin: "AUDIO-ASIN", pages: null, audio_seconds: 36000, image: null }
      }]
    }]
  });

  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, adapters);

  const sources = db.prepare(
    "SELECT source_bucket, source_media_type FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ?"
  ).all(profileId) as { source_bucket: string; source_media_type: string | null }[];
  assert.equal(sources.length, 1, "an unresolved primary format must not produce a secondary 'owned' row, even with a valid Owned-list entry present");
  assert.equal(sources[0]!.source_bucket, "primary");
  assert.equal(sources[0]!.source_media_type, null, "setup: the primary edition's format must genuinely be unresolved for this test to be meaningful");
});

test("Owned-list import creates a second row when the owned edition's format disagrees with the current edition", async () => {
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId, "hc-test-token", true);
  seedSyncSettings(db, profileId);
  const book = hcBook({ edition_id: 100 }).book;
  const adapters = createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [hcBook({ edition_id: 100 })],
    fetchHardcoverEditions: async () => new Map([[100, { id: 100, edition_format: "Hardcover", reading_format_id: 1, isbn_13: null, isbn_10: null, asin: null, pages: null, audio_seconds: null, image: null }]]),
    fetchHardcoverLists: async () => [{
      id: 1, name: "Owned", slug: "owned", bookIds: [book.id], books: [book],
      entries: [{
        book,
        editionId: 200,
        edition: { id: 200, edition_format: "Audible", reading_format_id: 2, isbn_13: null, isbn_10: null, asin: "AUDIO-ASIN", pages: null, audio_seconds: 36000, image: null }
      }]
    }]
  });

  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, adapters);

  const sources = db.prepare(
    "SELECT source_bucket, source_media_type, source_edition_id, source_audible_asin, hardcover_audio_seconds FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ? ORDER BY source_bucket"
  ).all(profileId) as { source_bucket: string; source_media_type: string; source_edition_id: string; source_audible_asin: string | null; hardcover_audio_seconds: number | null }[];
  assert.equal(sources.length, 2, "a disagreeing Owned-list edition must produce a second row");

  const primary = sources.find((s) => s.source_bucket === "primary")!;
  assert.equal(primary.source_media_type, "physical");

  const owned = sources.find((s) => s.source_bucket === "owned")!;
  assert.equal(owned.source_media_type, "audiobook");
  assert.equal(Number(owned.source_edition_id), 200, "must store the Owned-list entry's own edition id, not the current edition's");
  assert.equal(owned.source_audible_asin, "AUDIO-ASIN");
  assert.equal(owned.hardcover_audio_seconds, 36000);

  // The two rows must become two SEPARATE canonical books, one per format —
  // that's the whole point of the feature (surface under both Books and
  // Audiobooks), matching how a real dual-format book already works today
  // (e.g. a title with both a Grimmory print file and a Grimmory audio file
  // ends up as two canonical books, never merged into one). Format-bucket
  // prefixing on the shared hardcover_book_id identity key (bookIdentity.ts)
  // is what keeps them apart despite sharing the same underlying Hardcover
  // book id.
  const books = db.prepare(`
    SELECT b.id, b.media_type FROM books b
    JOIN book_sources bs ON bs.book_id = b.id
    WHERE bs.source_type = 'hardcover' AND bs.source_instance_id = ?
  `).all(profileId) as { id: number; media_type: string }[];
  assert.equal(books.length, 2, "the primary and owned rows must reconcile into two separate canonical books");
  assert.deepEqual(new Set(books.map((b) => b.media_type)), new Set(["book", "audiobook"]));

  // The owned/audiobook canonical must still get a Hardcover-sourced state —
  // otherwise it has no user relationship at all and looks like an unclaimed
  // catalog entry instead of something this profile owns — but that state is
  // local-only ('owned_list_local_only'): never matched against Grimmory and
  // never written back. It never borrows the shared work's status/rating —
  // with no Grimmory activity of its own it defaults to a neutral UNREAD.
  const audiobookCanonical = books.find((b) => b.media_type === "audiobook")!;
  const audiobookState = db.prepare(
    "SELECT status, last_sync_decision, hardcover_read_id, progress FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'"
  ).get(audiobookCanonical.id, profileId) as { status: string | null; last_sync_decision: string; hardcover_read_id: number | null; progress: number | null } | undefined;
  assert.ok(audiobookState, "the owned/audiobook canonical must get a local Hardcover-sourced state so it shows as belonging to the profile");
  assert.equal(audiobookState!.last_sync_decision, "owned_list_local_only");
  assert.equal(audiobookState!.status, "UNREAD", "with no Grimmory activity of its own the owned canonical defaults to UNREAD, never the primary edition's status");
  assert.equal(audiobookState!.hardcover_read_id, null, "the owned state must never carry a live Hardcover read id (it never writes back)");

  const bookCanonical = books.find((b) => b.media_type === "book")!;
  const hardcoverStateOnBookCanonical = db.prepare(
    "SELECT COUNT(*) AS count FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'"
  ).get(bookCanonical.id, profileId) as { count: number };
  assert.equal(hardcoverStateOnBookCanonical.count, 1, "the primary/book canonical keeps its normal Hardcover-sourced state");

  // Confirm write-back suppression held: no Hardcover mutation adapter was
  // ever invoked for the owned side (createFakeAdapters throws on any
  // adapter call not explicitly stubbed, so a passing sync already proves
  // update/insertHardcoverUserBook* were never called).
});

test("Owned-list import removes a previously-written 'owned' row once it's no longer justified", async () => {
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId, "hc-test-token", true);
  seedSyncSettings(db, profileId);
  // An id, title, slug, and ASIN distinct from the file's shared defaults
  // (id 555, title "Integration Test Book", and the "AUDIO-ASIN" literal
  // several other Owned-list tests also use) — ASIN is a high-confidence,
  // unprefixed identity key (bookIdentity.ts), so reusing the same literal
  // ASIN as another test's owned edition would merge this test's canonical
  // with that unrelated test's still-alive one, making the "fully deleted"
  // assertion below order-dependent on whichever other profile's data
  // happens to still be attached.
  const uniqueHcBook = (overrides: Partial<HardcoverUserBook> = {}) =>
    hcBook({ ...overrides, book: { ...hcBook().book, id: 990100, title: "Owned Row Removal Test Book", slug: "owned-row-removal-test-book" } });
  const book = uniqueHcBook({ edition_id: 100 }).book;
  const editionsMap = async () => new Map([[100, { id: 100, edition_format: "Hardcover", reading_format_id: 1, isbn_13: null, isbn_10: null, asin: null, pages: null, audio_seconds: null, image: null }]]);
  const ownedList = () => [{
    id: 1, name: "Owned", slug: "owned", bookIds: [book.id], books: [book],
    entries: [{
      book,
      editionId: 200,
      edition: { id: 200, edition_format: "Audible", reading_format_id: 2, isbn_13: null, isbn_10: null, asin: "OWNED-ROW-REMOVAL-TEST-ASIN", pages: null, audio_seconds: 36000, image: null }
    }]
  }];

  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [uniqueHcBook({ edition_id: 100 })],
    fetchHardcoverEditions: editionsMap,
    fetchHardcoverLists: async () => ownedList()
  }));
  const afterFirst = db.prepare(
    "SELECT COUNT(*) AS count FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ? AND source_bucket = 'owned'"
  ).get(profileId) as { count: number };
  assert.equal(afterFirst.count, 1, "setup: the owned row must exist before testing its removal");
  const ownedBookId = (db.prepare(
    "SELECT book_id FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ? AND source_bucket = 'owned'"
  ).get(profileId) as { book_id: number }).book_id;

  // Re-sync with the book no longer on the Owned list at all.
  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [uniqueHcBook({ edition_id: 100 })],
    fetchHardcoverEditions: editionsMap,
    fetchHardcoverLists: async () => []
  }));

  const afterSecond = db.prepare(
    "SELECT COUNT(*) AS count FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ? AND source_bucket = 'owned'"
  ).get(profileId) as { count: number };
  assert.equal(afterSecond.count, 0, "the owned row must be removed once the Owned-list entry disappears");

  const primaryStillThere = db.prepare(
    "SELECT COUNT(*) AS count FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ? AND source_bucket = 'primary'"
  ).get(profileId) as { count: number };
  assert.equal(primaryStillThere.count, 1, "removing the owned row must not touch the primary row");

  const staleOwnedState = db.prepare(
    "SELECT COUNT(*) AS count FROM user_book_states WHERE profile_id = ? AND source_type = 'hardcover' AND last_sync_decision = 'owned_list_local_only'"
  ).get(profileId) as { count: number };
  assert.equal(staleOwnedState.count, 0, "the owned canonical's local-only state must not survive once the owned row is gone");

  // The owned canonical had no other source (no Grimmory connection in this
  // test), so once its only book_sources row and its local-only state are
  // both gone, the canonical itself must be deleted too — not survive as a
  // ghost book with zero sources and zero states.
  const ghostBook = db.prepare("SELECT COUNT(*) AS count FROM books WHERE id = ?").get(ownedBookId) as { count: number };
  assert.equal(ghostBook.count, 0, "the now-sourceless owned canonical must be deleted, not left behind as a ghost book");
});

test("a legacy instance-less Hardcover row's stranded state survives a sync that also removes an unrelated owned row", async () => {
  // Regression for the ghost-canonical fix above: the scoped prune it adds
  // must never touch state stranded on an unrelated legacy (source_instance_id
  // IS NULL) Hardcover row — only cleanupLegacyHardcoverSources knows how to
  // migrate that state safely, and it runs later in the same block. A
  // profile-wide prune at that point (rather than one scoped to just the
  // books affected by this run's owned/shared row removals) would delete it
  // first, since a legacy row's source_instance_id can never equal a real
  // profile id.
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId, "hc-test-token", true);
  seedSyncSettings(db, profileId);

  const legacyBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Legacy Stranded Book')").run().lastInsertRowid);
  db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type)
    VALUES (?, 'hardcover', NULL, '777777', 'Legacy Stranded Book', 'physical')
  `).run(legacyBookId);
  db.prepare(`
    INSERT INTO user_book_states (book_id, profile_id, source_type, status, rating, sync_health, last_sync_at)
    VALUES (?, ?, 'hardcover', 'READ', 5, 'synced', datetime('now'))
  `).run(legacyBookId, profileId);

  // Sync 1: creates the owned row for an unrelated second book (990300),
  // matching the setup half of the ghost-canonical test above.
  const uniqueOwnedHcBook = (overrides: Partial<HardcoverUserBook> = {}) =>
    hcBook({ ...overrides, book: { ...hcBook().book, id: 990300, title: "Legacy Coexistence Test Book", slug: "legacy-coexistence-test-book" } });
  const ownedBook = uniqueOwnedHcBook({ edition_id: 100 }).book;
  const editionsMap = async () => new Map([[100, { id: 100, edition_format: "Hardcover", reading_format_id: 1, isbn_13: null, isbn_10: null, asin: null, pages: null, audio_seconds: null, image: null }]]);

  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [uniqueOwnedHcBook({ edition_id: 100 })],
    fetchHardcoverEditions: editionsMap,
    fetchHardcoverLists: async () => [{
      id: 1, name: "Owned", slug: "owned", bookIds: [ownedBook.id], books: [ownedBook],
      entries: [{
        book: ownedBook,
        editionId: 200,
        edition: { id: 200, edition_format: "Audible", reading_format_id: 2, isbn_13: null, isbn_10: null, asin: "LEGACY-COEXISTENCE-TEST-ASIN", pages: null, audio_seconds: 36000, image: null }
      }]
    }]
  }));

  // Sync 2: the owned entry disappears (triggers the scoped ghost cleanup for
  // book 990300's owned row) AND the legacy row's live counterpart (777777)
  // shows up in the library for the first time in the same run (the exact
  // condition under which cleanupLegacyHardcoverSources needs its own chance
  // to run before any state on the legacy row's book is lost).
  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [
      uniqueOwnedHcBook({ edition_id: 100 }),
      hcBook({ id: 20, edition_id: null, status_id: 3, rating: 5, book: { ...hcBook().book, id: 777777, title: "Legacy Stranded Book", slug: "legacy-stranded-book" } })
    ],
    fetchHardcoverEditions: editionsMap,
    fetchHardcoverLists: async () => []
  }));

  const survivingState = db.prepare(
    "SELECT COUNT(*) AS count FROM user_book_states WHERE profile_id = ? AND source_type = 'hardcover' AND rating = 5"
  ).get(profileId) as { count: number };
  assert.equal(survivingState.count, 1, "the legacy row's stranded rating must survive — never silently deleted by the ghost-canonical cleanup's prune");
});

test("the ghost-canonical prune is a no-op when a legacy row shares the same canonical as the just-deleted owned row", async () => {
  // A tighter version of the case above: here the legacy row lands on the
  // EXACT SAME canonical as the owned row that's being removed this run —
  // e.g. an old instance-less row and the new owned row share the same
  // Hardcover id/format bucket and already reconciled together. That book
  // still has a real book_sources row (the legacy one) even after the owned
  // row is deleted, so it was never actually orphaned — deleteOrphanedBooks
  // wouldn't touch it either way. Pruning this profile's own local-only
  // state here would only destroy it for no benefit.
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId, "hc-test-token", true);
  seedSyncSettings(db, profileId);

  const uniqueOwnedHcBook = (overrides: Partial<HardcoverUserBook> = {}) =>
    hcBook({ ...overrides, book: { ...hcBook().book, id: 990400, title: "Overlapping Legacy Test Book", slug: "overlapping-legacy-test-book" } });
  const ownedBook = uniqueOwnedHcBook({ edition_id: 100 }).book;
  const editionsMap = async () => new Map([[100, { id: 100, edition_format: "Hardcover", reading_format_id: 1, isbn_13: null, isbn_10: null, asin: null, pages: null, audio_seconds: null, image: null }]]);

  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [uniqueOwnedHcBook({ edition_id: 100 })],
    fetchHardcoverEditions: editionsMap,
    fetchHardcoverLists: async () => [{
      id: 1, name: "Owned", slug: "owned", bookIds: [ownedBook.id], books: [ownedBook],
      entries: [{
        book: ownedBook,
        editionId: 200,
        edition: { id: 200, edition_format: "Audible", reading_format_id: 2, isbn_13: null, isbn_10: null, asin: "OVERLAPPING-LEGACY-TEST-ASIN", pages: null, audio_seconds: 36000, image: null }
      }]
    }]
  }));

  const ownedBookId = (db.prepare(
    "SELECT book_id FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ? AND source_bucket = 'owned'"
  ).get(profileId) as { book_id: number }).book_id;

  // Directly attach a legacy (source_instance_id NULL) Hardcover row onto
  // that exact same canonical — standing in for the "already reconciled
  // together" case without depending on identity-key matching to produce it.
  db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type)
    VALUES (?, 'hardcover', NULL, 'overlap-legacy-external-id', 'Overlapping Legacy Test Book', 'audiobook')
  `).run(ownedBookId);

  // Re-sync with the Owned entry gone — this run deletes the owned row,
  // putting ownedBookId in affectedBookIds, but the book is NOT actually
  // orphaned: the legacy row inserted above is still a real book_sources row.
  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [uniqueOwnedHcBook({ edition_id: 100 })],
    fetchHardcoverEditions: editionsMap,
    fetchHardcoverLists: async () => []
  }));

  const stillHasLegacySource = db.prepare(
    "SELECT COUNT(*) AS count FROM book_sources WHERE book_id = ? AND source_instance_id IS NULL"
  ).get(ownedBookId) as { count: number };
  assert.equal(stillHasLegacySource.count, 1, "setup: the legacy row must still be present — this book was never actually orphaned");

  const ownedRowGone = db.prepare(
    "SELECT COUNT(*) AS count FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ? AND source_bucket = 'owned'"
  ).get(profileId) as { count: number };
  assert.equal(ownedRowGone.count, 0, "setup: the owned row itself was correctly removed");

  const ghostBook = db.prepare("SELECT COUNT(*) AS count FROM books WHERE id = ?").get(ownedBookId) as { count: number };
  assert.equal(ghostBook.count, 1, "the book must not be deleted — a real book_sources row (the legacy one) is still attached to it");
});

test("a book that exists only via the Owned list (no real Hardcover library entry) still gets a real status", async () => {
  // Mirrors "World War Z": the book has no real Hardcover user_books row at
  // all (fetchHardcoverLibrary never returns it) — it only shows up because
  // it's on the Owned list, entering as a list-only stub (status_id null by
  // default). With Owned Import on, that stub should get Hardcover's "want
  // to read" status_id instead, which should then flow into the displayed
  // status (there's no Grimmory-reported status to prefer — the on-disk
  // Grimmory audiobook file has never been opened) and, since nothing else
  // suppresses it, get written to the matching Grimmory record too.
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId, "hc-test-token", true);
  seedGrimmoryConnection(db, profileId);
  seedSyncSettings(db, profileId);

  const book = hcBook({ edition_id: null }).book;
  const grimmoryWrites: Array<{ bookId: number; status: string }> = [];
  const adapters = createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [],
    fetchHardcoverLists: async () => [{
      id: 1, name: "Owned", slug: "owned", bookIds: [book.id], books: [book],
      entries: [{
        book,
        editionId: 300,
        edition: { id: 300, edition_format: "Audiobook", reading_format_id: 2, isbn_13: null, isbn_10: null, asin: null, pages: null, audio_seconds: null, image: null }
      }]
    }],
    testGrimmoryLogin: async () => ({ ok: true, message: "ok", accessToken: "grim-token" }),
    fetchGrimmoryBooks: async () => [grBook({ id: 9, hardcoverBookId: String(book.id), readStatus: null, mediaType: "audiobook" })],
    updateGrimmoryStatus: async (_baseUrl, _token, bookId, status) => {
      grimmoryWrites.push({ bookId, status });
    }
  });

  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, adapters);

  const hcSource = db.prepare(
    "SELECT book_id, source_bucket, source_media_type FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ?"
  ).get(profileId) as { book_id: number; source_bucket: string; source_media_type: string };
  assert.equal(hcSource.source_bucket, "primary", "a list-only stub is a normal primary row, not a synthetic secondary bucket");
  assert.equal(hcSource.source_media_type, "audiobook");

  const state = db.prepare(
    "SELECT status, hardcover_status_id FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'"
  ).get(hcSource.book_id, profileId) as { status: string | null; hardcover_status_id: number | null };
  assert.equal(state.hardcover_status_id, 1, "the Owned-list stub gets Hardcover's 'want to read' status_id");
  assert.equal(state.status, "UNREAD", "with no Grimmory status to prefer, the display status falls back to Hardcover's own status_id");

  assert.deepEqual(grimmoryWrites, [{ bookId: 9, status: "UNREAD" }], "the resulting status is also written back to the matching Grimmory record");
});

test("a genuinely shared Hardcover book gives its non-owning Grimmory sibling local presence without write-back", async () => {
  // Mirrors "The Butcher's Masquerade": a real Grimmory print/ebook sibling
  // AND a real Grimmory audiobook sibling both share one Hardcover book, no
  // Owned-list involvement at all. The print sibling is actively reading, so
  // it wins the write-back slot (existing shared-ownership arbitration,
  // unchanged) — but the audiobook sibling still has real on-disk data and
  // must show as belonging to this profile (via a real 'shared'-bucket
  // book_sources row, so the "linked to Hardcover" source badge/filter picks
  // it up too, not just a bare local-only state) and never write back.
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId);
  seedGrimmoryConnection(db, profileId);
  seedSyncSettings(db, profileId);

  const adapters = createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [hcBook({ status_id: 2 })], // READING
    fetchHardcoverLists: async () => [],
    testGrimmoryLogin: async () => ({ ok: true, message: "ok", accessToken: "grim-token" }),
    fetchGrimmoryBooks: async () => [
      grBook({ id: 1, hardcoverBookId: "555", readStatus: "READING", mediaType: "physical", isbn13: "9780000000001" }),
      grBook({ id: 2, hardcoverBookId: "555", readStatus: null, mediaType: "audiobook", isbn13: "9780000000002" })
    ]
  });

  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, adapters);

  const hcSources = db.prepare(
    "SELECT book_id, source_bucket, source_media_type FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ? ORDER BY source_bucket"
  ).all(profileId) as { book_id: number; source_bucket: string; source_media_type: string }[];
  assert.equal(hcSources.length, 2, "a real opposite-format sibling justifies a second 'shared' Hardcover row, same mechanism as the Owned-list case");
  const primary = hcSources.find((s) => s.source_bucket === "primary")!;
  assert.equal(primary.source_media_type, "physical", "the actively-reading print sibling keeps owning the write-back slot");
  const shared = hcSources.find((s) => s.source_bucket === "shared")!;
  assert.equal(shared.source_media_type, "audiobook");
  assert.notEqual(shared.book_id, primary.book_id, "the 'shared' row must reconcile onto the audiobook sibling's own canonical, not the primary's");

  const grSources = db.prepare(
    "SELECT book_id, source_media_type FROM book_sources WHERE source_type = 'grimmory' AND source_instance_id = ? ORDER BY external_id"
  ).all(profileId) as { book_id: number; source_media_type: string }[];
  assert.equal(grSources.length, 2, "both Grimmory siblings must reconcile as their own canonicals");
  assert.notEqual(grSources[0]!.book_id, grSources[1]!.book_id);
  const audiobookGrSource = grSources.find((s) => s.source_media_type === "audiobook")!;
  assert.equal(audiobookGrSource.book_id, shared.book_id, "the 'shared' Hardcover row and the real Grimmory audiobook sibling must land on the same canonical");

  const audiobookState = db.prepare(
    "SELECT status, last_sync_decision, hardcover_read_id, progress FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'"
  ).get(shared.book_id, profileId) as { status: string | null; last_sync_decision: string; hardcover_read_id: number | null; progress: number | null } | undefined;
  assert.ok(audiobookState, "the non-owning audiobook sibling must still get a local Hardcover-sourced state");
  assert.equal(audiobookState!.last_sync_decision, "shared_sibling_local_only");
  assert.equal(audiobookState!.hardcover_read_id, null, "must never carry a live Hardcover read id — it never writes back");
  assert.equal(audiobookState!.status, "UNREAD", "a real sibling with no listening activity of its own must default to UNREAD, never borrow the print sibling's actively-reading status");

  const bookState = db.prepare(
    "SELECT COUNT(*) AS count FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'"
  ).get(primary.book_id, profileId) as { count: number };
  assert.equal(bookState.count, 1, "the owning print sibling keeps its normal Hardcover-sourced state");

  // createFakeAdapters throws on any adapter call not stubbed above — a
  // passing sync already proves no Hardcover write-back adapter (update/
  // insertHardcoverUserBook*) was ever called for either sibling.
});

test("a 'shared' row survives a sync where Grimmory is temporarily unavailable", async () => {
  // grimmoryBooks (and so sharedHardcoverOwnership) is empty for the whole
  // run whenever Grimmory can't be reached, regardless of whether the real
  // audiobook sibling this 'shared' row is based on still exists — the
  // cleanup path must not treat that as "the sibling is gone" and delete a
  // still-valid row on every transient outage.
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId);
  seedGrimmoryConnection(db, profileId);
  seedSyncSettings(db, profileId);

  // The primary edition resolves to "physical" from Hardcover's own edition
  // data (not from Grimmory-derived shared-ownership forcing), so its bucket
  // stays resolvable even on the second sync below where Grimmory data is
  // unavailable and sharedHardcoverOwnership has nothing in it.
  const editionsMap = async () => new Map([[100, { id: 100, edition_format: "Hardcover", reading_format_id: 1, isbn_13: null, isbn_10: null, asin: null, pages: null, audio_seconds: null, image: null }]]);

  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [hcBook({ status_id: 2, edition_id: 100 })], // READING
    fetchHardcoverEditions: editionsMap,
    fetchHardcoverLists: async () => [],
    testGrimmoryLogin: async () => ({ ok: true, message: "ok", accessToken: "grim-token" }),
    fetchGrimmoryBooks: async () => [
      grBook({ id: 1, hardcoverBookId: "555", readStatus: "READING", mediaType: "physical", isbn13: "9780000000003" }),
      grBook({ id: 2, hardcoverBookId: "555", readStatus: null, mediaType: "audiobook", isbn13: "9780000000004" })
    ]
  }));

  const sharedBefore = db.prepare(
    "SELECT id FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ? AND source_bucket = 'shared'"
  ).get(profileId) as { id: number } | undefined;
  assert.ok(sharedBefore, "setup: the 'shared' row must exist before testing outage survival");

  // Re-sync with Grimmory unreachable — Hardcover data is unchanged.
  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [hcBook({ status_id: 2, edition_id: 100 })],
    fetchHardcoverEditions: editionsMap,
    fetchHardcoverLists: async () => [],
    testGrimmoryLogin: async () => ({ ok: false, message: "simulated Grimmory outage" })
  }));

  const sharedAfter = db.prepare(
    "SELECT id FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ? AND source_bucket = 'shared'"
  ).get(profileId) as { id: number } | undefined;
  assert.ok(sharedAfter, "the 'shared' row must survive a Grimmory outage, not be deleted just because this run's Grimmory data is empty");
  assert.equal(sharedAfter!.id, sharedBefore!.id, "must be the same row, untouched — not deleted and recreated");
});

test("a Grimmory outage does not let a justified Owned-list entry create a competing 'owned' row next to a preserved 'shared' row", async () => {
  // secondarySibling is forced to null for the whole run whenever Grimmory
  // is unreachable (sharedHardcoverOwnership has nothing in it), which on
  // its own looks identical to "no real sibling exists" — the case the
  // Owned-list fallback exists to cover. Without deferring Owned-list
  // handling too, a justified Owned-list entry would create an 'owned' row
  // right alongside the preserved 'shared' row for the very same Hardcover
  // book, leaving primary + shared + owned all at once.
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId, "hc-test-token", true);
  seedGrimmoryConnection(db, profileId);
  seedSyncSettings(db, profileId);

  // Unique id/title/slug/ASIN/ISBNs: sync-engine.test.ts shares one `db`
  // across every test in the file, and ASIN/title/slug are high-confidence,
  // unprefixed identity keys (bookIdentity.ts) — reusing another test's
  // literals (e.g. the default hcBook() id 555 or "AUDIO-ASIN") can silently
  // merge unrelated tests' canonicals when run together.
  const editionsMap = async () => new Map([[100, { id: 100, edition_format: "Hardcover", reading_format_id: 1, isbn_13: null, isbn_10: null, asin: null, pages: null, audio_seconds: null, image: null }]]);
  const bookOverrides = { id: 990200, title: "Outage Owned Race Test Book", slug: "outage-owned-race-test-book" };
  const book = hcBook({ status_id: 2, edition_id: 100, book: { ...hcBook().book, ...bookOverrides } }).book;

  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [hcBook({ status_id: 2, edition_id: 100, book: { ...hcBook().book, ...bookOverrides } })], // READING
    fetchHardcoverEditions: editionsMap,
    fetchHardcoverLists: async () => [],
    testGrimmoryLogin: async () => ({ ok: true, message: "ok", accessToken: "grim-token" }),
    fetchGrimmoryBooks: async () => [
      grBook({ id: 990201, hardcoverBookId: "990200", readStatus: "READING", mediaType: "physical", isbn13: "9780000099021" }),
      grBook({ id: 990202, hardcoverBookId: "990200", readStatus: null, mediaType: "audiobook", isbn13: "9780000099022" })
    ]
  }));

  const beforeBuckets = db.prepare(
    "SELECT source_bucket FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ? ORDER BY source_bucket"
  ).all(profileId) as { source_bucket: string }[];
  assert.deepEqual(beforeBuckets.map((b) => b.source_bucket), ["primary", "shared"], "setup: a real audiobook sibling must produce a 'shared' row, not an 'owned' one");

  // Re-sync with Grimmory unreachable — Hardcover now also reports a
  // Owned-list entry whose format disagrees with the primary edition, which
  // would ordinarily justify an 'owned' row.
  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [hcBook({ status_id: 2, edition_id: 100, book: { ...hcBook().book, ...bookOverrides } })],
    fetchHardcoverEditions: editionsMap,
    fetchHardcoverLists: async () => [{
      id: 1, name: "Owned", slug: "owned", bookIds: [book.id], books: [book],
      entries: [{
        book,
        editionId: 200,
        edition: { id: 200, edition_format: "Audible", reading_format_id: 2, isbn_13: null, isbn_10: null, asin: "OUTAGE-OWNED-RACE-ASIN", pages: null, audio_seconds: 36000, image: null }
      }]
    }],
    testGrimmoryLogin: async () => ({ ok: false, message: "simulated Grimmory outage" })
  }));

  const afterBuckets = db.prepare(
    "SELECT source_bucket FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ? ORDER BY source_bucket"
  ).all(profileId) as { source_bucket: string }[];
  assert.deepEqual(afterBuckets.map((b) => b.source_bucket), ["primary", "shared"], "the outage must not add a competing 'owned' row next to the preserved 'shared' row");
});

test("a non-owning sibling with its own real Grimmory status is not overwritten by the owning sibling's status", async () => {
  // Mirrors "Carl's Doomsday Scenario"/"The Dungeon Anarchist's Cookbook":
  // both siblings have real, independently-tracked Grimmory progress that
  // genuinely disagrees (finished the book in print, only partway through —
  // or never started — the audiobook, or vice versa). The non-owning
  // sibling's local-only Hardcover state must defer entirely to its own
  // Grimmory-sourced state rather than borrowing the owning sibling's
  // status — book and audiobook editions are tracked completely
  // independently in Grimmory, so mirroring across them is only a fallback
  // for when the non-owning sibling has no Grimmory activity of its own.
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId);
  seedGrimmoryConnection(db, profileId);
  seedSyncSettings(db, profileId);

  const adapters = createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [hcBook({ status_id: 2 })], // READING
    fetchHardcoverLists: async () => [],
    testGrimmoryLogin: async () => ({ ok: true, message: "ok", accessToken: "grim-token" }),
    fetchGrimmoryBooks: async () => [
      grBook({ id: 1, hardcoverBookId: "555", readStatus: "READING", mediaType: "physical", isbn13: "9780000000001" }),
      // The audiobook sibling has already been finished — a real, different
      // status than the actively-reading print sibling that currently owns
      // Hardcover's write-back slot.
      grBook({ id: 2, hardcoverBookId: "555", readStatus: "READ", mediaType: "audiobook", isbn13: "9780000000002" })
    ]
  });

  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, adapters);

  const shared = db.prepare(
    "SELECT book_id FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ? AND source_bucket = 'shared'"
  ).get(profileId) as { book_id: number };

  const audiobookHcState = db.prepare(
    "SELECT status, rating, hardcover_status_id FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'"
  ).get(shared.book_id, profileId) as { status: string | null; rating: number | null; hardcover_status_id: number | null };
  assert.equal(audiobookHcState.status, null, "the local-only Hardcover state must not overwrite a sibling that has its own real Grimmory status");
  assert.equal(audiobookHcState.hardcover_status_id, null);

  const audiobookGrState = db.prepare(
    "SELECT status FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'"
  ).get(shared.book_id, profileId) as { status: string | null };
  assert.equal(audiobookGrState.status, "READ", "the sibling's own real Grimmory-sourced status must stand on its own, unaffected");
});

test("two finished siblings with no active owner never both attempt to write Hardcover", async () => {
  // Both siblings are genuinely finished (READ), so neither is "actively
  // reading" and there's no active write-back owner this run. Phase F's
  // matcher still only matches one of them (via the primary edition's own
  // resolved format) — the other must defer rather than reach Phase G's
  // "Grimmory-only book, insert it into Hardcover" fallback, which would
  // otherwise attempt a second, competing write into the same Hardcover
  // book. insertHardcoverUserBook/updateHardcoverUserBook are deliberately
  // NOT stubbed below — createFakeAdapters throws if either is called, so a
  // passing sync already proves neither fired for the unmatched sibling.
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId);
  seedGrimmoryConnection(db, profileId);
  seedSyncSettings(db, profileId);

  const adapters = createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [hcBook({ status_id: 3, edition_id: 100 })], // READ
    fetchHardcoverEditions: async () => new Map([[100, { id: 100, edition_format: "Hardcover", reading_format_id: 1, isbn_13: null, isbn_10: null, asin: null, pages: null, audio_seconds: null, image: null }]]),
    fetchHardcoverLists: async () => [],
    testGrimmoryLogin: async () => ({ ok: true, message: "ok", accessToken: "grim-token" }),
    fetchGrimmoryBooks: async () => [
      grBook({ id: 1, hardcoverBookId: "555", readStatus: "READ", mediaType: "physical", isbn13: "9780000000001" }),
      grBook({ id: 2, hardcoverBookId: "555", readStatus: "READ", mediaType: "audiobook", isbn13: "9780000000002" })
    ]
  });

  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, adapters);

  const shared = db.prepare(
    "SELECT book_id FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ? AND source_bucket = 'shared'"
  ).get(profileId) as { book_id: number } | undefined;
  assert.ok(shared, "setup: the audiobook sibling must exist as its own 'shared' canonical");

  const audiobookGrState = db.prepare(
    "SELECT status FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'"
  ).get(shared!.book_id, profileId) as { status: string | null };
  assert.equal(audiobookGrState.status, "READ", "the unmatched sibling's own Grimmory-sourced status is still recorded locally — it just never writes to Hardcover");
});

test("dry run resolves a Hardcover/Grimmory status conflict but never calls the Grimmory write adapter", async () => {
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId);
  seedGrimmoryConnection(db, profileId);
  seedSyncSettings(db, profileId, { conflict_strategy: "hardcover_wins" });

  const adapters = createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [hcBook({ status_id: 2 })], // READING
    fetchHardcoverLists: async () => [],
    testGrimmoryLogin: async () => ({ ok: true, message: "ok", accessToken: "grim-token" }),
    fetchGrimmoryBooks: async () => [grBook({ hardcoverBookId: "555", readStatus: "UNREAD" })]
    // updateGrimmoryStatus deliberately omitted: calling it fails the test.
  });

  await runSyncImpl(profileId, insertSyncRun(db, profileId), true, adapters);

  const state = db.prepare(`
    SELECT last_sync_decision FROM user_book_states WHERE source_type = 'hardcover' AND profile_id = ?
  `).get(profileId) as { last_sync_decision: string } | undefined;
  assert.equal(state?.last_sync_decision, "hardcover_wins", "the decision should still be computed and cached during a dry run");
});

test("a real (non-dry) run writes the resolved status to Grimmory via the adapter", async () => {
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId);
  seedGrimmoryConnection(db, profileId);
  seedSyncSettings(db, profileId, { conflict_strategy: "hardcover_wins" });

  const grimmoryWrites: Array<{ bookId: number; status: string }> = [];
  const adapters = createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [hcBook({ status_id: 2 })], // READING
    fetchHardcoverLists: async () => [],
    testGrimmoryLogin: async () => ({ ok: true, message: "ok", accessToken: "grim-token" }),
    fetchGrimmoryBooks: async () => [grBook({ hardcoverBookId: "555", readStatus: "UNREAD" })],
    updateGrimmoryStatus: async (_baseUrl, _token, bookId, status) => {
      grimmoryWrites.push({ bookId, status });
    }
  });

  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, adapters);

  assert.deepEqual(grimmoryWrites, [{ bookId: 1, status: "READING" }]);
});

test("an unchanged no-match Hardcover page count is negatively cached across syncs", async () => {
  const profileId = seedProfile(db);
  seedHardcoverConnection(db, profileId);
  seedGrimmoryConnection(db, profileId);
  seedSyncSettings(db, profileId, { sync_progress_enabled: 1 });
  let editionFetches = 0;
  const read = { id: 3, edition_id: 9, progress: null, progress_pages: 50, progress_seconds: null, started_at: null, finished_at: null, edition: { id: 9, pages: 100 } };
  const adapters = createFakeAdapters({
    fetchHardcoverUserId: async () => 42,
    fetchHardcoverLibrary: async () => [hcBook({ user_book_reads: [read] })],
    fetchHardcoverLists: async () => [],
    testGrimmoryLogin: async () => ({ ok: true, message: "ok", accessToken: "grim-token" }),
    fetchGrimmoryBooks: async () => [grBook({ hardcoverBookId: "555", readStatus: "READING", readProgress: null, primaryFileId: null })],
    fetchGrimmoryProgress: async () => ({ readProgress: null, lastReadTime: null, readStatus: "READING" }),
    fetchEditionsForBook: async () => { editionFetches++; return []; }
  });

  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, adapters);
  await runSyncImpl(profileId, insertSyncRun(db, profileId), false, adapters);

  assert.equal(editionFetches, 1, "an unchanged page count with no matching edition must use the negative cache");
});

test("two profiles syncing different Hardcover books do not cross-contaminate each other's book_sources", async () => {
  const profileA = seedProfile(db, "Profile A");
  const profileB = seedProfile(db, "Profile B");
  seedHardcoverConnection(db, profileA, "token-a");
  seedHardcoverConnection(db, profileB, "token-b");
  seedSyncSettings(db, profileA);
  seedSyncSettings(db, profileB);

  const adaptersFor = (userId: number) => createFakeAdapters({
    fetchHardcoverUserId: async () => userId,
    fetchHardcoverLibrary: async () => [hcBook({ book: { ...hcBook().book, id: 1000 + userId, title: `Book for user ${userId}` } })],
    fetchHardcoverLists: async () => []
  });

  await runSyncImpl(profileA, insertSyncRun(db, profileA), false, adaptersFor(1));
  await runSyncImpl(profileB, insertSyncRun(db, profileB), false, adaptersFor(2));

  const sourceA = db.prepare(
    "SELECT external_id FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ?"
  ).all(profileA) as { external_id: string }[];
  const sourceB = db.prepare(
    "SELECT external_id FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ?"
  ).all(profileB) as { external_id: string }[];

  assert.deepEqual(sourceA.map((s) => s.external_id), ["1001"]);
  assert.deepEqual(sourceB.map((s) => s.external_id), ["1002"]);
});

test("runExclusiveOfSyncs never runs concurrently with a queued sync — it waits for the sync to finish first", async () => {
  // Both runSync and runExclusiveOfSyncs chain onto the same module-level
  // queue synchronously, at call time — so calling runSync() first and then
  // runExclusiveOfSyncs() immediately after deterministically orders the
  // exclusive task after the sync's queue slot settles, regardless of actual
  // timing (no real race/sleep involved). This is what protects a scheduled
  // full-reconcile pass from merging/reassigning a book_id a sync is mid-write
  // against during one of its own await points.
  const profileId = seedProfile(db);
  const runId = insertSyncRun(db, profileId);
  const order: string[] = [];

  const syncPromise = runSync(profileId, runId, false).then(() => { order.push("sync"); });
  const exclusivePromise = runExclusiveOfSyncs(async () => { order.push("exclusive"); });

  await Promise.all([syncPromise, exclusivePromise]);

  assert.deepEqual(order, ["sync", "exclusive"], "the exclusive task must only run after the queued sync ahead of it has fully settled");
});
