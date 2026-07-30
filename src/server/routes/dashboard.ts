import { Router } from "express";
import { getDb } from "../db/index.js";
import type { DashboardResponse, BookSummary, SyncRun, ReadStatus, SyncHealth, MatchConfidence, MediaType } from "../../shared/types.js";
import { normalizeExternalId } from "../identifiers.js";

const router = Router();

router.get("/", (_req, res) => {
  const db = getDb();

  // One row per (book × profile) using the same CTE pattern as the books route
  const allRows = db.prepare(`
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
      bp.book_id,
      bp.profile_id,
      b.title    AS book_title,
      b.author   AS book_author,
      b.cover_cache_path AS book_cover_cache_path,
      b.last_modified_at AS book_last_modified_at,
      b.last_sync_at     AS book_last_sync_at,
      CAST(grim_src.external_id AS INTEGER) AS grimmory_book_id,
      grim_src.source_media_type AS grimmory_media_type,
      grim_src.grimmory_hardcover_book_id,
      grim_src.grimmory_goodreads_id,
      CAST(hc_src.external_id AS INTEGER)   AS hardcover_book_id,
      hc_src.source_media_type AS hardcover_media_type,
      hc_src.isbn13 AS hardcover_isbn13,
      gr_src.external_id AS goodreads_book_id,
      gr_src.goodreads_book_link,
      CAST(chap_src.external_id AS INTEGER) AS chaptarr_book_id,
      chap_src.source_media_type AS chaptarr_media_type,
      grim_ubs.status  AS grimmory_status,
      grim_ubs.rating  AS grimmory_rating,
      hc_ubs.hardcover_status_id,
      hc_ubs.rating    AS hardcover_rating,
      gr_ubs.goodreads_shelf,
      gr_ubs.rating    AS goodreads_rating,
      COALESCE(hc_ubs.match_confidence, grim_ubs.match_confidence, gr_ubs.match_confidence, 'none') AS match_confidence,
      COALESCE(hc_ubs.sync_health, grim_ubs.sync_health, gr_ubs.sync_health, 'pending') AS sync_health,
      MAX(COALESCE(hc_ubs.has_superseded, 0), COALESCE(grim_ubs.has_superseded, 0), COALESCE(gr_ubs.has_superseded, 0)) AS has_superseded,
      MAX(hc_ubs.last_sync_at, grim_ubs.last_sync_at, gr_ubs.last_sync_at) AS last_sync_at,
      CASE WHEN hc_ubs.id IS NOT NULL OR grim_ubs.id IS NOT NULL OR gr_ubs.id IS NOT NULL THEN 1 ELSE 0 END AS has_any_ubs
    FROM book_profile bp
    JOIN books b ON b.id = bp.book_id
    LEFT JOIN book_sources hc_src   ON hc_src.book_id   = bp.book_id AND hc_src.source_type   = 'hardcover' AND hc_src.source_instance_id = bp.profile_id
    LEFT JOIN book_sources gr_src   ON gr_src.book_id   = bp.book_id AND gr_src.source_type   = 'goodreads' AND gr_src.source_instance_id = bp.profile_id
    LEFT JOIN book_sources grim_src ON grim_src.book_id = bp.book_id AND grim_src.source_type = 'grimmory' AND grim_src.source_instance_id = bp.profile_id
    LEFT JOIN book_sources chap_src ON chap_src.book_id = bp.book_id AND chap_src.source_type = 'chaptarr'
    LEFT JOIN user_book_states hc_ubs   ON hc_ubs.book_id   = bp.book_id AND hc_ubs.profile_id   = bp.profile_id AND hc_ubs.source_type   = 'hardcover'
    LEFT JOIN user_book_states gr_ubs   ON gr_ubs.book_id   = bp.book_id AND gr_ubs.profile_id   = bp.profile_id AND gr_ubs.source_type   = 'goodreads'
    LEFT JOIN user_book_states grim_ubs ON grim_ubs.book_id = bp.book_id AND grim_ubs.profile_id = bp.profile_id AND grim_ubs.source_type = 'grimmory'
  `).all() as DbBook[];

  const grouped = groupByBook(allRows);
  const totalBooks = grouped.length;
  const missingInGrimmory = grouped.filter((rows) => rows.every((row) => row.grimmory_book_id === null)).length;
  const needsReview = grouped.filter((rows) => hasBookNeedsIdReview(rows)).length;
  const pendingDownload = grouped.filter((rows) => rows.some((row) => row.sync_health === "pending_download")).length;

  const recentlyAdded: BookSummary[] = grouped
    .map(dbToSummary)
    .sort((a, b) => (b.lastModifiedAt ?? "").localeCompare(a.lastModifiedAt ?? ""))
    .slice(0, 20);

  const recentRuns = db.prepare(`
    SELECT sr.*, p.display_name as profile_name
    FROM sync_runs sr
    LEFT JOIN profiles p ON sr.profile_id = p.id
    ORDER BY sr.started_at DESC LIMIT 5
  `).all() as DbSyncRun[];

  const recentActivity: SyncRun[] = recentRuns.map(dbToSyncRun);

  const response: DashboardResponse = {
    stats: { totalBooks, missingInGrimmory, needsReview, pendingDownload },
    recentlyAdded,
    recentActivity
  };

  res.json(response);
});

