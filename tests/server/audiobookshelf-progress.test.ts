import assert from "node:assert/strict";
import test from "node:test";
import { syncAudiobookshelfProgress } from "../../src/server/sync/audiobookshelf-progress.js";
import {
  clampPercent,
  effectiveAbsCurrentTimeSeconds,
  hasActiveBookSiblingForHardcover,
  meaningfulProgress,
  persistResolvedHardcoverAudioEdition,
  todayDate
} from "../../src/server/sync/sync-utils.js";
import { createTestDatabase } from "./test-db.js";

test("Audiobookshelf repairs a blank live Hardcover read when cached progress is stale", async (t) => {
  const { db, cleanup } = createTestDatabase();
  t.after(cleanup);

  const profileId = Number(db.prepare("INSERT INTO profiles (display_name) VALUES ('Test Profile')").run().lastInsertRowid);
  const bookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Test Audiobook')").run().lastInsertRowid);
  db.prepare(`
    INSERT INTO book_sources
      (book_id, source_type, source_instance_id, external_id, source_media_type, source_edition_id, hardcover_audio_seconds)
    VALUES (?, 'hardcover', ?, '555', 'audiobook', '10', 1000)
  `).run(bookId, profileId);
  db.prepare(`
    INSERT INTO book_sources
      (book_id, source_type, source_instance_id, external_id, source_media_type, audiobookshelf_duration, audiobookshelf_runtime_validated)
    VALUES (?, 'audiobookshelf', ?, 'abs-1', 'audiobook', 1000, 1)
  `).run(bookId, profileId);
  db.prepare(`
    INSERT INTO user_book_states
      (book_id, profile_id, source_type, progress, hardcover_status_id, hardcover_read_id, hardcover_user_book_id, hardcover_edition_id)
    VALUES (?, ?, 'hardcover', 20, 2, 99, 10, 10)
  `).run(bookId, profileId);

  const readWrites: Array<{ readId: number; fields: Record<string, unknown> }> = [];
  await syncAudiobookshelfProgress({
    db,
    profileId,
    runId: 1,
    hasAbs: true,
    hasHardcover: true,
    grimmoryAvailable: false,
    absBaseUrl: "https://abs.example",
    absApiKey: "key",
    baseUrl: "",
    grimmoryToken: null,
    hardcoverToken: "token",
    dryRun: false,
    counters: { written: 0, skipped: 0, superseded: 0, sourceFailures: 0 },
    grimmoryBooks: [],
    grimmoryProgressById: new Map(),
    hcBooks: [{
      id: 10,
      edition_id: 10,
      status_id: 2,
      book: { id: 555, default_audio_edition_id: 10 },
      user_book_reads: [{ id: 99, edition_id: 10, progress: 0, progress_seconds: 0, finished_at: null, started_at: "2026-08-16" }]
    }],
    adapters: {
      fetchAudiobookshelfAllProgress: async () => [{ libraryItemId: "abs-1", progress: 0.2, currentTime: 200, duration: 1000, lastUpdate: "2026-08-16T00:00:00.000Z" }],
      updateHardcoverUserBook: async () => {},
      updateHardcoverUserBookRead: async (_token: string, readId: number, fields: Record<string, unknown>) => {
        readWrites.push({ readId, fields });
      }
    },
    recordEvent: () => {},
    meaningfulProgress,
    effectiveAbsCurrentTimeSeconds,
    persistResolvedHardcoverAudioEdition,
    clampPercent,
    hasActiveBookSiblingForHardcover,
    localGrimmoryBookForBookId: () => undefined,
    todayDate
  });

  assert.equal(readWrites.length, 1);
  assert.equal(readWrites[0]!.readId, 99);
  assert.equal(readWrites[0]!.fields.progress_seconds, 200);
});
