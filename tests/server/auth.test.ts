import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Request, Response } from "express";

// auth.ts and db/index.ts both operate on the db/index.ts singleton, which
// reads DATA_DIR at module-evaluation time. A static `import` of auth.js would
// transitively evaluate db/index.ts before this file's own top-level code runs
// (ESM hoists imports ahead of everything else in the importing module), so
// DATA_DIR is set first and the singleton is loaded dynamically afterward —
// pointing it at a private temp dir keeps this file's runs off the shared
// ./.test-data database (and off any other file that touches the singleton
// without doing this, e.g. settings.test.ts) instead of racing them. Same
// pattern and rationale as sync-engine.test.ts.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "shelfbridge-auth-test-"));
process.env["DATA_DIR"] = dataDir;

const { getDb } = await import("../../src/server/db/index.js");
const { initSchema } = await import("../../src/server/db/schema.js");
const { logger } = await import("../../src/server/logger.js");
const {
  createSession,
  deleteSession,
  getValidSession,
  hashSessionToken,
  isSessionExpiryValid,
  parseCookies,
  setSessionCookie
} = await import("../../src/server/auth.js");

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

test("malformed cookie encoding is ignored", () => {
  const cookies = parseCookies("valid=value; broken=%E0%A4%A");
  assert.equal(cookies.get("valid"), "value");
  assert.equal(cookies.has("broken"), false);
});

test("sessions are stored as hashes with numeric expiry timestamps", () => {
  const sessionId = createSession();
  const row = getDb().prepare("SELECT token_hash, expires_at FROM auth_sessions WHERE token_hash = ?")
    .get(hashSessionToken(sessionId)) as { token_hash: string; expires_at: number } | undefined;

  assert.ok(row);
  assert.equal(row.token_hash, hashSessionToken(sessionId));
  assert.notEqual(row.token_hash, sessionId);
  assert.equal(isSessionExpiryValid(row.expires_at), true);
  assert.equal(getValidSession(sessionId), true);

  initSchema(getDb());
  assert.equal(getValidSession(sessionId), true);

  deleteSession(sessionId);
  assert.equal(getValidSession(sessionId), false);
});

test("session expiry uses numeric UTC seconds", () => {
  const now = 1_700_000_000;
  assert.equal(isSessionExpiryValid(now + 1, now), true);
  assert.equal(isSessionExpiryValid(now, now), false);
  assert.equal(isSessionExpiryValid(now - 1, now), false);
});

test("session cookies become Secure for HTTPS requests", () => {
  let cookie = "";
  const response = { setHeader: (_name: string, value: string) => { cookie = value; } } as unknown as Response;
  setSessionCookie({ secure: true } as Request, response, "test-session");
  assert.match(cookie, /; Secure;/);
});
