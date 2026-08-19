import assert from "node:assert/strict";
import test from "node:test";
import { syncGoodreadsEnrichment } from "../../src/server/sync/goodreads-phase.js";
import { reconcileBookIdentities } from "../../src/server/db/bookIdentity.js";
import { cacheSourceCover } from "../../src/server/sync/covers.js";
import { getUserState, upsertBookSource } from "../../src/server/sync/repository.js";
import { pruneGoodreadsUserStatesMissingFromFetch } from "../../src/server/sync/pruning.js";
import { hardcoverToGrimmoryRating, hasMeaningfulGoodreadsChange, sameNumber, sqliteNow, shouldGoodreadsOverwriteGrimmory } from "../../src/server/sync/sync-utils.js";
import { createTestDatabase } from "./test-db.js";
import { seedProfile } from "./test-helpers.js";

test("a changed Goodreads shelf writes its mapped status to the matched Grimmory book", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const bookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Book')").run().lastInsertRowid);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, grimmory_goodreads_id) VALUES (?, 'grimmory', ?, '10', 'gr-1')").run(bookId, profileId);
    db.prepare("INSERT INTO user_book_states (book_id, profile_id, source_type, status, rating, grimmory_last_read_time) VALUES (?, ?, 'grimmory', 'UNREAD', 4, '2025-01-01T00:00:00Z')").run(bookId, profileId);
    db.prepare("INSERT INTO user_book_states (book_id, profile_id, source_type, goodreads_shelf) VALUES (?, ?, 'goodreads', 'to-read')").run(bookId, profileId);
    const writes: Array<{ id: number; status: string }> = [];
    const events: Array<{ title: string; eventType: string; decision: string }> = [];
    await syncGoodreadsEnrichment({
      db, profileId, runId: 1,
      profile: { goodreads_enabled: 1, goodreads_user_id: "user", sync_goodreads_status_enabled: 1 },
      adapters: {
        fetchAllGoodreadsBooks: async () => [{ goodreadsId: "gr-1", title: "Book", author: null, coverUrl: null, isbn13: null, isbn10: null, seriesName: null, seriesNumber: null, shelf: "currently-reading", rating: 0, readAt: null, updatedAt: "2025-01-02T00:00:00Z", bookLink: null }],
        updateGrimmoryStatus: async (_base: string, _token: string, id: number, status: string) => { writes.push({ id, status }); }
      },
      counters: { written: 0, skipped: 0 }, dryRun: false, grimmoryAvailable: true, hasGrimmory: true, baseUrl: "https://grim", grimmoryToken: "token",
      recordEvent: (_db: unknown, _runId: number, _profileId: number, title: string, eventType: string, _source: string, decision: string) => {
        events.push({ title, eventType, decision });
      },
      pruneGoodreadsUserStatesMissingFromFetch, getUserState, hardcoverToGrimmoryRating,
      writeTagEnabled: false, taggedSourceGrimmoryIds: new Set(), taggedSourceTitles: new Map(), goodreadsSourceGrimmoryIds: new Set(),
      hasMeaningfulGoodreadsChange, upsertBookSource, sqliteNow, cacheSourceCover, shouldGoodreadsOverwriteGrimmory, sameNumber,
      syncGoodreadsShelvesToGrimmory: async () => false
    });
    assert.deepEqual(writes, [{ id: 10, status: "READING" }]);
    const state = db.prepare("SELECT status FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'").get(bookId, profileId) as { status: string };
    assert.equal(state.status, "READING");
    assert.ok(events.some((e) => e.eventType === "written" && e.decision === "goodreads_latest_status"), "expected the status write to be recorded as an event");
    assert.ok(!events.some((e) => e.eventType === "api_failure"), "phase should not have swallowed a failure");
  } finally { cleanup(); }
});

