import { Router } from "express";
import { getDb, getSetting } from "../db/index.js";
import type {
  BookDetail,
  BookDuplicateCandidate,
  BookFacets,
  BookRelationship,
  BookSummary,
  MediaType,
  BooksPageResponse,
  MatchConfidence,
  ReadStatus,
  SyncHealth
} from "../../shared/types.js";
import { getGrimmoryToken, writeGrimmoryExternalIds } from "../sync/grimmory.js";
import { logger } from "../logger.js";
import { reconcileBookIdentities } from "../db/bookIdentity.js";
import { normalizeExternalId, identifiersEqual } from "../identifiers.js";
import { validationErrorResponse, writeGrimmoryIdSchema } from "../validation.js";
import { hasIdentityReviewConflict } from "../sync/identity-review.js";

const router = Router();

export function parsePositiveId(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function writeAndPersistDuplicateMergePlan(
  db: ReturnType<typeof getDb>,
  plan: { bookId: number; profileId: number; goodreadsId: string | null; hardcoverBookId: string | null; hardcoverId: string | null },
  writeRemote: () => Promise<void>
): Promise<void> {
  await writeRemote();
  db.transaction(() => {
    db.prepare(`UPDATE book_sources SET grimmory_goodreads_id = COALESCE(?, grimmory_goodreads_id), grimmory_hardcover_book_id = COALESCE(?, grimmory_hardcover_book_id), grimmory_hardcover_id = COALESCE(?, grimmory_hardcover_id), last_modified_at = datetime('now') WHERE book_id = ? AND source_type = 'grimmory' AND source_instance_id = ?`)
      .run(plan.goodreadsId, plan.hardcoverBookId, plan.hardcoverId, plan.bookId, plan.profileId);
  })();
}

type StatusFilter = "UNREAD" | "READING" | "READ" | "ABANDONED";
type SourceFilter = "all" | "hardcover" | "goodreads" | "on-disk";

const HARDCOVER_STATUS_BY_READ_STATE: Record<StatusFilter, number> = {
  UNREAD: 1,
  READING: 2,
  READ: 3,
  ABANDONED: 5
};

const GOODREADS_SHELF_BY_READ_STATE: Record<StatusFilter, string> = {
  UNREAD: "to-read",
  READING: "currently-reading",
  READ: "read",
  ABANDONED: "did-not-finish"
};

// One row per (book × profile). Book-level source data comes from book_sources JOINs;
// per-profile user activity comes from user_book_states JOINs.
interface DbBookRow {
  // id is profile_id, used as the relationship identifier (unique per book within its relationship list)
  id: number;
  book_id: number;
  profile_id: number;
  profile_name: string;
  // Book master data (canonical across all sources)
  title: string;
  author: string | null;
  cover_url: string | null;
  cover_cache_path: string | null;
  isbn13: string | null;
  isbn10: string | null;
  series_name: string | null;
  series_number: string | null;
  book_title: string;
  book_author: string | null;
  book_media_type: string;
  book_cover_url: string | null;
  book_cover_cache_path: string | null;
  book_isbn13: string | null;
  book_isbn10: string | null;
  book_series_name: string | null;
  book_series_number: string | null;
  book_last_sync_at: string | null;
  book_last_modified_at: string;
  // Hardcover source (book-level)
  hardcover_book_id: number | null;
  hardcover_slug: string | null;
  hardcover_isbn13: string | null;
  hardcover_isbn10: string | null;
  hardcover_media_type: string | null;
  hardcover_edition_id: string | null;
  hardcover_edition_format: string | null;
  book_hardcover_book_id: number | null;
  book_hardcover_slug: string | null;
  // Goodreads source (book-level)
  goodreads_book_id: string | null;
  goodreads_book_link: string | null;
  goodreads_isbn13: string | null;
  goodreads_isbn10: string | null;
  book_goodreads_book_id: string | null;
  // Grimmory source (book-level)
  grimmory_book_id: number | null;
  grimmory_isbn13: string | null;
  grimmory_isbn10: string | null;
  grimmory_hardcover_id: string | null;
  grimmory_hardcover_book_id: string | null;
  grimmory_goodreads_id: string | null;
  grimmory_media_type: string | null;
  grimmory_primary_file_path: string | null;
  // Chaptarr source (book-level)
  chaptarr_book_id: number | null;
  chaptarr_monitored: number | null;
  chaptarr_has_file: number | null;
  chaptarr_id_mismatch: number | null;
  chaptarr_id_mismatch_dismissed: number | null;
  chaptarr_media_type: string | null;
  chaptarr_primary_file_path: string | null;
  // Audiobookshelf source (book-level)
  abs_item_id: string | null;
  abs_duration: number | null;
  abs_file_path: string | null;
  abs_asin: string | null;
  abs_runtime_validated: number | null;
  abs_runtime_delta: number | null;
  // Hardcover edition audio duration (book-level, for mismatch detection)
  hc_audio_seconds: number | null;
  // Audiobookshelf user state (per profile)
  abs_progress: number | null;
  abs_current_time: number | null;
  abs_updated_at: string | null;
  // Hardcover user state (per profile)
  hardcover_status_id: number | null;
  hardcover_rating: number | null;
  hardcover_read_id: number | null;
  hardcover_updated_at: string | null;
  hardcover_last_read_date: string | null;
  hardcover_progress: number | null;
  hardcover_progress_pages: number | null;
  hardcover_pages: number | null;
  // Goodreads user state (per profile)
  goodreads_shelf: string | null;
  goodreads_rating: number | null;
  goodreads_read_at: string | null;
  goodreads_updated_at: string | null;
  goodreads_match_type: string | null;
  // Grimmory user state (per profile)
  grimmory_status: string | null;
  grimmory_rating: number | null;
  grimmory_last_read_time: string | null;
  grimmory_date_finished: string | null;
  grimmory_progress: number | null;
  grimmory_primary_file_id: number | null;
  grimmory_shelves: string | null;
  // Sync state (aggregated from user_book_states, HC takes precedence)
  sync_health: string;
  match_confidence: string;
  match_type: string | null;
  has_superseded: number;
  last_sync_at: string | null;
  last_sync_decision: string | null;
  last_modified_at: string;
  // Connection info
  grimmory_base_url: string | null;
  goodreads_connection_enabled: number | null;
  has_any_ubs: number;
}

function normalizeSyncHealth(row: Pick<DbBookRow, "sync_health" | "grimmory_book_id">): string {
  return row.sync_health === "missing" && row.grimmory_book_id !== null ? "synced" : row.sync_health;
}

function hasNeedsIdReview(row: Pick<DbBookRow,
  "grimmory_book_id" | "goodreads_book_id" | "grimmory_goodreads_id" | "hardcover_book_id" | "grimmory_hardcover_book_id"
>): boolean {
  if (row.grimmory_book_id === null) return false;
  const sourceGoodreadsId = normalizeExternalId(row.goodreads_book_id);
  const grimmoryGoodreadsId = normalizeExternalId(row.grimmory_goodreads_id);
  const sourceHardcoverId = row.hardcover_book_id === null ? null : String(row.hardcover_book_id);
  const grimmoryHardcoverId = normalizeExternalId(row.grimmory_hardcover_book_id);
  return (sourceGoodreadsId !== null && !identifiersEqual(grimmoryGoodreadsId, sourceGoodreadsId))
    || (sourceHardcoverId !== null && !identifiersEqual(grimmoryHardcoverId, sourceHardcoverId));
}

function normalizeReviewText(value: string | null | undefined): string | null {
  const text = value
    ?.toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim() ?? null;
  return text || null;
}

function probableDuplicateTitleKey(value: string | null | undefined): string | null {
  const stripped = value?.split(/:|\s+-\s+/)[0]?.trim();
  return normalizeReviewText(stripped);
}

function normalizeSeriesNumber(value: string | null | undefined): string | null {
  const text = normalizeReviewText(value);
  if (!text) return null;
  return text.match(/\d+(?:\.\d+)?/)?.[0] ?? text;
}

function hasDistinctSeriesPosition(a: DbBookRow, b: DbBookRow): boolean {
  const seriesA = normalizeReviewText(a.book_series_name);
  const seriesB = normalizeReviewText(b.book_series_name);
  if (!seriesA || !seriesB || seriesA !== seriesB) return false;

  const numberA = normalizeSeriesNumber(a.book_series_number);
  const numberB = normalizeSeriesNumber(b.book_series_number);
  return Boolean(numberA && numberB && numberA !== numberB);
}

function duplicatePairKey(a: number, b: number): string {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  return `${low}:${high}`;
}

function dismissedDuplicatePairKeys(): Set<string> {
  const rows = getDb().prepare(`
    SELECT book_id_low, book_id_high
    FROM book_duplicate_dismissals
  `).all() as { book_id_low: number; book_id_high: number }[];
  return new Set(rows.map((row) => duplicatePairKey(row.book_id_low, row.book_id_high)));
}

function actionableDuplicateIds(groups: DbBookRow[][], dismissedPairs: Set<string>): Set<number> {
  return new Set(groups.flatMap((group) =>
    group
      .filter((candidate) => group.some((other) =>
        other.book_id !== candidate.book_id
        && !dismissedPairs.has(duplicatePairKey(candidate.book_id, other.book_id))
        && !hasDistinctSeriesPosition(candidate, other)
      ))
      .map((row) => row.book_id)
  ));
}

function probableDuplicateBookIds(rows: DbBookRow[], dismissedPairs = dismissedDuplicatePairKeys()): Set<number> {
  const byKey = new Map<string, DbBookRow[]>();
  for (const group of groupByBook(rows)) {
    const row = group[0]!;
    const title = probableDuplicateTitleKey(row.book_title);
    const author = normalizeReviewText(row.book_author);
    if (!title || !author) continue;
    const key = `${title}||${author}`;
    const candidates = byKey.get(key) ?? [];
    candidates.push(row);
    byKey.set(key, candidates);
  }

  const result = new Set<number>();
  for (const candidates of byKey.values()) {
    if (candidates.length < 2) continue;
    for (const id of actionableDuplicateIds([candidates], dismissedPairs)) result.add(id);
  }
  return result;
}

function probableDuplicateCandidateIds(rows: DbBookRow[], bookId: number, dismissedPairs = dismissedDuplicatePairKeys()): Set<number> {
  const current = rows.find((row) => row.book_id === bookId);
  if (!current) return new Set();

  const title = probableDuplicateTitleKey(current.book_title);
  const author = normalizeReviewText(current.book_author);
  if (!title || !author) return new Set();

  const candidates = new Set<number>();
  for (const group of groupByBook(rows)) {
    const row = group[0]!;
    if (row.book_id === bookId) continue;
    if (probableDuplicateTitleKey(row.book_title) !== title) continue;
    if (normalizeReviewText(row.book_author) !== author) continue;
    if (hasDistinctSeriesPosition(current, row)) continue;
    if (!dismissedPairs.has(duplicatePairKey(bookId, row.book_id))) candidates.add(row.book_id);
  }
  return candidates;
}

export function isLiveProbableDuplicatePair(
  rows: DbBookRow[],
  bookId: number,
  duplicateId: number,
  dismissedPairs = dismissedDuplicatePairKeys()
): boolean {
  return probableDuplicateCandidateIds(rows, bookId, dismissedPairs).has(duplicateId);
}

function duplicateMergePlans(db: ReturnType<typeof getDb>, firstBookId: number, secondBookId: number) {
  const rows = db.prepare(`
    SELECT id, book_id, source_type, source_instance_id, external_id, hardcover_slug, grimmory_hardcover_id
    FROM book_sources
    WHERE book_id IN (?, ?)
      AND source_type IN ('grimmory', 'hardcover', 'goodreads')
  `).all(firstBookId, secondBookId) as {
    id: number;
    book_id: number;
    source_type: "grimmory" | "hardcover" | "goodreads";
    source_instance_id: number | null;
    external_id: string;
    hardcover_slug: string | null;
    grimmory_hardcover_id: string | null;
  }[];
  const hasSource = (bookId: number, type: "grimmory" | "hardcover" | "goodreads") =>
    rows.some((row) => row.book_id === bookId && row.source_type === type);

  for (const [authoritativeBookId, grimmoryBookId] of [[firstBookId, secondBookId], [secondBookId, firstBookId]] as const) {
    // Only repair the deliberate review pattern: one metadata-only record and
    // one local Grimmory record. This avoids guessing for other duplicate types.
    if (hasSource(authoritativeBookId, "grimmory")
      || hasSource(grimmoryBookId, "hardcover")
      || hasSource(grimmoryBookId, "goodreads")) continue;
    const plans = rows
      .filter((row) => row.book_id === grimmoryBookId && row.source_type === "grimmory" && row.source_instance_id != null)
      .map((grimmory) => {
        const goodreads = rows.find((row) => row.book_id === authoritativeBookId && row.source_type === "goodreads" && row.source_instance_id === grimmory.source_instance_id);
        const hardcover = rows.find((row) => row.book_id === authoritativeBookId && row.source_type === "hardcover" && row.source_instance_id === grimmory.source_instance_id);
        return goodreads || hardcover ? { authoritativeBookId, grimmoryBookId, profileId: grimmory.source_instance_id!, grimmory, goodreads, hardcover } : null;
      })
      .filter((plan): plan is NonNullable<typeof plan> => plan !== null);
    if (plans.length > 0) return plans;
  }
  return [];
}

function dbToDuplicateCandidate(rows: DbBookRow[], mergeEligible: boolean): BookDuplicateCandidate {
  const summary = dbToSummary(rows);
  const row = rows[0]!;
  return {
    id: summary.id,
    title: summary.title,
    author: summary.author,
    coverUrl: summary.coverUrl,
    mediaType: summary.mediaType,
    grimmoryBookId: summary.grimmoryBookId,
    hardcoverBookId: summary.hardcoverBookId,
    goodreadsBookLink: summary.goodreadsBookLink,
    chaptarrBookId: summary.chaptarrBookId,
    seriesName: row.book_series_name,
    seriesNumber: row.book_series_number,
    mergeEligible
  };
}

function hasBookNeedsIdReview(rows: DbBookRow[]): boolean {
  return hasIdentityReviewConflict(rows);
}

function matchesSource(row: Pick<DbBookRow, "book_id">, source: SourceFilter, hardcoverBookIds: Set<number>, goodreadsBookIds: Set<number>, onDiskBookIds: Set<number>): boolean {
  if (source === "hardcover") return hardcoverBookIds.has(row.book_id);
  if (source === "goodreads") return goodreadsBookIds.has(row.book_id);
  if (source === "on-disk") return onDiskBookIds.has(row.book_id);
  return hardcoverBookIds.has(row.book_id) || goodreadsBookIds.has(row.book_id) || onDiskBookIds.has(row.book_id);
}

function matchesChaptarrPresence(bookId: number, mode: "in" | "out", chaptarrPresentBookIds: Set<number>): boolean {
  return mode === "in" ? chaptarrPresentBookIds.has(bookId) : !chaptarrPresentBookIds.has(bookId);
}

function matchesAction(
  row: DbBookRow,
  action: string,
  idReviewBookIds: Set<number>,
  probableDuplicateIds: Set<number>,
  grimmoryBookIds: Set<number>,
  chaptarrMonitoredBookIds: Set<number>,
  chaptarrHasFileBookIds: Set<number>,
  activeChaptarrIdMismatchBookIds: Set<number>,
  absRuntimeMismatchBookIds: Set<number>
): boolean {
  switch (action) {
    case "id-review":
      return idReviewBookIds.has(row.book_id);
    case "possible-duplicates":
    // Keep existing shared/bookmarked links working while the client normalises
    // them to the clearer public name.
    case "probable-duplicates":
      return probableDuplicateIds.has(row.book_id);
    case "add-to-chaptarr":
      return (row.hardcover_book_id !== null || row.goodreads_book_link !== null)
        && !chaptarrMonitoredBookIds.has(row.book_id)
        && !chaptarrHasFileBookIds.has(row.book_id);
    case "grab-in-chaptarr":
      return chaptarrMonitoredBookIds.has(row.book_id) && !chaptarrHasFileBookIds.has(row.book_id);
    case "review-in-grimmory":
      return chaptarrHasFileBookIds.has(row.book_id) && !grimmoryBookIds.has(row.book_id);
    case "fix-chaptarr-id":
      return activeChaptarrIdMismatchBookIds.has(row.book_id);
    case "abs-runtime-mismatch":
      return absRuntimeMismatchBookIds.has(row.book_id);
    default:
      return true;
  }
}

function matchesReadState(row: Pick<DbBookRow, "grimmory_status" | "hardcover_status_id" | "goodreads_shelf">, status: StatusFilter, source: SourceFilter): boolean {
  if (source === "hardcover") return row.hardcover_status_id === HARDCOVER_STATUS_BY_READ_STATE[status];
  if (source === "goodreads") return row.goodreads_shelf?.toLowerCase() === GOODREADS_SHELF_BY_READ_STATE[status];
  return row.grimmory_status === status
    || row.hardcover_status_id === HARDCOVER_STATUS_BY_READ_STATE[status]
    || row.goodreads_shelf?.toLowerCase() === GOODREADS_SHELF_BY_READ_STATE[status];
}

function matchesFilters(row: DbBookRow, opts: {
  includedProfileIds: number[];
  excludedProfileIds: number[];
  includedSources: SourceFilter[];
  excludedSources: SourceFilter[];
  status: string | undefined;
  chaptarr: "in" | "out" | null;
  action: string | null;
  q: string;
  idReviewBookIds: Set<number>;
  probableDuplicateIds: Set<number>;
  grimmoryBookIds: Set<number>;
  hardcoverBookIds: Set<number>;
  goodreadsBookIds: Set<number>;
  onDiskBookIds: Set<number>;
  chaptarrPresentBookIds: Set<number>;
  chaptarrMonitoredBookIds: Set<number>;
  chaptarrHasFileBookIds: Set<number>;
  activeChaptarrIdMismatchBookIds: Set<number>;
  absRuntimeMismatchBookIds: Set<number>;
}): boolean {
  if (opts.includedProfileIds.length > 0) {
    if (!opts.includedProfileIds.includes(row.profile_id)) return false;
    // Profile filters should only surface books where that profile actually has
    // user-level activity, not just a passive cross-joined catalog row.
    if (!row.has_any_ubs) return false;
  }
  if (opts.excludedProfileIds.includes(row.profile_id)) return false;
  if (opts.action && !matchesAction(row, opts.action, opts.idReviewBookIds, opts.probableDuplicateIds, opts.grimmoryBookIds, opts.chaptarrMonitoredBookIds, opts.chaptarrHasFileBookIds, opts.activeChaptarrIdMismatchBookIds, opts.absRuntimeMismatchBookIds)) return false;
  if (opts.chaptarr && !matchesChaptarrPresence(row.book_id, opts.chaptarr, opts.chaptarrPresentBookIds)) return false;
  if (opts.includedSources.length > 0 && !opts.includedSources.some((s) => matchesSource(row, s, opts.hardcoverBookIds, opts.goodreadsBookIds, opts.onDiskBookIds))) return false;
  if (opts.excludedSources.some((s) => matchesSource(row, s, opts.hardcoverBookIds, opts.goodreadsBookIds, opts.onDiskBookIds))) return false;
  const primarySource: SourceFilter = opts.includedSources.length === 1 ? opts.includedSources[0]! : "all";
  if (opts.status && opts.status !== "all" && !matchesReadState(row, opts.status as StatusFilter, primarySource)) return false;
  if (opts.q) {
    const query = opts.q.toLowerCase();
    return row.book_title.toLowerCase().includes(query)
      || (row.book_author?.toLowerCase().includes(query) ?? false);
  }
  return true;
}

function groupByBook(rows: DbBookRow[]): DbBookRow[][] {
  const groups = new Map<number, DbBookRow[]>();
  for (const row of rows) {
    const group = groups.get(row.book_id) ?? [];
    group.push(row);
    groups.set(row.book_id, group);
  }
  return Array.from(groups.values());
}

function aggregateHealth(rows: DbBookRow[]): SyncHealth {
  const order: SyncHealth[] = ["error", "missing", "conflict", "superseded", "pending", "synced"];
  const relevantRows = rows.some((row) => row.has_any_ubs)
    ? rows.filter((row) => row.has_any_ubs)
    : rows;
  const hasGrimmoryMatch = relevantRows.some((row) => row.grimmory_book_id !== null);
  const values = new Set(relevantRows.map((row) => {
    const health = normalizeSyncHealth(row) as SyncHealth;
    if (health === "missing" && hasGrimmoryMatch) return "synced";
    return health;
  }));
  if (hasIdentityReviewConflict(relevantRows) && values.has("synced")) return "synced";
  return order.find((value) => values.has(value)) ?? "synced";
}

function first<T>(rows: DbBookRow[], pick: (row: DbBookRow) => T | null | undefined): T | null {
  for (const row of rows) {
    const value = pick(row);
    if (value !== null && value !== undefined && String(value).trim() !== "") return value;
  }
  return null;
}

function coerceMediaType(value: string | null | undefined): Exclude<MediaType, "mixed" | "unknown"> | null {
  if (value === "book" || value === "physical" || value === "ebook" || value === "audiobook") return value;
  return null;
}

function aggregateMediaType(values: Array<string | null | undefined>): MediaType {
  const set = new Set(
    values
      .map(coerceMediaType)
      .filter((value): value is Exclude<MediaType, "mixed" | "unknown"> => value !== null)
      .map((value) => value === "physical" || value === "ebook" ? "book" : value)
  );
  if (set.size === 0) return "unknown";
  if (set.size === 1) return Array.from(set)[0]!;
  return "mixed";
}

function dbToSummary(rows: DbBookRow[]): BookSummary {
  const row = rows[0]!;
  // Only count profiles that have actual UBS activity — the CROSS JOIN anchor produces
  // rows for every (book × profile) pair, so we must not count profiles with no activity.
  const profileIds = Array.from(new Set(rows.filter((r) => r.has_any_ubs).map((candidate) => candidate.profile_id))).sort((a, b) => a - b);
  return {
    id: row.book_id,
    title: row.book_title,
    author: row.book_author,
    coverUrl: row.book_cover_cache_path ?? null,
    mediaType: aggregateMediaType(rows.flatMap((candidate) => [
      candidate.hardcover_media_type,
      candidate.grimmory_media_type,
      candidate.chaptarr_media_type
    ])),
    userCount: profileIds.length,
    profileIds,
    grimmoryBookId: first(rows, (candidate) => candidate.grimmory_book_id),
    grimmoryStatus: first(rows, (candidate) => candidate.grimmory_status as ReadStatus | null),
    grimmoryRating: first(rows, (candidate) => candidate.grimmory_rating),
    hardcoverBookId: first(rows, (candidate) => candidate.hardcover_book_id),
    hardcoverStatusId: first(rows, (candidate) => candidate.hardcover_status_id),
    hardcoverRating: first(rows, (candidate) => candidate.hardcover_rating),
    goodreadsBookLink: first(rows, (candidate) => candidate.goodreads_book_link),
    goodreadsShelf: first(rows, (candidate) => candidate.goodreads_shelf),
    chaptarrBookId: first(rows, (candidate) => candidate.chaptarr_book_id),
    audiobookshelfItemId: first(rows, (candidate) => candidate.abs_item_id),
    goodreadsRating: first(rows, (candidate) => candidate.goodreads_rating),
    matchConfidence: first(rows, (candidate) => candidate.match_confidence as MatchConfidence) ?? "none",
    syncHealth: aggregateHealth(rows),
    lastSyncAt: rows.reduce<string | null>((latest, candidate) => latest && candidate.last_sync_at ? (latest >= candidate.last_sync_at ? latest : candidate.last_sync_at) : latest ?? candidate.last_sync_at, null),
    lastModifiedAt: row.book_last_modified_at,
    hasSuperseded: rows.some((candidate) => Boolean(candidate.has_superseded)),
    needsIdReview: hasBookNeedsIdReview(rows)
  };
}

function dbToRelationship(row: DbBookRow): BookRelationship {
  const profileUrl = row.grimmory_base_url?.trim() || null;
  const globalUrl = getSetting("grimmory.baseUrl", "") || null;
  return {
    id: row.id,
    bookId: row.book_id,
    profileId: row.profile_id,
    profileName: row.profile_name,
    title: row.title,
    author: row.author,
    coverUrl: row.cover_cache_path ?? null,
    mediaType: aggregateMediaType([row.hardcover_media_type, row.grimmory_media_type, row.chaptarr_media_type]),
    isbn13: row.isbn13,
    isbn10: row.isbn10,
    seriesName: row.series_name,
    seriesNumber: row.series_number,
    grimmoryBookId: row.grimmory_book_id,
    grimmoryMediaType: coerceMediaType(row.grimmory_media_type) ?? "unknown",
    grimmoryStatus: row.grimmory_status as ReadStatus | null,
    grimmoryRating: row.grimmory_rating,
    grimmoryIsbn13: row.grimmory_isbn13,
    grimmoryIsbn10: row.grimmory_isbn10,
    grimmoryHardcoverId: row.grimmory_hardcover_id,
    grimmoryHardcoverBookId: row.grimmory_hardcover_book_id,
    grimmoryGoodreadsId: row.grimmory_goodreads_id,
    grimmoryLastReadTime: row.grimmory_last_read_time,
    grimmoryDateFinished: row.grimmory_date_finished,
    grimmoryProgress: row.grimmory_progress,
    grimmoryPrimaryFileId: row.grimmory_primary_file_id,
    grimmoryPrimaryFilePath: row.grimmory_primary_file_path,
    grimmoryBaseUrl: profileUrl ?? globalUrl,
    hardcoverBookId: row.hardcover_book_id,
    hardcoverMediaType: coerceMediaType(row.hardcover_media_type) ?? "unknown",
    hardcoverStatusId: row.hardcover_status_id,
    hardcoverRating: row.hardcover_rating,
    hardcoverIsbn13: row.hardcover_isbn13,
    hardcoverIsbn10: row.hardcover_isbn10,
    hardcoverEditionId: row.hardcover_edition_id ? parseInt(row.hardcover_edition_id, 10) || null : null,
    hardcoverEditionFormat: row.hardcover_edition_format,
    hardcoverUpdatedAt: row.hardcover_updated_at,
    hardcoverLastReadDate: row.hardcover_last_read_date,
    hardcoverProgress: row.hardcover_progress,
    hardcoverProgressPages: row.hardcover_progress_pages,
    hardcoverPages: row.hardcover_pages,
    hardcoverSlug: row.hardcover_slug,
    chaptarrBookId: row.chaptarr_book_id,
    chaptarrMediaType: coerceMediaType(row.chaptarr_media_type) ?? "unknown",
    chaptarrPrimaryFilePath: row.chaptarr_primary_file_path,
    audiobookshelfItemId: row.abs_item_id,
    audiobookshelfDuration: row.abs_duration,
    audiobookshelfFilePath: row.abs_file_path,
    audiobookshelfAsin: row.abs_asin,
    audiobookshelfRuntimeValidated: Boolean(row.abs_runtime_validated),
    audiobookshelfRuntimeDelta: row.abs_runtime_delta,
    audiobookshelfProgress: row.abs_progress,
    audiobookshelfCurrentTime: row.abs_current_time,
    audiobookshelfIsFinished: row.abs_progress != null && row.abs_progress >= 99,
    audiobookshelfUpdatedAt: row.abs_updated_at,
    goodreadsBookLink: row.goodreads_book_link,
    goodreadsShelf: row.goodreads_shelf,
    goodreadsRating: row.goodreads_rating,
    goodreadsBookId: row.goodreads_book_id,
    goodreadsIsbn13: row.goodreads_isbn13,
    goodreadsIsbn10: row.goodreads_isbn10,
    goodreadsMatchType: row.goodreads_match_type,
    goodreadsEnabled: Boolean(row.goodreads_connection_enabled),
    goodreadsReadAt: row.goodreads_read_at,
    goodreadsUpdatedAt: row.goodreads_updated_at,
    lastSyncDecision: row.last_sync_decision,
    matchType: row.match_type ?? null,
    matchConfidence: row.match_confidence as MatchConfidence,
    syncHealth: normalizeSyncHealth(row) as SyncHealth,
    lastSyncAt: row.last_sync_at,
    lastModifiedAt: row.last_modified_at,
    hasSuperseded: Boolean(row.has_superseded),
    needsIdReview: hasNeedsIdReview(row),
    shelfMemberships: row.grimmory_shelves
      ? row.grimmory_shelves.split(",").map((shelf) => shelf.trim()).filter(Boolean)
      : []
  };
}

function relationshipScore(row: DbBookRow): number {
  return (row.grimmory_book_id ? 16 : 0)
    + (row.hardcover_book_id ? 8 : 0)
    + (row.goodreads_book_id ? 4 : 0)
    + (row.cover_cache_path ? 2 : 0)
    + (row.last_sync_at ? 1 : 0);
}

function relationshipAlignmentScore(row: Pick<DbBookRow,
  "goodreads_book_id" | "grimmory_goodreads_id" | "hardcover_book_id" | "grimmory_hardcover_book_id"
>): number {
  let score = 0;

  const sourceGoodreadsId = normalizeExternalId(row.goodreads_book_id);
  const grimmoryGoodreadsId = normalizeExternalId(row.grimmory_goodreads_id);
  if (sourceGoodreadsId && identifiersEqual(sourceGoodreadsId, grimmoryGoodreadsId)) score += 4;

  const sourceHardcoverId = row.hardcover_book_id === null ? null : String(row.hardcover_book_id);
  const grimmoryHardcoverId = normalizeExternalId(row.grimmory_hardcover_book_id);
  if (sourceHardcoverId && identifiersEqual(sourceHardcoverId, grimmoryHardcoverId)) score += 2;

  return score;
}

function bestRelationshipRowsByProfile(rows: DbBookRow[]): DbBookRow[] {
  const byProfile = new Map<number, DbBookRow>();
  for (const row of rows) {
    const existing = byProfile.get(row.profile_id);
    if (!existing) {
      byProfile.set(row.profile_id, row);
      continue;
    }
    const score = relationshipScore(row);
    const existingScore = relationshipScore(existing);
    const alignmentScore = relationshipAlignmentScore(row);
    const existingAlignmentScore = relationshipAlignmentScore(existing);
    if (
      score > existingScore
      || (score === existingScore && alignmentScore > existingAlignmentScore)
      || (
        score === existingScore
        && alignmentScore === existingAlignmentScore
        && (row.last_modified_at ?? "") > (existing.last_modified_at ?? "")
      )
    ) {
      byProfile.set(row.profile_id, row);
    }
  }
  return Array.from(byProfile.values()).sort((a, b) => a.profile_name.localeCompare(b.profile_name));
}

function fetchRows(): DbBookRow[] {
  return getDb().prepare(`
    WITH all_books AS (
      SELECT DISTINCT book_id FROM book_sources
      WHERE book_id IS NOT NULL
        AND source_type IN ('grimmory', 'hardcover', 'goodreads')
    ),
    book_profile AS (
      SELECT ab.book_id, p.id AS profile_id
      FROM all_books ab
      CROSS JOIN profiles p
    )
    SELECT
      bp.profile_id AS id,
      bp.profile_id,
      bp.book_id,
      p.display_name AS profile_name,
      b.title,
      b.author,
      b.cover_url,
      b.cover_cache_path,
      b.isbn13,
      b.isbn10,
      b.series_name,
      b.series_number,
      b.title       AS book_title,
      b.author      AS book_author,
      b.media_type  AS book_media_type,
      b.cover_url   AS book_cover_url,
      b.cover_cache_path AS book_cover_cache_path,
      b.isbn13      AS book_isbn13,
      b.isbn10      AS book_isbn10,
      b.series_name AS book_series_name,
      b.series_number AS book_series_number,
      b.last_sync_at      AS book_last_sync_at,
      b.last_modified_at  AS book_last_modified_at,
      -- Hardcover source (book-level)
      CAST(hc_src.external_id AS INTEGER)  AS hardcover_book_id,
      hc_src.hardcover_slug,
      hc_src.isbn13 AS hardcover_isbn13,
      hc_src.isbn10 AS hardcover_isbn10,
      hc_src.source_media_type AS hardcover_media_type,
      hc_src.source_edition_id AS hardcover_edition_id,
      hc_src.source_edition_format AS hardcover_edition_format,
      CAST(hc_src.external_id AS INTEGER)  AS book_hardcover_book_id,
      hc_src.hardcover_slug AS book_hardcover_slug,
      -- Goodreads source (book-level)
      gr_src.external_id     AS goodreads_book_id,
      gr_src.goodreads_book_link,
      gr_src.isbn13          AS goodreads_isbn13,
      gr_src.isbn10          AS goodreads_isbn10,
      gr_src.external_id     AS book_goodreads_book_id,
      -- Grimmory source (book-level)
      CAST(grim_src.external_id AS INTEGER) AS grimmory_book_id,
      grim_src.isbn13                       AS grimmory_isbn13,
      grim_src.isbn10                       AS grimmory_isbn10,
      grim_src.grimmory_hardcover_id,
      grim_src.grimmory_hardcover_book_id,
      grim_src.grimmory_goodreads_id,
      grim_src.source_media_type           AS grimmory_media_type,
      grim_src.grimmory_primary_file_path,
      -- Chaptarr source (book-level)
      CAST(chap_src.external_id AS INTEGER) AS chaptarr_book_id,
      chap_src.chaptarr_monitored,
      chap_src.chaptarr_has_file,
      chap_src.chaptarr_id_mismatch,
      CASE WHEN chap_dismiss.id IS NULL THEN 0 ELSE 1 END AS chaptarr_id_mismatch_dismissed,
      chap_src.source_media_type           AS chaptarr_media_type,
      chap_src.chaptarr_primary_file_path,
      -- Audiobookshelf source (book-level)
      abs_src.external_id                  AS abs_item_id,
      abs_src.audiobookshelf_duration      AS abs_duration,
      abs_src.audiobookshelf_file_path     AS abs_file_path,
      abs_src.audiobookshelf_asin          AS abs_asin,
      abs_src.audiobookshelf_runtime_validated AS abs_runtime_validated,
      abs_src.audiobookshelf_runtime_delta AS abs_runtime_delta,
      -- Hardcover edition audio duration (for HC edition mismatch detection)
      hc_src.hardcover_audio_seconds       AS hc_audio_seconds,
      -- Audiobookshelf user state (per profile)
      abs_ubs.progress                     AS abs_progress,
      abs_ubs.audiobookshelf_current_time  AS abs_current_time,
      abs_ubs.audiobookshelf_updated_at    AS abs_updated_at,
      -- Hardcover user state (per profile)
      hc_ubs.hardcover_status_id,
      hc_ubs.rating           AS hardcover_rating,
      hc_ubs.hardcover_read_id,
      hc_ubs.hardcover_updated_at,
      hc_ubs.last_read_date   AS hardcover_last_read_date,
      hc_ubs.progress         AS hardcover_progress,
      hc_ubs.progress_pages   AS hardcover_progress_pages,
      hc_ubs.hardcover_pages,
      -- Goodreads user state (per profile)
      gr_ubs.goodreads_shelf,
      gr_ubs.rating           AS goodreads_rating,
      gr_ubs.goodreads_read_at,
      gr_ubs.goodreads_updated_at,
      gr_ubs.goodreads_match_type,
      -- Grimmory user state (per profile)
      grim_ubs.status         AS grimmory_status,
      grim_ubs.rating         AS grimmory_rating,
      grim_ubs.grimmory_last_read_time,
      grim_ubs.date_finished  AS grimmory_date_finished,
      grim_ubs.progress       AS grimmory_progress,
      grim_ubs.grimmory_primary_file_id,
      grim_ubs.grimmory_shelves,
      -- Sync state: HC user state takes precedence (sync decisions written there), then Grimmory, then GR
      COALESCE(hc_ubs.sync_health, grim_ubs.sync_health, gr_ubs.sync_health, 'pending') AS sync_health,
      COALESCE(hc_ubs.match_confidence, grim_ubs.match_confidence, gr_ubs.match_confidence, 'none') AS match_confidence,
      COALESCE(hc_ubs.match_type, grim_ubs.match_type, gr_ubs.match_type) AS match_type,
      MAX(COALESCE(hc_ubs.has_superseded, 0), COALESCE(grim_ubs.has_superseded, 0), COALESCE(gr_ubs.has_superseded, 0)) AS has_superseded,
      MAX(hc_ubs.last_sync_at, grim_ubs.last_sync_at, gr_ubs.last_sync_at) AS last_sync_at,
      COALESCE(hc_ubs.last_sync_decision, grim_ubs.last_sync_decision, gr_ubs.last_sync_decision) AS last_sync_decision,
      MAX(COALESCE(hc_ubs.last_modified_at, ''), COALESCE(grim_ubs.last_modified_at, ''), COALESCE(gr_ubs.last_modified_at, ''), b.last_modified_at) AS last_modified_at,
      -- Connection info
      gc.base_url  AS grimmory_base_url,
      grc.enabled  AS goodreads_connection_enabled,
      -- Whether this profile has any user activity for this book (used to compute userCount correctly)
      CASE WHEN hc_ubs.id IS NOT NULL OR grim_ubs.id IS NOT NULL OR gr_ubs.id IS NOT NULL THEN 1 ELSE 0 END AS has_any_ubs
    FROM book_profile bp
    JOIN books b ON b.id = bp.book_id
    JOIN profiles p ON p.id = bp.profile_id
    -- Per-instance sources are scoped to this row's own profile so a book with
    -- multiple configured instances of the same integration doesn't fan out into
    -- extra rows (or attribute another profile's source data to this profile).
    LEFT JOIN book_sources hc_src   ON hc_src.book_id   = bp.book_id AND hc_src.source_type   = 'hardcover' AND hc_src.source_instance_id = bp.profile_id
    LEFT JOIN book_sources gr_src   ON gr_src.book_id   = bp.book_id AND gr_src.source_type   = 'goodreads' AND gr_src.source_instance_id = bp.profile_id
    LEFT JOIN book_sources grim_src ON grim_src.book_id = bp.book_id AND grim_src.source_type = 'grimmory' AND grim_src.source_instance_id = bp.profile_id
    LEFT JOIN book_sources chap_src ON chap_src.book_id = bp.book_id AND chap_src.source_type = 'chaptarr'
    -- A dismissal only suppresses the specific mismatch it was raised against:
    -- if Chaptarr's reported upstream ids have since changed, the signature no
    -- longer matches and the row re-arms as an active mismatch.
    LEFT JOIN chaptarr_id_mismatch_dismissals chap_dismiss
      ON chap_dismiss.chaptarr_external_id = chap_src.external_id
      AND chap_dismiss.dismissed_hardcover_book_id IS chap_src.source_hardcover_book_id
      AND chap_dismiss.dismissed_goodreads_book_id IS chap_src.source_goodreads_book_id
    LEFT JOIN book_sources abs_src  ON abs_src.book_id  = bp.book_id AND abs_src.source_type  = 'audiobookshelf' AND abs_src.source_instance_id = bp.profile_id
    LEFT JOIN user_book_states hc_ubs   ON hc_ubs.book_id   = bp.book_id AND hc_ubs.profile_id   = bp.profile_id AND hc_ubs.source_type   = 'hardcover'
    LEFT JOIN user_book_states gr_ubs   ON gr_ubs.book_id   = bp.book_id AND gr_ubs.profile_id   = bp.profile_id AND gr_ubs.source_type   = 'goodreads'
    LEFT JOIN user_book_states grim_ubs ON grim_ubs.book_id = bp.book_id AND grim_ubs.profile_id = bp.profile_id AND grim_ubs.source_type = 'grimmory'
    LEFT JOIN user_book_states abs_ubs  ON abs_ubs.book_id  = bp.book_id AND abs_ubs.profile_id  = bp.profile_id AND abs_ubs.source_type  = 'audiobookshelf'
    LEFT JOIN grimmory_connections gc  ON gc.profile_id  = bp.profile_id
    LEFT JOIN goodreads_connections grc ON grc.profile_id = bp.profile_id
    ORDER BY b.title ASC, p.display_name ASC
  `).all() as DbBookRow[];
}

function compareSummaries(sortBy: string): (a: BookSummary, b: BookSummary) => number {
  if (sortBy === "updated-asc") return (a, b) => (a.lastModifiedAt ?? "").localeCompare(b.lastModifiedAt ?? "");
  if (sortBy === "title-desc") return (a, b) => b.title.localeCompare(a.title);
  if (sortBy === "title-asc") return (a, b) => a.title.localeCompare(b.title);
  return (a, b) => (b.lastModifiedAt ?? "").localeCompare(a.lastModifiedAt ?? "");
}

function countGroups(rows: DbBookRow[]): number {
  return groupByBook(rows).length;
}

// GET /api/books
router.get("/", (req, res) => {
  const db = getDb();

  const VALID_SOURCES = new Set<SourceFilter>(["hardcover", "goodreads", "on-disk"]);
  const parseSourceList = (raw: string | undefined): SourceFilter[] =>
    (raw ?? "").split(",").map((s) => s.trim()).filter((s): s is SourceFilter => VALID_SOURCES.has(s as SourceFilter));
  const parseIdList = (raw: string | unknown): number[] =>
    String(raw ?? "").split(",").map(Number).filter((n) => !isNaN(n) && n > 0);

  const includedSources = parseSourceList(req.query["source"] as string | undefined);
  const excludedSources = parseSourceList(req.query["excludeSource"] as string | undefined);
  const includedProfileIds = parseIdList(req.query["profileId"]);
  const excludedProfileIds = parseIdList(req.query["excludeProfileId"]);
  const status = req.query["status"] as string | undefined;
  const mediaType = req.query["mediaType"] === "audiobook"
    ? "audiobook"
    : req.query["mediaType"] === "all"
      ? "all"
      : "book";
  const rawChaptarr = req.query["chaptarr"] as string | undefined;
  const chaptarr: "in" | "out" | null = rawChaptarr === "in" || rawChaptarr === "out" ? rawChaptarr : null;
  const action = typeof req.query["action"] === "string" ? req.query["action"] : null;
  const sortBy = (req.query["sortBy"] as string) ?? "updated-desc";
  const page = Math.max(1, parseInt(req.query["page"] as string ?? "1", 10));
  const pageSize = Math.min(100, parseInt(req.query["pageSize"] as string ?? "48", 10));
  const q = typeof req.query["q"] === "string" ? req.query["q"].trim() : "";

  const allRows = fetchRows().filter((row) => mediaType === "all" || row.book_media_type === mediaType);
  const idReviewBookIds = new Set(
    groupByBook(allRows)
      .filter((rows) => hasBookNeedsIdReview(rows))
      .map((rows) => rows[0]!.book_id)
  );
  // Book-level presence sets. Source data is book-level in the new schema, so any row
  // for the same book will agree — but we still scan all rows for correctness.
  const hardcoverBookIds = new Set(allRows.filter((r) => r.hardcover_book_id !== null).map((r) => r.book_id));
  const goodreadsBookIds = new Set(allRows.filter((r) => r.goodreads_book_link !== null).map((r) => r.book_id));
  const onDiskBookIds = new Set(allRows.filter((r) => r.grimmory_book_id !== null || r.chaptarr_book_id !== null).map((r) => r.book_id));
  const grimmoryBookIds = new Set(allRows.filter((r) => r.grimmory_book_id !== null).map((r) => r.book_id));
  const chaptarrMonitoredBookIds = new Set(allRows.filter((r) => Boolean(r.chaptarr_monitored)).map((r) => r.book_id));
  const chaptarrHasFileBookIds = new Set(allRows.filter((r) => Boolean(r.chaptarr_has_file)).map((r) => r.book_id));
  const chaptarrPresentBookIds = new Set([...chaptarrMonitoredBookIds, ...chaptarrHasFileBookIds]);
  const activeChaptarrIdMismatchBookIds = new Set(allRows.filter((r) => Boolean(r.chaptarr_id_mismatch) && !Boolean(r.chaptarr_id_mismatch_dismissed)).map((r) => r.book_id));
  const dismissedPairs = dismissedDuplicatePairKeys();
  const probableDuplicateIds = probableDuplicateBookIds(allRows, dismissedPairs);
  const absRuntimeMismatchBookIds = new Set(allRows.filter((r) => {
    if (r.abs_item_id === null) return false;
    // If ABS item not yet matched to a book, flag it
    if (r.abs_runtime_validated === 0) return true;
    // If both ABS and HC have audio duration, flag when they differ by > 5%
    if (r.abs_duration !== null && r.abs_duration > 0 && r.hc_audio_seconds !== null && r.hc_audio_seconds > 0) {
      return Math.abs(r.abs_duration - r.hc_audio_seconds) / r.hc_audio_seconds > 0.05;
    }
    return false;
  }).map((r) => r.book_id));

  const filteredRows = allRows.filter((row) => matchesFilters(row, { includedProfileIds, excludedProfileIds, includedSources, excludedSources, status, chaptarr, action, q, idReviewBookIds, probableDuplicateIds, grimmoryBookIds, hardcoverBookIds, goodreadsBookIds, onDiskBookIds, chaptarrPresentBookIds, chaptarrMonitoredBookIds, chaptarrHasFileBookIds, activeChaptarrIdMismatchBookIds, absRuntimeMismatchBookIds }));
  const summaries = groupByBook(filteredRows).map(dbToSummary).sort(compareSummaries(sortBy));
  const offset = (page - 1) * pageSize;

  const profileNames = db.prepare("SELECT id, display_name FROM profiles").all() as { id: number; display_name: string }[];

  const passesPresence = (row: DbBookRow) =>
    (!chaptarr || matchesChaptarrPresence(row.book_id, chaptarr, chaptarrPresentBookIds)) &&
    (!action || matchesAction(row, action, idReviewBookIds, probableDuplicateIds, grimmoryBookIds, chaptarrMonitoredBookIds, chaptarrHasFileBookIds, activeChaptarrIdMismatchBookIds, absRuntimeMismatchBookIds));
  const passesSource = (row: DbBookRow) =>
    (includedSources.length === 0 || includedSources.some((s) => matchesSource(row, s, hardcoverBookIds, goodreadsBookIds, onDiskBookIds))) &&
    !excludedSources.some((s) => matchesSource(row, s, hardcoverBookIds, goodreadsBookIds, onDiskBookIds));
  const passesProfile = (row: DbBookRow) =>
    (includedProfileIds.length === 0 || includedProfileIds.includes(row.profile_id)) &&
    !excludedProfileIds.includes(row.profile_id);

  const profileRows = allRows.filter(passesProfile);
  const presenceRows = profileRows.filter(passesPresence);
  const sourceFilteredRows = presenceRows.filter(passesSource);
  const allProfileSourceRows = allRows.filter(passesPresence).filter(passesSource);

  const chaptarrInCount = countGroups(profileRows.filter((row) => matchesChaptarrPresence(row.book_id, "in", chaptarrPresentBookIds)));
  const chaptarrOutCount = countGroups(profileRows.filter((row) => matchesChaptarrPresence(row.book_id, "out", chaptarrPresentBookIds)));
  const addToChaptarrCount = countGroups(profileRows.filter((row) => matchesAction(row, "add-to-chaptarr", idReviewBookIds, probableDuplicateIds, grimmoryBookIds, chaptarrMonitoredBookIds, chaptarrHasFileBookIds, activeChaptarrIdMismatchBookIds, absRuntimeMismatchBookIds)));
  const grabInChaptarrCount = countGroups(profileRows.filter((row) => matchesAction(row, "grab-in-chaptarr", idReviewBookIds, probableDuplicateIds, grimmoryBookIds, chaptarrMonitoredBookIds, chaptarrHasFileBookIds, activeChaptarrIdMismatchBookIds, absRuntimeMismatchBookIds)));
  const reviewInGrimmoryCount = countGroups(profileRows.filter((row) => matchesAction(row, "review-in-grimmory", idReviewBookIds, probableDuplicateIds, grimmoryBookIds, chaptarrMonitoredBookIds, chaptarrHasFileBookIds, activeChaptarrIdMismatchBookIds, absRuntimeMismatchBookIds)));
  const fixChaptarrIdCount = countGroups(profileRows.filter((row) => matchesAction(row, "fix-chaptarr-id", idReviewBookIds, probableDuplicateIds, grimmoryBookIds, chaptarrMonitoredBookIds, chaptarrHasFileBookIds, activeChaptarrIdMismatchBookIds, absRuntimeMismatchBookIds)));
  const idReviewCount = countGroups(profileRows.filter((row) => idReviewBookIds.has(row.book_id)));
  const probableDuplicateCount = countGroups(profileRows.filter((row) => probableDuplicateIds.has(row.book_id)));

  const primarySource: SourceFilter = includedSources.length === 1 ? includedSources[0]! : "all";
  const STATUS_VALUES = ["UNREAD", "READING", "READ", "ABANDONED"] as const satisfies readonly StatusFilter[];
  const statusFacets: Record<string, number> = {};
  for (const readStatus of STATUS_VALUES) {
    statusFacets[readStatus] = countGroups(sourceFilteredRows.filter((row) => matchesReadState(row, readStatus, primarySource)));
  }
  const statusAllCount = countGroups(sourceFilteredRows.filter((row) =>
    STATUS_VALUES.some((s) => matchesReadState(row, s, primarySource))
  ));

  // Profile facets should reflect actual per-user relationships only. The rowset is
  // anchored by a CROSS JOIN, so source presence alone must not count toward a user.
  const profileActivityRows = allProfileSourceRows.filter((row) => row.has_any_ubs);
  const profileFacets = profileNames.map((profile) => ({
    profileId: profile.id,
    displayName: profile.display_name,
    count: countGroups(profileActivityRows.filter((row) => row.profile_id === profile.id))
  }));

  const facets: BookFacets = {
    status: statusFacets,
    statusAllCount,
    profiles: profileFacets,
    allCount: countGroups(allProfileSourceRows),
    sourceAllCount: countGroups(presenceRows),
    hardcoverCount: countGroups(presenceRows.filter((row) => matchesSource(row, "hardcover", hardcoverBookIds, goodreadsBookIds, onDiskBookIds))),
    goodreadsCount: countGroups(presenceRows.filter((row) => matchesSource(row, "goodreads", hardcoverBookIds, goodreadsBookIds, onDiskBookIds))),
    onDiskCount: countGroups(presenceRows.filter((row) => matchesSource(row, "on-disk", hardcoverBookIds, goodreadsBookIds, onDiskBookIds))),
    chaptarrInCount,
    chaptarrOutCount,
    addToChaptarrCount,
    grabInChaptarrCount,
    reviewInGrimmoryCount,
    fixChaptarrIdCount,
    idReviewCount,
    probableDuplicateCount,
    absRuntimeMismatchCount: countGroups(profileRows.filter((row) => absRuntimeMismatchBookIds.has(row.book_id))),
  };

  const response: BooksPageResponse = {
    items: summaries.slice(offset, offset + pageSize),
    total: summaries.length,
    facets
  };

  res.json(response);
});

// DELETE /api/books/:id
router.delete("/:id", (req, res) => {
  const db = getDb();
  const bookId = parsePositiveId(req.params["id"]);
  if (bookId === null) {
    res.status(400).json({ error: "Invalid book id" });
    return;
  }

  const existing = db.prepare(`
    SELECT id, title
    FROM books
    WHERE id = ?
  `).get(bookId) as { id: number; title: string } | undefined;

  if (!existing) {
    res.status(404).json({ error: "Book not found" });
    return;
  }

  const deleteBook = db.prepare("DELETE FROM books WHERE id = ?");
  const transaction = db.transaction(() => {
    deleteBook.run(bookId);
    reconcileBookIdentities(db);
  });

  try {
    transaction();
    logger.info("Deleted local canonical book", { bookId, title: existing.title });
    res.json({ ok: true });
  } catch (err) {
    logger.error("Failed to delete local canonical book", { bookId, error: err });
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/books/:bookId/duplicates/:duplicateId/dismiss
router.post("/:bookId/duplicates/:duplicateId/dismiss", (req, res) => {
  const db = getDb();
  const bookId = parsePositiveId(req.params["bookId"]);
  const duplicateId = parsePositiveId(req.params["duplicateId"]);
  if (bookId === null || duplicateId === null || bookId === duplicateId) {
    res.status(400).json({ error: "Invalid duplicate pair" });
    return;
  }

  const found = db.prepare(`
    SELECT COUNT(*) AS count
    FROM books
    WHERE id IN (?, ?)
  `).get(bookId, duplicateId) as { count: number };
  if (found.count !== 2) {
    res.status(404).json({ error: "One or both books could not be found" });
    return;
  }

  const low = Math.min(bookId, duplicateId);
  const high = Math.max(bookId, duplicateId);
  db.prepare(`
    INSERT INTO book_duplicate_dismissals (book_id_low, book_id_high)
    VALUES (?, ?)
    ON CONFLICT(book_id_low, book_id_high) DO UPDATE SET dismissed_at = datetime('now')
  `).run(low, high);

  logger.info("Dismissed probable duplicate pair", { bookId, duplicateId });
  res.json({ ok: true });
});

// POST /api/books/:bookId/duplicates/:duplicateId/merge
router.post("/:bookId/duplicates/:duplicateId/merge", async (req, res) => {
  const db = getDb();
  const bookId = parsePositiveId(req.params["bookId"]);
  const duplicateId = parsePositiveId(req.params["duplicateId"]);
  if (bookId === null || duplicateId === null || bookId === duplicateId) {
    res.status(400).json({ error: "Invalid duplicate pair" }); return;
  }
  if (!isLiveProbableDuplicatePair(fetchRows(), bookId, duplicateId)) {
    res.status(400).json({ error: "Merge requires a live probable-duplicate pair" }); return;
  }
  const plans = duplicateMergePlans(db, bookId, duplicateId);
  if (plans.length === 0) {
    res.status(400).json({ error: "Merge requires an authoritative Goodreads or Hardcover record and a Grimmory record" }); return;
  }
  try {
    // Each plan writes to a remote Grimmory server first and cannot be rolled
    // back once that write lands — so a later plan failing (whether during
    // setup — connection lookup, auth, local-ID validation — or during the
    // write itself) must not make this endpoint report total failure (502)
    // for a request that already partly applied. Every plan is set up and
    // run regardless of an earlier one's outcome, and the response reports
    // exactly which profiles succeeded and which didn't.
    const succeededProfileIds: number[] = [];
    const failures: Array<{ profileId: number; error: string }> = [];
    for (const plan of plans) {
      try {
        const connection = db.prepare("SELECT base_url, username, password FROM grimmory_connections WHERE profile_id = ?").get(plan.profileId) as { base_url: string; username: string; password: string } | undefined;
        const baseUrl = connection?.base_url?.trim() || getSetting("grimmory.baseUrl", "");
        const password = connection?.password;
        if (!baseUrl || !connection?.username || !password) throw new Error("Grimmory connection is not configured");
        const token = await getGrimmoryToken(baseUrl, connection.username, password);
        if (!token) throw new Error("Could not authenticate with Grimmory");
        const grimmoryLocalId = Number(plan.grimmory.external_id);
        if (!Number.isSafeInteger(grimmoryLocalId) || grimmoryLocalId <= 0) {
          throw new Error("Grimmory record has a non-numeric local ID");
        }

        const hardcoverId = plan.hardcover?.hardcover_slug?.trim() || plan.grimmory.grimmory_hardcover_id?.trim() || undefined;
        await writeAndPersistDuplicateMergePlan(db, {
          bookId: plan.grimmoryBookId, profileId: plan.profileId,
          goodreadsId: plan.goodreads?.external_id ?? null, hardcoverBookId: plan.hardcover?.external_id ?? null,
          hardcoverId: hardcoverId ?? null
        }, async () => {
          await writeGrimmoryExternalIds(baseUrl, token, grimmoryLocalId, {
            ...(plan.goodreads?.external_id ? { goodreadsId: plan.goodreads.external_id } : {}),
            ...(plan.hardcover?.external_id ? { hardcoverBookId: plan.hardcover.external_id, hardcoverId } : {})
          });
        });
        succeededProfileIds.push(plan.profileId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("Duplicate merge plan failed for one profile; continuing with the rest", { bookId, duplicateId, profileId: plan.profileId, error: err });
        failures.push({ profileId: plan.profileId, error: message });
      }
    }

    if (succeededProfileIds.length === 0) {
      res.status(502).json({ error: "Merge failed for every profile", failures });
      return;
    }

    db.transaction(() => {
      reconcileBookIdentities(db);
    })();
    const reconciled = db.prepare("SELECT book_id FROM book_sources WHERE id = ?").get(plans[0]!.grimmory.id) as { book_id: number } | undefined;
    if (!reconciled) throw new Error("Reconciled Grimmory record could not be found");
    logger.info("Merged duplicate by repairing Grimmory authoritative IDs", { bookId, duplicateId, succeededProfileIds, failures, plans: plans.map((plan) => ({ authoritativeBookId: plan.authoritativeBookId, grimmoryBookId: plan.grimmoryBookId, profileId: plan.profileId, goodreads: Boolean(plan.goodreads), hardcover: Boolean(plan.hardcover) })) });
    if (failures.length > 0) {
      res.status(207).json({ ok: true, bookId: reconciled.book_id, succeededProfileIds, failures });
    } else {
      res.json({ ok: true, bookId: reconciled.book_id });
    }
  } catch (err) { logger.warn("Failed duplicate merge", { bookId, duplicateId, error: err }); res.status(502).json({ error: err instanceof Error ? err.message : String(err) }); }
});

// POST /api/books/:bookId/chaptarr-id-mismatch/dismiss
router.post("/:bookId/chaptarr-id-mismatch/dismiss", (req, res) => {
  const db = getDb();
  const bookId = parsePositiveId(req.params["bookId"]);
  if (bookId === null) {
    res.status(400).json({ error: "Invalid book id" });
    return;
  }

  const rows = db.prepare(`
    SELECT external_id, source_hardcover_book_id, source_goodreads_book_id
    FROM book_sources
    WHERE book_id = ?
      AND source_type = 'chaptarr'
      AND COALESCE(chaptarr_id_mismatch, 0) = 1
  `).all(bookId) as { external_id: string; source_hardcover_book_id: string | null; source_goodreads_book_id: string | null }[];

  if (rows.length === 0) {
    res.status(404).json({ error: "No Chaptarr ID mismatch is active for this book" });
    return;
  }

  // Record what was actually mismatched (Chaptarr's currently-reported upstream
  // ids), so this dismissal only suppresses that specific mismatch — if a later
  // sync changes what Chaptarr reports, the row re-arms instead of staying
  // silently dismissed against a mismatch that no longer applies.
  const insert = db.prepare(`
    INSERT INTO chaptarr_id_mismatch_dismissals (chaptarr_external_id, dismissed_hardcover_book_id, dismissed_goodreads_book_id)
    VALUES (?, ?, ?)
    ON CONFLICT(chaptarr_external_id) DO UPDATE SET
      dismissed_at = datetime('now'),
      dismissed_hardcover_book_id = excluded.dismissed_hardcover_book_id,
      dismissed_goodreads_book_id = excluded.dismissed_goodreads_book_id
  `);
  const transaction = db.transaction(() => {
    for (const row of rows) insert.run(row.external_id, row.source_hardcover_book_id, row.source_goodreads_book_id);
  });
  transaction();

  logger.info("Dismissed Chaptarr ID mismatch", {
    bookId,
    chaptarrExternalIds: rows.map((row) => row.external_id)
  });
  res.json({ ok: true, dismissed: rows.length });
});

// POST /api/books/:bookId/relationships/:profileId/write-grimmory-id
// :profileId corresponds to BookRelationship.id (which equals profile_id in the new schema)
router.post("/:bookId/relationships/:profileId/write-grimmory-id", async (req, res) => {
  const db = getDb();
  const bookId = parsePositiveId(req.params["bookId"]);
  const profileId = parsePositiveId(req.params["profileId"]);
  if (bookId === null || profileId === null) {
    res.status(400).json({ error: "Invalid book or profile id" });
    return;
  }
  const parsed = writeGrimmoryIdSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(validationErrorResponse(parsed.error));
    return;
  }
  const { source } = parsed.data;

  // Grimmory local id/metadata is instance-specific — scope to this profile's own
  // Grimmory connection so the write below targets the correct server/book.
  const grimSrc = db.prepare(`
    SELECT external_id, grimmory_hardcover_id
    FROM book_sources WHERE source_type = 'grimmory' AND source_instance_id = ? AND book_id = ?
  `).get(profileId, bookId) as { external_id: string; grimmory_hardcover_id: string | null } | undefined;

  if (!grimSrc) {
    res.status(400).json({ error: "No Grimmory relationship is available for this book" });
    return;
  }
  const grimmoryBookId = parseInt(grimSrc.external_id, 10);

  // Grimmory connection is per-profile
  const gc = db.prepare(`
    SELECT base_url, username, password
    FROM grimmory_connections WHERE profile_id = ?
  `).get(profileId) as { base_url: string; username: string; password: string } | undefined;

  const baseUrl = gc?.base_url?.trim() || getSetting("grimmory.baseUrl", "");
  const username = gc?.username;
  const password = gc?.password;
  if (!baseUrl || !username || !password) {
    res.status(400).json({ error: "Grimmory connection is not configured" });
    return;
  }

  try {
    const token = await getGrimmoryToken(baseUrl, username, password);
    if (!token) {
      res.status(502).json({ error: "Could not authenticate with Grimmory" });
      return;
    }

    if (source === "goodreads") {
      // Scoped to this profile's own Goodreads instance — otherwise this write could
      // push another profile's selected Goodreads relationship into this profile's
      // Grimmory server.
      const grSrc = db.prepare(`
        SELECT external_id FROM book_sources WHERE source_type = 'goodreads' AND source_instance_id = ? AND book_id = ?
      `).get(profileId, bookId) as { external_id: string } | undefined;
      const goodreadsId = grSrc?.external_id?.trim();
      if (!goodreadsId) {
        res.status(400).json({ error: "No Goodreads ID is available for this book" });
        return;
      }
      await writeGrimmoryExternalIds(baseUrl, token, grimmoryBookId, { goodreadsId });
      db.prepare(`
        UPDATE book_sources SET grimmory_goodreads_id = ?, last_modified_at = datetime('now')
        WHERE book_id = ? AND source_type = 'grimmory' AND source_instance_id = ?
      `).run(goodreadsId, bookId, profileId);
      logger.info("Wrote Goodreads ID to Grimmory metadata", { bookId, profileId, grimmoryBookId, goodreadsId });
    } else {
      // Scoped to this profile's own Hardcover instance — same reasoning as Goodreads above.
      const hcSrc = db.prepare(`
        SELECT external_id, hardcover_slug FROM book_sources WHERE source_type = 'hardcover' AND source_instance_id = ? AND book_id = ?
      `).get(profileId, bookId) as { external_id: string; hardcover_slug: string | null } | undefined;
      if (!hcSrc?.external_id) {
        res.status(400).json({ error: "No Hardcover ID is available for this book" });
        return;
      }
      const hardcoverBookId = hcSrc.external_id;
      const hardcoverId = hcSrc.hardcover_slug?.trim() || grimSrc.grimmory_hardcover_id?.trim() || null;
      await writeGrimmoryExternalIds(baseUrl, token, grimmoryBookId, { hardcoverBookId, hardcoverId: hardcoverId ?? undefined });
      db.prepare(`
        UPDATE book_sources SET grimmory_hardcover_book_id = ?, grimmory_hardcover_id = ?, last_modified_at = datetime('now')
        WHERE book_id = ? AND source_type = 'grimmory' AND source_instance_id = ?
      `).run(hardcoverBookId, hardcoverId, bookId, profileId);
      logger.info("Wrote Hardcover ID to Grimmory metadata", { bookId, profileId, grimmoryBookId, hardcoverBookId, hardcoverId });
    }

    reconcileBookIdentities(db);
    res.json({ ok: true });
  } catch (err) {
    logger.warn("Failed to write external ID to Grimmory", { bookId, profileId, source, error: err });
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/books/:id
router.get("/:id", (req, res) => {
  const id = parseInt(req.params["id"] ?? "0", 10);
  const allRows = fetchRows();
  const rows = allRows.filter((row) => row.book_id === id);
  if (rows.length === 0) { res.status(404).json({ error: "Not found" }); return; }
  const activeRelationshipRows = rows.filter((row) => row.has_any_ubs);
  const duplicateIds = probableDuplicateCandidateIds(allRows, id);
  const duplicateCandidates = groupByBook(allRows)
    .filter((group) => duplicateIds.has(group[0]!.book_id))
    .map((group) => dbToDuplicateCandidate(group, duplicateMergePlans(getDb(), id, group[0]!.book_id).length > 0))
    .sort((a, b) => a.title.localeCompare(b.title));

  const summary = dbToSummary(rows);
  const hasActiveChaptarrIdMismatch = rows.some((candidate) =>
    Boolean(candidate.chaptarr_id_mismatch) && !Boolean(candidate.chaptarr_id_mismatch_dismissed)
  );
  const row = rows[0]!;
  const detail: BookDetail = {
    ...summary,
    isbn13: row.book_isbn13,
    isbn10: row.book_isbn10,
    seriesName: row.book_series_name,
    seriesNumber: row.book_series_number,
    hardcoverSlug: row.book_hardcover_slug,
    grimmoryHardcoverId: first(rows, (candidate) => candidate.grimmory_hardcover_id),
    grimmoryHardcoverBookId: first(rows, (candidate) => candidate.grimmory_hardcover_book_id),
    grimmoryGoodreadsId: first(rows, (candidate) => candidate.grimmory_goodreads_id),
    goodreadsBookId: row.book_goodreads_book_id,
    hardcoverExpected: rows.some((r) => r.hardcover_book_id !== null),
    hasActiveChaptarrIdMismatch,
    duplicateCandidates,
    relationships: bestRelationshipRowsByProfile(activeRelationshipRows).map((relationshipRow) => ({
      ...dbToRelationship(relationshipRow),
      needsIdReview: hasIdentityReviewConflict([relationshipRow])
    }))
  };

  res.json(detail);
});

export default router;
