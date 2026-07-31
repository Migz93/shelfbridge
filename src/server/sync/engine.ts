import { getDb, getSetting } from "../db/index.js";
import { reconcileBookIdentities } from "../db/bookIdentity.js";
import { logger } from "../logger.js";
import {
  fetchHardcoverUserId,
  fetchHardcoverLibrary,
  fetchHardcoverEditions,
  fetchHardcoverLists,
  fetchEditionsForBook,
  updateHardcoverUserBook,
  insertHardcoverUserBook,
  addBookToHardcoverList,
  insertHardcoverUserBookRead,
  updateHardcoverUserBookRead,
  deleteHardcoverUserBookRead,
  type HardcoverReadFields,
  type HardcoverEdition,
  type HardcoverUserBook
} from "./hardcover.js";
import {
  getGrimmoryToken,
  testGrimmoryLogin,
  fetchGrimmoryBooks,
  updateGrimmoryStatus,
  updateGrimmoryRating,
  grimmoryAuthorName,
  grimmoryRating,
  grimmoryCoverUrl,
  fetchGrimmoryShelfBookIds,
  ensureGrimmoryShelf,
  addBooksToGrimmoryShelf,
  fetchGrimmoryProgress,
  updateGrimmoryProgress,
  clearGrimmoryProgress,
  addGrimmoryTag,
  type GrimmoryBook
} from "./grimmory.js";
import {
  buildGrimmoryIndex,
  matchHardcoverBook,
  HARDCOVER_TO_GRIMMORY,
  GRIMMORY_TO_HARDCOVER,
  GOODREADS_TO_GRIMMORY
} from "./matcher.js";
import { fetchAllGoodreadsBooks, fetchShelfPage } from "./goodreads.js";
import { syncChaptarrStatus } from "./chaptarr.js";
import {
  fetchAudiobookshelfLibraries,
  fetchAudiobookshelfLibraryItems,
  fetchAudiobookshelfAllProgress
} from "./audiobookshelf.js";
import {
  enqueueImageCacheTask,
  ensureCoverCached,
  getCachedCoverPath,
  storeFetchedCover
} from "../image-cache.js";
import { decryptCredential } from "../security/credentials.js";
import { identifierVariants, normalizeExternalId } from "../identifiers.js";
import type { SyncStatus } from "../../shared/types.js";

// ── Source adapters ─────────────────────────────────────────────────────────
// Every network call runSyncImpl (and the shelf-sync helpers it calls) makes
// against Hardcover/Grimmory/Goodreads/Chaptarr/Audiobookshelf is routed through
// this object instead of the imported functions directly, so tests can substitute
// scripted fakes without hitting real HTTP. `defaultAdapters` wires up the real
// implementations and is what `runSync()` (the exported entry point) uses in
// production — this is a dependency-injection seam only, not a behavior change.
export interface SyncAdapters {
  fetchHardcoverUserId: typeof fetchHardcoverUserId;
  fetchHardcoverLibrary: typeof fetchHardcoverLibrary;
  fetchHardcoverEditions: typeof fetchHardcoverEditions;
  fetchHardcoverLists: typeof fetchHardcoverLists;
  fetchEditionsForBook: typeof fetchEditionsForBook;
  updateHardcoverUserBook: typeof updateHardcoverUserBook;
  insertHardcoverUserBook: typeof insertHardcoverUserBook;
  addBookToHardcoverList: typeof addBookToHardcoverList;
  insertHardcoverUserBookRead: typeof insertHardcoverUserBookRead;
  updateHardcoverUserBookRead: typeof updateHardcoverUserBookRead;
  deleteHardcoverUserBookRead: typeof deleteHardcoverUserBookRead;
  testGrimmoryLogin: typeof testGrimmoryLogin;
  fetchGrimmoryBooks: typeof fetchGrimmoryBooks;
  updateGrimmoryStatus: typeof updateGrimmoryStatus;
  updateGrimmoryRating: typeof updateGrimmoryRating;
  fetchGrimmoryShelfBookIds: typeof fetchGrimmoryShelfBookIds;
  ensureGrimmoryShelf: typeof ensureGrimmoryShelf;
  addBooksToGrimmoryShelf: typeof addBooksToGrimmoryShelf;
  fetchGrimmoryProgress: typeof fetchGrimmoryProgress;
  updateGrimmoryProgress: typeof updateGrimmoryProgress;
  clearGrimmoryProgress: typeof clearGrimmoryProgress;
  addGrimmoryTag: typeof addGrimmoryTag;
  fetchAllGoodreadsBooks: typeof fetchAllGoodreadsBooks;
  fetchShelfPage: typeof fetchShelfPage;
  syncChaptarrStatus: typeof syncChaptarrStatus;
  fetchAudiobookshelfLibraries: typeof fetchAudiobookshelfLibraries;
  fetchAudiobookshelfLibraryItems: typeof fetchAudiobookshelfLibraryItems;
  fetchAudiobookshelfAllProgress: typeof fetchAudiobookshelfAllProgress;
}

export const defaultAdapters: SyncAdapters = {
  fetchHardcoverUserId,
  fetchHardcoverLibrary,
  fetchHardcoverEditions,
  fetchHardcoverLists,
  fetchEditionsForBook,
  updateHardcoverUserBook,
  insertHardcoverUserBook,
  addBookToHardcoverList,
  insertHardcoverUserBookRead,
  updateHardcoverUserBookRead,
  deleteHardcoverUserBookRead,
  testGrimmoryLogin,
  fetchGrimmoryBooks,
  updateGrimmoryStatus,
  updateGrimmoryRating,
  fetchGrimmoryShelfBookIds,
  ensureGrimmoryShelf,
  addBooksToGrimmoryShelf,
  fetchGrimmoryProgress,
  updateGrimmoryProgress,
  clearGrimmoryProgress,
  addGrimmoryTag,
  fetchAllGoodreadsBooks,
  fetchShelfPage,
  syncChaptarrStatus,
  fetchAudiobookshelfLibraries,
  fetchAudiobookshelfLibraryItems,
  fetchAudiobookshelfAllProgress
};

const MAX_COVER_BYTES = 20 * 1024 * 1024;

function looksLikeImage(data: Buffer): boolean {
  if (data.length < 4) return false;
  // Grimmory v3.0.3 can return JPEG bytes with an application/json content type.
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return true;
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a") return true;
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return true;
  return false;
}