test("a matched Goodreads book's updated ISBN is reconciled, merging it with the book that now shares that ISBN", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);

    // Book A: already matched to Goodreads via gr-1, no ISBN yet.
    const bookA = Number(db.prepare("INSERT INTO books (title) VALUES ('Old Title')").run().lastInsertRowid);
    db.prepare(`
      INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, source_goodreads_book_id)
      VALUES (?, 'goodreads', ?, 'gr-1', 'Old Title', 'book', 'gr-1')
    `).run(bookA, profileId);

    // Book B: an unrelated existing book that happens to carry the ISBN
    // Goodreads is about to report for gr-1.
    const bookB = Number(db.prepare("INSERT INTO books (title) VALUES ('New Title')").run().lastInsertRowid);
    db.prepare(`
      INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, source_media_type, isbn13)
      VALUES (?, 'hardcover', 1, 'hc-1', 'New Title', 'book', '9780000000019')
    `).run(bookB);
    // Establishes book_identity_keys for both pre-existing books (a scoped
    // reconcile discovers candidates only through already-persisted keys —
    // see bookIdentity.ts's expandScopeToRows), matching what a real prior
    // sync would have already done for both.
    reconcileBookIdentities(db);

    await syncGoodreadsEnrichment({
      db, profileId, runId: 1,
      profile: { goodreads_enabled: 1, goodreads_user_id: "user", sync_goodreads_status_enabled: 0 },
      adapters: {
        fetchAllGoodreadsBooks: async () => [
          { goodreadsId: "gr-1", title: "New Title", author: null, coverUrl: null, isbn13: "9780000000019", isbn10: null, seriesName: null, seriesNumber: null, shelf: "to-read", rating: 0, readAt: null, updatedAt: null, bookLink: null }
        ],
        updateGrimmoryStatus: async () => {}
      },
      counters: { written: 0, skipped: 0 }, dryRun: false, grimmoryAvailable: false, hasGrimmory: false, baseUrl: "https://grim", grimmoryToken: null,
      recordEvent: () => {}, pruneGoodreadsUserStatesMissingFromFetch, getUserState, hardcoverToGrimmoryRating,
      writeTagEnabled: false, taggedSourceGrimmoryIds: new Set(), taggedSourceTitles: new Map(), goodreadsSourceGrimmoryIds: new Set(),
      hasMeaningfulGoodreadsChange, upsertBookSource, sqliteNow, cacheSourceCover, shouldGoodreadsOverwriteGrimmory, sameNumber,
      syncGoodreadsShelvesToGrimmory: async () => false
    });

    const books = db.prepare("SELECT id FROM books ORDER BY id").all() as { id: number }[];
    assert.equal(books.length, 1, "the matched Goodreads update's new ISBN must be reconciled, merging it with the book that shares it, not left stale");
  } finally { cleanup(); }
});

test("multiple unmatched Goodreads books each become their own canonical book in one batched reconcile", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    await syncGoodreadsEnrichment({
      db, profileId, runId: 1,
      profile: { goodreads_enabled: 1, goodreads_user_id: "user", sync_goodreads_status_enabled: 0 },
      adapters: {
        fetchAllGoodreadsBooks: async () => [
          { goodreadsId: "gr-100", title: "First Unmatched", author: null, coverUrl: null, isbn13: null, isbn10: null, seriesName: null, seriesNumber: null, shelf: "to-read", rating: 0, readAt: null, updatedAt: null, bookLink: null },
          { goodreadsId: "gr-200", title: "Second Unmatched", author: null, coverUrl: null, isbn13: null, isbn10: null, seriesName: null, seriesNumber: null, shelf: "to-read", rating: 0, readAt: null, updatedAt: null, bookLink: null }
        ],
        updateGrimmoryStatus: async () => {}
      },
      counters: { written: 0, skipped: 0 }, dryRun: false, grimmoryAvailable: false, hasGrimmory: false, baseUrl: "https://grim", grimmoryToken: null,
      recordEvent: () => {}, pruneGoodreadsUserStatesMissingFromFetch, getUserState, hardcoverToGrimmoryRating,
      writeTagEnabled: false, taggedSourceGrimmoryIds: new Set(), taggedSourceTitles: new Map(), goodreadsSourceGrimmoryIds: new Set(),
      hasMeaningfulGoodreadsChange, upsertBookSource, sqliteNow, cacheSourceCover, shouldGoodreadsOverwriteGrimmory, sameNumber,
      syncGoodreadsShelvesToGrimmory: async () => false
    });

    const states = db.prepare(`
      SELECT bs.source_goodreads_book_id as goodreadsId, ubs.book_id as bookId
      FROM book_sources bs
      JOIN user_book_states ubs ON ubs.book_id = bs.book_id AND ubs.profile_id = ? AND ubs.source_type = 'goodreads'
      WHERE bs.source_type = 'goodreads'
      ORDER BY bs.source_goodreads_book_id
    `).all(profileId) as { goodreadsId: string; bookId: number }[];

    assert.equal(states.length, 2);
    assert.notEqual(states[0]!.bookId, states[1]!.bookId, "unrelated Goodreads-only books must not be merged into the same canonical book");
  } finally { cleanup(); }
});

