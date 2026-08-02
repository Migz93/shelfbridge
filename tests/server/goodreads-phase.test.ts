import assert from "node:assert/strict";
import test from "node:test";
import { syncGoodreadsEnrichment } from "../../src/server/sync/goodreads-phase.js";
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
    await syncGoodreadsEnrichment({
      db, profileId, runId: 1,
      profile: { goodreads_enabled: 1, goodreads_user_id: "user", sync_goodreads_status_enabled: 1 },
      adapters: {
        fetchAllGoodreadsBooks: async () => [{ goodreadsId: "gr-1", title: "Book", author: null, coverUrl: null, isbn13: null, isbn10: null, seriesName: null, seriesNumber: null, shelf: "currently-reading", rating: 0, readAt: null, updatedAt: "2025-01-02T00:00:00Z", bookLink: null }],
        updateGrimmoryStatus: async (_base: string, _token: string, id: number, status: string) => { writes.push({ id, status }); }
      },
      counters: { written: 0, skipped: 0 }, dryRun: false, grimmoryAvailable: true, hasGrimmory: true, baseUrl: "https://grim", grimmoryToken: "token",
      recordEvent: () => {}, pruneGoodreadsUserStatesMissingFromFetch, getUserState, hardcoverToGrimmoryRating,
      writeTagEnabled: false, taggedSourceGrimmoryIds: new Set(), taggedSourceTitles: new Map(), goodreadsSourceGrimmoryIds: new Set(),
      hasMeaningfulGoodreadsChange, upsertBookSource, sqliteNow, cacheSourceCover, shouldGoodreadsOverwriteGrimmory, sameNumber,
      syncGoodreadsShelvesToGrimmory: async () => false
    });
    assert.deepEqual(writes, [{ id: 10, status: "READING" }]);
    const state = db.prepare("SELECT status FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'").get(bookId, profileId) as { status: string };
    assert.equal(state.status, "READING");
  } finally { cleanup(); }
});
