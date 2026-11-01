import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import { once } from "node:events";

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

const { getDb, getSetting, setSetting } = await import("../../src/server/db/index.js");
const { initSchema } = await import("../../src/server/db/schema.js");
const { logger } = await import("../../src/server/logger.js");
const {
  createSession,
  deleteSession,
  getValidSession,
  hashSessionToken,
  isSessionExpiryValid,
  parseCookies,
  setSessionCookie,
  sessionMiddleware,
  registerAuthRoutes,
  requireAuth
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


test("password changes validate credentials, revoke sessions atomically and preserve other data", { timeout: 15_000 }, async () => {
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(express.json(), sessionMiddleware);
  const router = express.Router();
  registerAuthRoutes(router);
  app.use("/api", router);
  app.get("/private", requireAuth, (_req, res) => res.json({ ok: true }));
  // Keep injected database failures out of Express's default diagnostic output.
  app.use((_err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "Unable to change password." });
  });
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  let clientIp = "192.0.2.230";
  async function post(route: string, body: unknown, cookie = "", ip = clientIp) {
    return fetch(base + "/api/auth/" + route, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie, "X-Forwarded-For": ip },
      body: JSON.stringify(body)
    });
  }
  function cookieOf(response: globalThis.Response) {
    return response.headers.get("set-cookie")?.split(";")[0] ?? "";
  }
  const oldPassword = "original-password";
  const newPassword = "replacement-password";
  const body = { currentPassword: oldPassword, newPassword, confirmPassword: newPassword };
  try {
    assert.equal((await post("change-password", body)).status, 503);
    const setup = await post("setup", { password: oldPassword });
    assert.equal(setup.status, 200);
    const cookie = cookieOf(setup);
    const secondLogin = await post("login", { password: oldPassword });
    const secondCookie = cookieOf(secondLogin);
    assert.ok(cookie && secondCookie && cookie !== secondCookie);
    assert.equal((await post("change-password", body)).status, 401);
    assert.equal((await post("change-password", body, "shelfbridge_session=bad")).status, 401);

    setSetting("chaptarr.apiKey", "test-integration-key");
    setSetting("sync.historyRetentionDays", "19");
    getDb().prepare("INSERT INTO profiles (display_name) VALUES (?)").run("Password test profile");
    // Compare all non-auth tables too, catching accidental profile/credential/settings writes.
    const snapshot = () => {
      const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'auth_sessions' ORDER BY name")
        .all() as { name: string }[];
      return tables.map(({ name }) => [name, getDb().prepare(`SELECT * FROM "${name}"`).all()
        .filter((row) => name !== "app_settings" || !(row as { key: string }).key.startsWith("auth."))]);
    };
    const before = snapshot();
    const credentials = () => [getSetting("auth.passwordHash", ""), getSetting("auth.passwordSalt", "")];
    const original = credentials();
    const sessions = () => getDb().prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all();
    const originalSessions = sessions();
    clientIp = "192.0.2.240";
    const invalidBodies = [
      { ...body, currentPassword: "wrong-password" },
      { ...body, currentPassword: 123 },
      { ...body, newPassword: "short", confirmPassword: "short" },
      { ...body, newPassword: 123 },
      { ...body, confirmPassword: "does-not-match" },
      { ...body, confirmPassword: null },
      {}
    ];
    for (const invalid of invalidBodies) {
      const response = await post("change-password", invalid, cookie);
      assert.equal(response.status, 400);
      assert.equal(typeof (await response.json() as { error: unknown }).error, "string");
      assert.deepEqual(credentials(), original);
      assert.deepEqual(sessions(), originalSessions);
      assert.deepEqual(snapshot(), before);
    }

    clientIp = "192.0.2.241";
    // A failed revocation must roll back both credential writes.
    getDb().exec("CREATE TRIGGER fail_session_delete BEFORE DELETE ON auth_sessions BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    try {
      assert.equal((await post("change-password", body, cookie)).status, 500);
      assert.deepEqual(credentials(), original);
      assert.deepEqual(sessions(), originalSessions);
    } finally {
      getDb().exec("DROP TRIGGER fail_session_delete");
    }

    clientIp = "192.0.2.242";
    // Hold both current-password verifications until both requests have passed
    // requireAuth. Commit one change before releasing the other so only the
    // transaction's recheck can reject the second request.
    const releases: (() => void)[] = [];
    let bothVerifying = () => {};
    const bothStarted = new Promise<void>((resolve) => { bothVerifying = resolve; });
    const realScrypt = crypto.scrypt;
    let verificationCount = 0;
    const concurrentScrypt = test.mock.method(crypto, "scrypt", (password: string, salt: string, keylen: number, callback: (err: Error | null, derivedKey: Buffer) => void) => {
      const hold = verificationCount++ < 2;
      realScrypt(password, salt, keylen, (err, derivedKey) => {
        if (hold) {
          let released = false;
          releases.push(() => {
            if (!released) { released = true; callback(err, derivedKey); }
          });
          if (releases.length === 2) bothVerifying();
        } else {
          callback(err, derivedKey);
        }
      });
    });
    let requests: Promise<globalThis.Response>[] = [];
    try {
      // Track which callback belongs to which request without depending on
      // request arrival or worker-thread completion order.
      const responses: globalThis.Response[] = [];
      requests = [
        post("change-password", body, cookie).then((response) => { responses.push(response); return response; }),
        post("change-password", body, secondCookie).then((response) => { responses.push(response); return response; })
      ];
      await bothStarted;
      releases[0]!();
      const success = await Promise.race(requests);
      assert.equal(success.status, 200);
      assert.deepEqual(await success.json(), { authenticated: false });
      assert.match(success.headers.get("set-cookie") ?? "", /shelfbridge_session=;.*Max-Age=0/);
      releases[1]!();
      await Promise.all(requests);
      const rejected = responses.find((response) => response.status !== 200)!;
      assert.equal(rejected.status, 401);
      assert.deepEqual(await rejected.json(), { error: "Session or password changed. Please sign in again." });
    } finally {
      concurrentScrypt.mock.restore();
      // Release any callback still held if an assertion failed.
      for (const release of releases) release();
      await Promise.allSettled(requests);
    }
    const replacement = credentials();
    assert.notEqual(replacement[0], original[0]);
    assert.notEqual(replacement[1], original[1]);
    assert.equal(replacement[0]?.includes(newPassword), false);
    assert.deepEqual(sessions(), []);
    assert.deepEqual(snapshot(), before);
    clientIp = "192.0.2.243";
    for (const revoked of [cookie, secondCookie]) {
      assert.equal((await fetch(base + "/private", { headers: { cookie: revoked } })).status, 401);
      assert.equal((await post("change-password", body, revoked)).status, 401);
    }
    const newLogin = await post("login", { password: newPassword });
    assert.equal(newLogin.status, 200);
    assert.equal((await fetch(base + "/private", { headers: { cookie: cookieOf(newLogin) } })).status, 200);
    assert.equal((await post("login", { password: oldPassword })).status, 401);

    // Hold the first completed scrypt callback so the password change is
    // guaranteed to commit while this login still holds the previous hash.
    let releaseLogin = () => {};
    let hashingStarted = () => {};
    const started = new Promise<void>((resolve) => { hashingStarted = resolve; });
    const originalScrypt = crypto.scrypt;
    let holdNext = true;
    const scryptMock = test.mock.method(crypto, "scrypt", (password: string, salt: string, keylen: number, callback: (err: Error | null, derivedKey: Buffer) => void) => {
      const hold = holdNext;
      holdNext = false;
      originalScrypt(password, salt, keylen, (err, derivedKey) => {
        if (hold) {
          releaseLogin = () => callback(err, derivedKey);
          hashingStarted();
        } else {
          callback(err, derivedKey);
        }
      });
    });
    try {
      const pendingLogin = post("login", { password: newPassword }, "", "192.0.2.231");
      await started;
      const finalPassword = "final-admin-password";
      const change = await post("change-password", {
        currentPassword: newPassword, newPassword: finalPassword, confirmPassword: finalPassword
      }, cookieOf(newLogin), "192.0.2.231");
      assert.equal(change.status, 200);
      releaseLogin();
      const staleLogin = await pendingLogin;
      assert.equal(staleLogin.status, 401);
      assert.equal(staleLogin.headers.get("set-cookie"), null);
      assert.deepEqual(sessions(), []);
      assert.deepEqual(snapshot(), before);

      const finalLogin = await post("login", { password: finalPassword }, "", "192.0.2.232");
      assert.equal(finalLogin.status, 200);
      for (let attempt = 0; attempt < 10; attempt++) {
        assert.equal((await post("login", { password: "wrong-password" }, "", "192.0.2.233")).status, 401);
      }
      // Login and password changes share the same rejected-request budget.
      assert.equal((await post("change-password", {
        currentPassword: finalPassword, newPassword, confirmPassword: newPassword
      }, cookieOf(finalLogin), "192.0.2.233")).status, 429);
      assert.equal((await fetch(base + "/private", { headers: { cookie: cookieOf(finalLogin) } })).status, 200);
    } finally {
      releaseLogin();
      scryptMock.mock.restore();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
