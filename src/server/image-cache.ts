import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db/index.js";
import { logger } from "./logger.js";
import { fetchCoverImage } from "./security/outbound.js";
import { reconcileBookIdentities } from "./db/bookIdentity.js";
import { runExclusiveOfSyncs } from "./sync/sync-queue.js";

const DATA_DIR = process.env["DATA_DIR"] ?? "./data";
const CACHE_DIR = path.join(DATA_DIR, "image-cache");
const COVER_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_CONCURRENT_CACHE_TASKS = 4;

type CacheTask = {
  key: string;
  run: () => Promise<void>;
};

const queuedCacheKeys = new Set<string>();
const cacheTaskQueue: CacheTask[] = [];
let activeCacheTasks = 0;

interface CacheRow {
  source_url: string | null;
  local_file_path: string | null;
  local_web_path: string | null;
  cached_at: string | null;
  last_refresh_at: string | null;
  refresh_after: string | null;
}

function runQueuedCacheTasks(): void {
  while (activeCacheTasks < MAX_CONCURRENT_CACHE_TASKS) {
    const task = cacheTaskQueue.shift();
    if (!task) return;

    activeCacheTasks += 1;
    void task.run()
      .catch((err) => {
        logger.warn("ImageCache: queued cover task failed", {
          key: task.key,
          error: err instanceof Error ? err.message : String(err)
        });
      })
      .finally(() => {
        activeCacheTasks = Math.max(0, activeCacheTasks - 1);
        queuedCacheKeys.delete(task.key);
        runQueuedCacheTasks();
      });
  }
}

/**
 * Queue cover work without holding up a sync. Keys are de-duplicated across
 * active and pending tasks so a frequent profile sync cannot build a second
 * image backlog while the first refresh is still running.
 */
export function enqueueImageCacheTask(key: string, run: () => Promise<void>): boolean {
  if (queuedCacheKeys.has(key)) return false;
  queuedCacheKeys.add(key);
  cacheTaskQueue.push({ key, run });
  runQueuedCacheTasks();
  return true;
}

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function isFresh(row: Pick<CacheRow, "cached_at" | "last_refresh_at" | "refresh_after">): boolean {
  const refreshedAt = row.last_refresh_at ?? row.cached_at;
  if (refreshedAt) {
    return Date.now() - new Date(refreshedAt).getTime() < COVER_FRESHNESS_MS;
  }
  if (!row.refresh_after) return false;
  return Date.now() < new Date(row.refresh_after).getTime();
}

function computeRefreshAfter(): string {
  return new Date(Date.now() + COVER_FRESHNESS_MS).toISOString();
}

