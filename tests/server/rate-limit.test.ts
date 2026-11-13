// shared: content — keep identical across Migz93 self-hosted apps (shelfbridge, hubarr, pacearr)

import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { Express } from "express";
import {
  GLOBAL_RATE_LIMIT,
  SIGN_IN_RATE_LIMIT,
  createGlobalRateLimiter,
  createSignInRateLimiter,
  isRateLimitExempt
} from "../../src/server/rate-limit.js";

interface LoggedWarning {
  message: string;
  meta?: Record<string, unknown>;
}

function recordingLogger() {
  const warnings: LoggedWarning[] = [];
  return {
    warnings,
    warn(message: string, meta?: Record<string, unknown>) {
      warnings.push({ message, meta });
    }
  };
}

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

/** Sends `count` GET requests in batches, so the test doesn't open thousands of sockets at once. */
async function statusesOf(url: string, count: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let sent = 0; sent < count; sent += 200) {
    const batch = Array.from({ length: Math.min(200, count - sent) }, async () => {
      const response = await fetch(url);
      await response.arrayBuffer();
      return response.status;
    });
    statuses.push(...(await Promise.all(batch)));
  }
  return statuses;
}

test("static assets, cached images and the favicon are exempt from the global limit", () => {
  assert.equal(isRateLimitExempt("/assets/index-abc123.js"), true);
  assert.equal(isRateLimitExempt("/images/covers/1.jpg"), true);
  assert.equal(isRateLimitExempt("/favicon.ico"), true);
  assert.equal(isRateLimitExempt("/favicon.ico/"), true);

  assert.equal(isRateLimitExempt("/api/dashboard"), false);
  assert.equal(isRateLimitExempt("/"), false);
  assert.equal(isRateLimitExempt("/books"), false);
  assert.equal(isRateLimitExempt("/assets"), false);
});

test("the global limiter rejects requests past the limit with JSON, logs once, and never counts exempt paths", async () => {
  const logger = recordingLogger();
  const app = express();
  app.use(createGlobalRateLimiter(logger));
  app.get("/api/ping", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/assets/app.js", (_req, res) => {
    res.type("js").send("");
  });

  await withServer(app, async (baseUrl) => {
    // Exempt requests beyond the limit must not use up any of the allowance.
    const exempt = await statusesOf(`${baseUrl}/assets/app.js`, GLOBAL_RATE_LIMIT.limit + 10);
    assert.ok(exempt.every((status) => status === 200));

    const allowed = await statusesOf(`${baseUrl}/api/ping`, GLOBAL_RATE_LIMIT.limit);
    assert.ok(allowed.every((status) => status === 200));

    const rejected = await fetch(`${baseUrl}/api/ping`);
    assert.equal(rejected.status, 429);
    assert.deepEqual(await rejected.json(), { error: "Too many requests. Please try again later." });
    assert.ok(rejected.headers.get("ratelimit-policy"), "expected draft-8 RateLimit-Policy header");
    assert.equal(rejected.headers.get("x-ratelimit-limit"), null, "legacy headers should be disabled");

    const rejectedAgain = await fetch(`${baseUrl}/api/ping`);
    await rejectedAgain.arrayBuffer();
    assert.equal(rejectedAgain.status, 429);

    assert.equal((await fetch(`${baseUrl}/assets/app.js`)).status, 200);
  });

  assert.equal(logger.warnings.length, 1);
  assert.equal(logger.warnings[0]?.message, "Rate limit exceeded");
  assert.equal(logger.warnings[0]?.meta?.["path"], "/api/ping");
});

test("the sign-in limiter only counts failed attempts and rejects the one after the limit", async () => {
  const logger = recordingLogger();
  const app = express();
  app.use(express.json());
  app.post("/api/auth/login", createSignInRateLimiter(logger), (req, res) => {
    const body = req.body as { password?: string };
    if (body.password === "correct") {
      res.json({ ok: true });
      return;
    }
    res.status(401).json({ error: "Invalid password." });
  });

  const attempt = (baseUrl: string, password: string) =>
    fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });

  await withServer(app, async (baseUrl) => {
    // Successful sign-ins beyond the limit must not use up the allowance. They
    // run sequentially because the count is only refunded once each response
    // finishes.
    for (let i = 0; i < SIGN_IN_RATE_LIMIT.limit + 5; i++) {
      const response = await attempt(baseUrl, "correct");
      await response.arrayBuffer();
      assert.equal(response.status, 200);
    }

    for (let i = 0; i < SIGN_IN_RATE_LIMIT.limit; i++) {
      const response = await attempt(baseUrl, "wrong");
      await response.arrayBuffer();
      assert.equal(response.status, 401);
    }

    const rejected = await attempt(baseUrl, "correct");
    assert.equal(rejected.status, 429);
    assert.deepEqual(await rejected.json(), { error: "Too many sign-in attempts. Please try again later." });
  });

  assert.equal(logger.warnings.length, 1);
  assert.equal(logger.warnings[0]?.message, "Sign-in rate limit exceeded");
});