async function fetchGrimmoryCoverFromPath(baseUrl: string, token: string, grimmoryBookId: number, path: string): Promise<Buffer | null> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  logger.info("Grimmory cover fetch attempt", { grimmoryBookId, url });
  const controller = new AbortController();
  let rejectTimeout!: (reason: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const timeout = setTimeout(() => {
    controller.abort();
    rejectTimeout(new Error("Grimmory cover download timed out"));
  }, 15000);
  try {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal
        });
        if (!res.ok) {
          logger.warn("Grimmory cover fetch non-OK", { grimmoryBookId, status: res.status, url });
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
          if (total > MAX_COVER_BYTES) { await reader.cancel(); return null; }
          chunks.push(Buffer.from(value));
        }
        const data = Buffer.concat(chunks);
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.startsWith("image/") && !looksLikeImage(data)) {
          logger.warn("Grimmory cover response is not an image", { grimmoryBookId, contentType, url });
          return null;
        }
        return data;
      })(),
      deadline
    ]);
  } catch (err) {
    if (controller.signal.aborted) {
      logger.warn("Grimmory cover fetch timed out", { grimmoryBookId, url, timeoutMs: 15000 });
    } else {
      logger.warn("Grimmory cover fetch failed", {
        grimmoryBookId,
        url,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchGrimmoryCoverBuffer(
  baseUrl: string,
  token: string,
  grimmoryBookId: number,
  mediaType: "physical" | "ebook" | "audiobook" | null = null
): Promise<Buffer | null> {
  const candidatePaths = mediaType === "audiobook"
    ? [
        `/api/v1/media/book/${grimmoryBookId}/audiobook-cover`,
        `/api/v1/media/book/${grimmoryBookId}/cover`
      ]
    : [`/api/v1/media/book/${grimmoryBookId}/cover`];

  for (const path of candidatePaths) {
    const data = await fetchGrimmoryCoverFromPath(baseUrl, token, grimmoryBookId, path);
    if (data) return data;
  }
  return null;
}

async function cacheSourceCover(db: Db, sourceId: number, sourceType: string, coverUrl: string): Promise<void> {
  try {
    const localPath = await ensureCoverCached(sourceId, coverUrl);
    if (localPath) {
      db.prepare("UPDATE book_sources SET cover_cache_path = ? WHERE id = ?").run(localPath, sourceId);
      logger.info("Cached source cover", { sourceType, sourceId });
    }
  } catch (err) {
    logger.warn("Failed to cache source cover", { sourceType, sourceId, coverUrl, error: err });
  }
}

async function cacheGrimmoryCover(
  db: Db,
  bookSourceId: number,
  baseUrl: string,
  token: string,
  grimmoryBookId: number,
  mediaType: "physical" | "ebook" | "audiobook" | null = null
): Promise<void> {
  try {
    const cachedPath = getCachedCoverPath(bookSourceId);
    if (cachedPath) {
      db.prepare("UPDATE book_sources SET cover_cache_path = ? WHERE id = ?").run(cachedPath, bookSourceId);
      return;
    }
    const data = await fetchGrimmoryCoverBuffer(baseUrl, token, grimmoryBookId, mediaType);
    if (!data) {
      logger.info("No Grimmory cover available; leaving other source covers eligible", { bookSourceId, grimmoryBookId });
      return;
    }
    const webPath = storeFetchedCover(bookSourceId, data);
    if (webPath) {
      db.prepare("UPDATE book_sources SET cover_cache_path = ? WHERE id = ?").run(webPath, bookSourceId);
      logger.info("Cached Grimmory source cover", { bookSourceId, grimmoryBookId });
    }
  } catch (err) {
    logger.warn("Failed to cache Grimmory source cover", { bookSourceId, grimmoryBookId, error: err });
  }
}

export type ConflictStrategy = "latest_wins" | "grimmory_wins" | "hardcover_wins";

interface SyncCounters {
  written: number;
  skipped: number;
  superseded: number;
  sourceFailures: number;
}

// Snapshot of previous state for change detection — covers both user_book_states columns
interface UserStateSnapshot {
  id?: number;
  status?: string | null;
  rating?: number | null;
  progress?: number | null;
  hardcover_status_id?: number | null;
  hardcover_rating?: number | null;
  hardcover_progress?: number | null;
  hardcover_edition_id?: number | null;
  hardcover_edition_pages?: number | null;
  grimmory_book_id?: number | null;
  grimmory_primary_file_id?: number | null;
  goodreads_shelf?: string | null;
  goodreads_rating?: number | null;
  goodreads_read_at?: string | null;
  sync_health?: string | null;
  match_confidence?: string | null;
  last_modified_at?: string | null;
}

function sameValue(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

function sameNumber(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) < 0.001;
}

function positiveRating(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function grimmoryToHardcoverRating(value: number | null | undefined): number | null {
  const rating = positiveRating(value);
  if (rating === null) return null;
  const hardcoverRating = rating / 2;
  return Math.max(0.5, Math.min(5, hardcoverRating));
}

function hardcoverToGrimmoryRating(value: number | null | undefined): number | null {
  const rating = positiveRating(value);
  if (rating === null) return null;
  return Math.max(1, Math.min(10, rating * 2));
}

function hasMeaningfulHcChange(existing: UserStateSnapshot | undefined, next: {
  status?: string | null;
  rating?: number | null;
  progress?: number | null;
  hardcoverStatusId?: number | null;
  hardcoverRating?: number | null;
  hardcoverProgress?: number | null;
}): boolean {
  if (!existing) return true;
  return ("hardcoverStatusId" in next && !sameValue(existing.hardcover_status_id, next.hardcoverStatusId))
    || ("hardcoverRating" in next && !sameNumber(existing.hardcover_rating, next.hardcoverRating))
    || ("hardcoverProgress" in next && !sameNumber(existing.hardcover_progress, next.hardcoverProgress))
    || ("status" in next && !sameValue(existing.status, next.status))
    || ("rating" in next && !sameNumber(existing.rating, next.rating))
    || ("progress" in next && !sameNumber(existing.progress, next.progress));
}

function hasMeaningfulGrChange(existing: UserStateSnapshot | undefined, next: {
  status?: string | null;
  rating?: number | null;
  progress?: number | null;
}): boolean {
  if (!existing) return true;
  return ("status" in next && !sameValue(existing.status, next.status))
    || ("rating" in next && !sameNumber(existing.rating, next.rating))
    || ("progress" in next && !sameNumber(existing.progress, next.progress));
}

function hasMeaningfulGoodreadsChange(existing: UserStateSnapshot | undefined, next: {
  goodreadsShelf?: string | null;
  goodreadsRating?: number | null;
  goodreadsReadAt?: string | null;
}): boolean {
  if (!existing) return true;
  return ("goodreadsShelf" in next && !sameValue(existing.goodreads_shelf, next.goodreadsShelf))
    || ("goodreadsRating" in next && !sameNumber(existing.goodreads_rating, next.goodreadsRating))
    || ("goodreadsReadAt" in next && !sameValue(existing.goodreads_read_at, next.goodreadsReadAt));
}

function hardcoverDate(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null;
}

function hardcoverPages(hcBook: HardcoverUserBook): number | null {
  // 1. Prefer the explicit edition page count if Hardcover returned it.
  const readEditionPages = hcBook.user_book_reads?.[0]?.edition?.pages;
  if (readEditionPages != null && readEditionPages > 0) return readEditionPages;

  // 2. Reverse-derive the page count Hardcover is actually using from the read's own
  // progress% and progress_pages. Hardcover computes read.progress = progress_pages / edition_pages,
  // so edition_pages = round(progress_pages / (progress / 100)). This works even when
  // the read has no explicit edition_id, and guarantees our page→% conversion matches
  // what Hardcover will return.
  const read = hcBook.user_book_reads?.[0];
  if (read?.progress != null && read.progress > 0 && read.progress_pages != null && read.progress_pages > 0) {
    const derived = Math.round(read.progress_pages / (read.progress / 100));
    if (derived > 0) return derived;
  }

  return hcBook.book.default_physical_edition?.pages ?? hcBook.book.pages ?? null;
}

function firstHardcoverSeries(hcBook: HardcoverUserBook): { name: string | null; number: string | null } {
  const seriesBook = hcBook.book.book_series
    ?.find((entry) => entry.series?.name?.trim());
  return {
    name: seriesBook?.series?.name?.trim() || null,
    number: seriesBook?.position == null ? null : String(seriesBook.position).trim() || null
  };
}

function latestHardcoverRead(
  hcBook: HardcoverUserBook,
  preferredEditionId: number | null = null
): NonNullable<HardcoverUserBook["user_book_reads"]>[number] | null {
  const reads = hcBook.user_book_reads;
  if (!reads || reads.length === 0) return null;
  // On a Hardcover book shared by multiple editions (e.g. a print copy and an
  // audiobook), the read with the highest id is not necessarily the one for
  // the edition we're actually tracking here — reads are ordered purely by
  // creation id, so an older-dated read that was simply touched/recreated
  // more recently can outrank the genuinely current one. Prefer a read on the
  // edition we know we care about when we have one; fall back to the
  // highest-id read otherwise (single-edition books, or no hint available).
  if (preferredEditionId !== null) {
    const editionMatch = reads.find((read) => read.edition_id === preferredEditionId);
    if (editionMatch) return editionMatch;
  }
  return reads[0] ?? null;
}

type HardcoverRead = NonNullable<HardcoverUserBook["user_book_reads"]>[number];

function hardcoverReadHasProgress(read: HardcoverRead): boolean {
  return read.progress !== null || read.progress_pages !== null || read.progress_seconds !== null;
}

function duplicateReadKey(read: HardcoverRead): string | null {
  if (!read.started_at || read.finished_at !== null) return null;
  return `${read.edition_id ?? "no-edition"}:${read.started_at}`;
}

function findDuplicateBlankHardcoverReads(hcBook: HardcoverUserBook): HardcoverRead[] {
  const reads = hcBook.user_book_reads ?? [];
  if (reads.length < 2) return [];

  const groups = new Map<string, HardcoverRead[]>();
  for (const read of reads) {
    const key = duplicateReadKey(read);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(read);
    groups.set(key, group);
  }

  const duplicates: HardcoverRead[] = [];
  for (const group of groups.values()) {
    const progressedReads = group.filter(hardcoverReadHasProgress);
    if (progressedReads.length === 0) continue;
    duplicates.push(...group.filter((read) => !hardcoverReadHasProgress(read)));
  }

  return duplicates;
}

async function cleanupDuplicateBlankHardcoverReads(opts: {
  db: Db;
  runId: number;
  profileId: number;
  title: string;
  bookId: number;
  hcBook: HardcoverUserBook;
  hardcoverToken: string;
  dryRun: boolean;
  counters: SyncCounters;
  adapters: SyncAdapters;
}): Promise<void> {
  const duplicates = findDuplicateBlankHardcoverReads(opts.hcBook);
  if (duplicates.length === 0) return;

  const duplicateIds = new Set(duplicates.map((read) => read.id));
  if (opts.dryRun) {
    recordEvent(opts.db, opts.runId, opts.profileId, opts.title, "written", "hardcover_cleanup", "would_delete_duplicate_blank_read", {
      hardcoverUserBookId: opts.hcBook.id,
      duplicateReadIds: Array.from(duplicateIds)
    });
    opts.counters.written++;
    return;
  }

  const deletedReadIds: number[] = [];
  for (const read of duplicates) {
    try {
      await opts.adapters.deleteHardcoverUserBookRead(opts.hardcoverToken, read.id);
      deletedReadIds.push(read.id);
      logger.info("Deleted duplicate blank Hardcover read", {
        profileId: opts.profileId,
        bookId: opts.bookId,
        hardcoverUserBookId: opts.hcBook.id,
        hardcoverReadId: read.id,
        editionId: read.edition_id,
        startedAt: read.started_at
      });
    } catch (err) {
      logger.warn("Failed to delete duplicate blank Hardcover read", {
        profileId: opts.profileId,
        bookId: opts.bookId,
        hardcoverUserBookId: opts.hcBook.id,
        hardcoverReadId: read.id,
        error: err
      });
      recordEvent(opts.db, opts.runId, opts.profileId, opts.title, "api_failure", "hardcover_cleanup", "delete_duplicate_blank_read_failed", {
        hardcoverUserBookId: opts.hcBook.id,
        hardcoverReadId: read.id,
        error: String(err)
      });
    }
  }

  if (deletedReadIds.length === 0) return;

  opts.hcBook.user_book_reads = (opts.hcBook.user_book_reads ?? []).filter((read) => !duplicateIds.has(read.id));
  recordEvent(opts.db, opts.runId, opts.profileId, opts.title, "written", "hardcover_cleanup", "deleted_duplicate_blank_read", {
    hardcoverUserBookId: opts.hcBook.id,
    deletedReadIds
  });
  opts.counters.written++;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function meaningfulProgress(percent: number | null | undefined): number | null {
  return typeof percent === "number" && Number.isFinite(percent) && percent > 0.001
    ? clampPercent(percent)
    : null;
}

// Scoped to this profile's own ABS/Hardcover instances — this runtime feeds the
// progress percentage used for this profile's outbound writes, so another
// profile's (possibly different) audiobook runtime must not leak in.
function audiobookRuntimeForBook(db: ReturnType<typeof getDb>, profileId: number, bookId: number): number | null {
  const row = db.prepare(`
    SELECT COALESCE(
      MAX(CASE WHEN source_type = 'audiobookshelf' AND source_instance_id = ? THEN audiobookshelf_duration END),
      MAX(CASE WHEN source_type = 'hardcover' AND source_instance_id = ? THEN hardcover_audio_seconds END)
    ) AS runtime_seconds
    FROM book_sources
    WHERE book_id = ?
  `).get(profileId, profileId, bookId) as { runtime_seconds: number | null } | undefined;
  return row?.runtime_seconds && row.runtime_seconds > 0 ? row.runtime_seconds : null;
}

function hardcoverProgressPercent(hcBook: HardcoverUserBook, audiobookRuntimeSeconds: number | null = null, preferredEditionId: number | null = null): number | null {
  const read = latestHardcoverRead(hcBook, preferredEditionId);
  const progressFromSeconds = typeof read?.progress_seconds === "number"
    && read.progress_seconds > 0
    && audiobookRuntimeSeconds
    && audiobookRuntimeSeconds > 0
    ? meaningfulProgress((read.progress_seconds / audiobookRuntimeSeconds) * 100)
    : null;

  if (typeof read?.progress === "number") {
    const directProgress = meaningfulProgress(read.progress);
    if (directProgress !== null || progressFromSeconds === null) return directProgress;
    return progressFromSeconds;
  }
  const pages = hardcoverPages(hcBook);
  if (typeof read?.progress_pages === "number" && pages && pages > 0) {
    return meaningfulProgress((read.progress_pages / pages) * 100);
  }
  return progressFromSeconds;
}

function effectiveAbsCurrentTimeSeconds(absProgress: { currentTime: number; progress: number }, duration: number | null): number {
  const derivedSeconds = duration && duration > 0 && absProgress.progress > 0
    ? Math.round(absProgress.progress * duration)
    : 0;

  if (absProgress.currentTime > 0) {
    // ABS can report a non-zero currentTime that disagrees substantially with the
    // percentage and duration for the same progress row. For outbound audiobook
    // sync, prefer the normalized seconds derived from progress × duration when
    // the mismatch is material, otherwise we keep rewriting the same HC state.
    if (derivedSeconds > 0 && Math.abs(Math.round(absProgress.currentTime) - derivedSeconds) > 30) {
      return derivedSeconds;
    }
    return Math.round(absProgress.currentTime);
  }

  if (derivedSeconds > 0) {
    return derivedSeconds;
  }

  return 0;
}

function persistResolvedHardcoverAudioEdition(
  db: ReturnType<typeof getDb>,
  profileId: number,
  bookId: number,
  editionId: number | null
): void {
  if (!editionId || editionId <= 0) return;
  // Scoped to this profile's own Hardcover instance — each profile can track a
  // different edition of the same shared book.
  db.prepare(`
    UPDATE book_sources
    SET source_edition_id = ?, source_media_type = 'audiobook', last_modified_at = datetime('now')
    WHERE source_type = 'hardcover' AND source_instance_id = ? AND book_id = ?
      AND (source_edition_id IS NULL OR source_edition_id != ? OR source_media_type IS NULL OR source_media_type != 'audiobook')
  `).run(String(editionId), profileId, bookId, String(editionId));
}

function progressPagesFromPercent(percent: number, pages: number | null): number | null {
  if (!pages || pages <= 0) return null;
  return Math.max(0, Math.min(pages, Math.round((percent / 100) * pages)));
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// Matches SQLite's datetime('now') format ("YYYY-MM-DD HH:MM:SS", UTC) so values
// generated in application code sort and compare identically to ones set in raw SQL.
function sqliteNow(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function sourceTagName(username: string | null, displayName: string | null): string {
  const rawName = (username?.trim() || displayName?.trim() || "user").toLowerCase();
  const safeName = rawName
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "user";
  return `shelfbridge-${safeName}`;
}

export function newerSource(hardcoverTime: string | null, grimmoryTime: string | null): "hardcover" | "grimmory" | null {
  if (!hardcoverTime || !grimmoryTime) return null;
  const hardcoverMs = Date.parse(hardcoverTime);
  const grimmoryMs = Date.parse(grimmoryTime);
  if (Number.isNaN(hardcoverMs) || Number.isNaN(grimmoryMs)) {
    return hardcoverTime >= grimmoryTime ? "hardcover" : "grimmory";
  }
  return hardcoverMs >= grimmoryMs ? "hardcover" : "grimmory";
}

export function shouldGoodreadsOverwriteGrimmory(goodreadsTime: string | null, grimmoryTime: string | null): boolean {
  if (!grimmoryTime) return true;
  if (!goodreadsTime) return false;
  return newerSource(goodreadsTime, grimmoryTime) === "hardcover";
}

function hardcoverFieldsFromGrimmory(grBook: GrimmoryBook): { status_id?: number; last_read_date?: string | null } | null {
  const statusId = grBook.readStatus ? GRIMMORY_TO_HARDCOVER[grBook.readStatus] : undefined;
  if (!statusId) return null;
  return {
    status_id: statusId,
    ...(grBook.readStatus === "READ" ? { last_read_date: hardcoverDate(grBook.dateFinished) } : {})
  };
}

function isActivelyReadingStatus(status: string | null | undefined): boolean {
  return status === "READING" || status === "RE_READING" || status === "PARTIALLY_READ";
}

function hardcoverIdForGrimmoryBook(book: GrimmoryBook): string | null {
  return normalizeExternalId(book.hardcoverBookId) ?? null;
}

function activeGrimmorySiblingsForHardcover(grimmoryBooks: GrimmoryBook[], hardcoverBookId: number | string): {
  book: GrimmoryBook | null;
  audiobook: GrimmoryBook | null;
} {
  const normalizedHardcoverId = normalizeExternalId(hardcoverBookId);
  if (!normalizedHardcoverId) return { book: null, audiobook: null };

  const active = grimmoryBooks.filter((book) =>
    hardcoverIdForGrimmoryBook(book) === normalizedHardcoverId
      && isActivelyReadingStatus(book.readStatus)
  );

  return {
    book: active.find((book) => book.mediaType !== "audiobook") ?? null,
    audiobook: active.find((book) => book.mediaType === "audiobook") ?? null
  };
}

function shouldBookProgressOwnSharedHardcover(grimmoryBooks: GrimmoryBook[], hardcoverBookId: number | string | null | undefined): boolean {
  if (hardcoverBookId === null || hardcoverBookId === undefined) return false;
  const siblings = activeGrimmorySiblingsForHardcover(grimmoryBooks, hardcoverBookId);
  return siblings.book !== null && siblings.audiobook !== null;
}

function normalizeEditionFormat(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function inferHardcoverMediaType(
  hcBook: HardcoverUserBook,
  edition: HardcoverEdition | null | undefined
): "physical" | "ebook" | "audiobook" | null {
  const editionId = hcBook.edition_id;
  const format = edition?.edition_format?.toLowerCase() ?? "";

  // Trust an explicit edition format over Hardcover's default_*_edition_id
  // pointers. Some books currently expose the same edition ID as physical,
  // ebook, and audio defaults simultaneously, which would otherwise cause a
  // clearly-ebook edition to be misbucketed as an audiobook.
  if (format.includes("ebook") || format.includes("kindle")) return "ebook";
  if (format.includes("hardcover") || format.includes("paperback") || format.includes("physical")) return "physical";
  if (format.includes("audio") || format.includes("audible") || format.includes("mp3")) return "audiobook";

  if (editionId && editionId === hcBook.book.default_audio_edition_id) return "audiobook";
  if (editionId && editionId === hcBook.book.default_ebook_edition_id) return "ebook";
  if (editionId && editionId === hcBook.book.default_physical_edition_id) return "physical";
  return null;
}

function hasGrimmoryUserActivity(book: GrimmoryBook): boolean {
  return book.readStatus !== null
    || grimmoryRating(book) !== null
    || book.readProgress !== null
    || book.lastReadTime !== null
    || book.dateFinished !== null;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

type Db = ReturnType<typeof import("../db/index.js").getDb>;

/**
 * Look up an existing book_sources row by (source_type, source_instance_id, external_id).
 * source_instance_id scopes ownership to the connection (profile) that produced the row,
 * so two configured instances of the same integration can reuse the same external_id
 * without colliding.
 */
function getBookSource(db: Db, sourceType: string, instanceId: number, externalId: string | number): { id: number; book_id: number | null; source_media_type: string | null; source_edition_id: string | null } | undefined {
  return db.prepare(
    "SELECT id, book_id, source_media_type, source_edition_id FROM book_sources WHERE source_type = ? AND source_instance_id = ? AND external_id = ?"
  ).get(sourceType, instanceId, String(externalId)) as { id: number; book_id: number | null; source_media_type: string | null; source_edition_id: string | null } | undefined;
}

/** Look up a user_book_states row by (book_id, profile_id, source_type) */
function getUserState(db: Db, bookId: number, profileId: number, sourceType: string): UserStateSnapshot | undefined {
  return db.prepare(
    "SELECT * FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = ?"
  ).get(bookId, profileId, sourceType) as UserStateSnapshot | undefined;
}

function localGrimmoryBookForBookId(db: Db, profileId: number, bookId: number, grimmoryBooks: GrimmoryBook[]): GrimmoryBook | null {
  const rows = db.prepare(`
    SELECT CAST(external_id AS INTEGER) AS grimmory_book_id
    FROM book_sources
    WHERE source_type = 'grimmory' AND source_instance_id = ? AND book_id = ?
  `).all(profileId, bookId) as { grimmory_book_id: number }[];

  for (const row of rows) {
    const book = grimmoryBooks.find((candidate) => candidate.id === row.grimmory_book_id);
    if (book) return book;
  }
  return null;
}

/** Upsert a book_sources row, scoped to (source_type, source_instance_id, external_id). Returns the row id. */
function upsertBookSource(db: Db, sourceType: string, instanceId: number, externalId: string | number, fields: Record<string, unknown>): number {
  const existing = getBookSource(db, sourceType, instanceId, externalId);
  if (existing) {
    const setClauses = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
    db.prepare(`UPDATE book_sources SET ${setClauses}, last_modified_at = datetime('now') WHERE id = ?`)
      .run(...Object.values(fields), existing.id);
    return existing.id;
  } else {
    const cols = ["source_type", "source_instance_id", "external_id", ...Object.keys(fields)].join(", ");
    const placeholders = Array(Object.keys(fields).length + 3).fill("?").join(", ");
    const result = db.prepare(`INSERT INTO book_sources (${cols}) VALUES (${placeholders})`)
      .run(sourceType, instanceId, String(externalId), ...Object.values(fields));
    return Number(result.lastInsertRowid);
  }
}

function audiobookCandidateWhereSql(): string {
  return `book_id IS NOT NULL AND (
    source_media_type = 'audiobook'
    OR hardcover_audio_seconds IS NOT NULL
    OR audiobookshelf_asin IS NOT NULL
    OR LOWER(COALESCE(source_edition_format, '')) LIKE '%audio%'
    OR LOWER(COALESCE(grimmory_primary_file_path, '')) LIKE '%.m4b'
    OR LOWER(COALESCE(grimmory_primary_file_path, '')) LIKE '%.mp3'
    OR LOWER(COALESCE(grimmory_primary_file_path, '')) LIKE '%.m4a'
    OR LOWER(COALESCE(grimmory_primary_file_path, '')) LIKE '%.aac'
    OR LOWER(COALESCE(chaptarr_primary_file_path, '')) LIKE '%.m4b'
    OR LOWER(COALESCE(chaptarr_primary_file_path, '')) LIKE '%.mp3'
    OR LOWER(COALESCE(chaptarr_primary_file_path, '')) LIKE '%.m4a'
    OR LOWER(COALESCE(chaptarr_primary_file_path, '')) LIKE '%.aac'
  )`;
}

// ── Main sync entry point ─────────────────────────────────────────────────────

// Serialise all profile syncs — reconcileBookIdentities mutates shared global
// state and concurrent runs produce merge/remap collisions.
let syncQueue = Promise.resolve();
const activeSyncRuns = new Map<number, { profileId: number; startedAt: string }>();

export function getActiveSyncStatus(): SyncStatus {
  const rows = Array.from(activeSyncRuns.entries()).map(([runId, run]) => ({
    runId,
    ...run
  })).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId - b.runId);

  return {
    isRunning: rows.length > 0,
    runIds: rows.map((row) => row.runId),
    profileIds: Array.from(new Set(rows.map((row) => row.profileId))),
    startedAt: rows[0]?.startedAt ?? null
  };
}

export function runSync(profileId: number, runId: number, dryRun: boolean): Promise<void> {
  activeSyncRuns.set(runId, { profileId, startedAt: new Date().toISOString() });
  const result = syncQueue
    .then(() => runSyncImpl(profileId, runId, dryRun))
    .finally(() => {
      activeSyncRuns.delete(runId);
    });
  syncQueue = result.catch(() => {});
  return result;
}

export async function runSyncImpl(
  profileId: number,
  runId: number,
  dryRun: boolean,
  adapters: SyncAdapters = defaultAdapters
): Promise<void> {
  const db = getDb();

  try {
    logger.info("Sync started", { profileId, runId, dryRun });

    const profile = db.prepare(`
      SELECT p.*, g.username, g.encrypted_password, g.base_url as grimmory_base_url,
             h.encrypted_api_token as hardcover_token,
             h.sync_list_id as hardcover_sync_list_id,
             h.sync_list_name as hardcover_sync_list_name,
             h.target_shelf_name as hardcover_target_shelf_name,
             gr.goodreads_user_id, gr.enabled as goodreads_enabled,
             gr.sync_shelf_name as goodreads_sync_shelf_name,
             gr.target_shelf_name as goodreads_target_shelf_name,
             ss.sync_status_enabled, ss.sync_progress_enabled,
             ss.sync_shelves_enabled, ss.sync_goodreads_enabled,
             ss.sync_goodreads_status_enabled, ss.sync_goodreads_shelves_enabled,
             ss.sync_write_tag_enabled,
             ss.conflict_strategy,
             abs_conn.encrypted_api_key as abs_encrypted_api_key
      FROM profiles p
      LEFT JOIN grimmory_connections g ON g.profile_id = p.id
      LEFT JOIN hardcover_connections h ON h.profile_id = p.id
      LEFT JOIN goodreads_connections gr ON gr.profile_id = p.id
      LEFT JOIN sync_settings ss ON ss.profile_id = p.id
      LEFT JOIN audiobookshelf_connections abs_conn ON abs_conn.profile_id = p.id
      WHERE p.id = ?
    `).get(profileId) as Record<string, unknown> | undefined;

    if (!profile) throw new Error(`Profile ${profileId} not found`);

    const baseUrl = (profile["grimmory_base_url"] as string | null) || getSetting("grimmory.baseUrl", "");
    const username = profile["username"] as string | null;
    const password = decryptCredential(profile["encrypted_password"] as string | null);
    const hardcoverToken = decryptCredential(profile["hardcover_token"] as string | null);
    const conflictStrategy = (profile["conflict_strategy"] as ConflictStrategy | null)
      ?? (getSetting("sync.conflictStrategy", "latest_wins") as ConflictStrategy);
    const writeTagEnabled = !!(profile["sync_write_tag_enabled"] as number | null);
    const writeTagName = sourceTagName(username, profile["display_name"] as string | null);

    const hasGrimmory = !!(baseUrl && username && password);
    const hasHardcover = !!hardcoverToken;

    const absBaseUrl = getSetting("audiobookshelf.baseUrl", "");
    const absApiKey = decryptCredential(profile["abs_encrypted_api_key"] as string | null);
    const hasAbs = !!(absBaseUrl && absApiKey);

    const counters: SyncCounters = { written: 0, skipped: 0, superseded: 0, sourceFailures: 0 };
    // ── Phase A: Fetch all libraries ────────────────────────────────────────

    let hcBooks: HardcoverUserBook[] = [];
    let hcEditions = new Map<number, HardcoverEdition>();
    let hcLists: Awaited<ReturnType<typeof fetchHardcoverLists>> = [];

    if (hasHardcover) {
      try {
        logger.info("Fetching Hardcover user ID", { profileId });
        const hardcoverUserId = await adapters.fetchHardcoverUserId(hardcoverToken);

        logger.info("Fetching Hardcover library", { profileId, hardcoverUserId });
        hcBooks = await adapters.fetchHardcoverLibrary(hardcoverToken, hardcoverUserId);
        logger.info("Hardcover library fetched", { profileId, count: hcBooks.length });

        logger.info("Fetching Hardcover lists", { profileId });
        hcLists = await adapters.fetchHardcoverLists(hardcoverToken);
        logger.info("Hardcover lists fetched", { profileId, count: hcLists.length });
      } catch (err) {
        logger.error("Hardcover unavailable; aborting sync before local data changes", { profileId, error: err });
        recordEvent(db, runId, profileId, "Hardcover", "api_failure", "hardcover", "source_unavailable", {
          source: "hardcover", error: String(err)
        });
        throw err;
      }

      const hardcoverSyncListId = profile["hardcover_sync_list_id"] as string | null;
      const hardcoverSyncListName = profile["hardcover_sync_list_name"] as string | null;

      let listsForListOnlyBooks = hcLists;
      if (hardcoverSyncListId?.trim()) {
        const selectedList = hcLists.find((list) => String(list.id) === hardcoverSyncListId);
        if (!selectedList) {
          throw new Error(`Selected Hardcover sync list was not found: ${hardcoverSyncListName ?? hardcoverSyncListId}`);
        }
        listsForListOnlyBooks = [selectedList];
      }

      const libraryBookIds = new Set(hcBooks.map((b) => b.book.id));
      const listOnlyBooksById = new Map<number, { book: HardcoverUserBook["book"]; editionId: number | null; edition: HardcoverEdition | null }>();
      for (const list of listsForListOnlyBooks) {
        for (const entry of list.entries) {
          const book = entry.book;
          if (!libraryBookIds.has(book.id) && !listOnlyBooksById.has(book.id)) {
            listOnlyBooksById.set(book.id, entry);
          }
        }
      }

      if (listOnlyBooksById.size > 0) {
        const stubs: HardcoverUserBook[] = Array.from(listOnlyBooksById.values()).map((entry) => ({
          id: 0,
          edition_id: entry.editionId,
          status_id: null,
          rating: null,
          updated_at: null,
          first_started_reading_date: null,
          last_read_date: null,
          book: entry.book,
          user_book_reads: null
        }));
        hcBooks = [...hcBooks, ...stubs];
        for (const entry of listOnlyBooksById.values()) {
          if (entry.editionId && entry.edition) hcEditions.set(entry.editionId, entry.edition);
        }
        logger.info("Added list-only Hardcover books", { profileId, count: stubs.length });
      }

      if (hardcoverSyncListId?.trim()) {
        const selectedList = listsForListOnlyBooks[0]!;
        const allowedBookIds = new Set(selectedList.bookIds);
        const beforeCount = hcBooks.length;
        hcBooks = hcBooks.filter((book) => allowedBookIds.has(book.book.id));
        logger.info("Hardcover sync list applied", {
          profileId, listId: selectedList.id, listName: selectedList.name,
          beforeCount, afterCount: hcBooks.length
        });
      }

      const editionIds = hcBooks.map((book) => book.edition_id ?? 0).filter((id) => id > 0);
      if (editionIds.length > 0) {
        try {
          hcEditions = await adapters.fetchHardcoverEditions(hardcoverToken, editionIds);
          logger.info("Hardcover edition details fetched", { profileId, requested: editionIds.length, fetched: hcEditions.size });
        } catch (err) {
          logger.warn("Hardcover edition detail fetch failed; falling back to default edition metadata", { profileId, error: err });
        }
      }
    } else {
      logger.info("Skipping Hardcover sync source because no API token is configured", { profileId });
    }

    let grimmoryToken: string | null = null;
    let grimmoryBooks: GrimmoryBook[] = [];
    let grimmoryAvailable = false;

    if (hasGrimmory) {
      logger.info("Authenticating with Grimmory", { profileId, username });
      const loginResult = await adapters.testGrimmoryLogin(baseUrl, username!, password!);
      grimmoryToken = loginResult.accessToken ?? null;
      if (!loginResult.ok || !grimmoryToken) {
        counters.sourceFailures++;
        const eventType = loginResult.message.toLowerCase().includes("login failed") ? "credential_failure" : "api_failure";
        logger.warn("Grimmory unavailable; preserving Grimmory data for this sync run", { profileId, message: loginResult.message });
        recordEvent(db, runId, profileId, "Grimmory", eventType, "grimmory", "source_unavailable", {
          source: "grimmory", message: loginResult.message
        });
      } else {
        try {
          logger.info("Fetching Grimmory library", { profileId });
          grimmoryBooks = await adapters.fetchGrimmoryBooks(baseUrl, grimmoryToken);
          grimmoryAvailable = true;
          logger.info("Grimmory library fetched", { profileId, count: grimmoryBooks.length });
        } catch (err) {
          counters.sourceFailures++;
          grimmoryToken = null;
          logger.warn("Grimmory library fetch failed; preserving Grimmory data for this sync run", { profileId, error: err });
          recordEvent(db, runId, profileId, "Grimmory", "api_failure", "grimmory", "source_unavailable", {
            source: "grimmory", error: String(err)
          });
        }
      }
    }

    // Fetch Grimmory progress (needed for Phase B Grimmory user state)
    const grimmoryProgressById = new Map<number, { readProgress: number | null; lastReadTime: string | null; readStatus: string | null }>();
    if (grimmoryAvailable && grimmoryToken && profile["sync_progress_enabled"] !== 0) {
      for (const grBook of grimmoryBooks) {
        try {
          const progress = await adapters.fetchGrimmoryProgress(baseUrl, grimmoryToken, grBook.id);
          grimmoryProgressById.set(grBook.id, progress);
          grBook.readProgress = progress.readProgress;
          grBook.lastReadTime = progress.lastReadTime ?? grBook.lastReadTime ?? null;
        } catch (err) {
          logger.warn("Failed to fetch Grimmory progress", { profileId, grimmoryBookId: grBook.id, error: err });
        }
      }
    }

    // Books with a runtime-validated Audiobookshelf link are ABS-owned: ABS is
    // the source of truth for their listening progress and status (Phase N).
    // Computed from the DB as it stood at the end of the previous run — a
    // stable snapshot — rather than anything derived from Hardcover's data
    // this run, because Hardcover's "current edition" on a shared book can
    // flip (e.g. editing any read record on it appears to retarget it) and
    // must not be allowed to bounce this book's format classification between
    // audiobook and print from one sync to the next.
    const absOwnedBookIds = new Set(
      (db.prepare(`
        SELECT DISTINCT book_id FROM book_sources
        WHERE source_type = 'audiobookshelf' AND book_id IS NOT NULL AND audiobookshelf_runtime_validated = 1
      `).all() as { book_id: number }[]).map((row) => row.book_id)
    );

    // The Hardcover book ID shared by an ABS-owned audiobook, anchored via
    // Grimmory's own audiobook row rather than the 'hardcover' source row's
    // book_id. The Grimmory<->Audiobookshelf link (matched by file path/ASIN,
    // independent of anything Hardcover reports) stays consistently clustered
    // together across runs; the 'hardcover' row's book_id is the one that
    // drifts when Hardcover's mutable "current edition" flips, so anchoring
    // off it directly would let a single bad run break this signal for good
    // instead of self-healing on the next one. A print/ebook Grimmory sibling
    // of the same Hardcover book must not push its own status/progress into
    // that shared book outside of Phase N, and Phase C below must keep
    // routing this Hardcover book to its audiobook sibling regardless of
    // which edition Hardcover currently reports as "current" for it.
    const absOwnedHardcoverBookIds = absOwnedBookIds.size > 0
      ? new Set(
          (db.prepare(`
            SELECT DISTINCT gr.grimmory_hardcover_book_id AS hardcover_book_id
            FROM book_sources gr
            WHERE gr.source_type = 'grimmory'
              AND gr.source_media_type = 'audiobook'
              AND gr.grimmory_hardcover_book_id IS NOT NULL
              AND gr.book_id IN (${Array.from(absOwnedBookIds).map(() => "?").join(",")})
          `).all(...Array.from(absOwnedBookIds)) as { hardcover_book_id: string }[])
            .map((row) => normalizeExternalId(row.hardcover_book_id))
            .filter((id): id is string => id !== null)
        )
      : new Set<string>();

    // ── Phase B: Write Grimmory book_sources ────────────────────────────────
    // Grimmory books are written first so reconcileBookIdentities() can assign
    // book_ids that HC can then look up when writing user_book_states.

    if (grimmoryAvailable) {
      for (const grBook of grimmoryBooks) {
        const title = grBook.title ?? "";
        const author = grimmoryAuthorName(grBook) ?? null;
        const coverUrl = grimmoryCoverUrl(grBook) ?? null;

        const sourceId = upsertBookSource(db, "grimmory", profileId, grBook.id, {
          title,
          author,
          cover_url: coverUrl,
          isbn13: grBook.isbn13 ?? null,
          isbn10: grBook.isbn10 ?? null,
          series_name: grBook.seriesName ?? null,
          series_number: grBook.seriesNumber ?? null,
          source_media_type: grBook.mediaType ?? null,
          source_narrator: grBook.narrator ?? null,
          source_audible_asin: grBook.audibleAsin ?? null,
          source_hardcover_book_id: grBook.hardcoverBookId ?? null,
          source_hardcover_slug: grBook.hardcoverId ?? null,
          source_goodreads_book_id: grBook.goodreadsId ?? null,
          grimmory_hardcover_book_id: grBook.hardcoverBookId ?? null,
          grimmory_goodreads_id: grBook.goodreadsId ?? null,
          grimmory_hardcover_id: grBook.hardcoverId ?? null,
          grimmory_primary_file_path: grBook.primaryFilePath ?? null,
          last_sync_at: sqliteNow(),
          last_sync_decision: "grimmory_source"
        });

        if (coverUrl) {
          enqueueImageCacheTask(`cover:${sourceId}`, async () => {
            await cacheSourceCover(db, sourceId, "grimmory", coverUrl);
          });
        } else if (grimmoryToken) {
          enqueueImageCacheTask(`cover:${sourceId}`, async () => {
            await cacheGrimmoryCover(db, sourceId, baseUrl, grimmoryToken, grBook.id, grBook.mediaType ?? null);
          });
        }
      }

      logger.info("Grimmory book_sources written", { profileId, count: grimmoryBooks.length });
    }

    // ── Phase C: Write HC book_sources ─────────────────────────────────────
    if (hasHardcover) {
      for (const hcBook of hcBooks) {
        const userEdition = hcBook.edition_id ? hcEditions.get(hcBook.edition_id) : null;
        const preferredSiblings = grimmoryAvailable
          ? activeGrimmorySiblingsForHardcover(grimmoryBooks, hcBook.book.id)
          : { book: null, audiobook: null };
        const bookOwnsSharedHardcover = preferredSiblings.book !== null && preferredSiblings.audiobook !== null;
        const normalizedHcBookId = normalizeExternalId(hcBook.book.id) ?? String(hcBook.book.id);
        // Hardcover's "currently pinned" edition on a shared book can drift on
        // its own (e.g. editing any read on the book appears to retarget it),
        // which would otherwise bounce this row between audiobook/print every
        // run. When we already know (from ABS) that this Hardcover book is the
        // audiobook side, keep routing it there regardless of what edition
        // Hardcover currently reports as current.
        const absOwnsThisHardcoverBook = !bookOwnsSharedHardcover && absOwnedHardcoverBookIds.has(normalizedHcBookId);
        const inferredMediaType = inferHardcoverMediaType(hcBook, userEdition);
        // Hardcover uses one book ID for multiple active editions, while our
        // book_sources row is keyed by that book ID. Keep the row in the book
        // bucket and clear edition-specific fields so HC iteration order cannot
        // flip the local identity between book and audiobook.
        const mediaType = bookOwnsSharedHardcover
          ? "physical"
          : absOwnsThisHardcoverBook
            ? "audiobook"
            : inferredMediaType;
        // Only trust Hardcover's live "current edition" data for audio-specific
        // fields (edition id, format, audio seconds, ASIN) when it actually
        // looks like an audio edition this run. If ABS ownership forced
        // mediaType to "audiobook" but Hardcover's current edition has drifted
        // to something else, keep whatever audio edition data was already
        // persisted rather than overwriting it with mismatched (e.g. ebook) data.
        const trustCurrentEditionForAudio = mediaType !== "audiobook" || inferredMediaType === "audiobook";
        const edition = mediaType === "audiobook"
          ? hcBook.book.default_audio_edition
          : mediaType === "ebook"
            ? hcBook.book.default_ebook_edition
            : hcBook.book.default_physical_edition;
        const title = hcBook.book.title ?? "";
        const author = hcBook.book.contributions?.[0]?.author?.name ?? null;
        const coverUrl = userEdition?.image?.url ?? hcBook.book.image?.url ?? null;
        const hcIsbn13 = userEdition?.isbn_13
          ?? edition?.isbn_13
          ?? hcBook.book.default_audio_edition?.isbn_13
          ?? hcBook.book.default_ebook_edition?.isbn_13
          ?? null;
        const hcIsbn10 = userEdition?.isbn_10
          ?? edition?.isbn_10
          ?? hcBook.book.default_audio_edition?.isbn_10
          ?? hcBook.book.default_ebook_edition?.isbn_10
          ?? null;
        const hardcoverSlug = hcBook.book.slug ?? null;
        const series = firstHardcoverSeries(hcBook);
        const editionFormat = bookOwnsSharedHardcover ? null : normalizeEditionFormat(userEdition?.edition_format);
        const editionAsin = userEdition?.asin?.trim() || null;
        const ebookAsin = mediaType === "ebook"
          ? (editionAsin ?? hcBook.book.default_ebook_edition?.asin ?? null)
          : hcBook.book.default_ebook_edition?.asin ?? null;
        const audioAsin = mediaType === "audiobook"
          ? ((trustCurrentEditionForAudio ? editionAsin : null) ?? hcBook.book.default_audio_edition?.asin ?? null)
          : hcBook.book.default_audio_edition?.asin ?? null;
        const hcAudioSeconds = userEdition?.audio_seconds ?? null;
        // For shared Hardcover books, keep the row edition-neutral as well as
        // book-bucketed; otherwise whichever HC edition syncs last can flip the
        // identity fields for every local sibling.
        const sourceFields: Record<string, unknown> = {
          title,
          author,
          cover_url: coverUrl,
          isbn13: hcIsbn13,
          isbn10: hcIsbn10,
          series_name: series.name,
          series_number: series.number,
          source_hardcover_book_id: hcBook.book.id,
          source_hardcover_slug: hardcoverSlug,
          source_media_type: mediaType,
          source_asin: ebookAsin,
          source_audible_asin: audioAsin,
          hardcover_slug: hardcoverSlug,
          last_sync_at: sqliteNow()
        };
        if (bookOwnsSharedHardcover) {
          sourceFields.source_edition_id = null;
          sourceFields.source_edition_format = null;
          sourceFields.hardcover_audio_seconds = null;
        } else if (trustCurrentEditionForAudio) {
          // Hardcover's current edition data actually matches this row's
          // media type this run — safe to persist.
          sourceFields.source_edition_id = hcBook.edition_id ?? null;
          sourceFields.source_edition_format = editionFormat;
          sourceFields.hardcover_audio_seconds = hcAudioSeconds;
        }
        // else: Hardcover's current edition has drifted away from this row's
        // (ABS-forced) media type — leave the previously persisted
        // edition id/format/audio_seconds alone rather than overwrite them
        // with mismatched data.
        const sourceId = upsertBookSource(db, "hardcover", profileId, hcBook.book.id, sourceFields);

        if (coverUrl) {
          enqueueImageCacheTask(`cover:${sourceId}`, async () => {
            await cacheSourceCover(db, sourceId, "hardcover", coverUrl);
          });
        }
      }

      // Prune states first: source pruning preserves rows with a live state.
      pruneHardcoverUserStatesMissingFromFetch(db, profileId, new Set(hcBooks.map((b) => b.book.id)));
      pruneHardcoverSourcesMissingFromFetch(db, profileId, new Set(hcBooks.map((b) => b.book.id)));
      logger.info("Hardcover book_sources written", { profileId, count: hcBooks.length });
    }

    // ── Phase D: Reconcile identities ────────────────────────────────────────
    // Now that both Grimmory and HC sources are written, reconcile so every
    // book_sources row gets a book_id. This is what links HC sources to
    // Grimmory sources for the HC sync loop below.
    reconcileBookIdentities(db);
    if (hasHardcover) {
      db.prepare(`
        DELETE FROM user_book_states
        WHERE profile_id = ?
          AND source_type = 'hardcover'
          AND NOT EXISTS (
            SELECT 1 FROM book_sources
            WHERE book_sources.book_id = user_book_states.book_id
              AND book_sources.source_type = 'hardcover'
          )
      `).run(profileId);
    }

    // ── Phase E: Build Grimmory in-memory match index (for HC loop) ─────────
    const grimmoryIndex = buildGrimmoryIndex(grimmoryBooks);
    const matchedGrimmoryIds = new Set<number>();
    const taggedSourceGrimmoryIds = new Set<number>();
    const hardcoverSourceGrimmoryIds = new Set<number>();
    const goodreadsSourceGrimmoryIds = new Set<number>();
    const taggedSourceTitles = new Map<number, string>();

    // ── Phase F: HC user states + API sync ───────────────────────────────────
    // For each HC book, find its matching Grimmory book (via the in-memory index
    // AND the book_sources reconciliation), then apply conflict resolution and
    // write user_book_states.
    for (const hcBook of hcBooks) {
      const hcSource = getBookSource(db, "hardcover", profileId, hcBook.book.id);
      if (!hcSource?.book_id) {
        // Should not happen after reconcile, but skip gracefully
        logger.warn("HC book source has no book_id after reconcile", { profileId, hardcoverBookId: hcBook.book.id });
        continue;
      }
      const bookId = hcSource.book_id;

      const preferredSiblings = grimmoryAvailable
        ? activeGrimmorySiblingsForHardcover(grimmoryBooks, hcBook.book.id)
        : { book: null, audiobook: null };
      const bookOwnsSharedHardcover = preferredSiblings.book !== null && preferredSiblings.audiobook !== null;

      // Find matching Grimmory book via the in-memory matcher
      const match = bookOwnsSharedHardcover && preferredSiblings.book
        ? { grimmoryBook: preferredSiblings.book, confidence: "high" as const, matchType: "hardcover_book_id" as const }
        : grimmoryAvailable
        ? matchHardcoverBook(hcBook, grimmoryIndex, {
            goodreadsId: (db.prepare(
              "SELECT external_id FROM book_sources WHERE source_type='goodreads' AND book_id=? LIMIT 1"
            ).get(bookId) as { external_id: string } | undefined)?.external_id ?? null,
            mediaTypeHint: (hcSource.source_media_type as "physical" | "ebook" | "audiobook" | null | undefined) ?? null
          })
        : null;
      const grBook = match?.grimmoryBook ?? null;
      const localIdentityGrimmoryBook = !grBook && grimmoryAvailable
        ? localGrimmoryBookForBookId(db, profileId, bookId, grimmoryBooks)
        : null;
      if (grBook) matchedGrimmoryIds.add(grBook.id);
      if (localIdentityGrimmoryBook) matchedGrimmoryIds.add(localIdentityGrimmoryBook.id);

      const title = hcBook.book.title ?? grBook?.title ?? localIdentityGrimmoryBook?.title ?? "";

      if (writeTagEnabled && grBook) {
        taggedSourceGrimmoryIds.add(grBook.id);
        taggedSourceTitles.set(grBook.id, title);
      }
      if (grBook) hardcoverSourceGrimmoryIds.add(grBook.id);

      // Load previous states for change detection and conflict resolution
      const prevHcState = getUserState(db, bookId, profileId, "hardcover");
      const prevGrState = grimmoryAvailable
        ? getUserState(db, bookId, profileId, "grimmory")
        : null;

      const hcStatusId = hcBook.status_id;
      const grStatus = grBook?.readStatus ?? null;
      const projectedHcStatus = grStatus
        ?? localIdentityGrimmoryBook?.readStatus
        ?? prevHcState?.status
        ?? null;
      const audiobookRuntimeSeconds = audiobookRuntimeForBook(db, profileId, bookId);

      const { decision, syncHealth, writeGrimmory, writeHardcover } = localIdentityGrimmoryBook
        ? {
            decision: "local_identity_has_grimmory_match",
            syncHealth: "synced",
            writeGrimmory: false,
            writeHardcover: false
          }
        : grimmoryAvailable
        ? computeSyncDecision({
            hcBook, grBook, conflictStrategy,
            syncStatusEnabled: profile["sync_status_enabled"] !== 0,
            previousGrimmoryStatus: prevGrState?.status ?? null,
            previousHardcoverStatusId: prevHcState?.hardcover_status_id ?? null
          })
        : {
            decision: "grimmory_unavailable",
            syncHealth: prevHcState?.sync_health ?? "pending",
            writeGrimmory: false, writeHardcover: false
          };

      if (hcBook.id && hardcoverToken) {
        await cleanupDuplicateBlankHardcoverReads({
          db,
          runId,
          profileId,
          title,
          bookId,
          hcBook,
          hardcoverToken,
          dryRun,
          counters,
          adapters
        });
      }

      // Use the persisted, stable edition id for this Hardcover row (set in
      // Phase C) rather than Hardcover's live per-run edition_id, so read
      // selection isn't thrown off by the same "current edition" drift that
      // Phase C already guards against.
      const persistedEditionId = hcSource.source_edition_id != null
        ? Number.parseInt(hcSource.source_edition_id, 10)
        : null;
      const readSelectionEditionId = Number.isFinite(persistedEditionId) ? persistedEditionId : null;
      const hcRead = latestHardcoverRead(hcBook, readSelectionEditionId);
      const hcProgress = hardcoverProgressPercent(hcBook, audiobookRuntimeSeconds, readSelectionEditionId);
      const hcPages = hardcoverPages(hcBook);

      if (!prevHcState && hasGrimmory && !grimmoryAvailable) {
        recordEvent(db, runId, profileId, title, "skipped_no_change", null, "grimmory_unavailable_no_local_insert", {
          source: "grimmory", hardcoverBookId: hcBook.book.id
        });
        counters.skipped++;
        continue;
      }

      const meaningfulChange = hasMeaningfulHcChange(prevHcState, {
        hardcoverStatusId: hcStatusId ?? null,
        hardcoverRating: hcBook.rating ?? null,
        hardcoverProgress: hcProgress
      });

      // Upsert user_book_states (hardcover)
      const hcStateFields: Record<string, unknown> = {
        status: projectedHcStatus,
        rating: hcBook.rating ?? null,
        progress: hcProgress,
        progress_pages: hcRead?.progress_pages ?? null,
        progress_seconds: hcRead?.progress_seconds ?? null,
        last_read_date: hcBook.last_read_date ?? null,
        date_finished: null,
        sync_health: syncHealth,
        match_confidence: match?.confidence ?? (localIdentityGrimmoryBook ? "low" : "none"),
        match_type: match?.matchType ?? (localIdentityGrimmoryBook ? "local_identity" : null),
        last_sync_decision: decision,
        hardcover_status_id: hcStatusId ?? null,
        hardcover_user_book_id: hcBook.id ?? null,
        hardcover_read_id: hcRead?.id ?? null,
        hardcover_updated_at: hcBook.updated_at ?? null,
        hardcover_pages: hcPages
      };

      if (prevHcState) {
        const setClauses = Object.keys(hcStateFields).map((k) => `${k} = ?`).join(", ");
        db.prepare(`
          UPDATE user_book_states SET ${setClauses},
            last_sync_at = datetime('now'),
            last_modified_at = CASE WHEN ? THEN datetime('now') ELSE last_modified_at END
          WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'
        `).run(...Object.values(hcStateFields), meaningfulChange ? 1 : 0, bookId, profileId);
      } else {
        const cols = ["book_id", "profile_id", "source_type", ...Object.keys(hcStateFields)].join(", ");
        const placeholders = Array(Object.keys(hcStateFields).length + 3).fill("?").join(", ");
        db.prepare(`INSERT OR IGNORE INTO user_book_states (${cols}, last_sync_at) VALUES (${placeholders}, datetime('now'))`)
          .run(bookId, profileId, "hardcover", ...Object.values(hcStateFields));
      }

      // ── Apply writes ──────────────────────────────────────────────────────
      // Skip pushing Hardcover's status onto Grimmory for ABS-owned audiobooks —
      // Phase N derives and writes the correct status from actual ABS listening
      // progress instead, since Hardcover's status_id for these can be stale.
      if (writeGrimmory && grBook && grimmoryAvailable && grimmoryToken && hcStatusId !== null && !absOwnedBookIds.has(bookId)) {
        const targetStatus = HARDCOVER_TO_GRIMMORY[hcStatusId];
        if (targetStatus) {
          if (!dryRun) {
            try {
              await adapters.updateGrimmoryStatus(baseUrl, grimmoryToken, grBook.id, targetStatus);
              logger.info("Wrote status to Grimmory", { profileId, bookId: grBook.id, status: targetStatus });
            } catch (writeErr) {
              logger.warn("Failed to write status to Grimmory", { profileId, bookId: grBook.id, error: writeErr });
              recordEvent(db, runId, profileId, title, "api_failure", "hardcover_to_grimmory", "write_failed", { error: String(writeErr) });
              counters.skipped++;
              continue;
            }
          }
          recordEvent(db, runId, profileId, title, "written", "hardcover_to_grimmory", decision, { hcStatusId, targetStatus, dryRun });
          counters.written++;
        } else {
          counters.skipped++;
        }
      } else if (writeHardcover && grStatus) {
        const hardcoverFields = grBook ? hardcoverFieldsFromGrimmory(grBook) : null;
        if (hardcoverFields?.status_id) {
          if (!dryRun) {
            try {
              if (hcBook.id) {
                await adapters.updateHardcoverUserBook(hardcoverToken, hcBook.id, hardcoverFields);
                logger.info("Wrote status to Hardcover", { profileId, userBookId: hcBook.id, statusId: hardcoverFields.status_id });
              } else {
                const targetRating = grBook ? grimmoryToHardcoverRating(grimmoryRating(grBook)) : null;
                await adapters.insertHardcoverUserBook(hardcoverToken, {
                  book_id: hcBook.book.id,
                  ...hardcoverFields,
                  ...(targetRating !== null ? { rating: targetRating } : {})
                });
                if (targetRating !== null) {
                  db.prepare("UPDATE user_book_states SET rating = ? WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'")
                    .run(targetRating, bookId, profileId);
                }
                logger.info("Inserted status for list-only Hardcover book", { profileId, bookId: hcBook.book.id, statusId: hardcoverFields.status_id });
              }
            } catch (writeErr) {
              logger.warn("Failed to write status to Hardcover", { profileId, userBookId: hcBook.id, bookId: hcBook.book.id, error: writeErr });
              recordEvent(db, runId, profileId, title, "api_failure", "grimmory_to_hardcover", "write_failed", { error: String(writeErr) });
              counters.skipped++;
              continue;
            }
          }
          recordEvent(db, runId, profileId, title, "written", "grimmory_to_hardcover", decision, { grStatus, targetStatusId: hardcoverFields.status_id, dryRun });
          counters.written++;
        } else {
          counters.skipped++;
        }
      } else if (syncHealth === "missing") {
        recordEvent(db, runId, profileId, title, "missing_match", null, "no_grimmory_match", {});
        counters.skipped++;
      } else if (!grimmoryAvailable && hasGrimmory) {
        recordEvent(db, runId, profileId, title, "skipped_no_change", null, "grimmory_unavailable_preserved", { source: "grimmory" });
        counters.skipped++;
      } else {
        recordEvent(db, runId, profileId, title, "skipped_no_change", null, decision, {});
        counters.skipped++;
      }

      // ── Rating sync ──────────────────────────────────────────────────────
      if (profile["sync_status_enabled"] !== 0 && grBook && grimmoryAvailable && grimmoryToken) {
        const grRating = positiveRating(grimmoryRating(grBook));
        const hcRating = positiveRating(hcBook.rating);
        const grAsHardcover = grimmoryToHardcoverRating(grRating);
        const hcAsGrimmory = hardcoverToGrimmoryRating(hcRating);
        const ratingsAlreadySynced = grAsHardcover !== null && hcRating !== null && sameNumber(grAsHardcover, hcRating);
        const grRatingChanged = prevGrState?.rating != null ? !sameNumber(grRating, prevGrState.rating) : false;
        const hcRatingChanged = prevHcState?.rating != null ? !sameNumber(hcRating, prevHcState.rating) : false;

        let ratingDirection: "grimmory_to_hardcover" | "hardcover_to_grimmory" | null = null;
        let ratingDecision = "rating_already_synced";

        if (!ratingsAlreadySynced) {
          if (grRating !== null && hcRating === null) {
            ratingDirection = "grimmory_to_hardcover";
            ratingDecision = "grimmory_only_rating";
          } else if (grRating === null && hcRating !== null) {
            ratingDirection = "hardcover_to_grimmory";
            ratingDecision = "hardcover_only_rating";
          } else if (grRating !== null && hcRating !== null) {
            if (conflictStrategy === "grimmory_wins") {
              ratingDirection = "grimmory_to_hardcover";
              ratingDecision = "grimmory_wins_rating";
            } else if (conflictStrategy === "hardcover_wins") {
              ratingDirection = "hardcover_to_grimmory";
              ratingDecision = "hardcover_wins_rating";
            } else if (grRatingChanged && !hcRatingChanged) {
              ratingDirection = "grimmory_to_hardcover";
              ratingDecision = "grimmory_rating_changed";
            } else if (hcRatingChanged && !grRatingChanged) {
              ratingDirection = "hardcover_to_grimmory";
              ratingDecision = "hardcover_rating_changed";
            } else {
              const latestRatingSource = newerSource(hcBook.updated_at ?? null, grBook.lastReadTime ?? null);
              if (latestRatingSource === "hardcover") {
                ratingDirection = "hardcover_to_grimmory";
                ratingDecision = "latest_rating_hardcover";
              } else if (latestRatingSource === "grimmory") {
                ratingDirection = "grimmory_to_hardcover";
                ratingDecision = "latest_rating_grimmory";
              } else {
                ratingDirection = "grimmory_to_hardcover";
                ratingDecision = !grRatingChanged && !hcRatingChanged
                  ? "stored_rating_mismatch_no_timestamps_grimmory_preferred"
                  : "initial_rating_grimmory_preferred";
              }
            }
          }
        }

        if (ratingDirection === "grimmory_to_hardcover" && grAsHardcover !== null) {
          if (dryRun) {
            recordEvent(db, runId, profileId, title, "written", "grimmory_to_hardcover", ratingDecision, { grimmoryRating: grRating, targetRating: grAsHardcover, dryRun });
            counters.written++;
          } else {
            try {
              if (hcBook.id) {
                await adapters.updateHardcoverUserBook(hardcoverToken, hcBook.id, { rating: grAsHardcover });
                logger.info("Wrote rating to Hardcover", { profileId, userBookId: hcBook.id, grimmoryRating: grRating, hardcoverRating: grAsHardcover });
              } else {
                await adapters.insertHardcoverUserBook(hardcoverToken, { book_id: hcBook.book.id, rating: grAsHardcover });
                logger.info("Inserted rating for list-only Hardcover book", { profileId, hardcoverBookId: hcBook.book.id, grimmoryRating: grRating, hardcoverRating: grAsHardcover });
              }
              db.prepare("UPDATE user_book_states SET rating = ?, last_sync_at = datetime('now'), last_sync_decision = ?, last_modified_at = datetime('now') WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'")
                .run(grAsHardcover, ratingDecision, bookId, profileId);
              recordEvent(db, runId, profileId, title, "written", "grimmory_to_hardcover", ratingDecision, { grimmoryRating: grRating, targetRating: grAsHardcover });
              counters.written++;
            } catch (writeErr) {
              logger.warn("Failed to write rating to Hardcover", { profileId, userBookId: hcBook.id, hardcoverBookId: hcBook.book.id, error: writeErr });
              recordEvent(db, runId, profileId, title, "api_failure", "grimmory_to_hardcover", "rating_write_failed", { error: String(writeErr) });
              counters.skipped++;
            }
          }
        } else if (ratingDirection === "hardcover_to_grimmory" && hcAsGrimmory !== null) {
          if (dryRun) {
            recordEvent(db, runId, profileId, title, "written", "hardcover_to_grimmory", ratingDecision, { hardcoverRating: hcRating, targetRating: hcAsGrimmory, dryRun });
            counters.written++;
          } else {
            try {
              await adapters.updateGrimmoryRating(baseUrl, grimmoryToken, grBook.id, hcAsGrimmory);
              db.prepare("UPDATE user_book_states SET last_sync_at = datetime('now'), last_sync_decision = ?, last_modified_at = datetime('now') WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'")
                .run(ratingDecision, bookId, profileId);
              recordEvent(db, runId, profileId, title, "written", "hardcover_to_grimmory", ratingDecision, { hardcoverRating: hcRating, targetRating: hcAsGrimmory });
              counters.written++;
              logger.info("Wrote rating to Grimmory", { profileId, grimmoryBookId: grBook.id, hardcoverRating: hcRating, grimmoryRating: hcAsGrimmory });
            } catch (writeErr) {
              logger.warn("Failed to write rating to Grimmory", { profileId, grimmoryBookId: grBook.id, error: writeErr });
              recordEvent(db, runId, profileId, title, "api_failure", "hardcover_to_grimmory", "rating_write_failed", { error: String(writeErr) });
              counters.skipped++;
            }
          }
        }
      }

      // ── Progress sync ────────────────────────────────────────────────────
      if (profile["sync_progress_enabled"] !== 0 && grBook && grimmoryAvailable && grimmoryToken && grBook.mediaType !== "audiobook") {
        const grProgress = meaningfulProgress(grBook.readProgress ?? null);
        const hcProgressNow = hcProgress;
        // 0.5% tolerance accounts for integer page-count rounding: converting a % to pages
        // and back can introduce up to 0.5/pages*100% error (e.g. 0.26% for a 196-page book).
        const progressAlreadySynced = grProgress !== null && hcProgressNow !== null && Math.abs(grProgress - hcProgressNow) < 0.5;
        const hadPreviousProgress = prevGrState?.progress != null || prevHcState?.progress != null;
        const grProgressChanged = prevGrState?.progress != null
          ? (grProgress === null || Math.abs(grProgress - prevGrState.progress) >= 0.1)
          : false;
        const hcProgressChanged = prevHcState?.progress != null
          ? (hcProgressNow === null || Math.abs(hcProgressNow - prevHcState.progress) >= 0.1)
          : false;

        let progressDirection: "grimmory_to_hardcover" | "hardcover_to_grimmory" | null = null;
        let progressDecision = "progress_already_synced";

        if (bookOwnsSharedHardcover && grProgress !== null && !progressAlreadySynced) {
          // Hardcover only exposes one current-progress slot per work. When a
          // book and audiobook are both active, the book edition owns that slot
          // even if the profile's general conflict strategy is Hardcover-wins.
          progressDirection = "grimmory_to_hardcover";
          progressDecision = "book_progress_wins_shared_hardcover";
        } else if (!progressAlreadySynced) {
          const grTime = grBook.lastReadTime ?? null;
          const hcTime = hcBook.updated_at ?? null;
          const latestProgressSource = newerSource(hcTime, grTime);
          if (grProgress !== null && hcProgressNow === null) {
            if (conflictStrategy === "hardcover_wins" || (conflictStrategy === "latest_wins" && (hcProgressChanged || latestProgressSource === "hardcover"))) {
              progressDirection = "hardcover_to_grimmory";
              progressDecision = "hardcover_progress_cleared";
            } else {
              progressDirection = "grimmory_to_hardcover";
              progressDecision = "grimmory_only_progress";
            }
          } else if (grProgress === null && hcProgressNow !== null) {
            if (conflictStrategy === "grimmory_wins" || (conflictStrategy === "latest_wins" && (grProgressChanged || latestProgressSource === "grimmory"))) {
              progressDirection = "grimmory_to_hardcover";
              progressDecision = "grimmory_progress_cleared";
            } else {
              progressDirection = "hardcover_to_grimmory";
              progressDecision = "hardcover_only_progress";
            }
          } else if (grProgress !== null && hcProgressNow !== null) {
            if (conflictStrategy === "grimmory_wins") {
              progressDirection = "grimmory_to_hardcover";
              progressDecision = "grimmory_wins_progress";
            } else if (conflictStrategy === "hardcover_wins") {
              progressDirection = "hardcover_to_grimmory";
              progressDecision = "hardcover_wins_progress";
            } else if (grProgressChanged && !hcProgressChanged) {
              progressDirection = "grimmory_to_hardcover";
              progressDecision = "grimmory_progress_changed";
            } else if (hcProgressChanged && !grProgressChanged) {
              progressDirection = "hardcover_to_grimmory";
              progressDecision = "hardcover_progress_changed";
            } else if (latestProgressSource === "grimmory") {
              progressDirection = "grimmory_to_hardcover";
              progressDecision = "latest_progress_grimmory";
            } else if (latestProgressSource === "hardcover") {
              progressDirection = "hardcover_to_grimmory";
              progressDecision = "latest_progress_hardcover";
            } else if (!hadPreviousProgress) {
              progressDirection = "hardcover_to_grimmory";
              progressDecision = "initial_progress_hardcover_preferred";
            }
          }
        }

        // Lazy edition resolution: only for actively-reading books, cached permanently.
        // Fetches once when no edition is stored yet, and re-fetches if hcPages changes
        // (meaning the user switched editions or the file was replaced).
        let resolvedEditionId: number | null = prevHcState?.hardcover_edition_id ?? null;
        const storedEditionPages = prevHcState?.hardcover_edition_pages ?? null;
        const needsEditionResolution = hcProgress !== null
          && hcPages !== null
          && (resolvedEditionId === null || storedEditionPages !== hcPages);

        if (needsEditionResolution && hardcoverToken) {
          try {
            const editions = await adapters.fetchEditionsForBook(hardcoverToken, hcBook.book.id);
            const matched = editions.find(e => e.pages === hcPages);
            if (matched) {
              resolvedEditionId = matched.id;
              db.prepare(`
                UPDATE user_book_states SET hardcover_edition_id = ?, hardcover_edition_pages = ?
                WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'
              `).run(resolvedEditionId, hcPages, bookId, profileId);
              logger.info("Resolved Hardcover edition for progress tracking", {
                profileId, bookId, editionId: resolvedEditionId, pages: hcPages
              });
            } else {
              // No exact page-count match — clear any stale cached edition
              resolvedEditionId = null;
              db.prepare(`
                UPDATE user_book_states SET hardcover_edition_id = NULL, hardcover_edition_pages = NULL
                WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'
              `).run(bookId, profileId);
              logger.warn("No Hardcover edition matched page count; edition will not be set on progress writes", {
                profileId, bookId, hcPages, available: editions.map(e => e.pages)
              });
            }
          } catch (editionErr) {
            logger.warn("Failed to fetch editions for Hardcover book", { profileId, bookId, error: editionErr });
          }
        }

        if (progressDirection === "grimmory_to_hardcover" && grProgress !== null) {
          const progressPages = progressPagesFromPercent(grProgress, hcPages);
          if (!progressPages) {
            logger.warn("Skipping Grimmory progress write to Hardcover without page count", { profileId, bookId, grimmoryBookId: grBook.id });
          } else if (dryRun) {
            recordEvent(db, runId, profileId, title, "written", "grimmory_to_hardcover", progressDecision, { progress: grProgress, progressPages, dryRun });
            counters.written++;
          } else {
            try {
              const readFields: HardcoverReadFields = {
                ...(resolvedEditionId !== null ? { edition_id: resolvedEditionId } : {}),
                progress_pages: progressPages,
                started_at: hcRead?.started_at ?? todayDate(),
                finished_at: grBook.readStatus === "READ" ? hardcoverDate(grBook.dateFinished) : null
              };
              const hardcoverReadId = hcRead?.id ?? await adapters.insertHardcoverUserBookRead(hardcoverToken, hcBook.id, readFields);
              if (hcRead?.id) await adapters.updateHardcoverUserBookRead(hardcoverToken, hcRead.id, readFields);
              // Store the round-tripped percentage (pages / totalPages) rather than the raw
              // Grimmory %, so the next sync's hcProgressChanged comparison is stable and
              // doesn't re-trigger a write just from integer rounding.
              const storedProgress = hcPages && hcPages > 0 ? (progressPages / hcPages) * 100 : grProgress;
              db.prepare(`
                UPDATE user_book_states SET progress = ?, progress_pages = ?,
                  last_sync_at = datetime('now'), last_sync_decision = ?, last_modified_at = datetime('now')
                WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'
              `).run(storedProgress, progressPages, progressDecision, bookId, profileId);
              // Track the HC read_id for future progress updates
              if (hardcoverReadId) {
                db.prepare("UPDATE user_book_states SET hardcover_read_id = ? WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'")
                  .run(hardcoverReadId, bookId, profileId);
              }
              recordEvent(db, runId, profileId, title, "written", "grimmory_to_hardcover", progressDecision, { progress: grProgress, progressPages, editionId: resolvedEditionId });
              counters.written++;
              logger.info("Wrote progress to Hardcover", { profileId, userBookId: hcBook.id, progress: grProgress, progressPages, editionId: resolvedEditionId });
            } catch (writeErr) {
              logger.warn("Failed to write progress to Hardcover", { profileId, userBookId: hcBook.id, error: writeErr });
              recordEvent(db, runId, profileId, title, "api_failure", "grimmory_to_hardcover", "progress_write_failed", { error: String(writeErr) });
              counters.skipped++;
            }
          }
        } else if (progressDirection === "hardcover_to_grimmory" && hcProgressNow !== null) {
          const primaryFileId = grBook.primaryFileId;
          if (!primaryFileId) {
            logger.warn("Skipping Hardcover progress write to Grimmory without primary file ID", { profileId, bookId, grimmoryBookId: grBook.id });
          } else if (dryRun) {
            recordEvent(db, runId, profileId, title, "written", "hardcover_to_grimmory", progressDecision, { progress: hcProgressNow, dryRun });
            counters.written++;
          } else {
            try {
              await adapters.updateGrimmoryProgress(baseUrl, grimmoryToken, grBook.id, primaryFileId, hcProgressNow);
              db.prepare("UPDATE user_book_states SET progress = ?, last_sync_at = datetime('now'), last_sync_decision = ?, last_modified_at = datetime('now') WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'")
                .run(hcProgressNow, progressDecision, bookId, profileId);
              recordEvent(db, runId, profileId, title, "written", "hardcover_to_grimmory", progressDecision, { progress: hcProgressNow });
              counters.written++;
              logger.info("Wrote progress to Grimmory", { profileId, grimmoryBookId: grBook.id, progress: hcProgressNow });
            } catch (writeErr) {
              logger.warn("Failed to write progress to Grimmory", { profileId, grimmoryBookId: grBook.id, error: writeErr });
              recordEvent(db, runId, profileId, title, "api_failure", "hardcover_to_grimmory", "progress_write_failed", { error: String(writeErr) });
              counters.skipped++;
            }
          }
        } else if (progressDirection === "hardcover_to_grimmory" && hcProgressNow === null) {
          const primaryFileId = grBook.primaryFileId;
          if (!primaryFileId) {
            // no-op
          } else if (dryRun) {
            recordEvent(db, runId, profileId, title, "written", "hardcover_to_grimmory", progressDecision, { clearedProgress: true, grimmoryProgress: grProgress, dryRun });
            counters.written++;
          } else {
            try {
              await adapters.clearGrimmoryProgress(baseUrl, grimmoryToken, grBook.id, primaryFileId);
              db.prepare("UPDATE user_book_states SET progress = NULL, last_sync_at = datetime('now'), last_sync_decision = ?, last_modified_at = datetime('now') WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'")
                .run(progressDecision, bookId, profileId);
              recordEvent(db, runId, profileId, title, "written", "hardcover_to_grimmory", progressDecision, { clearedProgress: true, previousGrimmoryProgress: grProgress });
              counters.written++;
              logger.info("Cleared Grimmory progress from Hardcover source", { profileId, bookId, grimmoryBookId: grBook.id });
            } catch (writeErr) {
              logger.warn("Failed to clear Grimmory progress", { profileId, grimmoryBookId: grBook.id, error: writeErr });
              recordEvent(db, runId, profileId, title, "api_failure", "hardcover_to_grimmory", "progress_clear_failed", { error: String(writeErr) });
              counters.skipped++;
            }
          }
        } else if (progressDirection === "grimmory_to_hardcover" && grProgress === null) {
          logger.info("Skipped restoring cleared Grimmory progress", { profileId, bookId, grimmoryBookId: grBook.id, progressDecision });
          recordEvent(db, runId, profileId, title, "skipped_no_change", "grimmory_to_hardcover", progressDecision, { hardcoverProgress: hcProgressNow });
          counters.skipped++;
        }
      }
    }

    // ── Phase G: Grimmory user states ────────────────────────────────────────
    // Only keep per-profile Grimmory rows when the user actually has Grimmory
    // activity on that book. Passive "on disk" catalog presence comes from
    // book_sources and should not create a user relationship by itself.
    if (grimmoryAvailable) {
      for (const grBook of grimmoryBooks) {
        const grSource = getBookSource(db, "grimmory", profileId, grBook.id);
        if (!grSource?.book_id) {
          logger.warn("Grimmory source has no book_id after reconcile", { profileId, grimmoryBookId: grBook.id });
          continue;
        }
        const bookId = grSource.book_id;

        const grReadStatus = grBook.readStatus ?? null;
        const grRat = grimmoryRating(grBook) ?? null;
        const grProgress = grBook.readProgress ?? null;
        const grLastReadTime = grBook.lastReadTime ?? null;
        const grDateFinished = grBook.dateFinished ?? null;
        const grPrimaryFileId = grBook.primaryFileId ?? null;

        const prevGrState = getUserState(db, bookId, profileId, "grimmory");
        const hasActivity = hasGrimmoryUserActivity(grBook);
        if (!hasActivity) {
          if (prevGrState) {
            db.prepare(
              "DELETE FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'"
            ).run(bookId, profileId);
          }
          continue;
        }
        const meaningfulChange = hasMeaningfulGrChange(prevGrState, {
          status: grReadStatus,
          rating: grRat,
          progress: grProgress
        });

        db.prepare(`
          DELETE FROM user_book_states
          WHERE profile_id = ?
            AND source_type = 'grimmory'
            AND grimmory_book_id = ?
            AND book_id <> ?
        `).run(profileId, grBook.id, bookId);

        db.prepare(`
          INSERT INTO user_book_states
            (book_id, profile_id, source_type, status, rating, progress,
             last_read_date, date_finished, sync_health,
             grimmory_book_id, grimmory_last_read_time, grimmory_primary_file_id,
             last_sync_at, last_sync_decision, last_modified_at)
          VALUES (?, ?, 'grimmory', ?, ?, ?, ?, ?, 'synced', ?, ?, ?, datetime('now'), 'grimmory_source', datetime('now'))
          ON CONFLICT(book_id, profile_id, source_type) DO UPDATE SET
            status = excluded.status,
            rating = excluded.rating,
            progress = excluded.progress,
            last_read_date = excluded.last_read_date,
            date_finished = excluded.date_finished,
            sync_health = 'synced',
            grimmory_book_id = excluded.grimmory_book_id,
            grimmory_last_read_time = excluded.grimmory_last_read_time,
            grimmory_primary_file_id = excluded.grimmory_primary_file_id,
            last_sync_at = datetime('now'),
            last_sync_decision = 'grimmory_source',
            last_modified_at = CASE WHEN ? THEN datetime('now') ELSE last_modified_at END
        `).run(
          bookId, profileId,
          grReadStatus, grRat, grProgress,
          grLastReadTime, grDateFinished,
          grBook.id,
          grLastReadTime, grPrimaryFileId,
          meaningfulChange ? 1 : 0
        );

        // If Grimmory has a Hardcover book ID stored and HC is configured,
        // sync status into Hardcover for books not matched via HC import loop.
        if (!matchedGrimmoryIds.has(grBook.id)) {
          const hardcoverBookId = grBook.hardcoverBookId ? Number.parseInt(grBook.hardcoverBookId, 10) : NaN;
          const hardcoverFields = hardcoverFieldsFromGrimmory(grBook);
          const hardcoverRat = grimmoryToHardcoverRating(grimmoryRating(grBook));
          const bookOwnsSharedHardcover = grBook.mediaType === "audiobook"
            && shouldBookProgressOwnSharedHardcover(grimmoryBooks, grBook.hardcoverBookId);
          // Print/ebook siblings of an ABS-owned audiobook must never push their
          // own status into the Hardcover book they share — that book's status
          // is owned entirely by Phase N's ABS-derived writes. Without this,
          // this print sibling (unmatched via the main HC loop because the
          // shared Hardcover book was routed to its audiobook sibling instead)
          // would insert/overwrite the shared user_book with the print's status,
          // fighting Phase N's audiobook progress on every run.
          const audiobookSiblingOwnsSharedHardcover = grBook.mediaType !== "audiobook"
            && absOwnedHardcoverBookIds.has(normalizeExternalId(grBook.hardcoverBookId) ?? "");
          if (bookOwnsSharedHardcover || audiobookSiblingOwnsSharedHardcover) {
            logger.info("Skipped Grimmory-to-Hardcover status write because a sibling edition owns shared Hardcover progress", {
              profileId,
              grimmoryBookId: grBook.id,
              hardcoverBookId: Number.isInteger(hardcoverBookId) ? hardcoverBookId : null
            });
            recordEvent(db, runId, profileId, grBook.title ?? "", "skipped_no_change", "grimmory_to_hardcover", "book_progress_wins_shared_hardcover", {
              grimmoryBookId: grBook.id,
              hardcoverBookId: Number.isInteger(hardcoverBookId) ? hardcoverBookId : null
            });
            counters.skipped++;
            continue;
          }
          if (hasHardcover && profile["sync_status_enabled"] !== 0 && Number.isInteger(hardcoverBookId) && hardcoverFields?.status_id) {
            const title = grBook.title ?? "";
            if (dryRun) {
              recordEvent(db, runId, profileId, title, "written", "grimmory_to_hardcover", "would_insert_hardcover_user_book", {
                grStatus: grBook.readStatus, hardcoverBookId, targetStatusId: hardcoverFields.status_id,
                ...(hardcoverRat !== null ? { targetRating: hardcoverRat } : {}), dryRun
              });
              counters.written++;
            } else {
              try {
                await adapters.insertHardcoverUserBook(hardcoverToken, {
                  book_id: hardcoverBookId,
                  ...hardcoverFields,
                  ...(hardcoverRat !== null ? { rating: hardcoverRat } : {})
                });
                recordEvent(db, runId, profileId, title, "written", "grimmory_to_hardcover", "inserted_hardcover_user_book", {
                  grStatus: grBook.readStatus, hardcoverBookId, targetStatusId: hardcoverFields.status_id,
                  ...(hardcoverRat !== null ? { targetRating: hardcoverRat } : {})
                });
                counters.written++;
                logger.info("Inserted Grimmory-only book into Hardcover", {
                  profileId, grimmoryBookId: grBook.id, hardcoverBookId, statusId: hardcoverFields.status_id, rating: hardcoverRat
                });
              } catch (writeErr) {
                logger.warn("Failed to insert Grimmory-only book into Hardcover", { profileId, grimmoryBookId: grBook.id, hardcoverBookId, error: writeErr });
                recordEvent(db, runId, profileId, title, "api_failure", "grimmory_to_hardcover", "insert_hardcover_user_book_failed", { error: String(writeErr) });
                counters.skipped++;
              }
            }
          }
        }
      }

      pruneGrimmoryUserStatesMissingFromFetch(db, profileId, new Set(grimmoryBooks.map((b) => b.id)));
      // Source pruning preserves rows with a live state, so it must run second.
      pruneGrimmorySourcesMissingFromFetch(db, profileId, new Set(grimmoryBooks.map((b) => b.id)));
      logger.info("Grimmory user_book_states written", { profileId, count: grimmoryBooks.length });
    }

    // ── Phase H: Goodreads enrichment ────────────────────────────────────────
    let grimmoryShelvesCleared = false;
    const goodreadsUserId = profile["goodreads_user_id"] as string | null;
    const goodreadsSyncShelfName = (profile["goodreads_sync_shelf_name"] as string | null)?.trim() || null;
    const goodreadsConnectionEnabled = profile["goodreads_enabled"] as number | null;
    const syncGoodreadsStatus = !!(profile["sync_goodreads_status_enabled"] as number | null);

    if (goodreadsConnectionEnabled && goodreadsUserId?.trim()) {
      const goodreadsShelves = goodreadsSyncShelfName ? [goodreadsSyncShelfName] : undefined;
      logger.info("Fetching Goodreads library", { profileId, goodreadsUserId, shelfFilter: goodreadsSyncShelfName });
      try {
        const goodreadsBooks = await adapters.fetchAllGoodreadsBooks(goodreadsUserId, goodreadsShelves);
        logger.info("Goodreads library fetched", { profileId, count: goodreadsBooks.length, shelfFilter: goodreadsSyncShelfName });

        pruneGoodreadsUserStatesMissingFromFetch(db, profileId, new Set(goodreadsBooks.map((b) => b.goodreadsId)));

        // Build lookup indexes from existing book_sources and user_book_states for matching
        type LinkLookup = { book_id: number; ustate_id: number | null };
        const existingByGoodreadsId: Record<string, LinkLookup> = {};
        const existingByIsbn13: Record<string, LinkLookup> = {};
        const existingByIsbn10: Record<string, LinkLookup> = {};
        const existingByTitle: Record<string, Array<LinkLookup & {
          author: string | null;
          seriesName: string | null;
          seriesNumber: string | null;
        }>> = {};

        // Look up across all book_sources (not just this profile) to find any matching book
        const allSources = db.prepare(`
          SELECT bs.book_id, bs.source_type, bs.external_id,
                 bs.grimmory_goodreads_id, bs.source_goodreads_book_id,
                 bs.source_goodreads_work_id, bs.source_goodreads_edition_id,
                 bs.isbn13, bs.isbn10, bs.title,
                 bs.author, bs.series_name, bs.series_number,
                 ubs.id as ustate_id
          FROM book_sources bs
          LEFT JOIN user_book_states ubs ON ubs.book_id = bs.book_id AND ubs.profile_id = ? AND ubs.source_type = 'goodreads'
          WHERE bs.book_id IS NOT NULL
        `).all(profileId) as Array<{
          book_id: number; source_type: string; external_id: string;
          grimmory_goodreads_id: string | null; source_goodreads_book_id: string | null;
          source_goodreads_work_id: string | null; source_goodreads_edition_id: string | null;
          isbn13: string | null; isbn10: string | null;
          title: string | null; author: string | null; series_name: string | null; series_number: string | null;
          ustate_id: number | null;
        }>;

        const addGoodreadsLookup = (value: string | null | undefined, lookup: LinkLookup): void => {
          for (const id of identifierVariants(value)) {
            existingByGoodreadsId[id] ??= lookup;
          }
        };

        for (const src of allSources) {
          const lookup: LinkLookup = { book_id: src.book_id, ustate_id: src.ustate_id };
          if (src.source_type === "goodreads") {
            addGoodreadsLookup(src.external_id, lookup);
          }
          if (src.source_type === "grimmory" && src.grimmory_goodreads_id) {
            addGoodreadsLookup(src.grimmory_goodreads_id, lookup);
          }
          addGoodreadsLookup(src.source_goodreads_book_id, lookup);
          addGoodreadsLookup(src.source_goodreads_work_id, lookup);
          addGoodreadsLookup(src.source_goodreads_edition_id, lookup);
          if (src.isbn13) existingByIsbn13[src.isbn13] ??= lookup;
          if (src.isbn10) existingByIsbn10[src.isbn10] ??= lookup;
          const norm = src.title ? normalizeTitle(src.title) : "";
          if (norm) {
            const candidates = existingByTitle[norm] ?? [];
            candidates.push({
              ...lookup,
              author: src.author ? normalizeTitle(src.author) : null,
              seriesName: src.series_name ? normalizeTitle(src.series_name) : null,
              seriesNumber: normalizeSeriesNumber(src.series_number)
            });
            existingByTitle[norm] = candidates;
          }
        }

        let goodreadsMatched = 0;
        let goodreadsUnmatched = 0;

        for (const grBook of goodreadsBooks) {
          let matched: LinkLookup | undefined;
          let matchType: string | null = null;

          const normalizedGoodreadsId = normalizeExternalId(grBook.goodreadsId);
          if (normalizedGoodreadsId && existingByGoodreadsId[normalizedGoodreadsId]) {
            matched = existingByGoodreadsId[normalizedGoodreadsId];
            matchType = "goodreads_id";
          } else if (grBook.isbn13 && existingByIsbn13[grBook.isbn13]) {
            matched = existingByIsbn13[grBook.isbn13];
            matchType = "isbn13";
          } else if (grBook.isbn10 && existingByIsbn10[grBook.isbn10]) {
            matched = existingByIsbn10[grBook.isbn10];
            matchType = "isbn10";
          } else {
            const norm = normalizeTitle(grBook.title);
            const grAuthor = grBook.author ? normalizeTitle(grBook.author) : null;
            const grSeriesName = grBook.seriesName ? normalizeTitle(grBook.seriesName) : null;
            const grSeriesNumber = normalizeSeriesNumber(grBook.seriesNumber);
            const candidates = norm ? existingByTitle[norm] : undefined;
            const candidate = candidates?.find((existing) => {
              if (existing.author && grAuthor && existing.author !== grAuthor) return false;
              if (existing.seriesName && grSeriesName && existing.seriesName !== grSeriesName) return false;
              if (existing.seriesNumber && grSeriesNumber && existing.seriesNumber !== grSeriesNumber) return false;
              return true;
            });
            if (candidate) {
              matched = candidate;
              matchType = "title_author";
            }
          }

          // Load previous GR state for this book if it exists
          const prevGoState = matched ? getUserState(db, matched.book_id, profileId, "goodreads") : undefined;
          const previousShelf = prevGoState?.goodreads_shelf ?? null;
          const previousGoodreadsRating = prevGoState?.goodreads_rating ?? null;
          const targetGoodreadsRating = hardcoverToGrimmoryRating(grBook.rating);

          if (matched) {
            const bookId = matched.book_id;

            if (writeTagEnabled) {
              // Tag the Grimmory book for this profile
              const grSource = db.prepare(
                "SELECT CAST(external_id AS INTEGER) as grimmory_book_id FROM book_sources WHERE source_type='grimmory' AND source_instance_id = ? AND book_id=? LIMIT 1"
              ).get(profileId, bookId) as { grimmory_book_id: number } | undefined;
              if (grSource?.grimmory_book_id) {
                taggedSourceGrimmoryIds.add(grSource.grimmory_book_id);
                taggedSourceTitles.set(grSource.grimmory_book_id, grBook.title);
                goodreadsSourceGrimmoryIds.add(grSource.grimmory_book_id);
              }
            }

            const meaningfulGoodreadsChange = hasMeaningfulGoodreadsChange(prevGoState, {
              goodreadsShelf: grBook.shelf,
              goodreadsRating: grBook.rating,
              goodreadsReadAt: grBook.readAt
            });

            // Upsert GR book_source
            const goodreadsSourceId = upsertBookSource(db, "goodreads", profileId, grBook.goodreadsId, {
              book_id: bookId,
              title: grBook.title,
              author: grBook.author,
              cover_url: grBook.coverUrl ?? null,
              isbn13: grBook.isbn13 ?? null,
              isbn10: grBook.isbn10 ?? null,
              series_name: grBook.seriesName ?? null,
              series_number: grBook.seriesNumber ?? null,
              source_goodreads_book_id: grBook.goodreadsId,
              goodreads_book_link: grBook.bookLink ?? null,
              last_sync_at: sqliteNow()
            });
            if (grBook.coverUrl) {
              enqueueImageCacheTask(`cover:${goodreadsSourceId}`, async () => {
                await cacheSourceCover(db, goodreadsSourceId, "goodreads", grBook.coverUrl!);
              });
            }

            // Upsert GR user state
            db.prepare(`
              INSERT INTO user_book_states
                (book_id, profile_id, source_type, rating, sync_health,
                 goodreads_shelf, goodreads_read_at, goodreads_updated_at,
                 goodreads_match_type, goodreads_book_link,
                 last_sync_at, last_sync_decision, last_modified_at)
              VALUES (?, ?, 'goodreads', ?, 'synced', ?, ?, ?, ?, ?, datetime('now'), 'goodreads_match', datetime('now'))
              ON CONFLICT(book_id, profile_id, source_type) DO UPDATE SET
                rating = excluded.rating,
                goodreads_shelf = excluded.goodreads_shelf,
                goodreads_read_at = excluded.goodreads_read_at,
                goodreads_updated_at = excluded.goodreads_updated_at,
                goodreads_match_type = excluded.goodreads_match_type,
                goodreads_book_link = excluded.goodreads_book_link,
                sync_health = 'synced',
                last_sync_at = datetime('now'),
                last_sync_decision = 'goodreads_match',
                last_modified_at = CASE WHEN ? THEN datetime('now') ELSE last_modified_at END
            `).run(
              bookId, profileId, grBook.rating,
              grBook.shelf, grBook.readAt, grBook.updatedAt,
              matchType, grBook.bookLink,
              meaningfulGoodreadsChange ? 1 : 0
            );

            // Sync Goodreads status → Grimmory when enabled and shelf changed
            const grSource = db.prepare(
              "SELECT CAST(external_id AS INTEGER) as grimmory_book_id FROM book_sources WHERE source_type='grimmory' AND source_instance_id = ? AND book_id=? LIMIT 1"
            ).get(profileId, bookId) as { grimmory_book_id: number } | undefined;
            const grimmoryBookId = grSource?.grimmory_book_id ?? null;

            if (syncGoodreadsStatus && hasGrimmory && grimmoryToken && grimmoryBookId && grBook.shelf !== previousShelf && previousShelf !== null) {
              const grimmoryStatus = await db.prepare(
                "SELECT status FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'"
              ).get(bookId, profileId) as { status: string | null } | undefined;
              const mappedStatus = GOODREADS_TO_GRIMMORY[grBook.shelf];
              if (mappedStatus && mappedStatus !== grimmoryStatus?.status) {
                const grLastReadTime = (db.prepare(
                  "SELECT grimmory_last_read_time FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'"
                ).get(bookId, profileId) as { grimmory_last_read_time: string | null } | undefined)?.grimmory_last_read_time ?? null;
                const goodreadsIsLatest = shouldGoodreadsOverwriteGrimmory(grBook.updatedAt, grLastReadTime);
                if (!goodreadsIsLatest) {
                  logger.info("Skipped Goodreads status write because Grimmory is newer", { profileId, bookId, previousShelf, newShelf: grBook.shelf, mappedStatus });
                  recordEvent(db, runId, profileId, grBook.title, "skipped_no_change", "goodreads_to_grimmory", "grimmory_newer_than_goodreads", { mappedStatus });
                  counters.skipped++;
                } else if (dryRun) {
                  recordEvent(db, runId, profileId, grBook.title, "written", "goodreads_to_grimmory", "goodreads_latest_status", { previousShelf, newShelf: grBook.shelf, mappedStatus, dryRun });
                  counters.written++;
                } else {
                  try {
                    await adapters.updateGrimmoryStatus(baseUrl, grimmoryToken, grimmoryBookId, mappedStatus);
                    logger.info("Updated Grimmory status from Goodreads", { profileId, bookId, shelf: grBook.shelf, status: mappedStatus });
                    db.prepare("UPDATE user_book_states SET status = ? WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'")
                      .run(mappedStatus, bookId, profileId);
                    recordEvent(db, runId, profileId, grBook.title, "written", "goodreads_to_grimmory", "goodreads_latest_status", { previousShelf, newShelf: grBook.shelf, mappedStatus });
                    counters.written++;
                  } catch (err) {
                    logger.warn("Failed to update Grimmory status from Goodreads", { profileId, bookId, error: err });
                    recordEvent(db, runId, profileId, grBook.title, "api_failure", "goodreads_to_grimmory", "status_write_failed", { error: String(err) });
                  }
                }
              }
            }

            // Sync Goodreads rating → Grimmory when enabled and rating changed
            if (syncGoodreadsStatus && hasGrimmory && grimmoryToken && grimmoryBookId && targetGoodreadsRating !== null) {
              const grimmoryRat = (db.prepare(
                "SELECT rating FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'"
              ).get(bookId, profileId) as { rating: number | null } | undefined)?.rating ?? null;
              const grLastReadTime2 = (db.prepare(
                "SELECT grimmory_last_read_time FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'"
              ).get(bookId, profileId) as { grimmory_last_read_time: string | null } | undefined)?.grimmory_last_read_time ?? null;

              if ((grBook.rating !== previousGoodreadsRating || !sameNumber(targetGoodreadsRating, grimmoryRat)) && !sameNumber(targetGoodreadsRating, grimmoryRat)) {
                const goodreadsIsLatest = shouldGoodreadsOverwriteGrimmory(grBook.updatedAt, grLastReadTime2);
                if (!goodreadsIsLatest) {
                  recordEvent(db, runId, profileId, grBook.title, "skipped_no_change", "goodreads_to_grimmory", "grimmory_newer_than_goodreads_rating", { goodreadsRating: grBook.rating, targetRating: targetGoodreadsRating });
                  counters.skipped++;
                } else if (dryRun) {
                  recordEvent(db, runId, profileId, grBook.title, "written", "goodreads_to_grimmory", "goodreads_latest_rating", { goodreadsRating: grBook.rating, targetRating: targetGoodreadsRating, dryRun });
                  counters.written++;
                } else {
                  try {
                    await adapters.updateGrimmoryRating(baseUrl, grimmoryToken, grimmoryBookId, targetGoodreadsRating);
                    logger.info("Updated Grimmory rating from Goodreads", { profileId, bookId, goodreadsRating: grBook.rating, targetRating: targetGoodreadsRating });
                    recordEvent(db, runId, profileId, grBook.title, "written", "goodreads_to_grimmory", "goodreads_latest_rating", { goodreadsRating: grBook.rating, targetRating: targetGoodreadsRating });
                    counters.written++;
                  } catch (err) {
                    logger.warn("Failed to update Grimmory rating from Goodreads", { profileId, bookId, error: err });
                    recordEvent(db, runId, profileId, grBook.title, "api_failure", "goodreads_to_grimmory", "rating_write_failed", { error: String(err) });
                  }
                }
              }
            }

            goodreadsMatched++;
          } else {
            // No existing book found — create new GR source + user state
            if (hasGrimmory && !grimmoryAvailable) {
              logger.warn("Skipping new Goodreads-only book: Grimmory unavailable", { profileId, goodreadsId: grBook.goodreadsId, title: grBook.title });
              goodreadsUnmatched++;
              continue;
            }

            // Create GR book_source (book_id will be assigned by reconcile)
            const newSourceId = upsertBookSource(db, "goodreads", profileId, grBook.goodreadsId, {
              title: grBook.title,
              author: grBook.author,
              cover_url: grBook.coverUrl ?? null,
              isbn13: grBook.isbn13 ?? null,
              isbn10: grBook.isbn10 ?? null,
              series_name: grBook.seriesName ?? null,
              series_number: grBook.seriesNumber ?? null,
              source_goodreads_book_id: grBook.goodreadsId,
              goodreads_book_link: grBook.bookLink ?? null,
              last_sync_at: sqliteNow()
            });

            if (grBook.coverUrl) {
              enqueueImageCacheTask(`cover:${newSourceId}`, async () => {
                await cacheSourceCover(db, newSourceId, "goodreads", grBook.coverUrl!);
              });
            }

            // Reconcile to assign book_id, then write user state
            reconcileBookIdentities(db);
            const newSource = db.prepare("SELECT book_id FROM book_sources WHERE id = ?").get(newSourceId) as { book_id: number } | undefined;
            if (newSource?.book_id) {
              db.prepare(`
                INSERT OR IGNORE INTO user_book_states
                  (book_id, profile_id, source_type, rating, sync_health,
                   goodreads_shelf, goodreads_read_at, goodreads_updated_at,
                   goodreads_match_type, goodreads_book_link,
                   last_sync_at, last_sync_decision, last_modified_at)
                VALUES (?, ?, 'goodreads', ?, 'missing', ?, ?, ?, ?, ?, datetime('now'), 'goodreads_only', datetime('now'))
              `).run(
                newSource.book_id, profileId, grBook.rating,
                grBook.shelf, grBook.readAt, grBook.updatedAt,
                matchType, grBook.bookLink
              );
              logger.info("Created Goodreads-only book", { profileId, goodreadsId: grBook.goodreadsId, title: grBook.title, bookId: newSource.book_id });
            }
            goodreadsUnmatched++;
          }
        }

        // Reconcile to pick up new GR sources
        reconcileBookIdentities(db);
        logger.info("Goodreads enrichment complete", { profileId, goodreadsMatched, goodreadsUnmatched });

        if (grimmoryAvailable && hasGrimmory && grimmoryToken) {
          db.prepare("UPDATE user_book_states SET grimmory_shelves = NULL WHERE profile_id = ? AND source_type = 'grimmory'").run(profileId);
          grimmoryShelvesCleared = true;
          await syncGoodreadsShelvesToGrimmory(db, profileId, goodreadsUserId, baseUrl, grimmoryToken, dryRun, adapters);
        }
      } catch (err) {
        counters.sourceFailures++;
        logger.warn("Goodreads unavailable; preserving Goodreads data for this sync run", { profileId, error: err });
        recordEvent(db, runId, profileId, "Goodreads", "api_failure", "goodreads", "source_unavailable", { source: "goodreads", error: String(err) });
      }
    }

    // ── Phase I: Write tag ───────────────────────────────────────────────────
    if (grimmoryAvailable) {
      const currentGrimmoryIds = new Set(grimmoryBooks.map((b) => b.id));
      for (const grimmoryBookId of taggedSourceGrimmoryIds) {
        if (!currentGrimmoryIds.has(grimmoryBookId)) {
          taggedSourceGrimmoryIds.delete(grimmoryBookId);
          taggedSourceTitles.delete(grimmoryBookId);
        }
      }
    }

    if (writeTagEnabled && grimmoryAvailable && hasGrimmory && grimmoryToken && taggedSourceGrimmoryIds.size > 0) {
      logger.info("Applying Grimmory source tag", { profileId, tag: writeTagName, count: taggedSourceGrimmoryIds.size });
      for (const grimmoryBookId of taggedSourceGrimmoryIds) {
        const bookTitle = taggedSourceTitles.get(grimmoryBookId) ?? "";
        if (dryRun) {
          recordEvent(db, runId, profileId, bookTitle, "written", "source_to_grimmory", "would_write_tag", { grimmoryBookId, tag: writeTagName, dryRun });
          counters.written++;
          continue;
        }
        try {
          const changed = await adapters.addGrimmoryTag(baseUrl, grimmoryToken, grimmoryBookId, writeTagName);
          if (changed) {
            recordEvent(db, runId, profileId, bookTitle, "written", "source_to_grimmory", "tag_written", { grimmoryBookId, tag: writeTagName });
            counters.written++;
            logger.info("Wrote Grimmory source tag", { profileId, grimmoryBookId, tag: writeTagName });
          } else {
            recordEvent(db, runId, profileId, bookTitle, "skipped_no_change", "source_to_grimmory", "tag_already_present", { grimmoryBookId, tag: writeTagName });
            counters.skipped++;
          }
        } catch (writeErr) {
          logger.warn("Failed to write Grimmory source tag", { profileId, grimmoryBookId, tag: writeTagName, error: writeErr });
          recordEvent(db, runId, profileId, bookTitle, "api_failure", "source_to_grimmory", "tag_write_failed", { grimmoryBookId, tag: writeTagName, error: String(writeErr) });
          counters.skipped++;
        }
      }
    }

    if (grimmoryAvailable && hasGrimmory && grimmoryToken) {
      await syncMatchedSourceBooksToGrimmoryShelf(
        db,
        profileId,
        baseUrl,
        grimmoryToken,
        "hardcover",
        profile["hardcover_target_shelf_name"] as string | null,
        hardcoverSourceGrimmoryIds,
        dryRun,
        adapters
      );
      await syncMatchedSourceBooksToGrimmoryShelf(
        db,
        profileId,
        baseUrl,
        grimmoryToken,
        "goodreads",
        profile["goodreads_target_shelf_name"] as string | null,
        goodreadsSourceGrimmoryIds,
        dryRun,
        adapters
      );
    }

    // ── Phase J: Hardcover list → Grimmory shelf sync ────────────────────────
    if (hasHardcover && grimmoryAvailable && hasGrimmory && grimmoryToken) {
      await syncListsToShelves(db, profileId, baseUrl, grimmoryToken, hcLists, hardcoverToken, dryRun, !grimmoryShelvesCleared, adapters);
    }

    // ── Phase K: Chaptarr status pass ───────────────────────────────────────
    await adapters.syncChaptarrStatus(profileId);

    // ── Phase M: Audiobookshelf library sync ─────────────────────────────────
    if (hasAbs) {
      try {
        logger.info("Fetching Audiobookshelf libraries", { profileId });
        const absLibraries = await adapters.fetchAudiobookshelfLibraries(absBaseUrl, absApiKey!);
        const bookLibraries = absLibraries.filter((lib) => lib.mediaType === "book");
        const liveAbsIds = new Set<string>();
        let absSnapshotComplete = true;
        logger.info("Audiobookshelf libraries fetched", { profileId, total: absLibraries.length, bookLibraries: bookLibraries.length });

        for (const library of bookLibraries) {
          let items: Awaited<ReturnType<typeof fetchAudiobookshelfLibraryItems>>;
          try {
            items = await adapters.fetchAudiobookshelfLibraryItems(absBaseUrl, absApiKey!, library.id);
          } catch (libraryErr) {
            absSnapshotComplete = false;
            counters.sourceFailures++;
            logger.warn("Audiobookshelf library items fetch failed; continuing with remaining libraries", {
              profileId,
              libraryId: library.id,
              libraryName: library.name,
              error: libraryErr
            });
            recordEvent(db, runId, profileId, library.name, "api_failure", "audiobookshelf", "library_items_unavailable", {
              libraryId: library.id,
              error: String(libraryErr)
            });
            continue;
          }
          logger.info("Audiobookshelf library items fetched", { profileId, libraryId: library.id, libraryName: library.name, count: items.length });

          for (const item of items) {
            liveAbsIds.add(item.id);
            const meta = item.media?.metadata;
            if (!meta) continue;

            const absDuration = meta.duration ?? item.media.duration ?? null;
            const absFilePath = item.libraryFiles?.[0]?.metadata?.path ?? item.path ?? null;
            const absAsin = meta.asin ?? null;
            const absIsbn = meta.isbn ?? null;
            const absNarrator = meta.narrator ?? meta.narratorName ?? null;

            // Try to find an existing book_id to link this ABS item to
            let linkedBookId: number | null = null;

            // Check if already stored with this ABS item ID, scoped to this profile's
            // own ABS instance — another profile's ABS server could reuse the same
            // local item id for an unrelated audiobook.
            const existing = db.prepare(
              "SELECT book_id FROM book_sources WHERE source_type = 'audiobookshelf' AND source_instance_id = ? AND external_id = ?"
            ).get(profileId, item.id) as { book_id: number | null } | undefined;

            if (existing?.book_id) {
              linkedBookId = existing.book_id;
            } else {
              // Match by file path against other audiobook-capable sources first.
              // This is the strongest ABS identity signal and avoids linking an
              // audiobook item onto an ebook/physical canonical row.
              if (absFilePath) {
                const fileMatch = db.prepare(`
                  SELECT book_id FROM book_sources
                  WHERE ${audiobookCandidateWhereSql()} AND (
                    grimmory_primary_file_path = ? OR chaptarr_primary_file_path = ?
                  )
                  LIMIT 1
                `).get(absFilePath, absFilePath) as { book_id: number } | undefined;
                if (fileMatch) linkedBookId = fileMatch.book_id;
              }

              // Match by audiobook ASIN only against audiobook-capable rows.
              // ABS exposes audiobook metadata, so using the dedicated audible
              // ASIN field is much safer than the generic ebook ASIN column.
              if (!linkedBookId && absAsin) {
                const asinMatch = db.prepare(`
                  SELECT book_id FROM book_sources
                  WHERE ${audiobookCandidateWhereSql()}
                    AND (source_audible_asin = ? OR audiobookshelf_asin = ?)
                  LIMIT 1
                `).get(absAsin, absAsin) as { book_id: number } | undefined;
                if (asinMatch) linkedBookId = asinMatch.book_id;
              }

              // ISBN is a weaker fallback because many works share identifiers
              // across print, ebook, and audio variants. Restrict it to rows that
              // already look like audiobook records.
              if (!linkedBookId && absIsbn) {
                const isbnMatch = db.prepare(`
                  SELECT book_id FROM book_sources
                  WHERE ${audiobookCandidateWhereSql()} AND (isbn13 = ? OR isbn10 = ?)
                  LIMIT 1
                `).get(absIsbn, absIsbn) as { book_id: number } | undefined;
                if (isbnMatch) linkedBookId = isbnMatch.book_id;
              }
            }

            // Runtime validation: compare ABS duration with HC edition duration if available
            // Currently HC edition pages exist but not audio duration — mark validated when matched
            const runtimeValidated = linkedBookId !== null ? 1 : null;

            const absFields: Record<string, unknown> = {
              title: meta.title ?? null,
              author: meta.authorName ?? null,
              series_name: meta.seriesName ?? null,
              source_media_type: "audiobook",
              source_narrator: absNarrator,
              audiobookshelf_duration: absDuration !== null ? Math.round(absDuration) : null,
              audiobookshelf_file_path: absFilePath,
              audiobookshelf_asin: absAsin,
              audiobookshelf_runtime_validated: runtimeValidated,
              audiobookshelf_runtime_delta: null
            };
            if (linkedBookId !== null) {
              absFields["book_id"] = linkedBookId;
            }

            upsertBookSource(db, "audiobookshelf", profileId, item.id, absFields);
          }
        }

        if (!absSnapshotComplete) {
          logger.warn("Skipped Audiobookshelf stale-state pruning because library snapshot was incomplete", {
            profileId,
            liveItemCount: liveAbsIds.size
          });
        } else if (liveAbsIds.size > 0) {
          const placeholders = Array.from(liveAbsIds).map(() => "?").join(",");
          db.prepare(`
            DELETE FROM user_book_states
            WHERE profile_id = ?
              AND source_type = 'audiobookshelf'
              AND audiobookshelf_item_id IS NOT NULL
              AND audiobookshelf_item_id NOT IN (${placeholders})
          `).run(profileId, ...Array.from(liveAbsIds));
        } else {
          db.prepare(`
            DELETE FROM user_book_states
            WHERE profile_id = ?
              AND source_type = 'audiobookshelf'
              AND audiobookshelf_item_id IS NOT NULL
          `).run(profileId);
        }
        reconcileBookIdentities(db);
      } catch (err) {
        logger.warn("Audiobookshelf library sync failed; skipping ABS phase", { profileId, error: String(err) });
        recordEvent(db, runId, profileId, "Audiobookshelf", "api_failure", "audiobookshelf", "source_unavailable", { error: String(err) });
      }
    }

    // ── Phase N: Audiobookshelf progress sync ────────────────────────────────
    // ABS is the source of truth for audiobook listening progress.
    // When ABS reports progress for a matched audiobook, push that progress
    // outward to Grimmory and Hardcover whenever they differ meaningfully.
    if (hasAbs && (hasHardcover || grimmoryAvailable)) {
      try {
        logger.info("Fetching Audiobookshelf progress", { profileId });
        const absProgressList = await adapters.fetchAudiobookshelfAllProgress(absBaseUrl, absApiKey!);
        const absProgressIndex = new Map(absProgressList.map((p) => [p.libraryItemId, p]));
        logger.info("Audiobookshelf progress fetched", { profileId, count: absProgressList.length });

        // Get this profile's own ABS book_sources that are linked to a book. Scoped to
        // source_instance_id: absSource.abs_item_id is looked up against this profile's
        // own absProgressIndex below, and an unscoped row from another profile's ABS
        // instance could coincidentally share a local item id with an unrelated book.
        const absSources = db.prepare(`
          SELECT bs.external_id AS abs_item_id, bs.book_id,
                 bs.audiobookshelf_duration AS abs_duration,
                 bs.audiobookshelf_runtime_validated AS runtime_validated
          FROM book_sources bs
          WHERE bs.source_type = 'audiobookshelf' AND bs.source_instance_id = ? AND bs.book_id IS NOT NULL
        `).all(profileId) as Array<{ abs_item_id: string; book_id: number; abs_duration: number | null; runtime_validated: number | null }>;

        // Build book_id → Grimmory book_id lookup for use inside the loop, scoped to
        // this profile's own Grimmory instance (the id is about to be sent back to
        // this profile's Grimmory server).
        const grimmoryIdByBookId = new Map<number, number>();
        if (grimmoryAvailable) {
          (db.prepare(`
            SELECT book_id, CAST(external_id AS INTEGER) AS grimmory_book_id
            FROM book_sources WHERE source_type = 'grimmory' AND source_instance_id = ? AND book_id IS NOT NULL
          `).all(profileId) as Array<{ book_id: number; grimmory_book_id: number }>).forEach((row) => {
            grimmoryIdByBookId.set(row.book_id, row.grimmory_book_id);
          });
        }

        for (const absSource of absSources) {
          const absProgress = absProgressIndex.get(absSource.abs_item_id);

          // HC user state (if HC configured)
          const hcState = hasHardcover ? db.prepare(`
            SELECT hardcover_updated_at, progress, progress_seconds, hardcover_status_id, hardcover_read_id,
                   hardcover_user_book_id, hardcover_edition_id
            FROM user_book_states
            WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'
          `).get(absSource.book_id, profileId) as {
            hardcover_updated_at: string | null;
            progress: number | null;
            progress_seconds: number | null;
            hardcover_status_id: number | null;
            hardcover_read_id: number | null;
            hardcover_user_book_id: number | null;
            hardcover_edition_id: number | null;
          } | undefined : undefined;

          // HC audio_seconds/edition from book_sources (used for mismatch logging
          // and to detect when Hardcover's "current edition" pointer has drifted
          // away from the edition we're actually tracking progress against). Scoped
          // to this profile's own Hardcover instance — each profile can track a
          // different edition of the same book.
          const hcAudioSecondsRow = hasHardcover ? db.prepare(`
            SELECT hardcover_audio_seconds, source_edition_id, external_id FROM book_sources
            WHERE source_type = 'hardcover' AND source_instance_id = ? AND book_id = ?
          `).get(profileId, absSource.book_id) as { hardcover_audio_seconds: number | null; source_edition_id: string | null; external_id: string } | undefined : undefined;
          const hcAudioSeconds = hcAudioSecondsRow?.hardcover_audio_seconds ?? null;
          const persistedAudioEditionId = hcAudioSecondsRow?.source_edition_id != null
            ? Number.parseInt(hcAudioSecondsRow.source_edition_id, 10)
            : null;
          // Hardcover's own live "current edition" pointer for this book right
          // now — compared against our persisted target below to detect drift
          // even when our local cache still (correctly) remembers audio.
          const liveHcBookForEdition = hcAudioSecondsRow
            ? hcBooks.find((b) => String(b.book.id) === hcAudioSecondsRow.external_id)
            : undefined;
          if (absSource.abs_duration && hcAudioSeconds && hcAudioSeconds > 0) {
            const delta = Math.abs(absSource.abs_duration - hcAudioSeconds) / hcAudioSeconds;
            if (delta > 0.05) {
              logger.warn("ABS/HC audio duration mismatch — HC edition may be wrong", {
                profileId, bookId: absSource.book_id, absDuration: absSource.abs_duration, hcAudioSeconds, deltaPct: Math.round(delta * 100)
              });
            }
          }

          // Grimmory data for this book (if Grimmory available)
          const grimmoryBookId = grimmoryIdByBookId.get(absSource.book_id) ?? null;
          const grimProgressData = grimmoryBookId !== null ? grimmoryProgressById.get(grimmoryBookId) : undefined;
          const grBook = grimmoryBookId !== null ? grimmoryBooks.find((b) => b.id === grimmoryBookId) : undefined;
          const grProgress = meaningfulProgress(grimProgressData?.readProgress ?? null); // 0–100
          const bookOwnsSharedHardcover = grBook?.mediaType === "audiobook"
            && shouldBookProgressOwnSharedHardcover(grimmoryBooks, grBook.hardcoverBookId);

          const absDuration = absSource.abs_duration ?? (absProgress?.duration ?? null);
          const hcProgressPct = hcState?.progress_seconds && absDuration && absDuration > 0
            ? meaningfulProgress((hcState.progress_seconds / absDuration) * 100)
            : null;
          const storedHcProgress = meaningfulProgress(hcState?.progress ?? null);
          const effectiveHcProgress = storedHcProgress !== null
            ? storedHcProgress
            : hcProgressPct;
          const absSourcePct = absProgress ? clampPercent(absProgress.progress * 100) : null;

          // Backfill duration on book_sources if not yet stored (ABS item metadata may return 0).
          // Scoped to this profile's own ABS instance — a colliding item id on another
          // profile's ABS server must not have its duration overwritten.
          if (absDuration !== null && absDuration > 0 && !absSource.abs_duration) {
            db.prepare(
              "UPDATE book_sources SET audiobookshelf_duration = ? WHERE source_type = 'audiobookshelf' AND source_instance_id = ? AND external_id = ?"
            ).run(Math.round(absDuration), profileId, absSource.abs_item_id);
          }

          // Upsert ABS user state regardless of progress sync eligibility
          if (absProgress) {
            const absProgressPct = absProgress.progress * 100;
            const absUpdatedAt = new Date(absProgress.lastUpdate).toISOString();
            const absCurrentTimeSeconds = effectiveAbsCurrentTimeSeconds(absProgress, absDuration);
            db.prepare(`
              DELETE FROM user_book_states
              WHERE profile_id = ?
                AND source_type = 'audiobookshelf'
                AND audiobookshelf_item_id = ?
                AND book_id <> ?
            `).run(profileId, absSource.abs_item_id, absSource.book_id);
            const prevAbsState = db.prepare(
              "SELECT id, progress FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'audiobookshelf'"
            ).get(absSource.book_id, profileId) as { id: number; progress: number | null } | undefined;

            if (prevAbsState) {
              db.prepare(`
                UPDATE user_book_states
                SET progress = ?, audiobookshelf_item_id = ?, audiobookshelf_current_time = ?,
                    audiobookshelf_duration = ?, audiobookshelf_updated_at = ?,
                    last_modified_at = datetime('now'), last_sync_at = datetime('now')
                WHERE book_id = ? AND profile_id = ? AND source_type = 'audiobookshelf'
              `).run(
                absProgressPct, absSource.abs_item_id,
                absCurrentTimeSeconds,
                absDuration !== null ? Math.round(absDuration) : null,
                absUpdatedAt,
                absSource.book_id, profileId
              );
            } else {
              db.prepare(`
                INSERT INTO user_book_states
                  (book_id, profile_id, source_type, progress, audiobookshelf_item_id,
                   audiobookshelf_current_time, audiobookshelf_duration, audiobookshelf_updated_at,
                   sync_health, last_sync_at, last_modified_at)
                VALUES (?, ?, 'audiobookshelf', ?, ?, ?, ?, ?, 'synced', datetime('now'), datetime('now'))
              `).run(
                absSource.book_id, profileId, absProgressPct, absSource.abs_item_id,
                absCurrentTimeSeconds,
                absDuration !== null ? Math.round(absDuration) : null,
                absUpdatedAt
              );
            }
          }

          // ABS-driven progress sync — only when runtime is validated, duration is
          // known, and ABS actually reports a progress value for the item.
          if (!absSource.runtime_validated) continue;
          if (absDuration === null || absDuration <= 0) continue;
          if (absSourcePct === null) continue;
          const needsWrite = (targetPct: number | null): boolean =>
            targetPct === null ? absSourcePct > 0 : Math.abs(absSourcePct - targetPct) >= 0.1;
          // ABS is the source of truth for audiobook status too — 98%+ counts as
          // finished. This overrides whatever status Hardcover or Grimmory
          // currently have stored, since both can drift (e.g. a stale Hardcover
          // status left over from before the two editions were linked correctly).
          const absDesiredStatusId = absSourcePct >= 98 ? 3 : 2;
          const absDesiredGrimmoryStatus = HARDCOVER_TO_GRIMMORY[absDesiredStatusId];

          // ── Write to Grimmory ──
          if (grBook?.primaryFileId && grimmoryToken && needsWrite(grProgress)) {
            const direction = "abs_to_grimmory";
            const decision = "abs_newer_progress";
            if (!dryRun) {
              try {
                await adapters.updateGrimmoryProgress(baseUrl, grimmoryToken, grBook.id, grBook.primaryFileId, absSourcePct);
                logger.info("Wrote progress to Grimmory", { profileId, bookId: absSource.book_id, source: "abs", pct: absSourcePct });
                recordEvent(db, runId, profileId, grBook.title ?? "", "written", direction, decision, { pct: absSourcePct });
                counters.written++;
              } catch (writeErr) {
                logger.warn("Failed to write progress to Grimmory", { profileId, bookId: absSource.book_id, source: "abs", error: writeErr });
                counters.skipped++;
              }
            } else {
              recordEvent(db, runId, profileId, grBook.title ?? "", "written", direction, decision, { pct: absSourcePct, dryRun: true });
              counters.written++;
            }
          }

          // ── Write status to Grimmory (ABS-derived) ──
          if (grBook && grimmoryToken && absDesiredGrimmoryStatus && grBook.readStatus !== absDesiredGrimmoryStatus) {
            const direction = "abs_to_grimmory";
            const decision = "abs_derived_status";
            if (!dryRun) {
              try {
                await adapters.updateGrimmoryStatus(baseUrl, grimmoryToken, grBook.id, absDesiredGrimmoryStatus);
                logger.info("Wrote ABS-derived status to Grimmory", { profileId, bookId: absSource.book_id, status: absDesiredGrimmoryStatus, pct: absSourcePct });
                recordEvent(db, runId, profileId, grBook.title ?? "", "written", direction, decision, { status: absDesiredGrimmoryStatus, pct: absSourcePct });
                counters.written++;
              } catch (writeErr) {
                logger.warn("Failed to write ABS-derived status to Grimmory", { profileId, bookId: absSource.book_id, error: writeErr });
                counters.skipped++;
              }
            } else {
              recordEvent(db, runId, profileId, grBook.title ?? "", "written", direction, decision, { status: absDesiredGrimmoryStatus, pct: absSourcePct, dryRun: true });
              counters.written++;
            }
          }

          // ── Write to Hardcover ──
          if (bookOwnsSharedHardcover) {
            logger.info("Skipped ABS-to-Hardcover progress write because book edition owns shared Hardcover progress", {
              profileId,
              bookId: absSource.book_id,
              grimmoryBookId: grBook?.id ?? null,
              pct: absSourcePct
            });
            recordEvent(db, runId, profileId, grBook?.title ?? "", "skipped_no_change", "abs_to_hardcover", "book_progress_wins_shared_hardcover", {
              pct: absSourcePct,
              grimmoryBookId: grBook?.id ?? null
            });
            counters.skipped++;
            continue;
          }

          // Also re-enter when only the status is stale (e.g. progress already
          // matches within tolerance but Hardcover's status_id is left over from
          // before this book's audiobook/print editions were linked correctly) —
          // otherwise a wrong status can never self-correct once progress settles.
          const hcStatusNeedsCorrection = hasHardcover && hcState?.hardcover_status_id !== absDesiredStatusId;
          // Also re-enter when Hardcover's "current edition" pointer for this
          // shared book has drifted off the audio edition (e.g. touching any
          // other read on it flips this) even though progress/status content
          // already match — otherwise Hardcover keeps showing the wrong
          // edition (and its unrelated 0% progress) as "currently reading"
          // even while the actual audio read stays perfectly in sync.
          const hcEditionNeedsCorrection = hasHardcover
            && Number.isFinite(persistedAudioEditionId)
            && liveHcBookForEdition !== undefined
            && liveHcBookForEdition.edition_id !== persistedAudioEditionId;
          if (needsWrite(effectiveHcProgress) || hcStatusNeedsCorrection || hcEditionNeedsCorrection) {
            const hcSourceRow = hasHardcover ? db.prepare(`
              SELECT external_id, source_edition_id, source_media_type, source_audible_asin, hardcover_audio_seconds
              FROM book_sources
              WHERE source_type = 'hardcover' AND source_instance_id = ? AND book_id = ?
            `).get(profileId, absSource.book_id) as {
              external_id: string;
              source_edition_id: string | number | null;
              source_media_type: string | null;
              source_audible_asin: string | null;
              hardcover_audio_seconds: number | null;
            } | undefined : undefined;
            // Scoped to this profile's own Grimmory/ABS instances — these values feed a
            // Hardcover edition lookup made through this profile's own Hardcover token,
            // so another profile's cross-reference data must not leak in.
            const audiobookIdentityRow = db.prepare(`
              SELECT
                MAX(CASE WHEN source_type = 'grimmory' AND source_instance_id = ? THEN source_hardcover_book_id END) AS grimmory_hardcover_book_id,
                MAX(CASE WHEN source_type = 'grimmory' AND source_instance_id = ? THEN source_audible_asin END) AS grimmory_audible_asin,
                MAX(CASE WHEN source_type = 'audiobookshelf' AND source_instance_id = ? THEN audiobookshelf_asin END) AS audiobookshelf_asin
              FROM book_sources
              WHERE book_id = ?
            `).get(profileId, profileId, profileId, absSource.book_id) as {
              grimmory_hardcover_book_id: string | null;
              grimmory_audible_asin: string | null;
              audiobookshelf_asin: string | null;
            } | undefined;
            const parsedHcBookId = hcSourceRow
              ? parseInt(hcSourceRow.external_id, 10)
              : (audiobookIdentityRow?.grimmory_hardcover_book_id
                  ? parseInt(audiobookIdentityRow.grimmory_hardcover_book_id, 10)
                  : null);
            const hcBookId = parsedHcBookId !== null && Number.isFinite(parsedHcBookId) ? parsedHcBookId : null;
            const hcLibraryBook = hcBookId !== null ? hcBooks.find((book) => book.book.id === hcBookId) : undefined;
            let preferredEditionId: number | null = null;
            const desiredStatusId = absDesiredStatusId;

            if (hcSourceRow?.source_edition_id != null && hcSourceRow.source_media_type === "audiobook") {
              preferredEditionId = parseInt(String(hcSourceRow.source_edition_id), 10) || null;
            }

            if (!preferredEditionId && hardcoverToken && hcBookId !== null) {
              try {
                const candidateAsins = new Set([
                  audiobookIdentityRow?.audiobookshelf_asin,
                  audiobookIdentityRow?.grimmory_audible_asin,
                  hcSourceRow?.source_audible_asin
                ].filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim().toLowerCase()));
                const editions = await adapters.fetchEditionsForBook(hardcoverToken, hcBookId);
                const asinMatch = editions.find((edition) => edition.asin && candidateAsins.has(edition.asin.trim().toLowerCase()));
                const runtimeMatch = !asinMatch && absDuration
                  ? editions.find((edition) => edition.audio_seconds && Math.abs(edition.audio_seconds - absDuration) / absDuration <= 0.05)
                  : undefined;
                const formatMatch = !asinMatch && !runtimeMatch
                  ? editions.find((edition) => edition.edition_format?.toLowerCase().includes("audio"))
                  : undefined;
                preferredEditionId = asinMatch?.id ?? runtimeMatch?.id ?? formatMatch?.id ?? null;
                if (preferredEditionId) {
                  logger.info("Resolved Hardcover audio edition for ABS progress", {
                    profileId,
                    bookId: absSource.book_id,
                    hcBookId,
                    preferredEditionId,
                    matchedBy: asinMatch ? "asin" : runtimeMatch ? "duration" : "format"
                  });
                }
              } catch (editionErr) {
                logger.warn("Failed to resolve Hardcover audio edition for ABS progress", {
                  profileId,
                  bookId: absSource.book_id,
                  hcBookId,
                  error: editionErr
                });
              }
            }
            if (!preferredEditionId) {
              preferredEditionId = hcLibraryBook?.book.default_audio_edition_id ?? null;
            }

            persistResolvedHardcoverAudioEdition(db, profileId, absSource.book_id, preferredEditionId);

            if (hcState?.hardcover_user_book_id) {
              const progressSeconds = absProgress
                ? effectiveAbsCurrentTimeSeconds(absProgress, absDuration)
                : Math.round((absSourcePct / 100) * (absDuration ?? 0));
              const direction = "abs_to_hardcover";
              const decision = "abs_newer_progress";
              const desiredStatusText = desiredStatusId === 3 ? "READ" : "READING";
              const readFields: HardcoverReadFields = {
                edition_id: preferredEditionId ?? undefined,
                progress_pages: 0,
                progress_seconds: progressSeconds,
                started_at: todayDate(),
                finished_at: null,
                finished_at_precision: null
              };
              if (!dryRun) {
                try {
                  // Only patch edition_id/status_id when they actually differ —
                  // Hardcover appears to auto-start a fresh blank read whenever
                  // edition_id is (re)patched, even to its current value, which
                  // would otherwise pile up a new empty read on every sync run.
                  // Compare against Hardcover's live current edition (not just
                  // our local cache) since that pointer can drift on its own
                  // between syncs without our cache knowing.
                  const userBookPatch: { edition_id?: number | null; status_id?: number } = {};
                  if (preferredEditionId && preferredEditionId !== (liveHcBookForEdition?.edition_id ?? hcState.hardcover_edition_id)) {
                    userBookPatch.edition_id = preferredEditionId;
                  }
                  if (hcState.hardcover_status_id !== desiredStatusId) userBookPatch.status_id = desiredStatusId;
                  if (Object.keys(userBookPatch).length > 0) {
                    await adapters.updateHardcoverUserBook(hardcoverToken, hcState.hardcover_user_book_id, userBookPatch);
                  }
                  // Our cached hardcover_read_id can go stale — e.g. Hardcover
                  // auto-creates a fresh blank read when status_id changes, or an
                  // older read simply ages out / gets removed. Verify it's still
                  // live before updating it; blindly updating a read id Hardcover
                  // no longer recognizes silently no-ops, leaving the actually
                  // displayed (blank) read at 0% forever. Fall back to an existing
                  // open read on the target edition, then to inserting a new one.
                  const liveReads = hcLibraryBook?.user_book_reads ?? [];
                  const cachedReadStillLive = hcState.hardcover_read_id != null
                    && liveReads.some((read) => read.id === hcState.hardcover_read_id);
                  const targetReadId = cachedReadStillLive
                    ? hcState.hardcover_read_id
                    : liveReads.find((read) => read.edition_id === preferredEditionId && read.finished_at === null)?.id ?? null;

                  if (targetReadId) {
                    await adapters.updateHardcoverUserBookRead(hardcoverToken, targetReadId, readFields);
                    if (targetReadId !== hcState.hardcover_read_id) {
                      logger.info("Re-pointed Hardcover read to live record after stale/missing cached read id", {
                        profileId, bookId: absSource.book_id, staleReadId: hcState.hardcover_read_id, targetReadId
                      });
                      db.prepare("UPDATE user_book_states SET hardcover_read_id = ? WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'")
                        .run(targetReadId, absSource.book_id, profileId);
                    }
                  } else {
                    const newReadId = await adapters.insertHardcoverUserBookRead(hardcoverToken, hcState.hardcover_user_book_id, readFields);
                    db.prepare("UPDATE user_book_states SET hardcover_read_id = ? WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'")
                      .run(newReadId, absSource.book_id, profileId);
                  }
                  db.prepare(`
                    UPDATE user_book_states
                    SET status = ?, progress = NULL, progress_seconds = ?, hardcover_status_id = ?,
                        hardcover_edition_id = COALESCE(?, hardcover_edition_id),
                        last_sync_at = datetime('now'), last_sync_decision = ?
                    WHERE book_id = ? AND profile_id = ? AND source_type = 'hardcover'
                  `).run(desiredStatusText, progressSeconds, desiredStatusId, preferredEditionId, decision, absSource.book_id, profileId);
                  logger.info("Wrote audio progress to Hardcover", { profileId, bookId: absSource.book_id, source: "abs", pct: absSourcePct, progressSeconds, preferredEditionId });
                  recordEvent(db, runId, profileId, "", "written", direction, decision, { pct: absSourcePct, progressSeconds, preferredEditionId });
                  counters.written++;
                } catch (writeErr) {
                  logger.warn("Failed to write audio progress to Hardcover", { profileId, bookId: absSource.book_id, source: "abs", error: writeErr });
                  counters.skipped++;
                }
              } else {
                recordEvent(db, runId, profileId, "", "written", direction, decision, { pct: absSourcePct, progressSeconds, preferredEditionId, dryRun: true });
                counters.written++;
              }
            } else if (hardcoverToken) {
              // No valid user_book_id yet. If Grimmory/ABS can identify the HC book,
              // create an audiobook user_book/read so future syncs have a local state.
              if (hcBookId !== null) {
                const progressSeconds = absProgress
                  ? effectiveAbsCurrentTimeSeconds(absProgress, absDuration)
                  : Math.round((absSourcePct / 100) * (absDuration ?? 0));
                const direction = "abs_to_hardcover";
                const decision = "abs_newer_progress";
                if (!dryRun) {
                  try {
                    const desiredStatusText = desiredStatusId === 3 ? "READ" : "READING";
                    const newUserBookId = await adapters.insertHardcoverUserBook(hardcoverToken, {
                      book_id: hcBookId,
                      status_id: desiredStatusId,
                      edition_id: preferredEditionId ?? undefined
                    });
                    const newReadId = await adapters.insertHardcoverUserBookRead(hardcoverToken, newUserBookId, {
                      edition_id: preferredEditionId ?? undefined,
                      progress_pages: 0,
                      progress_seconds: progressSeconds,
                      started_at: todayDate(),
                      finished_at: null,
                      finished_at_precision: null
                    });
                    db.prepare(`
                      INSERT INTO user_book_states
                        (book_id, profile_id, source_type, status, progress, progress_pages,
                         progress_seconds, sync_health, hardcover_status_id, hardcover_read_id,
                         hardcover_user_book_id, hardcover_edition_id, last_sync_at,
                         last_sync_decision, last_modified_at)
                      VALUES (?, ?, 'hardcover', ?, NULL, 0, ?, 'synced', ?, ?, ?, ?,
                              datetime('now'), ?, datetime('now'))
                      ON CONFLICT(book_id, profile_id, source_type) DO UPDATE SET
                        status = excluded.status,
                        progress = NULL,
                        progress_pages = 0,
                        progress_seconds = excluded.progress_seconds,
                        sync_health = 'synced',
                        hardcover_status_id = excluded.hardcover_status_id,
                        hardcover_read_id = excluded.hardcover_read_id,
                        hardcover_user_book_id = excluded.hardcover_user_book_id,
                        hardcover_edition_id = excluded.hardcover_edition_id,
                        last_sync_at = datetime('now'),
                        last_sync_decision = excluded.last_sync_decision,
                        last_modified_at = datetime('now')
                    `).run(
                      absSource.book_id, profileId, desiredStatusText, progressSeconds, desiredStatusId,
                      newReadId, newUserBookId, preferredEditionId, decision
                    );
                    logger.info("Created HC user_book and wrote audio progress", {
                      profileId, bookId: absSource.book_id, hcBookId, newUserBookId, preferredEditionId, statusId: desiredStatusId, progressSeconds
                    });
                    recordEvent(db, runId, profileId, "", "written", direction, decision, { pct: absSourcePct, progressSeconds, preferredEditionId, createdUserBook: true });
                    counters.written++;
                  } catch (writeErr) {
                    logger.warn("Failed to create HC user_book for audio progress", {
                      profileId, bookId: absSource.book_id, hcBookId, error: writeErr
                    });
                    counters.skipped++;
                  }
                } else {
                  recordEvent(db, runId, profileId, "", "written", direction, decision, { pct: absSourcePct, progressSeconds, preferredEditionId, createdUserBook: true, dryRun: true });
                  counters.written++;
                }
              } else {
                // Book has no HC match — cannot write
                recordEvent(db, runId, profileId, "", "skipped_no_change", "abs_to_hardcover", "hc_book_id_missing", { pct: absSourcePct });
                counters.skipped++;
              }
            } else {
              recordEvent(db, runId, profileId, "", "skipped_no_change", "abs_to_hardcover", "hc_user_book_id_missing", { pct: absSourcePct });
              counters.skipped++;
            }
          }
        }
      } catch (err) {
        logger.warn("Audiobookshelf progress sync failed", { profileId, error: String(err) });
        recordEvent(db, runId, profileId, "Audiobookshelf", "api_failure", "audiobookshelf", "progress_sync_failed", { error: String(err) });
      }
    }

    // ── Phase L: Final reconcile ─────────────────────────────────────────────
    reconcileBookIdentities(db);

    const summary = dryRun
      ? `Dry run: ${counters.written} would write, ${counters.skipped} skipped${counters.sourceFailures ? `, ${counters.sourceFailures} source unavailable` : ""}, ${grimmoryBooks.length ? `matched against ${grimmoryBooks.length} Grimmory books` : "no Grimmory connection"}`
      : `${counters.written} written, ${counters.skipped} skipped${counters.sourceFailures ? `, ${counters.sourceFailures} source unavailable` : ""}`;

    db.prepare(`
      UPDATE sync_runs
      SET status = 'success', finished_at = datetime('now'), summary = ?,
          changes_written = ?, changes_skipped = ?, changes_superseded = ?
      WHERE id = ?
    `).run(summary, counters.written, counters.skipped, counters.superseded, runId);

    logger.info("Sync completed", { profileId, runId, dryRun, ...counters, hcBooks: hcBooks.length, grBooks: grimmoryBooks.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Sync failed", { profileId, runId, error: message });
    recordEvent(db, runId, profileId, "Sync", "api_failure", null, "source_unavailable", { error: message });
    db.prepare(`
      UPDATE sync_runs
      SET status = 'error', finished_at = datetime('now'),
          summary = 'Sync failed', error = ?
      WHERE id = ?
    `).run(message, runId);
  }
}

// ── Pruning helpers ───────────────────────────────────────────────────────────

// Prune HC user states for books no longer in the fetched HC library
export function pruneHardcoverUserStatesMissingFromFetch(
  db: Db,
  profileId: number,
  fetchedHcBookIds: Set<number>
): void {
  if (fetchedHcBookIds.size === 0) return;
  const placeholders = Array.from(fetchedHcBookIds).map(() => "?").join(",");
  const result = db.prepare(`
    DELETE FROM user_book_states
    WHERE profile_id = ? AND source_type = 'hardcover'
      AND book_id IN (
        SELECT book_id FROM book_sources
        WHERE source_type = 'hardcover' AND source_instance_id = ?
          AND CAST(external_id AS INTEGER) NOT IN (${placeholders})
      )
  `).run(profileId, profileId, ...Array.from(fetchedHcBookIds));
  if (result.changes > 0) {
    logger.info("Pruned HC user states missing from fetched library", { profileId, deleted: result.changes });
  }
}

// Prune this profile's Hardcover book_sources for books no longer in its HC library.
// Scoped to source_instance_id so another profile's Hardcover connection can't be pruned.
export function pruneHardcoverSourcesMissingFromFetch(db: Db, profileId: number, fetchedHcBookIds: Set<number>): void {
  if (fetchedHcBookIds.size === 0) return;
  const placeholders = Array.from(fetchedHcBookIds).map(() => "?").join(",");
  // Only delete if this profile itself has no user_book_states referencing the book via
  // HC — scoped to match the DELETE's own instance scope, so another profile's state
  // can't keep this profile's orphaned source row alive indefinitely.
  const result = db.prepare(`
    DELETE FROM book_sources
    WHERE source_type = 'hardcover' AND source_instance_id = ?
      AND CAST(external_id AS INTEGER) NOT IN (${placeholders})
      AND NOT EXISTS (
        SELECT 1 FROM user_book_states
        WHERE book_id = book_sources.book_id AND source_type = 'hardcover' AND profile_id = ?
      )
  `).run(profileId, ...Array.from(fetchedHcBookIds), profileId);
  if (result.changes > 0) {
    logger.info("Pruned HC book_sources with no remaining user states", { profileId, deleted: result.changes });
  }
}

// Prune this profile's Grimmory book_sources for books no longer in its Grimmory library.
// Scoped to source_instance_id so another profile's Grimmory connection can't be pruned.
export function pruneGrimmorySourcesMissingFromFetch(db: Db, profileId: number, fetchedGrimmoryIds: Set<number>): void {
  if (fetchedGrimmoryIds.size === 0) return;
  const placeholders = Array.from(fetchedGrimmoryIds).map(() => "?").join(",");
  const result = db.prepare(`
    DELETE FROM book_sources
    WHERE source_type = 'grimmory' AND source_instance_id = ?
      AND CAST(external_id AS INTEGER) NOT IN (${placeholders})
      AND NOT EXISTS (
        SELECT 1 FROM user_book_states
        WHERE book_id = book_sources.book_id AND source_type = 'grimmory' AND profile_id = ?
      )
  `).run(profileId, ...Array.from(fetchedGrimmoryIds), profileId);
  if (result.changes > 0) {
    logger.info("Pruned Grimmory book_sources with no remaining user states", { profileId, deleted: result.changes });
  }
}

// Prune Grimmory user states for books no longer in this profile's Grimmory library
export function pruneGrimmoryUserStatesMissingFromFetch(
  db: Db,
  profileId: number,
  fetchedGrimmoryIds: Set<number>
): void {
  if (fetchedGrimmoryIds.size === 0) return;
  const placeholders = Array.from(fetchedGrimmoryIds).map(() => "?").join(",");
  const result = db.prepare(`
    DELETE FROM user_book_states
    WHERE profile_id = ? AND source_type = 'grimmory'
      AND book_id IN (
        SELECT book_id FROM book_sources
        WHERE source_type = 'grimmory' AND source_instance_id = ?
          AND CAST(external_id AS INTEGER) NOT IN (${placeholders})
      )
  `).run(profileId, profileId, ...Array.from(fetchedGrimmoryIds));
  if (result.changes > 0) {
    logger.info("Pruned Grimmory user states missing from fetched library", { profileId, deleted: result.changes });
  }
}

// Prune GR user states for books no longer in this profile's GR library
export function pruneGoodreadsUserStatesMissingFromFetch(
  db: Db,
  profileId: number,
  fetchedGoodreadsIds: Set<string>
): void {
  if (fetchedGoodreadsIds.size === 0) return;
  const placeholders = Array.from(fetchedGoodreadsIds).map(() => "?").join(",");
  const result = db.prepare(`
    DELETE FROM user_book_states
    WHERE profile_id = ? AND source_type = 'goodreads'
      AND book_id IN (
        SELECT book_id FROM book_sources
        WHERE source_type = 'goodreads' AND source_instance_id = ?
          AND external_id NOT IN (${placeholders})
      )
  `).run(profileId, profileId, ...Array.from(fetchedGoodreadsIds));
  if (result.changes > 0) {
    logger.info("Pruned Goodreads user states missing from fetched library", { profileId, deleted: result.changes });
  }
}

// ── Shelf sync helpers ────────────────────────────────────────────────────────

async function syncGoodreadsShelvesToGrimmory(
  db: Db,
  profileId: number,
  goodreadsUserId: string,
  baseUrl: string,
  grimmoryToken: string,
  dryRun: boolean,
  adapters: SyncAdapters
): Promise<void> {
  type MappingRow = { id: number; source_list_name: string; grimmory_shelf_name: string; grimmory_shelf_id: number | null };
  const mappings = db.prepare(`
    SELECT id, source_list_name, grimmory_shelf_name, grimmory_shelf_id
    FROM shelf_mappings
    WHERE profile_id = ? AND source = 'goodreads' AND source_list_name IS NOT NULL AND enabled = 1
  `).all(profileId) as MappingRow[];

  if (mappings.length === 0) return;
  logger.info("Syncing Goodreads shelves to Grimmory", { profileId, count: mappings.length });

  // Build lookup: goodreads_book_id → grimmory_book_id
  const grimmoryByGoodreadsId: Record<string, number> = {};
  const grimmoryByIsbn13: Record<string, number> = {};
  const grimmoryByIsbn10: Record<string, number> = {};
  const grimmoryByTitle: Record<string, number> = {};

  // gr_src is scoped to this profile's own Grimmory instance — the resulting
  // grimmory_book_id is about to be sent to this profile's Grimmory server, and
  // another instance's local ID would point at an unrelated book there.
  const sourcePairs = db.prepare(`
    SELECT go_src.external_id as goodreads_id, go_src.isbn13 as go_isbn13, go_src.isbn10 as go_isbn10,
           go_src.title as go_title,
           CAST(gr_src.external_id AS INTEGER) as grimmory_book_id
    FROM book_sources go_src
    JOIN book_sources gr_src ON gr_src.book_id = go_src.book_id AND gr_src.source_type = 'grimmory' AND gr_src.source_instance_id = ?
    WHERE go_src.source_type = 'goodreads'
  `).all(profileId) as { goodreads_id: string; go_isbn13: string | null; go_isbn10: string | null; go_title: string | null; grimmory_book_id: number }[];

  for (const pair of sourcePairs) {
    grimmoryByGoodreadsId[pair.goodreads_id] = pair.grimmory_book_id;
    if (pair.go_isbn13) grimmoryByIsbn13[pair.go_isbn13] ??= pair.grimmory_book_id;
    if (pair.go_isbn10) grimmoryByIsbn10[pair.go_isbn10] ??= pair.grimmory_book_id;
    const norm = pair.go_title ? normalizeTitle(pair.go_title) : "";
    if (norm) grimmoryByTitle[norm] ??= pair.grimmory_book_id;
  }

  for (const mapping of mappings) {
    const shelfName = mapping.source_list_name;
    let grimmoryBookIds: number[] = [];

    try {
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        const { books, hasMore: more } = await adapters.fetchShelfPage(goodreadsUserId, shelfName, page);
        for (const book of books) {
          let gId: number | undefined;
          if (book.goodreadsId && grimmoryByGoodreadsId[book.goodreadsId]) gId = grimmoryByGoodreadsId[book.goodreadsId];
          else if (book.isbn13 && grimmoryByIsbn13[book.isbn13]) gId = grimmoryByIsbn13[book.isbn13];
          else if (book.isbn10 && grimmoryByIsbn10[book.isbn10]) gId = grimmoryByIsbn10[book.isbn10];
          else { const norm = normalizeTitle(book.title); if (norm && grimmoryByTitle[norm]) gId = grimmoryByTitle[norm]; }
          if (gId && !grimmoryBookIds.includes(gId)) grimmoryBookIds.push(gId);
        }
        hasMore = more;
        page++;
        if (hasMore) await new Promise((r) => setTimeout(r, 300));
      }
    } catch (err) {
      logger.warn("Failed to fetch Goodreads shelf books for mapping", { profileId, shelfName, error: err });
      continue;
    }

    if (grimmoryBookIds.length === 0) {
      logger.info("No matched Grimmory books for Goodreads shelf", { profileId, shelfName, grimmoryShelfName: mapping.grimmory_shelf_name });
    }

    if (dryRun && !mapping.grimmory_shelf_id) {
      logger.info("Dry run: mapped Grimmory shelf would be resolved or created", { profileId, shelfName, grimmoryShelfName: mapping.grimmory_shelf_name });
      continue;
    }

    let shelfId = mapping.grimmory_shelf_id;
    if (!shelfId) {
      try {
        shelfId = await adapters.ensureGrimmoryShelf(baseUrl, grimmoryToken, mapping.grimmory_shelf_name);
        db.prepare("UPDATE shelf_mappings SET grimmory_shelf_id = ? WHERE id = ?").run(shelfId, mapping.id);
      } catch (err) {
        logger.warn("Failed to resolve Grimmory shelf for Goodreads sync", { profileId, grimmoryShelfName: mapping.grimmory_shelf_name, error: err });
        continue;
      }
    }

    let currentIds: number[];
    try {
      currentIds = await adapters.fetchGrimmoryShelfBookIds(baseUrl, grimmoryToken, shelfId);
    } catch (err) {
      logger.warn("Failed to fetch Grimmory shelf for Goodreads sync", { profileId, shelfName, grimmoryShelfName: mapping.grimmory_shelf_name, error: err });
      continue;
    }

    const toAdd = grimmoryBookIds.filter((id) => !currentIds.includes(id));
    if (toAdd.length > 0) {
      if (dryRun) {
        logger.info("Dry run: would add books to Grimmory shelf from Goodreads shelf", { profileId, shelfName, grimmoryShelfName: mapping.grimmory_shelf_name, count: toAdd.length });
      } else {
        try {
          await adapters.addBooksToGrimmoryShelf(baseUrl, grimmoryToken, toAdd, shelfId);
          logger.info("Synced Goodreads shelf to Grimmory shelf", { profileId, shelfName, grimmoryShelfName: mapping.grimmory_shelf_name, added: toAdd.length });
        } catch (err) {
          logger.warn("Failed to add books to Grimmory shelf from Goodreads", { profileId, grimmoryShelfName: mapping.grimmory_shelf_name, error: err });
        }
      }
    } else {
      logger.info("Grimmory shelf already up to date for Goodreads shelf", { profileId, shelfName, grimmoryShelfName: mapping.grimmory_shelf_name });
    }

    // Record Grimmory shelf membership on user_book_states
    const allOnShelf = [...new Set([...currentIds, ...toAdd])];
    if (allOnShelf.length > 0 && !dryRun) {
      const grimmoryShelfName = mapping.grimmory_shelf_name;
      const shelfPlaceholders = allOnShelf.map(() => "?").join(",");
      db.prepare(`
        UPDATE user_book_states SET grimmory_shelves = CASE
          WHEN grimmory_shelves IS NULL THEN ?
          WHEN (',' || grimmory_shelves || ',') NOT LIKE ('%,' || ? || ',%') THEN grimmory_shelves || ',' || ?
          ELSE grimmory_shelves
        END
        WHERE profile_id = ? AND source_type = 'grimmory'
          AND book_id IN (
            SELECT book_id FROM book_sources
            WHERE source_type = 'grimmory' AND source_instance_id = ? AND CAST(external_id AS INTEGER) IN (${shelfPlaceholders})
          )
      `).run(grimmoryShelfName, grimmoryShelfName, grimmoryShelfName, profileId, profileId, ...allOnShelf);
    }
  }
}

async function syncMatchedSourceBooksToGrimmoryShelf(
  _db: Db,
  profileId: number,
  baseUrl: string,
  grimmoryToken: string,
  source: "hardcover" | "goodreads",
  targetShelfName: string | null,
  grimmoryBookIds: Set<number>,
  dryRun: boolean,
  adapters: SyncAdapters
): Promise<void> {
  const shelfName = targetShelfName?.trim();
  if (!shelfName || grimmoryBookIds.size === 0) return;

  let shelfId: number;
  try {
    shelfId = await adapters.ensureGrimmoryShelf(baseUrl, grimmoryToken, shelfName);
  } catch (err) {
    logger.warn("Failed to resolve Grimmory target shelf for source sync", { profileId, source, shelfName, error: err });
    return;
  }

  let currentIds: number[];
  try {
    currentIds = await adapters.fetchGrimmoryShelfBookIds(baseUrl, grimmoryToken, shelfId);
  } catch (err) {
    logger.warn("Failed to fetch Grimmory target shelf for source sync", { profileId, source, shelfName, error: err });
    return;
  }

  const toAdd = Array.from(grimmoryBookIds).filter((id) => !currentIds.includes(id));
  if (toAdd.length === 0) {
    logger.info("Grimmory target shelf already up to date for source sync", { profileId, source, shelfName });
    return;
  }

  if (dryRun) {
    logger.info("Dry run: would add matched source books to Grimmory target shelf", { profileId, source, shelfName, count: toAdd.length });
    return;
  }

  try {
    await adapters.addBooksToGrimmoryShelf(baseUrl, grimmoryToken, toAdd, shelfId);
    logger.info("Added matched source books to Grimmory target shelf", { profileId, source, shelfName, added: toAdd.length });
  } catch (err) {
    logger.warn("Failed to add matched source books to Grimmory target shelf", { profileId, source, shelfName, error: err });
  }
}

async function syncListsToShelves(
  db: Db,
  profileId: number,
  baseUrl: string,
  grimmoryToken: string,
  hcLists: Awaited<ReturnType<typeof fetchHardcoverLists>>,
  hardcoverToken: string,
  dryRun: boolean,
  clearFirst: boolean,
  adapters: SyncAdapters
): Promise<void> {
  if (clearFirst) {
    db.prepare("UPDATE user_book_states SET grimmory_shelves = NULL WHERE profile_id = ? AND source_type = 'grimmory'").run(profileId);
  }

  interface MappingRow {
    id: number;
    source_list_id: string;
    source_list_name: string;
    grimmory_shelf_name: string;
    grimmory_shelf_id: number | null;
  }

  const mappings = db.prepare(`
    SELECT id, source_list_id, source_list_name, grimmory_shelf_name, grimmory_shelf_id
    FROM shelf_mappings
    WHERE profile_id = ? AND source = 'hardcover' AND source_list_id IS NOT NULL AND enabled = 1
  `).all(profileId) as MappingRow[];

  if (mappings.length === 0) return;
  logger.info("Syncing mapped Hardcover lists and Grimmory shelves", { profileId, count: mappings.length });

  for (const mapping of mappings) {
    const hcList = hcLists.find((l) => String(l.id) === mapping.source_list_id);
    if (!hcList) {
      logger.warn("Hardcover list not found for mapping — may have been deleted", { profileId, mappingId: mapping.id, listId: mapping.source_list_id });
      continue;
    }

    let grimmoryBookIds: number[] = [];
    if (hcList.bookIds.length > 0) {
      const placeholders = hcList.bookIds.map(() => "?").join(",");
      grimmoryBookIds = (db.prepare(`
        SELECT DISTINCT CAST(gr_src.external_id AS INTEGER) as grimmory_book_id
        FROM book_sources hc_src
        JOIN book_sources gr_src ON gr_src.book_id = hc_src.book_id AND gr_src.source_type = 'grimmory' AND gr_src.source_instance_id = ?
        WHERE hc_src.source_type = 'hardcover'
          AND (
            CAST(hc_src.external_id AS INTEGER) IN (${placeholders})
            OR gr_src.grimmory_hardcover_book_id IN (${placeholders})
          )
      `).all(profileId, ...hcList.bookIds, ...hcList.bookIds.map(String)) as { grimmory_book_id: number }[]).map((r) => r.grimmory_book_id);
    }

    if (hcList.bookIds.length > 0 && grimmoryBookIds.length === 0) {
      logger.info("No matched Grimmory books for Hardcover list", { profileId, listName: hcList.name, hardcoverBookCount: hcList.bookIds.length });
    }

    if (dryRun && !mapping.grimmory_shelf_id) {
      logger.info("Dry run: mapped Grimmory shelf would be resolved or created", { profileId, listName: hcList.name, shelfName: mapping.grimmory_shelf_name });
      continue;
    }

    let shelfId = mapping.grimmory_shelf_id;
    if (!shelfId) {
      try {
        shelfId = await adapters.ensureGrimmoryShelf(baseUrl, grimmoryToken, mapping.grimmory_shelf_name);
        db.prepare("UPDATE shelf_mappings SET grimmory_shelf_id = ? WHERE id = ?").run(shelfId, mapping.id);
      } catch (err) {
        logger.warn("Failed to resolve Grimmory shelf for list sync", { profileId, shelfName: mapping.grimmory_shelf_name, error: err });
        continue;
      }
    }

    let currentIds: number[];
    try {
      currentIds = await adapters.fetchGrimmoryShelfBookIds(baseUrl, grimmoryToken, shelfId);
    } catch (err) {
      logger.warn("Failed to fetch Grimmory shelf for Hardcover list sync", { profileId, listName: hcList.name, shelfName: mapping.grimmory_shelf_name, error: err });
      continue;
    }

    const toAdd = grimmoryBookIds.filter((id) => !currentIds.includes(id));
    if (toAdd.length > 0) {
      if (dryRun) {
        logger.info("Dry run: would add books to Grimmory shelf from Hardcover list", { profileId, listName: hcList.name, shelfName: mapping.grimmory_shelf_name, count: toAdd.length });
      } else {
        try {
          await adapters.addBooksToGrimmoryShelf(baseUrl, grimmoryToken, toAdd, shelfId);
          logger.info("Synced Hardcover list to Grimmory shelf", { profileId, listName: hcList.name, shelfName: mapping.grimmory_shelf_name, added: toAdd.length });
        } catch (err) {
          logger.warn("Failed to add books to Grimmory shelf", { profileId, shelfName: mapping.grimmory_shelf_name, error: err });
        }
      }
    } else {
      logger.info("Grimmory shelf already up to date for list", { profileId, shelfName: mapping.grimmory_shelf_name });
    }

    const allOnShelf = [...new Set([...currentIds, ...toAdd])];
    if (allOnShelf.length > 0 && !dryRun) {
      const shelfName = mapping.grimmory_shelf_name;
      const shelfPlaceholders = allOnShelf.map(() => "?").join(",");
      db.prepare(`
        UPDATE user_book_states SET grimmory_shelves = CASE
          WHEN grimmory_shelves IS NULL THEN ?
          WHEN (',' || grimmory_shelves || ',') NOT LIKE ('%,' || ? || ',%') THEN grimmory_shelves || ',' || ?
          ELSE grimmory_shelves
        END
        WHERE profile_id = ? AND source_type = 'grimmory'
          AND book_id IN (
            SELECT book_id FROM book_sources
            WHERE source_type = 'grimmory' AND source_instance_id = ? AND CAST(external_id AS INTEGER) IN (${shelfPlaceholders})
          )
      `).run(shelfName, shelfName, shelfName, profileId, profileId, ...allOnShelf);
    }

    if (currentIds.length === 0) continue;

    const reversePlaceholders = currentIds.map(() => "?").join(",");
    // Find Hardcover book IDs for books on this Grimmory shelf via two paths:
    // 1. Books already matched through the book_sources join (canonical match)
    // 2. Books whose Grimmory record carries a grimmory_hardcover_book_id (unmatched
    //    but Grimmory knows the Hardcover ID — covers books added directly in Grimmory)
    // Both Grimmory-side lookups are scoped to this profile's own Grimmory instance,
    // since currentIds are local IDs from this profile's own shelf fetch.
    const hardcoverBookIds = (db.prepare(`
      SELECT DISTINCT hardcover_book_id FROM (
        SELECT CAST(hc_src.external_id AS INTEGER) AS hardcover_book_id
        FROM book_sources gr_src
        JOIN book_sources hc_src ON hc_src.book_id = gr_src.book_id AND hc_src.source_type = 'hardcover'
        WHERE gr_src.source_type = 'grimmory' AND gr_src.source_instance_id = ?
          AND CAST(gr_src.external_id AS INTEGER) IN (${reversePlaceholders})
        UNION
        SELECT CAST(grimmory_hardcover_book_id AS INTEGER) AS hardcover_book_id
        FROM book_sources
        WHERE source_type = 'grimmory' AND source_instance_id = ?
          AND CAST(external_id AS INTEGER) IN (${reversePlaceholders})
          AND grimmory_hardcover_book_id IS NOT NULL
          AND grimmory_hardcover_book_id != ''
      )
      WHERE hardcover_book_id IS NOT NULL AND hardcover_book_id > 0
    `).all(profileId, ...currentIds, profileId, ...currentIds) as { hardcover_book_id: number | null }[])
      .map((r) => r.hardcover_book_id)
      .filter((id): id is number => typeof id === "number" && id > 0);

    const currentHardcoverIds = new Set(hcList.bookIds);
    const toAddToHardcover = Array.from(new Set(hardcoverBookIds)).filter((id) => !currentHardcoverIds.has(id));

    if (toAddToHardcover.length === 0) {
      logger.info("Hardcover list already up to date for Grimmory shelf", { profileId, listName: hcList.name, shelfName: mapping.grimmory_shelf_name });
      continue;
    }

    if (dryRun) {
      logger.info("Dry run: would add books to Hardcover list from Grimmory shelf", { profileId, listName: hcList.name, shelfName: mapping.grimmory_shelf_name, count: toAddToHardcover.length });
      continue;
    }

    let addedToHardcover = 0;
    for (const hardcoverBookId of toAddToHardcover) {
      try {
        await adapters.addBookToHardcoverList(hardcoverToken, Number.parseInt(mapping.source_list_id, 10), hardcoverBookId);
        addedToHardcover++;
      } catch (err) {
        logger.warn("Failed to add book to Hardcover list", { profileId, listName: hcList.name, hardcoverBookId, error: err });
      }
    }

    if (addedToHardcover > 0) {
      logger.info("Synced Grimmory shelf to Hardcover list", { profileId, listName: hcList.name, shelfName: mapping.grimmory_shelf_name, added: addedToHardcover });
    }
  }
}

// ── Sync decision ─────────────────────────────────────────────────────────────

export interface SyncDecision {
  decision: string;
  syncHealth: string;
  writeGrimmory: boolean;
  writeHardcover: boolean;
}

export function computeSyncDecision(opts: {
  hcBook: HardcoverUserBook;
  grBook: GrimmoryBook | null;
  conflictStrategy: ConflictStrategy;
  syncStatusEnabled: boolean;
  previousGrimmoryStatus: string | null;
  previousHardcoverStatusId: number | null;
}): SyncDecision {
  const { hcBook, grBook, conflictStrategy, syncStatusEnabled, previousGrimmoryStatus, previousHardcoverStatusId } = opts;

  if (!grBook) {
    return { decision: "no_grimmory_match", syncHealth: "missing", writeGrimmory: false, writeHardcover: false };
  }

  const hcStatusId = hcBook.status_id;
  const grStatus = grBook.readStatus ?? null;

  if (!syncStatusEnabled || (hcStatusId === null && !grStatus)) {
    return { decision: "no_status_to_sync", syncHealth: "synced", writeGrimmory: false, writeHardcover: false };
  }

  const mappedHcToGr = hcStatusId !== null ? HARDCOVER_TO_GRIMMORY[hcStatusId] : null;
  const mappedGrToHc = grStatus ? GRIMMORY_TO_HARDCOVER[grStatus] : null;
  const alreadySynced = mappedHcToGr === grStatus || mappedGrToHc === hcStatusId;

  if (alreadySynced) {
    return { decision: "already_synced", syncHealth: "synced", writeGrimmory: false, writeHardcover: false };
  }

  const grimmoryChanged = previousGrimmoryStatus !== null && grStatus !== previousGrimmoryStatus;
  const hardcoverChanged = previousHardcoverStatusId !== null && hcStatusId !== previousHardcoverStatusId;

  if (grimmoryChanged && !mappedGrToHc && !hardcoverChanged) {
    return { decision: "grimmory_status_ignored", syncHealth: "synced", writeGrimmory: false, writeHardcover: false };
  }
  if (grimmoryChanged && !hardcoverChanged && mappedGrToHc) {
    return { decision: "grimmory_status_changed", syncHealth: "synced", writeGrimmory: false, writeHardcover: true };
  }
  if (hardcoverChanged && !grimmoryChanged && mappedHcToGr) {
    return { decision: "hardcover_status_changed", syncHealth: "synced", writeGrimmory: true, writeHardcover: false };
  }
  if (grimmoryChanged && hardcoverChanged) {
    if (conflictStrategy === "hardcover_wins") {
      return { decision: "both_changed_hardcover_wins", syncHealth: "synced", writeGrimmory: true, writeHardcover: false };
    }
    if (conflictStrategy === "grimmory_wins" && mappedGrToHc) {
      return { decision: "both_changed_grimmory_wins", syncHealth: "synced", writeGrimmory: false, writeHardcover: true };
    }
    if (conflictStrategy === "grimmory_wins" && !mappedGrToHc) {
      return { decision: "grimmory_status_ignored", syncHealth: "synced", writeGrimmory: false, writeHardcover: false };
    }
  }

  if (hcStatusId !== null && grStatus) {
    if (conflictStrategy === "hardcover_wins") {
      return { decision: "hardcover_wins", syncHealth: "synced", writeGrimmory: true, writeHardcover: false };
    }
    if (conflictStrategy === "grimmory_wins") {
      if (!mappedGrToHc) return { decision: "grimmory_status_ignored", syncHealth: "synced", writeGrimmory: false, writeHardcover: false };
      return { decision: "grimmory_wins", syncHealth: "synced", writeGrimmory: false, writeHardcover: true };
    }
    const hcTime = hcBook.updated_at ?? null;
    const grTime = grBook.lastReadTime ?? null;
    const latestStatusSource = newerSource(hcTime, grTime);
    if (latestStatusSource) {
      if (latestStatusSource === "hardcover") return { decision: "latest_wins_hardcover", syncHealth: "synced", writeGrimmory: true, writeHardcover: false };
      if (!mappedGrToHc) return { decision: "grimmory_status_ignored", syncHealth: "synced", writeGrimmory: false, writeHardcover: false };
      return { decision: "latest_wins_grimmory", syncHealth: "synced", writeGrimmory: false, writeHardcover: true };
    }
    return { decision: "no_timestamps_hardcover_preferred", syncHealth: "synced", writeGrimmory: true, writeHardcover: false };
  }

  if (hcStatusId !== null && !grStatus) {
    return { decision: "hardcover_only_status", syncHealth: "synced", writeGrimmory: true, writeHardcover: false };
  }
  if (!hcStatusId && grStatus) {
    if (!mappedGrToHc) return { decision: "grimmory_status_ignored", syncHealth: "synced", writeGrimmory: false, writeHardcover: false };
    return { decision: "grimmory_only_status", syncHealth: "synced", writeGrimmory: false, writeHardcover: true };
  }

  return { decision: "nothing_to_sync", syncHealth: "synced", writeGrimmory: false, writeHardcover: false };
}

// Strip parenthetical series info "(Series, #N)" then lowercase + alphanumeric only
export function normalizeTitle(title: string): string {
  return title
    .replace(/\s*\(.*?\)\s*/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSeriesNumber(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  const match = text.match(/\d+(?:\.\d+)?/);
  return match?.[0] ?? text.replace(/\s+/g, " ");
}

function recordEvent(
  db: Db,
  runId: number,
  profileId: number,
  bookTitle: string,
  eventType: string,
  direction: string | null,
  decision: string,
  details: Record<string, unknown>
): void {
  db.prepare(`
    INSERT INTO sync_events (sync_run_id, profile_id, book_title, event_type, direction, decision, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(runId, profileId, bookTitle, eventType, direction, decision, JSON.stringify(details));
}

/**
 * Re-fetch stale Grimmory covers for all book_sources where the cached cover
 * (stored without a source_url because it required an auth token) is past its
 * refresh_after date. Grouped and authenticated per source_instance_id, since a
 * local Grimmory book id is only meaningful against the server that issued it.
 */
export async function refreshStaleGrimmoryCovers(): Promise<void> {
  const db = getDb();

  const stale = db.prepare(`
    SELECT ic.entity_id, CAST(bs.external_id AS INTEGER) as grimmory_book_id, bs.source_instance_id
    FROM image_cache ic
    JOIN book_sources bs ON bs.id = CAST(ic.entity_id AS INTEGER)
    WHERE ic.source_url IS NULL
      AND bs.source_type = 'grimmory'
      AND (ic.last_refresh_at IS NULL OR ic.last_refresh_at < datetime('now', '-7 days'))
  `).all() as { entity_id: string; grimmory_book_id: number; source_instance_id: number | null }[];

  if (stale.length === 0) {
    logger.info("ImageCache: no stale Grimmory covers to refresh");
    return;
  }

  // Legacy rows left unscoped by the v14 migration (see schema.ts) can't be safely
  // attributed to any one profile's connection, so they're excluded here rather than
  // guessed. They get replaced with a properly scoped row on that profile's next
  // sync, but until then their cached cover simply won't refresh — log the count so
  // that gap is diagnosable instead of invisible.
  const unscoped = stale.filter((row) => row.source_instance_id === null);
  if (unscoped.length > 0) {
    logger.warn("ImageCache: skipping stale Grimmory covers with no scoped instance (pre-v14 legacy rows)", {
      count: unscoped.length
    });
  }
  const scoped = stale.filter((row): row is { entity_id: string; grimmory_book_id: number; source_instance_id: number } =>
    row.source_instance_id !== null
  );

  if (scoped.length === 0) return;

  logger.info("ImageCache: refreshing stale Grimmory covers", { count: scoped.length });

  const staleByInstance = new Map<number, { entity_id: string; grimmory_book_id: number }[]>();
  for (const { entity_id, grimmory_book_id, source_instance_id } of scoped) {
    const group = staleByInstance.get(source_instance_id) ?? [];
    group.push({ entity_id, grimmory_book_id });
    staleByInstance.set(source_instance_id, group);
  }

  let refreshed = 0;

  for (const [profileId, entries] of staleByInstance) {
    // Isolate each instance's work — a login/decrypt/fetch failure for one profile's
    // Grimmory connection must not abort the remaining profiles' cover refreshes.
    try {
      // Each group is authenticated against its own profile's Grimmory connection —
      // a local book id from one Grimmory server must never be fetched through
      // another profile's connection.
      const conn = db.prepare(`
        SELECT g.base_url, g.username, g.encrypted_password
        FROM grimmory_connections g
        JOIN profiles p ON p.id = g.profile_id
        WHERE g.profile_id = ?
          AND p.enabled = 1
          AND g.username IS NOT NULL
          AND g.encrypted_password IS NOT NULL
      `).get(profileId) as { base_url: string | null; username: string; encrypted_password: string } | undefined;
      // grimmory.baseUrl is a first-class global setting (see routes/settings.ts) used
      // as the shared-server default everywhere else a profile's Grimmory URL is
      // resolved (profiles.ts, the manual relationship route, the main sync entry
      // point) — households running one shared Grimmory server for multiple profiles
      // rely on setting it once and leaving each profile's own base_url blank. This
      // loop is already correctly scoped to profileId's own connection row by this
      // point, so falling back to that same shared default here is consistent with,
      // not different from, every other Grimmory URL resolution in the app.
      const baseUrl = conn?.base_url || getSetting("grimmory.baseUrl", "");

      if (!conn || !baseUrl) {
        logger.warn("ImageCache: no Grimmory connection available for cover refresh", { profileId });
        continue;
      }

      const password = decryptCredential(conn.encrypted_password);
      if (!password) {
        logger.warn("ImageCache: could not decrypt Grimmory password", { profileId });
        continue;
      }

      const token = await getGrimmoryToken(baseUrl, conn.username, password);
      if (!token) {
        logger.warn("ImageCache: Grimmory login failed, skipping cover refresh", { profileId });
        continue;
      }

      for (const { entity_id, grimmory_book_id } of entries) {
        const sourceId = parseInt(entity_id, 10);
        const source = db.prepare(
          "SELECT source_media_type FROM book_sources WHERE id = ?"
        ).get(sourceId) as { source_media_type: "physical" | "ebook" | "audiobook" | null } | undefined;
        const data = await fetchGrimmoryCoverBuffer(baseUrl, token, grimmory_book_id, source?.source_media_type ?? null);
        if (!data) continue;
        const webPath = storeFetchedCover(sourceId, data);
        if (webPath) {
          db.prepare("UPDATE book_sources SET cover_cache_path = ? WHERE id = ?").run(webPath, sourceId);
          refreshed++;
        }
      }
    } catch (error) {
      logger.warn("ImageCache: Grimmory cover refresh failed for instance; continuing with others", { profileId, error });
    }
  }

  logger.info("ImageCache: Grimmory covers refreshed", { count: refreshed });
}
