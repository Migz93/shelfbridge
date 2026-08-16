import assert from "node:assert/strict";
import test from "node:test";
import { upsertBookSource } from "../../src/server/sync/repository.js";
import { createTestDatabase } from "./test-db.js";

test("upsertBookSource refreshes sync time without changing modification time", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    upsertBookSource(db, "grimmory", 1, "book-1", {
      title: "Stable Book",
      last_sync_at: "2026-01-01T00:00:00.000Z"
    });
    db.prepare("UPDATE book_sources SET last_modified_at = '2020-01-01 00:00:00' WHERE source_type = 'grimmory'").run();

    upsertBookSource(db, "grimmory", 1, "book-1", {
      title: "Stable Book",
      last_sync_at: "2026-01-02T00:00:00.000Z"
    });

    const unchanged = db.prepare(
      "SELECT last_sync_at, last_modified_at FROM book_sources WHERE source_type = 'grimmory'"
    ).get() as { last_sync_at: string; last_modified_at: string };
    assert.equal(unchanged.last_sync_at, "2026-01-02T00:00:00.000Z");
    assert.equal(unchanged.last_modified_at, "2020-01-01 00:00:00");

    upsertBookSource(db, "grimmory", 1, "book-1", {
      title: "Changed Book",
      last_sync_at: "2026-01-03T00:00:00.000Z"
    });

    const changed = db.prepare(
      "SELECT last_sync_at, last_modified_at FROM book_sources WHERE source_type = 'grimmory'"
    ).get() as { last_sync_at: string; last_modified_at: string };
    assert.equal(changed.last_sync_at, "2026-01-03T00:00:00.000Z");
    assert.notEqual(changed.last_modified_at, "2020-01-01 00:00:00");
  } finally {
    cleanup();
  }
});
