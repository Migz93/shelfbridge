import assert from "node:assert/strict";
import test from "node:test";
import { getSetting, setSetting } from "../../src/server/db/index.js";

// getSetting/setSetting operate on the db/index.ts singleton (getDb()), which is
// backed by DATA_DIR/shelfbridge.db. `npm test` points DATA_DIR at an isolated,
// gitignored .test-data/ directory so this never touches real app data.

test("getSetting returns the fallback when the key is unset", () => {
  assert.equal(getSetting("nonexistent.key", "fallback-value"), "fallback-value");
});

test("setSetting then getSetting round-trips the value", () => {
  setSetting("sync.conflictStrategy", "hardcover_wins");
  assert.equal(getSetting("sync.conflictStrategy", "latest_wins"), "hardcover_wins");
});

test("setSetting overwrites an existing value", () => {
  setSetting("sync.conflictStrategy", "grimmory_wins");
  setSetting("sync.conflictStrategy", "latest_wins");
  assert.equal(getSetting("sync.conflictStrategy", "unused"), "latest_wins");
});