interface DbBook {
  book_id: number;
  profile_id: number;
  book_title: string;
  book_author: string | null;
  book_cover_cache_path: string | null;
  book_last_modified_at: string;
  book_last_sync_at: string | null;
  grimmory_book_id: number | null;
  grimmory_media_type: string | null;
  grimmory_hardcover_book_id: string | null;
  grimmory_goodreads_id: string | null;
  hardcover_book_id: number | null;
  hardcover_media_type: string | null;
  goodreads_book_id: string | null;
  goodreads_book_link: string | null;
  chaptarr_book_id: number | null;
  chaptarr_media_type: string | null;
  grimmory_status: string | null;
  grimmory_rating: number | null;
  hardcover_status_id: number | null;
  hardcover_rating: number | null;
  goodreads_shelf: string | null;
  goodreads_rating: number | null;
  match_confidence: string;
  sync_health: string;
  has_superseded: number;
  last_sync_at: string | null;
  has_any_ubs: number;
}

interface DbSyncRun {
  id: number;
  profile_id: number | null;
  profile_name: string | null;
  started_at: string;
  finished_at: string | null;
  status: string;
  summary: string;
  error: string | null;
  dry_run: number;
  changes_written: number;
  changes_skipped: number;
  changes_superseded: number;
}

function groupByBook(rows: DbBook[]): DbBook[][] {
  const groups = new Map<number, DbBook[]>();
  for (const row of rows) {
    const group = groups.get(row.book_id) ?? [];
    group.push(row);
    groups.set(row.book_id, group);
  }
  return Array.from(groups.values());
}

function normalizeSyncHealth(row: Pick<DbBook, "sync_health" | "grimmory_book_id">): string {
  return row.sync_health === "missing" && row.grimmory_book_id !== null ? "synced" : row.sync_health;
}

function aggregateHealth(rows: DbBook[]): SyncHealth {
  const order: SyncHealth[] = ["error", "missing", "conflict", "superseded", "pending", "synced"];
  const values = new Set(rows.map((row) => normalizeSyncHealth(row) as SyncHealth));
  if (hasIdentityReviewConflict(rows) && values.has("synced")) return "synced";
  return order.find((value) => values.has(value)) ?? "synced";
}