function atomicWrite(filePath: string, data: Buffer): void {
  // Temp file in same directory so rename() stays on one filesystem
  const tmpPath = path.join(path.dirname(filePath), `.tmp-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

async function fetchImageBuffer(sourceUrl: string): Promise<Buffer | null> {
  const controller = new AbortController();
  let rejectTimeout!: (reason: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const timeout = setTimeout(() => {
    controller.abort();
    rejectTimeout(new Error(`Cover download timed out after ${FETCH_TIMEOUT_MS}ms`));
  }, FETCH_TIMEOUT_MS);
  try {
    return await Promise.race([
      (async () => {
        const res = await fetchCoverImage(sourceUrl, {
          headers: { "User-Agent": "ShelfBridge/0.1 (book sync app)" },
          signal: controller.signal
        });
        if (!res.ok) {
          logger.warn("ImageCache: fetch failed", { sourceUrl, status: res.status });
          return null;
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.startsWith("image/")) {
          logger.warn("ImageCache: response is not an image", { sourceUrl, contentType });
          return null;
        }
        const contentLength = Number(res.headers.get("content-length") ?? 0);
        if (contentLength > MAX_BYTES) {
          logger.warn("ImageCache: response too large", { sourceUrl, contentLength });
          return null;
        }
        const reader = res.body?.getReader();
        if (!reader) return null;
        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > MAX_BYTES) {
            await reader.cancel();
            logger.warn("ImageCache: response exceeded byte cap mid-stream", { sourceUrl });
            return null;
          }
          chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks);
      })(),
      deadline
    ]);
  } catch (err) {
    if (controller.signal.aborted) {
      logger.warn("ImageCache: cover download timed out", { sourceUrl, timeoutMs: FETCH_TIMEOUT_MS });
      return null;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAndStore(cacheKey: string, entityId: string, sourceUrl: string): Promise<string | null> {
  const data = await fetchImageBuffer(sourceUrl);
  if (!data) return null;

  ensureCacheDir();
  const filename = `${crypto.randomUUID()}.jpg`;
  const filePath = path.join(CACHE_DIR, filename);
  const webPath = `/images/${filename}`;

  try {
    atomicWrite(filePath, data);
  } catch (err) {
    logger.warn("ImageCache: failed to write cover to disk", {
      cacheKey, error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }

  const now = new Date().toISOString();
  const refreshAfter = computeRefreshAfter();

  getDb().prepare(`
    INSERT INTO image_cache (cache_key, entity_id, source_url, local_file_path, local_web_path,
      cached_at, last_refresh_at, refresh_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      source_url = excluded.source_url,
      local_file_path = excluded.local_file_path,
      local_web_path = excluded.local_web_path,
      last_refresh_at = excluded.last_refresh_at,
      refresh_after = excluded.refresh_after,
      last_error = NULL
  `).run(cacheKey, entityId, sourceUrl, filePath, webPath, now, now, refreshAfter);

  logger.info("ImageCache: cover cached", { cacheKey, webPath, sourceUrl });
  return webPath;
}

async function refreshInBackground(cacheKey: string, entityId: string, sourceUrl: string, oldFilePath: string | null): Promise<void> {
  const now = new Date().toISOString();
  getDb().prepare("UPDATE image_cache SET last_attempted_at = ? WHERE cache_key = ?").run(now, cacheKey);

  const data = await fetchImageBuffer(sourceUrl);
  if (!data) {
    getDb().prepare("UPDATE image_cache SET last_error = ? WHERE cache_key = ?")
      .run("Fetch failed during background refresh", cacheKey);
    return;
  }

  ensureCacheDir();
  const filename = `${crypto.randomUUID()}.jpg`;
  const newFilePath = path.join(CACHE_DIR, filename);
  const newWebPath = `/images/${filename}`;

  try {
    atomicWrite(newFilePath, data);
  } catch (err) {
    logger.warn("ImageCache: background refresh write failed", {
      cacheKey, error: err instanceof Error ? err.message : String(err)
    });
    getDb().prepare("UPDATE image_cache SET last_error = ? WHERE cache_key = ?")
      .run("Disk write failed", cacheKey);
    return;
  }

  const refreshAfter = computeRefreshAfter();
  getDb().prepare(`
    UPDATE image_cache SET
      source_url = ?, local_file_path = ?, local_web_path = ?,
      last_refresh_at = ?, refresh_after = ?, last_error = NULL
    WHERE cache_key = ?
  `).run(sourceUrl, newFilePath, newWebPath, new Date().toISOString(), refreshAfter, cacheKey);

  // Delete the old file only once image_cache itself is durably pointing at
  // the new one — deleting it first would leave the row referencing a path
  // that no longer exists on disk if the process died in between.
  if (oldFilePath && oldFilePath !== newFilePath) {
    try { fs.unlinkSync(oldFilePath); } catch { /* best-effort */ }
  }

  logger.info("ImageCache: cover refreshed", { cacheKey, webPath: newWebPath });

  // entityId is always a book_sources.id (see the cacheKey convention in
  // fetchAndStore/storeFetchedCover). ensureCoverCached returns the OLD path
  // immediately when it schedules this refresh, so book_sources.cover_cache_path
  // (written from that stale return value) and the canonical
  // books.cover_cache_path would otherwise keep pointing at the file just
  // deleted above until some unrelated later write happens to re-cache this
  // same source. Propagate the new path now instead. Isolated in its own
  // try/catch: the refresh itself already succeeded and committed above, so a
  // propagation failure here must not abort refreshStaleCachedCovers's loop
  // over the rest of its batch.
  try {
    const sourceId = Number.parseInt(entityId, 10);
    if (Number.isFinite(sourceId)) {
      const db = getDb();
      db.prepare("UPDATE book_sources SET cover_cache_path = ? WHERE id = ?").run(newWebPath, sourceId);
      await runExclusiveOfSyncs(async () => {
        reconcileBookIdentities(db, { sourceIds: [sourceId] });
      });
    }
  } catch (err) {
    logger.warn("ImageCache: failed to propagate refreshed cover path to book_sources", {
      cacheKey, error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Re-fetch all image_cache entries whose refresh_after timestamp has passed
 * and have a stored source_url (public CDN/Hardcover/Goodreads covers).
 * Grimmory covers (source_url IS NULL) are handled separately by
 * refreshStaleGrimmoryCovers in engine.ts, which handles authentication.
 * Called by the scheduled image-cache-refresh job.
 */
export async function refreshStaleCachedCovers(): Promise<void> {
  const db = getDb();
  const stale = db
    .prepare(
      `SELECT cache_key, entity_id, source_url, local_file_path
       FROM image_cache
       WHERE source_url IS NOT NULL
         AND (last_refresh_at IS NULL OR last_refresh_at < datetime('now', '-7 days'))`
    )
    .all() as { cache_key: string; entity_id: string; source_url: string; local_file_path: string | null }[];

  if (stale.length === 0) {
    logger.info("ImageCache: no stale covers to refresh");
    return;
  }

  logger.info("ImageCache: refreshing stale covers", { count: stale.length });
  for (const row of stale) {
    await refreshInBackground(row.cache_key, row.entity_id, row.source_url, row.local_file_path);
  }
  logger.info("ImageCache: stale cover refresh complete", { count: stale.length });
}

/**
 * Store a pre-fetched cover image for a book that serves its cover from an
 * authenticated endpoint (e.g. Grimmory). Unlike ensureCoverCached, this
 * does NOT try to re-fetch from a URL — it only writes if the entry is absent
 * or the file is missing from disk, leaving any already-fresh cache alone.
 * Returns the local web path, or null on failure.
 */
export function storeFetchedCover(bookLinkId: number, data: Buffer): string | null {
  const cacheKey = `cover:${bookLinkId}`;
  const entityId = String(bookLinkId);

  const row = getDb().prepare(
    "SELECT local_file_path, local_web_path, cached_at, last_refresh_at, refresh_after FROM image_cache WHERE cache_key = ?"
  ).get(cacheKey) as Pick<CacheRow, "local_file_path" | "local_web_path" | "cached_at" | "last_refresh_at" | "refresh_after"> | undefined;

  // Skip only when the fresh on-disk file already matches the fetched bytes.
  // This lets us replace stale placeholder art after changing Grimmory cover
  // endpoints without rewriting unchanged images on every sync.
  if (row?.local_web_path && isFresh(row) && fs.existsSync(row.local_file_path ?? "")) {
    try {
      const existing = fs.readFileSync(row.local_file_path!);
      if (existing.equals(data)) return row.local_web_path;
    } catch {
      // Fall through and rewrite if the existing file can't be read.
    }
  }

  ensureCacheDir();
  const filename = `${crypto.randomUUID()}.jpg`;
  const filePath = path.join(CACHE_DIR, filename);
  const webPath = `/images/${filename}`;

  try {
    atomicWrite(filePath, data);
  } catch (err) {
    logger.warn("ImageCache: failed to write Grimmory cover to disk", {
      cacheKey, error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }

  if (row?.local_file_path && row.local_file_path !== filePath) {
    try { fs.unlinkSync(row.local_file_path); } catch { /* best-effort */ }
  }

  const now = new Date().toISOString();
  // Grimmory covers are fetched with a live token. The daily authenticated
  // refresh job checks them again after the shared seven-day freshness window.
  const refreshAfter = computeRefreshAfter();

  getDb().prepare(`
    INSERT INTO image_cache (cache_key, entity_id, source_url, local_file_path, local_web_path,
      cached_at, last_refresh_at, refresh_after)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      local_file_path = excluded.local_file_path,
      local_web_path = excluded.local_web_path,
      last_refresh_at = excluded.last_refresh_at,
      refresh_after = excluded.refresh_after,
      last_error = NULL
  `).run(cacheKey, entityId, filePath, webPath, now, now, refreshAfter);

  logger.info("ImageCache: Grimmory cover cached", { cacheKey, webPath });
  return webPath;
}

/**
 * Ensure a book cover is cached locally. Returns the local web path or null.
 *
 * - Fresh hit  → return immediately, no fetch
 * - Stale hit  → return existing path, refresh in background
 * - Miss       → fetch inline and return path, or null on failure
 */
export async function ensureCoverCached(bookLinkId: number, sourceUrl: string): Promise<string | null> {
  const cacheKey = `cover:${bookLinkId}`;

  const row = getDb().prepare(
    "SELECT source_url, local_file_path, local_web_path, cached_at, last_refresh_at, refresh_after FROM image_cache WHERE cache_key = ?"
  ).get(cacheKey) as CacheRow | undefined;

  if (row?.local_web_path) {
    const fileExists = fs.existsSync(row.local_file_path ?? "");

    if (!fileExists) {
      // File gone from disk — re-fetch inline
      logger.warn("ImageCache: cached file missing on disk, re-fetching", { cacheKey });
    } else if (isFresh(row)) {
      // A changed URL is a strong signal that the upstream cover changed, so
      // refresh early while still serving the existing local file.
      if (row.source_url !== sourceUrl) {
        getDb().prepare("UPDATE image_cache SET source_url = ? WHERE cache_key = ?").run(sourceUrl, cacheKey);
        enqueueImageCacheTask(`${cacheKey}:refresh`, async () => {
          await refreshInBackground(cacheKey, String(bookLinkId), sourceUrl, row.local_file_path);
        });
      }
      return row.local_web_path;
    } else {
      // Stale — serve existing, refresh in background
      logger.debug("ImageCache: cover stale, serving existing while refreshing", { cacheKey });
      if (row.source_url !== sourceUrl) {
        getDb().prepare("UPDATE image_cache SET source_url = ? WHERE cache_key = ?").run(sourceUrl, cacheKey);
      }
      enqueueImageCacheTask(`${cacheKey}:refresh`, async () => {
        await refreshInBackground(cacheKey, String(bookLinkId), sourceUrl, row.local_file_path);
      });
      return row.local_web_path;
    }
  }

  // Cache miss or file missing — fetch inline
  return fetchAndStore(cacheKey, String(bookLinkId), sourceUrl);
}

/** Return an existing on-disk cached cover without initiating network work. */
export function getCachedCoverPath(bookLinkId: number): string | null {
  const row = getDb().prepare(
    "SELECT local_file_path, local_web_path FROM image_cache WHERE cache_key = ?"
  ).get(`cover:${bookLinkId}`) as Pick<CacheRow, "local_file_path" | "local_web_path"> | undefined;

  if (!row?.local_web_path || !fs.existsSync(row.local_file_path ?? "")) return null;
  return row.local_web_path;
}
