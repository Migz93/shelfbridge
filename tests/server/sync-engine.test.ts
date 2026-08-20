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
  // never leaves them undefined) — hasGrimmoryUserActivity checks `!== null`, so an
  // undefined field here would read as "has activity" and silently mask bugs.
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
