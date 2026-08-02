import crypto from "node:crypto";
import type { NextFunction, Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { getDb, getSetting, setSetting } from "./db/index.js";
import { logger } from "./logger.js";

const SESSION_COOKIE_NAME = "shelfbridge_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
const MIN_PASSWORD_LENGTH = 8;

declare module "express-serve-static-core" {
  interface Request {
    sessionId?: string | null;
    authenticated?: boolean;
  }
}

export function parseCookies(rawCookie = ""): Map<string, string> {
  return rawCookie
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Map<string, string>>((acc, pair) => {
      const index = pair.indexOf("=");
      if (index === -1) return acc;
      try {
        acc.set(pair.slice(0, index), decodeURIComponent(pair.slice(index + 1)));
      } catch {
        // Invalid cookie encoding is unauthenticated input, not a server error.
      }
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

export function hashSessionToken(sessionId: string): string {
  return crypto.createHash("sha256").update(sessionId).digest("hex");
}

export function isSessionExpiryValid(expiresAt: number, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return Number.isSafeInteger(expiresAt) && expiresAt > nowSeconds;
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

export function createSession(): string {
  const db = getDb();
  const sessionId = createSessionId();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  db.prepare("INSERT INTO auth_sessions (token_hash, expires_at) VALUES (?, ?)").run(hashSessionToken(sessionId), expiresAt);
  return sessionId;
}

export function deleteSession(sessionId: string): void {
  getDb().prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hashSessionToken(sessionId));
}

export function getValidSession(sessionId: string): boolean {
  const row = getDb()
    .prepare("SELECT token_hash, expires_at FROM auth_sessions WHERE token_hash = ? AND expires_at > ?")
    .get(hashSessionToken(sessionId), Math.floor(Date.now() / 1000)) as { token_hash: string; expires_at: number } | undefined;
  return Boolean(row);
}

function hasValidSignature(sessionId: string, signature: string): boolean {
  const expected = signedValue(getSessionSecret(), sessionId);
  const actual = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

export function setSessionCookie(req: Request, res: Response, sessionId: string): void {
  const signed = `${sessionId}.${signedValue(getSessionSecret(), sessionId)}`;
  const secure = req.secure ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(signed)}; HttpOnly; Path=/; SameSite=Strict${secure}; Max-Age=${SESSION_TTL_SECONDS}`
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
  if (!sessionId || !signature || !hasValidSignature(sessionId, signature)) {
    next();
    return;
  }

  if (getValidSession(sessionId)) {
    req.authenticated = true;
    req.sessionId = sessionId;
  }

  next();
}

const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." }
});

const loginUsernameLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
    return crypto.createHash("sha256").update(username).digest("hex");
  },
  message: { error: "Too many login attempts. Try again later." }
});

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
    setSessionCookie(req, res, sessionId);
    logger.info("ShelfBridge authentication configured");
    res.json({ authenticated: true });
  });

  router.post("/auth/login", loginIpLimiter, loginUsernameLimiter, async (req, res) => {
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
    setSessionCookie(req, res, sessionId);
    logger.info("ShelfBridge login succeeded");
    res.json({ authenticated: true });
  });

  router.post("/auth/logout", (req, res) => {
    if (req.sessionId) deleteSession(req.sessionId);
    clearSessionCookie(res);
    res.status(204).end();
  });
}
