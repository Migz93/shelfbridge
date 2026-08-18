import { getDb, getSetting } from "../db/index.js";
import { logger } from "../logger.js";
import { ensureCoverCached, getCachedCoverPath, storeFetchedCover } from "../image-cache.js";
import { getGrimmoryToken } from "./grimmory.js";
import { fetchIntegration } from "../security/outbound.js";
import { reconcileBookIdentities } from "../db/bookIdentity.js";
import { runExclusiveOfSyncs } from "./sync-queue.js";

type Db = ReturnType<typeof getDb>;
const MAX_COVER_BYTES = 20 * 1024 * 1024;

function looksLikeImage(data: Buffer): boolean {
  if (data.length < 4) return false;
  // Grimmory can return JPEG bytes with an application/json content type.
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return true;
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a") return true;
  return data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
}

async function fetchGrimmoryCoverFromPath(baseUrl: string, token: string, grimmoryBookId: number, path: string): Promise<Buffer | null> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  logger.info("Grimmory cover fetch attempt", { grimmoryBookId, url });
  const controller = new AbortController();
  let rejectTimeout!: (reason: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const timeout = setTimeout(() => { controller.abort(); rejectTimeout(new Error("Grimmory cover download timed out")); }, 15000);
  try {
    return await Promise.race([(async () => {
      const res = await fetchIntegration(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      if (!res.ok) { logger.warn("Grimmory cover fetch non-OK", { grimmoryBookId, status: res.status, url }); return null; }
      const reader = res.body?.getReader();
      if (!reader) return null;
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_COVER_BYTES) {
          await reader.cancel();
          logger.warn("Grimmory cover exceeds the size limit", { grimmoryBookId, url, totalBytes: total, limitBytes: MAX_COVER_BYTES });
          return null;
        }
        chunks.push(Buffer.from(value));
      }
      const data = Buffer.concat(chunks);
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/") && !looksLikeImage(data)) { logger.warn("Grimmory cover response is not an image", { grimmoryBookId, contentType, url }); return null; }
      return data;
    })(), deadline]);
  } catch (err) {
    logger.warn(controller.signal.aborted ? "Grimmory cover fetch timed out" : "Grimmory cover fetch failed", {
      grimmoryBookId, url, ...(controller.signal.aborted ? { timeoutMs: 15000 } : { error: err instanceof Error ? err.message : String(err) })
    });
    return null;
  } finally { clearTimeout(timeout); }
}

export async function fetchGrimmoryCoverBuffer(baseUrl: string, token: string, grimmoryBookId: number, mediaType: "physical" | "ebook" | "audiobook" | null = null): Promise<Buffer | null> {
  const paths = mediaType === "audiobook"
    ? [`/api/v1/media/book/${grimmoryBookId}/audiobook-cover`, `/api/v1/media/book/${grimmoryBookId}/cover`]
    : [`/api/v1/media/book/${grimmoryBookId}/cover`];
  for (const path of paths) {
    const data = await fetchGrimmoryCoverFromPath(baseUrl, token, grimmoryBookId, path);
    if (data) return data;
  }
  return null;
}

// Cover caching is a fire-and-forget background task (see enqueueImageCacheTask),
// entirely decoupled from the sync that queued it — it can finish during a
// sync, after one, or via the scheduled refresh job. Nothing else re-reconciles
// this source afterward, so book_sources.cover_cache_path landing here would
// otherwise never propagate into the canonical books.cover_cache_path (see
// bookIdentity.ts's canonicalValues/bestCoverRow) until the next unrelated
// reconcile touches this book. Serialized via runExclusiveOfSyncs since this
// can fire concurrently with an in-flight sync or the full-reconcile job.
async function reconcileCoverSource(db: Db, sourceId: number): Promise<void> {
  await runExclusiveOfSyncs(async () => {
    reconcileBookIdentities(db, { sourceIds: [sourceId] });
  });
}

export async function cacheSourceCover(db: Db, sourceId: number, sourceType: string, coverUrl: string): Promise<void> {
  try {
    const localPath = await ensureCoverCached(sourceId, coverUrl);
    if (localPath) {
      db.prepare("UPDATE book_sources SET cover_cache_path = ? WHERE id = ?").run(localPath, sourceId);
      logger.info("Cached source cover", { sourceType, sourceId });
      await reconcileCoverSource(db, sourceId);
    }
  } catch (err) { logger.warn("Failed to cache source cover", { sourceType, sourceId, coverUrl, error: err }); }
}

