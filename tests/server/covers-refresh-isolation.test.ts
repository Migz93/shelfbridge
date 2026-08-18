import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// refreshStaleGrimmoryCovers operates on the db/index.ts singleton (getDb())
// and makes real outbound HTTP requests via fetchIntegration — point DATA_DIR
// at a private temp dir before the first import of the singleton (matching
// covers-reconcile.test.ts), and run a local Express server standing in for
// Grimmory.
const dataDir = mkdtempSync(path.join(os.tmpdir(), "shelfbridge-covers-refresh-test-"));
process.env["DATA_DIR"] = dataDir;
mkdirSync(path.join(dataDir, "image-cache"), { recursive: true });

const { getDb } = await import("../../src/server/db/index.js");
const { refreshStaleGrimmoryCovers } = await import("../../src/server/sync/covers.js");
const { seedProfile } = await import("./test-helpers.js");
const { logger } = await import("../../src/server/logger.js");

const db = getDb();

test.after(async () => {
  await new Promise<void>((resolve) => {
    logger.once("finish", resolve);
    logger.end();
  });
  logger.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function withFakeGrimmory(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.post("/api/v1/auth/login", (_req, res) => res.json({ accessToken: "test-token" }));
  app.get("/api/v1/media/book/:id/cover", (_req, res) => {
    res.setHeader("content-type", "image/jpeg");
    res.send(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("refreshStaleGrimmoryCovers isolates a per-source failure so later sources in the same instance still refresh", async () => {
  const profileId = seedProfile(db);

  const failingBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Failing Cover Book')").run().lastInsertRowid);
  const failingSourceId = Number(db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title)
    VALUES (?, 'grimmory', ?, '9001', 'Failing Cover Book')
  `).run(failingBookId, profileId).lastInsertRowid);

  const okBookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Refreshable Cover Book')").run().lastInsertRowid);
  const okSourceId = Number(db.prepare(`
    INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title)
    VALUES (?, 'grimmory', ?, '9002', 'Refreshable Cover Book')
  `).run(okBookId, profileId).lastInsertRowid);

  // Both entries are stale (source_url IS NULL, no last_refresh_at). Insert
  // the failing one first so a bug that aborts the whole instance on its
  // first entry's failure would leave the second (ok) entry unrefreshed too.
  db.prepare("INSERT INTO image_cache (cache_key, entity_id) VALUES (?, ?)").run(`cover:${failingSourceId}`, String(failingSourceId));
  db.prepare("INSERT INTO image_cache (cache_key, entity_id) VALUES (?, ?)").run(`cover:${okSourceId}`, String(okSourceId));

  // Simulates a downstream write failure (e.g. a constraint violation or a
  // disk error) on the book_sources UPDATE for one specific source, without
  // needing to fabricate a failure deep inside reconcileBookIdentities.
  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const stmt = originalPrepare(sql);
    if (sql === "UPDATE book_sources SET cover_cache_path = ? WHERE id = ?") {
      const originalRun = stmt.run.bind(stmt);
      // @ts-expect-error -- intentionally overriding a native binding for this test only
      stmt.run = (webPath: unknown, sourceId: unknown) => {
        if (sourceId === failingSourceId) throw new Error("simulated write failure");
        return originalRun(webPath, sourceId);
      };
    }
    return stmt;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  try {
    await withFakeGrimmory(async (baseUrl) => {
      db.prepare(`
        INSERT INTO grimmory_connections (profile_id, base_url, username, password, status)
        VALUES (?, ?, 'testuser', 'testpass', 'connected')
      `).run(profileId, baseUrl);

      await refreshStaleGrimmoryCovers();
    });
  } finally {
    db.prepare = originalPrepare;
  }

  const okCache = db.prepare("SELECT local_web_path FROM image_cache WHERE entity_id = ?").get(String(okSourceId)) as { local_web_path: string | null } | undefined;
  assert.ok(okCache?.local_web_path, "the source after the failing one must still be refreshed, not skipped");

  const failingSource = db.prepare("SELECT cover_cache_path FROM book_sources WHERE id = ?").get(failingSourceId) as { cover_cache_path: string | null } | undefined;
  assert.equal(failingSource?.cover_cache_path ?? null, null, "the failing source's own book_sources row must not end up with a cached path, since its UPDATE threw");
});
