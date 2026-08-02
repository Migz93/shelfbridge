import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { getDb } from "../../src/server/db/index.js";
import { initSchema } from "../../src/server/db/schema.js";
import {
  createSession,
  deleteSession,
  getValidSession,
  hashSessionToken,
  isSessionExpiryValid,
  parseCookies,
  setSessionCookie
} from "../../src/server/auth.js";

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