test("one book throwing during processing does not abort the rest of the Goodreads phase", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    const events: Array<{ eventType: string; decision: string }> = [];
    const counters = { written: 0, skipped: 0, sourceFailures: 0 };

    // upsertBookSource throws for the first (poisoned) book's external id and
    // succeeds normally for everything else, simulating an unexpected failure
    // isolated to one book's write rather than the whole Goodreads source.
    const flakyUpsertBookSource: typeof upsertBookSource = (db_, sourceType, instanceId, externalId, fields) => {
      if (externalId === "gr-poison") throw new Error("simulated write failure");
      return upsertBookSource(db_, sourceType, instanceId, externalId, fields);
    };

    await syncGoodreadsEnrichment({
      db, profileId, runId: 1,
      profile: { goodreads_enabled: 1, goodreads_user_id: "user", sync_goodreads_status_enabled: 0 },
      adapters: {
        fetchAllGoodreadsBooks: async () => [
          { goodreadsId: "gr-poison", title: "Poisoned Book", author: null, coverUrl: null, isbn13: null, isbn10: null, seriesName: null, seriesNumber: null, shelf: "to-read", rating: 0, readAt: null, updatedAt: null, bookLink: null },
          { goodreadsId: "gr-fine", title: "Fine Book", author: null, coverUrl: null, isbn13: null, isbn10: null, seriesName: null, seriesNumber: null, shelf: "to-read", rating: 0, readAt: null, updatedAt: null, bookLink: null }
        ],
        updateGrimmoryStatus: async () => {}
      },
      counters, dryRun: false, grimmoryAvailable: false, hasGrimmory: false, baseUrl: "https://grim", grimmoryToken: null,
      recordEvent: (_db: unknown, _runId: number, _profileId: number, _title: string, eventType: string, _source: string, decision: string) => {
        events.push({ eventType, decision });
      },
      pruneGoodreadsUserStatesMissingFromFetch, getUserState, hardcoverToGrimmoryRating,
      writeTagEnabled: false, taggedSourceGrimmoryIds: new Set(), taggedSourceTitles: new Map(), goodreadsSourceGrimmoryIds: new Set(),
      hasMeaningfulGoodreadsChange, upsertBookSource: flakyUpsertBookSource, sqliteNow, cacheSourceCover, shouldGoodreadsOverwriteGrimmory, sameNumber,
      syncGoodreadsShelvesToGrimmory: async () => false
    });

    const fineSource = db.prepare("SELECT book_id FROM book_sources WHERE source_goodreads_book_id = 'gr-fine'").get() as { book_id: number } | undefined;
    assert.ok(fineSource, "the book after the poisoned one must still be processed");
    assert.equal(counters.sourceFailures, 0, "a single book's failure must not be reported as a Goodreads source outage");
    assert.ok(events.some((e) => e.eventType === "api_failure" && e.decision === "book_processing_failed"), "the poisoned book's failure should still be recorded as an event");
  } finally { cleanup(); }
});