export async function cacheGrimmoryCover(db: Db, bookSourceId: number, baseUrl: string, token: string, grimmoryBookId: number, mediaType: "physical" | "ebook" | "audiobook" | null = null): Promise<void> {
  try {
    const cachedPath = getCachedCoverPath(bookSourceId);
    if (cachedPath) {
      db.prepare("UPDATE book_sources SET cover_cache_path = ? WHERE id = ?").run(cachedPath, bookSourceId);
      await reconcileCoverSource(db, bookSourceId);
      return;
    }
    const data = await fetchGrimmoryCoverBuffer(baseUrl, token, grimmoryBookId, mediaType);
    if (!data) { logger.info("No Grimmory cover available; leaving other source covers eligible", { bookSourceId, grimmoryBookId }); return; }
    const webPath = storeFetchedCover(bookSourceId, data);
    if (webPath) {
      db.prepare("UPDATE book_sources SET cover_cache_path = ? WHERE id = ?").run(webPath, bookSourceId);
      logger.info("Cached Grimmory source cover", { bookSourceId, grimmoryBookId });
      await reconcileCoverSource(db, bookSourceId);
    }
  } catch (err) { logger.warn("Failed to cache Grimmory source cover", { bookSourceId, grimmoryBookId, error: err }); }
}

/** Refreshes token-protected Grimmory covers, grouped by their source instance. */
export async function refreshStaleGrimmoryCovers(): Promise<void> {
  const db = getDb();
  const stale = db.prepare(`
    SELECT ic.entity_id, CAST(bs.external_id AS INTEGER) as grimmory_book_id, bs.source_instance_id
    FROM image_cache ic JOIN book_sources bs ON bs.id = CAST(ic.entity_id AS INTEGER)
    WHERE ic.source_url IS NULL AND bs.source_type = 'grimmory'
      AND (ic.last_refresh_at IS NULL OR ic.last_refresh_at < datetime('now', '-7 days'))
  `).all() as { entity_id: string; grimmory_book_id: number; source_instance_id: number | null }[];
  if (stale.length === 0) { logger.info("ImageCache: no stale Grimmory covers to refresh"); return; }
  const unscoped = stale.filter((row) => row.source_instance_id === null);
  if (unscoped.length) logger.warn("ImageCache: skipping stale Grimmory covers with no scoped instance (pre-v14 legacy rows)", { count: unscoped.length });
  const groups = new Map<number, { entity_id: string; grimmory_book_id: number }[]>();
  for (const row of stale) {
    if (row.source_instance_id === null) continue;
    const group = groups.get(row.source_instance_id) ?? [];
    group.push({ entity_id: row.entity_id, grimmory_book_id: row.grimmory_book_id });
    groups.set(row.source_instance_id, group);
  }
  if (groups.size === 0) return;
  logger.info("ImageCache: refreshing stale Grimmory covers", { count: stale.length - unscoped.length });
  let refreshed = 0;
  for (const [profileId, entries] of groups) {
    try {
      const conn = db.prepare(`
        SELECT g.base_url, g.username, g.password FROM grimmory_connections g
        JOIN profiles p ON p.id = g.profile_id
        WHERE g.profile_id = ? AND p.enabled = 1 AND g.username IS NOT NULL AND g.password IS NOT NULL
      `).get(profileId) as { base_url: string | null; username: string; password: string } | undefined;
      const baseUrl = conn?.base_url || getSetting("grimmory.baseUrl", "");
      if (!conn || !baseUrl) { logger.warn("ImageCache: no Grimmory connection available for cover refresh", { profileId }); continue; }
      const password = conn.password;
      if (!password) { logger.warn("ImageCache: no Grimmory password available for cover refresh", { profileId }); continue; }
      const token = await getGrimmoryToken(baseUrl, conn.username, password);
      if (!token) { logger.warn("ImageCache: Grimmory login failed, skipping cover refresh", { profileId }); continue; }
      for (const { entity_id, grimmory_book_id } of entries) {
        const sourceId = Number.parseInt(entity_id, 10);
        try {
          const source = db.prepare("SELECT source_media_type FROM book_sources WHERE id = ?").get(sourceId) as { source_media_type: "physical" | "ebook" | "audiobook" | null } | undefined;
          const data = await fetchGrimmoryCoverBuffer(baseUrl, token, grimmory_book_id, source?.source_media_type ?? null);
          if (!data) continue;
          const webPath = storeFetchedCover(sourceId, data);
          if (webPath) {
            db.prepare("UPDATE book_sources SET cover_cache_path = ? WHERE id = ?").run(webPath, sourceId);
            await reconcileCoverSource(db, sourceId);
            refreshed++;
          }
        } catch (error) {
          logger.warn("ImageCache: Grimmory cover refresh failed for source; continuing with others", { profileId, sourceId, error });
        }
      }
    } catch (error) { logger.warn("ImageCache: Grimmory cover refresh failed for instance; continuing with others", { profileId, error }); }
  }
  logger.info("ImageCache: Grimmory covers refreshed", { count: refreshed });
}
