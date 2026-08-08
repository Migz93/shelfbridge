import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// getSetting/setSetting operate on the db/index.ts singleton (getDb()), which
// reads DATA_DIR at module-evaluation time. A static `import` would evaluate
// that module before this file's own top-level code runs (ESM hoists imports
// ahead of everything else in the importing module), so DATA_DIR is set first
// and the singleton is loaded dynamically afterward — pointing it at a private
// temp dir keeps this file's runs off the shared ./.test-data database (and
// off any other file that touches the singleton without doing this, e.g.
// auth.test.ts) instead of racing them. Same pattern and rationale as
// sync-engine.test.ts.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "shelfbridge-settings-test-"));
process.env["DATA_DIR"] = dataDir;

const { getDb, getSetting, setSetting } = await import("../../src/server/db/index.js");
const { logger } = await import("../../src/server/logger.js");

test.after(async () => {
  // The logger writes into dataDir too — end it and wait for the flush to
  // finish before removing the directory, or its file transport throws an
  // unhandled ENOENT trying to write after the directory is already gone.
  await new Promise<void>((resolve) => {
    logger.once("finish", resolve);
    logger.end();
  });
  logger.close();
  getDb().close();
  rmSync(dataDir, { recursive: true, force: true });
});

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
