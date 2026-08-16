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

const { runSyncImpl } = await import("../../src/server/sync/engine.js");
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
  return { id: 1, title: "Integration Test Book", ...overrides };
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
    syncChaptarrStatus: async () => { chaptarrCalls++; }
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
