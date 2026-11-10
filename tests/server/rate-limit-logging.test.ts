// shared: content — keep identical across Shelfbridge, Hubarr and Pacearr
import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, type AddressInfo } from "node:net";
import test from "node:test";
import express, { type Express } from "express";
import { createGlobalRateLimiter, createSignInRateLimiter, GLOBAL_RATE_LIMIT, SIGN_IN_RATE_LIMIT } from "../../src/server/rate-limit.js";

async function withServer(app: Express, run: (base: string) => Promise<void>) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run("http://127.0.0.1:" + (server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

async function prime(base: string, count: number, expected: number, ip = "192.0.2.1") {
  for (let sent = 0; sent < count; sent += 100) {
    await Promise.all(Array.from({ length: Math.min(100, count - sent) }, async () => {
      const response = await fetch(base + "/limited", { headers: { "X-Forwarded-For": ip } });
      await response.arrayBuffer();
      assert.equal(response.status, expected);
    }));
  }
}

// One TCP write makes the HTTP parser dispatch overlapping requests before the
// limiter's awaited store increments settle. Separate fetch calls miss this race.
async function burst(base: string, ip = "192.0.2.1"): Promise<number[]> {
  const port = Number(new URL(base).port);
  let wire = "";
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(Array.from({ length: 4 }, (_, index) =>
        "GET /limited HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: " + ip
        + "\r\nConnection: " + (index === 3 ? "close" : "keep-alive") + "\r\n\r\n").join(""));
    });
    socket.setTimeout(10_000, () => socket.destroy(new Error("Pipelined request timed out")));
    socket.on("data", chunk => { wire += chunk.toString(); });
    socket.on("error", reject);
    socket.on("close", () => resolve());
  });
  const statuses = [...wire.matchAll(/HTTP\/1\.1 (\d+)/g)].map(match => Number(match[1]));
  assert.equal(statuses.length, 4);
  return statuses;
}

for (const primed of [GLOBAL_RATE_LIMIT.limit - 1, GLOBAL_RATE_LIMIT.limit]) {
  test("pipelined global rejections log once after " + primed + " requests", { timeout: 30_000 }, async () => {
    const warnings: string[] = [];
    const app = express();
    app.set("trust proxy", 1);
    app.use(createGlobalRateLimiter({ warn: message => { warnings.push(message); } }));
    app.get("/limited", (_req, res) => { res.send("ok"); });
    await withServer(app, async base => {
      await prime(base, primed, 200);
      const statuses = await burst(base);
      // Permit either conservative or exact admission by the dependency at the
      // boundary. The invariant here is one warning whenever rejections occur.
      assert.ok(statuses.every(status => status === 200 || status === 429));
      assert.ok(statuses.includes(429));
      assert.deepEqual(warnings, ["Rate limit exceeded"]);
      assert.ok((await burst(base)).every(status => status === 429));
      assert.equal(warnings.length, 1);
    });
  });
}

test("sign-in warnings are independent per client and become eligible in the next window", { timeout: 15_000 }, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const warnings: string[] = [];
  const app = express();
  app.set("trust proxy", 1);
  app.use(createSignInRateLimiter({ warn: message => { warnings.push(message); } }));
  app.get("/limited", (_req, res) => { res.sendStatus(401); });
  await withServer(app, async base => {
    for (const ip of ["192.0.2.1", "192.0.2.2"]) {
      await prime(base, SIGN_IN_RATE_LIMIT.limit, 401, ip);
      assert.ok((await burst(base, ip)).every(status => status === 429));
    }
    assert.equal(warnings.length, 2);
    await burst(base);
    assert.equal(warnings.length, 2);
    t.mock.timers.tick(SIGN_IN_RATE_LIMIT.windowMs + 1);
    await prime(base, SIGN_IN_RATE_LIMIT.limit, 401);
    assert.ok((await burst(base)).every(status => status === 429));
    assert.equal(warnings.length, 3);
  });
});
