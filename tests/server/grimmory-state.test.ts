import assert from "node:assert/strict";
import test from "node:test";
import { syncGrimmoryState } from "../../src/server/sync/grimmory-state.js";
import { resolveSharedHardcoverOwnership } from "../../src/server/sync/hardcover-ownership.js";
import {
  grimmoryToHardcoverRating,
  hardcoverFieldsFromGrimmory,
  hasGrimmoryUserActivity,
  hasMeaningfulGrChange
} from "../../src/server/sync/sync-utils.js";
import { getUserState } from "../../src/server/sync/repository.js";
import { pruneGrimmorySourcesMissingFromFetch, pruneGrimmoryUserStatesMissingFromFetch } from "../../src/server/sync/pruning.js";
import { createTestDatabase } from "./test-db.js";
import { seedProfile } from "./test-helpers.js";

function seedUnmatchedGrimmoryBook(db: ReturnType<typeof createTestDatabase>["db"], profileId: number, grimmoryId: number, hardcoverBookId: string) {
  const bookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Shared work')").run().lastInsertRowid);
  db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, source_media_type, grimmory_hardcover_book_id)
    VALUES (?, 'grimmory', ?, ?, 'ebook', ?)
  `).run(bookId, profileId, String(grimmoryId), hardcoverBookId);
  return bookId;
}

test("an ownership conflict is not reported as a skip when Hardcover isn't configured", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    seedUnmatchedGrimmoryBook(db, profileId, 1, "42");

    // A distinct, actively-reading audiobook sibling owns the shared record —
    // the finished book below would be blocked *if* a write were ever
    // attempted, but with hasHardcover: false, none ever would be.
    const owner = { id: 2, hardcoverBookId: "42", mediaType: "audiobook", readStatus: "READING" };
    const finishedBook = { id: 1, title: "Finished Book", hardcoverBookId: "42", mediaType: "ebook", readStatus: "READ", dateFinished: "2026-01-01T00:00:00Z" };
    const sharedHardcoverOwnership = resolveSharedHardcoverOwnership([finishedBook, owner] as any, new Set());

    const counters = { written: 0, skipped: 0, superseded: 0, sourceFailures: 0 };
    const events: Array<{ eventType: string; decision: string }> = [];

    await syncGrimmoryState({
      db, profileId, runId: 1, grimmoryBooks: [finishedBook, owner] as any, grimmoryAvailable: true, counters,
      recordEvent: (_db, _runId, _profileId, _title, eventType, _direction, decision) => { events.push({ eventType, decision }); },
      getUserState, hasMeaningfulGrChange, dryRun: false, hasGrimmoryUserActivity,
      matchedGrimmoryIds: new Set(), hardcoverFieldsFromGrimmory, grimmoryToHardcoverRating,
      sharedHardcoverOwnership, hasHardcover: false,
      profile: {}, adapters: {} as any, hardcoverToken: "",
      pruneGrimmoryUserStatesMissingFromFetch, pruneGrimmorySourcesMissingFromFetch, grimmorySnapshotStatus: "complete"
    });

    assert.equal(counters.skipped, 0, "no write was ever eligible, so nothing should count as skipped");
    assert.ok(
      !events.some((e) => e.decision === "shared_hardcover_owned_by_sibling"),
      "an ownership conflict must not be reported when Hardcover isn't even configured"
    );
  } finally { cleanup(); }
});

test("an ownership conflict is still reported as a skip once a write is otherwise eligible", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    seedUnmatchedGrimmoryBook(db, profileId, 1, "42");

    const owner = { id: 2, hardcoverBookId: "42", mediaType: "audiobook", readStatus: "READING" };
    const finishedBook = { id: 1, title: "Finished Book", hardcoverBookId: "42", mediaType: "ebook", readStatus: "READ", dateFinished: "2026-01-01T00:00:00Z" };
    const sharedHardcoverOwnership = resolveSharedHardcoverOwnership([finishedBook, owner] as any, new Set());

    const counters = { written: 0, skipped: 0, superseded: 0, sourceFailures: 0 };
    const events: Array<{ eventType: string; decision: string }> = [];

    await syncGrimmoryState({
      db, profileId, runId: 1, grimmoryBooks: [finishedBook, owner] as any, grimmoryAvailable: true, counters,
      recordEvent: (_db, _runId, _profileId, _title, eventType, _direction, decision) => { events.push({ eventType, decision }); },
      getUserState, hasMeaningfulGrChange, dryRun: false, hasGrimmoryUserActivity,
      matchedGrimmoryIds: new Set(), hardcoverFieldsFromGrimmory, grimmoryToHardcoverRating,
      sharedHardcoverOwnership, hasHardcover: true,
      profile: { sync_status_enabled: 1 }, adapters: {} as any, hardcoverToken: "token",
      pruneGrimmoryUserStatesMissingFromFetch, pruneGrimmorySourcesMissingFromFetch, grimmorySnapshotStatus: "complete"
    });

    assert.equal(counters.skipped, 1);
    assert.ok(events.some((e) => e.decision === "shared_hardcover_owned_by_sibling"));
  } finally { cleanup(); }
});
