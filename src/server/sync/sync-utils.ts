type Db = ReturnType<typeof getDb>;
import { grimmoryRating } from "./grimmory.js";
import { recordSyncEvent } from "./events.js";
import type { SyncAdapters } from "./adapters.js";
import { getDb } from "../db/index.js";
import { logger } from "../logger.js";
import type { HardcoverEdition, HardcoverUserBook } from "./hardcover.js";
import type { GrimmoryBook } from "./grimmory.js";
import { GRIMMORY_TO_HARDCOVER } from "./matcher.js";
import { normalizeExternalId } from "../identifiers.js";
import type { UserStateSnapshot } from "./repository.js";
import { newerSource } from "./time-order.js";
export interface SyncCounters { written: number; skipped: number; superseded: number; sourceFailures: number; }

export type { UserStateSnapshot } from "./repository.js";

export function sameValue(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

export function sameNumber(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) < 0.001;
}

export function positiveRating(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function grimmoryToHardcoverRating(value: number | null | undefined): number | null {
  const rating = positiveRating(value);
  if (rating === null) return null;
  const hardcoverRating = rating / 2;
  return Math.max(0.5, Math.min(5, hardcoverRating));
}

export function hardcoverToGrimmoryRating(value: number | null | undefined): number | null {
  const rating = positiveRating(value);
  if (rating === null) return null;
  return Math.max(1, Math.min(10, rating * 2));
}

export function hasMeaningfulHcChange(existing: UserStateSnapshot | undefined, next: {
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

export function hasMeaningfulGrChange(existing: UserStateSnapshot | undefined, next: {
  status?: string | null;
  rating?: number | null;
  progress?: number | null;
}): boolean {
  if (!existing) return true;
  return ("status" in next && !sameValue(existing.status, next.status))
    || ("rating" in next && !sameNumber(existing.rating, next.rating))
    || ("progress" in next && !sameNumber(existing.progress, next.progress));
}

export function hasMeaningfulGoodreadsChange(existing: UserStateSnapshot | undefined, next: {
  goodreadsShelf?: string | null;
  goodreadsRating?: number | null;
  goodreadsReadAt?: string | null;
}): boolean {
  if (!existing) return true;
  return ("goodreadsShelf" in next && !sameValue(existing.goodreads_shelf, next.goodreadsShelf))
    || ("goodreadsRating" in next && !sameNumber(existing.goodreads_rating, next.goodreadsRating))
    || ("goodreadsReadAt" in next && !sameValue(existing.goodreads_read_at, next.goodreadsReadAt));
}

export function hardcoverDate(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null;
}

export function hardcoverPages(hcBook: HardcoverUserBook, read: HardcoverRead | null = hcBook.user_book_reads?.[0] ?? null): number | null {
  // 1. Prefer the explicit edition page count if Hardcover returned it.
  const readEditionPages = read?.edition?.pages;
  if (readEditionPages != null && readEditionPages > 0) return readEditionPages;

  // 2. Reverse-derive the page count Hardcover is actually using from the read's own
  // progress% and progress_pages. Hardcover computes read.progress = progress_pages / edition_pages,
  // so edition_pages = round(progress_pages / (progress / 100)). This works even when
  // the read has no explicit edition_id, and guarantees our page→% conversion matches
  // what Hardcover will return.
  if (read?.progress != null && read.progress > 0 && read.progress_pages != null && read.progress_pages > 0) {
    const derived = Math.round(read.progress_pages / (read.progress / 100));
    if (derived > 0) return derived;
  }

  return hcBook.book.default_physical_edition?.pages ?? hcBook.book.pages ?? null;
}

export function firstHardcoverSeries(hcBook: HardcoverUserBook): { name: string | null; number: string | null } {
  const seriesBook = hcBook.book.book_series
    ?.find((entry) => entry.series?.name?.trim());
  return {
    name: seriesBook?.series?.name?.trim() || null,
    number: seriesBook?.position == null ? null : String(seriesBook.position).trim() || null
  };
}

export function latestHardcoverRead(
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
    const editionReads = reads.filter((read) => read.edition_id === preferredEditionId);
    // Hardcover may auto-create an empty read while changing the parent
    // user-book edition. Prefer an already-progressed read on the intended
    // edition so that a blank duplicate cannot become the sync source.
    const progressedEditionRead = editionReads.find(hardcoverReadHasProgress);
    if (progressedEditionRead) return progressedEditionRead;
    if (editionReads[0]) return editionReads[0];
  }
  return reads[0] ?? null;
}

export type HardcoverRead = NonNullable<HardcoverUserBook["user_book_reads"]>[number];

export function hardcoverReadHasProgress(read: HardcoverRead): boolean {
  return read.progress !== null || read.progress_pages !== null || read.progress_seconds !== null;
}

export function duplicateReadKey(read: HardcoverRead): string | null {
  if (!read.started_at || read.finished_at !== null) return null;
  return `${read.edition_id ?? "no-edition"}:${read.started_at}`;
}

export function findDuplicateBlankHardcoverReads(hcBook: HardcoverUserBook): HardcoverRead[] {
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

export async function cleanupDuplicateBlankHardcoverReads(opts: {
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
    recordSyncEvent(opts.db, opts.runId, opts.profileId, opts.title, "written", "hardcover_cleanup", "would_delete_duplicate_blank_read", {
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
      recordSyncEvent(opts.db, opts.runId, opts.profileId, opts.title, "api_failure", "hardcover_cleanup", "delete_duplicate_blank_read_failed", {
        hardcoverUserBookId: opts.hcBook.id,
        hardcoverReadId: read.id,
        error: String(err)
      });
    }
  }

  if (deletedReadIds.length === 0) return;

  // Only drop reads that were actually deleted remotely — a read whose
  // deletion failed above must stay in the in-memory state, or later logic
  // in this sync run would treat it as already gone.
  const deletedReadIdSet = new Set(deletedReadIds);
  opts.hcBook.user_book_reads = (opts.hcBook.user_book_reads ?? []).filter((read) => !deletedReadIdSet.has(read.id));
  recordSyncEvent(opts.db, opts.runId, opts.profileId, opts.title, "written", "hardcover_cleanup", "deleted_duplicate_blank_read", {
    hardcoverUserBookId: opts.hcBook.id,
    deletedReadIds
  });
  opts.counters.written++;
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function meaningfulProgress(percent: number | null | undefined): number | null {
  return typeof percent === "number" && Number.isFinite(percent) && percent > 0.001
    ? clampPercent(percent)
    : null;
}

// Scoped to this profile's own ABS/Hardcover instances — this runtime feeds the
// progress percentage used for this profile's outbound writes, so another
// profile's (possibly different) audiobook runtime must not leak in.
export function audiobookRuntimeForBook(db: ReturnType<typeof getDb>, profileId: number, bookId: number): number | null {
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

export function hardcoverProgressPercent(hcBook: HardcoverUserBook, audiobookRuntimeSeconds: number | null = null, preferredEditionId: number | null = null): number | null {
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
  const pages = hardcoverPages(hcBook, read);
  if (typeof read?.progress_pages === "number" && pages && pages > 0) {
    return meaningfulProgress((read.progress_pages / pages) * 100);
  }
  return progressFromSeconds;
}

export function effectiveAbsCurrentTimeSeconds(absProgress: { currentTime: number; progress: number }, duration: number | null): number {
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

export function persistResolvedHardcoverAudioEdition(
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

export function progressPagesFromPercent(percent: number, pages: number | null): number | null {
  if (!pages || pages <= 0) return null;
  return Math.max(0, Math.min(pages, Math.round((percent / 100) * pages)));
}

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// Matches SQLite's datetime('now') format ("YYYY-MM-DD HH:MM:SS", UTC) so values
// generated in application code sort and compare identically to ones set in raw SQL.
export function sqliteNow(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function sourceTagName(username: string | null, displayName: string | null): string {
  const rawName = (username?.trim() || displayName?.trim() || "user").toLowerCase();
  const safeName = rawName
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "user";
  return `shelfbridge-${safeName}`;
}

export { newerSource };

export function shouldGoodreadsOverwriteGrimmory(goodreadsTime: string | null, grimmoryTime: string | null): boolean {
  if (!grimmoryTime) return true;
  if (!goodreadsTime) return false;
  return newerSource(goodreadsTime, grimmoryTime) === "hardcover";
}

export function hardcoverFieldsFromGrimmory(grBook: GrimmoryBook): { status_id?: number; last_read_date?: string | null } | null {
  const statusId = grBook.readStatus ? GRIMMORY_TO_HARDCOVER[grBook.readStatus] : undefined;
  if (!statusId) return null;
  return {
    status_id: statusId,
    ...(grBook.readStatus === "READ" ? { last_read_date: hardcoverDate(grBook.dateFinished) } : {})
  };
}

export function isActivelyReadingStatus(status: string | null | undefined): boolean {
  return status === "READING" || status === "RE_READING" || status === "PARTIALLY_READ";
}

export function hardcoverIdForGrimmoryBook(book: GrimmoryBook): string | null {
  return normalizeExternalId(book.hardcoverBookId) ?? null;
}

export function activeGrimmorySiblingsForHardcover(grimmoryBooks: GrimmoryBook[], hardcoverBookId: number | string): {
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

export function hasActiveBookSiblingForHardcover(
  grimmoryBooks: GrimmoryBook[],
  hardcoverBookId: number | string | null | undefined
): boolean {
  return hardcoverBookId !== null && hardcoverBookId !== undefined
    && activeGrimmorySiblingsForHardcover(grimmoryBooks, hardcoverBookId).book !== null;
}

/** An active book owns a Hardcover work only when a distinct audiobook shares it. */
export function hasActiveBookSiblingForSharedHardcover(
  grimmoryBooks: GrimmoryBook[],
  hardcoverBookId: number | string | null | undefined
): boolean {
  if (hardcoverBookId === null || hardcoverBookId === undefined) return false;
  const normalizedHardcoverId = normalizeExternalId(hardcoverBookId);
  return normalizedHardcoverId !== null
    && activeGrimmorySiblingsForHardcover(grimmoryBooks, hardcoverBookId).book !== null
    && grimmoryBooks.some((book) =>
      book.mediaType === "audiobook" && hardcoverIdForGrimmoryBook(book) === normalizedHardcoverId
    );
}

export function shouldActiveSiblingOwnSharedHardcover(grimmoryBooks: GrimmoryBook[], grBook: GrimmoryBook): boolean {
  if (grBook.hardcoverBookId === null || grBook.hardcoverBookId === undefined) return false;
  const siblings = activeGrimmorySiblingsForHardcover(grimmoryBooks, grBook.hardcoverBookId);
  // A shared Hardcover work only has one mutable user-book record. If both
  // formats are active, reading takes precedence; otherwise the sole active
  // sibling owns it. Completed/inactive siblings must never overwrite it.
  const owner = siblings.book ?? siblings.audiobook;
  return owner !== null && owner.id !== grBook.id;
}

export function shouldAbsAudiobookOwnSharedHardcover(
  grimmoryBooks: GrimmoryBook[],
  grBook: GrimmoryBook,
  absOwnedHardcoverBookIds: ReadonlySet<string>
): boolean {
  const hardcoverBookId = hardcoverIdForGrimmoryBook(grBook);
  if (grBook.mediaType === "audiobook" || !hardcoverBookId || !absOwnedHardcoverBookIds.has(hardcoverBookId)) return false;
  // An actively read book deliberately overrides an ABS audiobook. Otherwise,
  // retain ABS ownership even after the audiobook has completed, so an
  // inactive print/ebook sibling cannot resurrect and overwrite its record.
  return activeGrimmorySiblingsForHardcover(grimmoryBooks, hardcoverBookId).book === null;
}

export function normalizeEditionFormat(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export function inferHardcoverMediaType(
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

export function hasGrimmoryUserActivity(book: GrimmoryBook): boolean {
  return book.readStatus !== null
    || grimmoryRating(book) !== null
    || book.readProgress !== null
    || book.lastReadTime !== null
    || book.dateFinished !== null;
}

// ── DB helpers ────────────────────────────────────────────────────────────────