function first<T>(rows: DbBook[], pick: (row: DbBook) => T | null | undefined): T | null {
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

function dbToSummary(rows: DbBook[]): BookSummary {
  const row = rows[0]!;
  const profileIds = Array.from(new Set(rows.filter((r) => r.has_any_ubs).map((candidate) => candidate.profile_id))).sort((a, b) => a - b);
  return {
    id: row.book_id,
    title: row.book_title,
    author: row.book_author,
    coverUrl: row.book_cover_cache_path,
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
    goodreadsRating: first(rows, (candidate) => candidate.goodreads_rating),
    chaptarrBookId: first(rows, (candidate) => candidate.chaptarr_book_id),
    audiobookshelfItemId: null,
    matchConfidence: first(rows, (candidate) => candidate.match_confidence as MatchConfidence) ?? "none",
    syncHealth: aggregateHealth(rows),
    lastSyncAt: row.book_last_sync_at,
    lastModifiedAt: row.book_last_modified_at,
    hasSuperseded: rows.some((candidate) => Boolean(candidate.has_superseded)),
    needsIdReview: hasBookNeedsIdReview(rows)
  };
}

function distinctClean(values: Array<string | number | null | undefined>): string[] {
  return Array.from(new Set(
    values
      .map((value) => normalizeExternalId(value))
      .filter((value): value is string => Boolean(value))
  ));
}

function distinctComparableIds(
  rows: Array<Pick<DbBook, "goodreads_book_id" | "grimmory_goodreads_id" | "hardcover_book_id" | "grimmory_hardcover_book_id">>,
  source: "goodreads" | "hardcover"
): string[] {
  if (source === "goodreads") {
    const comparableRows = rows.filter((row) => normalizeExternalId(row.goodreads_book_id) !== null);
    return distinctClean(comparableRows.flatMap((row) => [row.goodreads_book_id, row.grimmory_goodreads_id]));
  }

  // Only compare Grimmory's stored Hardcover ID when we also have a ShelfBridge
  // Hardcover source row for the canonical book. Grimmory can legitimately carry
  // a Hardcover cross-reference for books that never came from Hardcover.
  const comparableRows = rows.filter((row) => row.hardcover_book_id !== null);
  return distinctClean(comparableRows.flatMap((row) => [row.hardcover_book_id, row.grimmory_hardcover_book_id]));
}

function hasAggregateSourceReviewConflict(
  rows: Array<Pick<DbBook, "goodreads_book_id" | "grimmory_goodreads_id" | "hardcover_book_id" | "grimmory_hardcover_book_id">>,
  source: "goodreads" | "hardcover"
): boolean {
  const sourceIds = distinctComparableIds(rows, source);
  const grimmoryIds = source === "goodreads"
    ? distinctClean(rows.map((row) => row.grimmory_goodreads_id))
    : distinctClean(rows.map((row) => row.grimmory_hardcover_book_id));

  // If Grimmory doesn't carry an ID for this source, there is nothing actionable
  // to review here beyond the canonical merge itself.
  if (grimmoryIds.length === 0) return false;
  if (grimmoryIds.length > 1) return true;

  const [grimmoryId] = grimmoryIds;
  return grimmoryId !== undefined && sourceIds.length > 0 && !sourceIds.includes(grimmoryId);
}

// book_sources rows for Grimmory/Hardcover/Goodreads are now scoped per profile
// instance (see schema v14), so the same book can legitimately carry different
// cross-reference IDs on different profiles' own servers — that's not a conflict.
// Evaluate each profile's own rows independently rather than aggregating IDs
// across every profile sharing this book.
function hasIdentityReviewConflict(rows: DbBook[]): boolean {
  const byProfile = new Map<number, DbBook[]>();
  for (const row of rows) {
    const group = byProfile.get(row.profile_id) ?? [];
    group.push(row);
    byProfile.set(row.profile_id, group);
  }
  return Array.from(byProfile.values()).some((profileRows) =>
    hasAggregateSourceReviewConflict(profileRows, "goodreads")
      || hasAggregateSourceReviewConflict(profileRows, "hardcover")
  );
}

function hasBookNeedsIdReview(rows: DbBook[]): boolean {
  return hasIdentityReviewConflict(rows);
}

function dbToSyncRun(row: DbSyncRun): SyncRun {
  return {
    id: row.id,
    profileId: row.profile_id,
    profileName: row.profile_name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as SyncRun["status"],
    summary: row.summary,
    error: row.error,
    dryRun: Boolean(row.dry_run),
    changesWritten: row.changes_written,
    changesSkipped: row.changes_skipped,
    changesSuperseded: row.changes_superseded
  };
}

export default router;
