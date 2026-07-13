import crypto from "node:crypto";
import type { NextFunction, Request, Response, Router } from "express";
import { getDb, getSetting, setSetting } from "./db/index.js";
import { logger } from "./logger.js";

const SESSION_COOKIE_NAME = "shelfbridge_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const MIN_PASSWORD_LENGTH = 8;

declare module "express-serve-static-core" {
  interface Request {
    sessionId?: string | null;
    authenticated?: boolean;
  }
}

function parseCookies(rawCookie = ""): Map<string, string> {
  return rawCookie
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Map<string, string>>((acc, pair) => {
      const index = pair.indexOf("=");
      if (index === -1) return acc;
      acc.set(pair.slice(0, index), decodeURIComponent(pair.slice(index + 1)));
      return acc;
    }, new Map());
}

function getSessionSecret(): string {
  const existing = getSetting("auth.sessionSecret", "");
  if (existing) return existing;
  const generated = crypto.randomBytes(32).toString("hex");
  setSetting("auth.sessionSecret", generated);
  logger.info("Generated ShelfBridge session secret");
  return generated;
}

function signedValue(secret: string, value: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function createSessionId(): string {
  return crypto.randomBytes(32).toString("hex");
}

async function hashPassword(password: string, salt?: string): Promise<{ passwordSalt: string; passwordHash: string }> {
  const passwordSalt = salt || crypto.randomBytes(16).toString("hex");
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, passwordSalt, 64, (error, value) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    });
  });

  return { passwordSalt, passwordHash: derived.toString("hex") };
}

async function verifyPassword(password: string, expectedHash: string, salt: string): Promise<boolean> {
  const result = await hashPassword(password, salt);
  const actual = Buffer.from(result.passwordHash, "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function authConfigured(): boolean {
  return Boolean(getSetting("auth.passwordHash", "") && getSetting("auth.passwordSalt", ""));
}

function createSession(): string {
  const db = getDb();
  const sessionId = createSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare("INSERT INTO auth_sessions (id, expires_at) VALUES (?, ?)").run(sessionId, expiresAt);
  return sessionId;
}

function deleteSession(sessionId: string): void {
  getDb().prepare("DELETE FROM auth_sessions WHERE id = ?").run(sessionId);
}

function getValidSession(sessionId: string): boolean {
  const row = getDb()
    .prepare("SELECT id FROM auth_sessions WHERE id = ? AND expires_at > datetime('now')")
    .get(sessionId);
  return Boolean(row);
}

function setSessionCookie(res: Response, sessionId: string): void {
  const signed = `${sessionId}.${signedValue(getSessionSecret(), sessionId)}`;
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(signed)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
}

function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

export function sessionMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.authenticated = false;
  req.sessionId = null;

  const raw = parseCookies(req.headers.cookie).get(SESSION_COOKIE_NAME);
  if (!raw) {
    next();
    return;
  }

  const [sessionId, signature] = raw.split(".");
  if (!sessionId || !signature || signedValue(getSessionSecret(), sessionId) !== signature) {
    next();
    return;
  }

  if (getValidSession(sessionId)) {
    req.authenticated = true;
    req.sessionId = sessionId;
  }

  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!authConfigured()) {
    res.status(503).json({ error: "ShelfBridge authentication has not been configured." });
    return;
  }
  if (!req.authenticated) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  next();
}

export function registerAuthRoutes(router: Router): void {
  router.get("/auth/status", (req, res) => {
    res.json({ configured: authConfigured(), authenticated: Boolean(req.authenticated) });
  });

  router.get("/auth/session", (req, res) => {
    res.json({ authenticated: Boolean(req.authenticated) });
  });

  router.post("/auth/setup", async (req, res) => {
    if (authConfigured()) {
      res.status(409).json({ error: "Authentication is already configured." });
      return;
    }

    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
      return;
    }

    const { passwordHash, passwordSalt } = await hashPassword(password);
    setSetting("auth.passwordHash", passwordHash);
    setSetting("auth.passwordSalt", passwordSalt);
    const sessionId = createSession();
    setSessionCookie(res, sessionId);
    logger.info("ShelfBridge authentication configured");
    res.json({ authenticated: true });
  });

  router.post("/auth/login", async (req, res) => {
    const passwordHash = getSetting("auth.passwordHash", "");
    const passwordSalt = getSetting("auth.passwordSalt", "");
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!passwordHash || !passwordSalt) {
      res.status(503).json({ error: "ShelfBridge authentication has not been configured." });
      return;
    }

    if (!password || !(await verifyPassword(password, passwordHash, passwordSalt))) {
      logger.warn("ShelfBridge login failed");
      res.status(401).json({ error: "Invalid password." });
      return;
    }

    const sessionId = createSession();
    setSessionCookie(res, sessionId);
    logger.info("ShelfBridge login succeeded");
    res.json({ authenticated: true });
  });

  router.post("/auth/logout", (req, res) => {
    if (req.sessionId) deleteSession(req.sessionId);
    clearSessionCookie(res);
    res.status(204).end();
  });
}
