import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// profilesRouter's cleanup helpers operate on the db/index.ts singleton
// (getDb()), not a db instance passed in by the caller — point DATA_DIR at a
// private temp dir before the first import of the singleton module, matching
// sync-engine.test.ts's pattern for the same reason.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "shelfbridge-profiles-disable-test-"));
process.env["DATA_DIR"] = dataDir;

const { getDb } = await import("../../src/server/db/index.js");
const profilesRouter = (await import("../../src/server/routes/profiles.js")).default;
const { seedProfile, seedHardcoverConnection } = await import("./test-helpers.js");
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

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/api/profiles", profilesRouter);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function seedHardcoverMatchedGrimmoryBook(profileId: number): number {
  const bookId = Number(db.prepare("INSERT INTO books DEFAULT VALUES").run().lastInsertRowid);
  db.prepare("INSERT INTO user_book_states (book_id, profile_id, source_type, sync_health) VALUES (?, ?, 'hardcover', 'synced')").run(bookId, profileId);
  db.prepare("INSERT INTO user_book_states (book_id, profile_id, source_type, sync_health) VALUES (?, ?, 'grimmory', 'synced')").run(bookId, profileId);
  return bookId;
}

test("disabling a Hardcover connection with >500 matches marks only that profile's matched Grimmory rows missing, batched under SQLite's parameter limit", async () => {
  const profileId = seedProfile(db);
  const otherProfileId = seedProfile(db, "Other Profile");
  seedHardcoverConnection(db, profileId);
  seedHardcoverConnection(db, otherProfileId);

  // Enough matched books to force the detach UPDATE across multiple 500-sized
  // batches — this is the exact case that made the earlier unbatched version
  // exceed SQLite's bound-parameter limit.
  const MATCHED_COUNT = 1200;
  const matchedBookIds: number[] = [];
  db.transaction(() => {
    for (let i = 0; i < MATCHED_COUNT; i++) {
      matchedBookIds.push(seedHardcoverMatchedGrimmoryBook(profileId));
    }
  })();

  // A Grimmory-only book for the same profile, never matched to Hardcover —
  // must not be touched by the detach update.
  const unmatchedBookId = Number(db.prepare("INSERT INTO books DEFAULT VALUES").run().lastInsertRowid);
  db.prepare("INSERT INTO user_book_states (book_id, profile_id, source_type, sync_health) VALUES (?, ?, 'grimmory', 'synced')").run(unmatchedBookId, profileId);

  // A different profile with its own Hardcover match on its own book — must
  // survive this profile's disable untouched (cross-profile isolation).
  const otherProfileBookId = seedHardcoverMatchedGrimmoryBook(otherProfileId);

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/profiles/${profileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hardcover: { enabled: false } })
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  const remainingHcStates = db.prepare(
    "SELECT COUNT(*) AS count FROM user_book_states WHERE profile_id = ? AND source_type = 'hardcover'"
  ).get(profileId) as { count: number };
  assert.equal(remainingHcStates.count, 0, "this profile's Hardcover state must be fully deleted");

  const missingCount = (db.prepare(
    `SELECT COUNT(*) AS count FROM user_book_states
     WHERE profile_id = ? AND source_type = 'grimmory' AND sync_health = 'missing' AND last_sync_decision = 'hardcover_source_disabled'`
  ).get(profileId) as { count: number }).count;
  assert.equal(missingCount, MATCHED_COUNT, "every previously-matched book's Grimmory row must be marked missing, across all batches");

  const unmatchedState = db.prepare(
    "SELECT sync_health FROM user_book_states WHERE profile_id = ? AND source_type = 'grimmory' AND book_id = ?"
  ).get(profileId, unmatchedBookId) as { sync_health: string };
  assert.equal(unmatchedState.sync_health, "synced", "a Grimmory book with no Hardcover match must not be touched");

  const otherProfileHcState = db.prepare(
    "SELECT COUNT(*) AS count FROM user_book_states WHERE profile_id = ? AND source_type = 'hardcover'"
  ).get(otherProfileId) as { count: number };
  assert.equal(otherProfileHcState.count, 1, "a different profile's Hardcover state must survive this profile's disable");

  const otherProfileGrimmoryState = db.prepare(
    "SELECT sync_health FROM user_book_states WHERE profile_id = ? AND source_type = 'grimmory' AND book_id = ?"
  ).get(otherProfileId, otherProfileBookId) as { sync_health: string };
  assert.equal(otherProfileGrimmoryState.sync_health, "synced", "a different profile's Grimmory row must not be marked missing by this profile's disable");

  assert.ok(matchedBookIds.length === MATCHED_COUNT);
});
