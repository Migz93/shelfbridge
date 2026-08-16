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

test("Audiobookshelf creates a Hardcover read from a Chaptarr-only shared work mapping", async (t) => {
  const { db, cleanup } = createTestDatabase();
  t.after(cleanup);

  const profileId = Number(db.prepare("INSERT INTO profiles (display_name) VALUES ('Test Profile')").run().lastInsertRowid);
  const bookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Test Audiobook')").run().lastInsertRowid);
  db.prepare(`
    INSERT INTO book_sources
      (book_id, source_type, source_instance_id, external_id, source_hardcover_book_id, source_media_type)
    VALUES (?, 'chaptarr', 0, 'chaptarr-1', '555', 'audiobook')
  `).run(bookId);
  db.prepare(`
    INSERT INTO book_sources
      (book_id, source_type, source_instance_id, external_id, source_media_type, audiobookshelf_duration, audiobookshelf_runtime_validated)
    VALUES (?, 'audiobookshelf', ?, 'abs-1', 'audiobook', 1000, 1)
  `).run(bookId, profileId);

  const createdUserBooks: Array<{ bookId: number; fields: Record<string, unknown> }> = [];
  const createdReads: Array<{ userBookId: number; fields: Record<string, unknown> }> = [];
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
    hcBooks: [{ id: 10, edition_id: 10, status_id: 2, book: { id: 555, default_audio_edition_id: 10 }, user_book_reads: [] }],
    adapters: {
      fetchAudiobookshelfAllProgress: async () => [{ libraryItemId: "abs-1", progress: 0.2, currentTime: 200, duration: 1000, lastUpdate: "2026-08-16T00:00:00.000Z" }],
      fetchEditionsForBook: async () => [{ id: 10, edition_format: "Audiobook", audio_seconds: 1000 }],
      insertHardcoverUserBook: async (_token: string, fields: Record<string, unknown>) => {
        createdUserBooks.push({ bookId: fields.book_id as number, fields });
        return 20;
      },
      insertHardcoverUserBookRead: async (_token: string, userBookId: number, fields: Record<string, unknown>) => {
        createdReads.push({ userBookId, fields });
        return 30;
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

  assert.deepEqual(createdUserBooks, [{ bookId: 555, fields: { book_id: 555, status_id: 2, edition_id: 10 } }]);
  assert.equal(createdReads.length, 1);
  assert.equal(createdReads[0]!.userBookId, 20);
  assert.equal(createdReads[0]!.fields.progress_seconds, 200);
});
