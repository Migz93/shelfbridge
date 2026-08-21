import type Database from "better-sqlite3";
import { cleanupOrphanedImageCache } from "./imageCacheMaintenance.js";
import { logger } from "../logger.js";
import { normalizeExternalId, normalizeIsbn } from "../identifiers.js";
import { probableDuplicateTitleKey, probableDuplicateAuthorKey } from "./duplicateKeys.js";

interface BookSourceRow {
  id: number;
  book_id: number | null;
  source_type: string;
  source_instance_id: number | null;
  external_id: string;
  title: string | null;
  author: string | null;
  cover_url: string | null;
  cover_cache_path: string | null;
  isbn13: string | null;
  isbn10: string | null;
  series_name: string | null;
  series_number: string | null;
  source_hardcover_book_id: string | null;
  source_hardcover_slug: string | null;
  source_goodreads_book_id: string | null;
  source_goodreads_work_id: string | null;
  source_goodreads_edition_id: string | null;
  source_edition_id: string | null;
  source_edition_format: string | null;
  source_media_type: string | null;
  source_narrator: string | null;
  source_asin: string | null;
  source_audible_asin: string | null;
  audiobookshelf_file_path: string | null;
  audiobookshelf_asin: string | null;
  hardcover_slug: string | null;
  grimmory_hardcover_book_id: string | null;
  grimmory_goodreads_id: string | null;
  grimmory_hardcover_id: string | null;
  grimmory_primary_file_path: string | null;
  chaptarr_primary_file_path: string | null;
  last_sync_at: string | null;
  last_modified_at: string | null;
  created_at: string | null;
}

export interface UserBookStateMoveRow {
  id: number;
  book_id: number;
  profile_id: number;
  source_type: string;
  progress: number | null;
  progress_seconds: number | null;
  grimmory_book_id: number | null;
  audiobookshelf_item_id: string | null;
  last_modified_at: string | null;
}

type IdentityKey = `${string}:${string}`;
type FormatBucket = "book" | "audiobook" | "unknown";

class UnionFind {
  private readonly parent = new Map<number, number>();

  add(id: number): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: number): number {
    this.add(id);
    const parent = this.parent.get(id);
    if (parent === undefined || parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }
}

function clean(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function normalizeTitle(value: string | null | undefined): string | null {
  const text = clean(value)
    ?.toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, " ")
    // Unicode-aware: an ASCII-only character class would strip a non-Latin
    // title down to nothing, defeating title-based matching for it entirely.
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim() ?? null;
  return text && text.length > 0 ? text : null;
}

function normalizeSeriesNumber(value: string | null | undefined): string | null {
  const text = clean(value)?.toLowerCase() ?? null;
  if (!text) return null;
  const match = text.match(/\d+(?:\.\d+)?/);
  return match?.[0] ?? text.replace(/\s+/g, " ");
}

function normalizePath(value: string | null | undefined): string | null {
  const text = clean(value);
  return text ? text.replace(/\\/g, "/") : null;
}

function inferPathFormatBucket(path: string | null | undefined): FormatBucket {
  const normalized = normalizePath(path)?.toLowerCase() ?? null;
  if (!normalized) return "unknown";

  if (
    normalized.endsWith(".m4b")
    || normalized.endsWith(".mp3")
    || normalized.endsWith(".m4a")
    || normalized.endsWith(".aac")
    || normalized.includes("/audiobook")
    || normalized.includes("/audiobooks/")
  ) {
    return "audiobook";
  }

  if (
    normalized.endsWith(".epub")
    || normalized.endsWith(".mobi")
    || normalized.endsWith(".azw3")
    || normalized.endsWith(".azw")
    || normalized.endsWith(".pdf")
    || normalized.includes("/books/")
    || normalized.includes("/ebooks/")
  ) {
    return "book";
  }

  return "unknown";
}

function inferEditionFormatBucket(format: string | null | undefined): FormatBucket {
  const normalized = clean(format)?.toLowerCase() ?? null;
  if (!normalized) return "unknown";

  if (
    normalized.includes("audio")
    || normalized.includes("audible")
    || normalized.includes("mp3")
  ) {
    return "audiobook";
  }

  if (
    normalized.includes("ebook")
    || normalized.includes("e-book")
    || normalized.includes("kindle")
    || normalized.includes("epub")
    || normalized.includes("digital")
    || normalized.includes("paperback")
    || normalized.includes("hardcover")
    || normalized.includes("mass market")
    || normalized.includes("trade paperback")
    || normalized.includes("library binding")
  ) {
    return "book";
  }

  return "unknown";
}

// Collapses a resolved media type string into the two buckets that matter
// for comparing whether two editions/siblings are "the same format" or
// genuinely different: physical and ebook (or the generic "book") are both
// "book", audiobook stays "audiobook", anything else is unresolved. Shared
// with sync-utils.ts's formatBucket (which narrows the input type further)
// so the two can't silently drift apart into disagreeing about what counts
// as which bucket.
export function resolvedMediaTypeBucket(mediaType: string | null): "book" | "audiobook" | null {
  if (mediaType === "audiobook") return "audiobook";
  if (mediaType === "ebook" || mediaType === "physical" || mediaType === "book") return "book";
  return null;
}

function rowFormatBucket(row: Pick<BookSourceRow,
  "source_type" | "source_media_type" | "source_edition_format" | "source_narrator" | "grimmory_primary_file_path" | "chaptarr_primary_file_path"
>): FormatBucket {
  const editionBucket = inferEditionFormatBucket(row.source_edition_format);

  // source_media_type is now trusted first for every source type, including
  // Hardcover: it's derived from Hardcover's structured reading_format_id
  // (see inferHardcoverMediaType in sync-utils.ts), which is far more
  // reliable than the free-text edition_format this function otherwise
  // parses — that field is user-submitted and can be blank, absent, or
  // mislabeled relative to the edition's actual reading_format.
  const resolvedBucket = resolvedMediaTypeBucket(row.source_media_type);
  if (resolvedBucket) return resolvedBucket;

  if (editionBucket !== "unknown") return editionBucket;

  const pathBucket = inferPathFormatBucket(row.grimmory_primary_file_path ?? row.chaptarr_primary_file_path);
  if (pathBucket !== "unknown") return pathBucket;

  // Narrators are a strong audiobook hint for sources that don't normalize
  // media type cleanly on every row.
  if (clean(row.source_narrator)) return "audiobook";

  if (row.source_type === "goodreads") return "book";
  return "unknown";
}

function canonicalFormat(rows: BookSourceRow[]): Exclude<FormatBucket, "unknown"> | "unknown" {
  const values = new Set(rows.map(rowFormatBucket).filter((value) => value !== "unknown"));
  if (values.has("audiobook")) return "audiobook";
  if (values.has("book")) return "book";
  return "unknown";
}

// High-confidence identity keys: source IDs and cross-reference IDs stored by sources.
// These are authoritative enough to cluster books without further validation.
function highIdentityKeys(row: BookSourceRow): IdentityKey[] {
  const bucket = rowFormatBucket(row);
  const pairs: Array<[string, string | null]> = [];

  // Chaptarr metadata can carry stale upstream IDs when its resolver picks the
  // wrong edition/book. Use those IDs for display/review context, but not as
  // high-confidence merge keys; otherwise one bad Chaptarr row can bridge two
  // distinct canonical books.
  if (row.source_type !== "chaptarr") {
    pairs.push(
      ["hardcover_book_id", normalizeExternalId(row.source_hardcover_book_id)],
      ["hardcover_slug", clean(row.source_hardcover_slug)?.toLowerCase() ?? null],
      ["goodreads_book_id", normalizeExternalId(row.source_goodreads_book_id)],
      ["goodreads_work_id", normalizeExternalId(row.source_goodreads_work_id)],
      ["goodreads_edition_id", normalizeExternalId(row.source_goodreads_edition_id)],
      ["asin", clean(row.source_asin)?.toUpperCase() ?? null],
      ["audible_asin", clean(row.source_audible_asin)?.toUpperCase() ?? null],
    );
  }

  if (row.source_type === "hardcover") {
    pairs.push(["hardcover_book_id", normalizeExternalId(row.external_id)]);
    pairs.push(["hardcover_slug", clean(row.hardcover_slug)?.toLowerCase() ?? null]);
  } else if (row.source_type === "grimmory") {
    // A Grimmory external_id is only meaningful within its own server instance —
    // two different Grimmory servers (different source_instance_id) can legitimately
    // reuse the same local ID for unrelated books, so the instance id must be part
    // of the key rather than trusting the raw external_id as globally unique.
    const grimmoryLocalId = clean(row.external_id);
    pairs.push(["grimmory_book_id", grimmoryLocalId && row.source_instance_id !== null
      ? `${row.source_instance_id}:${grimmoryLocalId}`
      : null]);
    // Grimmory stores cross-reference IDs from HC and GR — use them to cluster
    pairs.push(["hardcover_book_id", normalizeExternalId(row.grimmory_hardcover_book_id)]);
    pairs.push(["hardcover_slug", clean(row.grimmory_hardcover_id)?.toLowerCase() ?? null]);
    pairs.push(["goodreads_book_id", normalizeExternalId(row.grimmory_goodreads_id)]);
  } else if (row.source_type === "goodreads") {
    pairs.push(["goodreads_book_id", normalizeExternalId(row.external_id)]);
  } else if (row.source_type === "audiobookshelf") {
    pairs.push(["audible_asin", clean(row.audiobookshelf_asin)?.toUpperCase() ?? null]);
  } else if (row.source_type === "chaptarr") {
    // Chaptarr has no strong cross-reference IDs; relies on ISBN / title matching
  }

  return Array.from(new Set(
    pairs
      .filter((pair): pair is [string, string] => pair[1] !== null)
      .map(([type, value]) => `${bucket}.${type}:${value}` as IdentityKey)
  ));
}

// Deliberately NOT bucket-prefixed like highIdentityKeys/filePathIdentityKeys: an
// ISBN identifies a specific edition regardless of the format bucket a row happens
// to resolve to, and a row's bucket is often unresolved ("unknown") for reasons
// that have nothing to do with the book's actual format (e.g. a Hardcover source
// with no edition data yet — see rowFormatBucket). Prefixing here would silently
// block an exact-ISBN match between such a row and its already-canonicalized
// counterpart. The merge loop below still guards this with highKeyConflict(), so
// a shared ISBN alone can never override a genuinely conflicting authoritative ID.
function isbnIdentityKeys(row: BookSourceRow): IdentityKey[] {
  const pairs: Array<[string, string | null]> = [
    ["isbn13", normalizeIsbn(row.isbn13)],
    ["isbn10", normalizeIsbn(row.isbn10)],
  ];

  return Array.from(new Set(
    pairs
      .filter((pair): pair is [string, string] => pair[1] !== null)
      .map(([type, value]) => `${type}:${value}` as IdentityKey)
  ));
}

// On-disk file path, used to bridge Grimmory/Audiobookshelf rows to the (single,
// global) Chaptarr instance that manages the same physical library. This is NOT a
// high-confidence key: two independent Grimmory/Audiobookshelf server instances can
// expose the same relative path (e.g. identical container mount layouts) for
// unrelated books, so a shared path alone must not blindly merge two books — it
// is treated the same as an ISBN match (blocked by a conflicting authoritative ID,
// and by an explicit title/author disagreement — see the clustering pass below).
function filePathIdentityKeys(row: BookSourceRow): IdentityKey[] {
  const bucket = rowFormatBucket(row);
  const path = normalizePath(row.grimmory_primary_file_path ?? row.chaptarr_primary_file_path ?? row.audiobookshelf_file_path);
  return path ? [`${bucket}.file_path:${path}` as IdentityKey] : [];
}

function highKeyConflict(keysA: Set<IdentityKey>, keysB: Set<IdentityKey>): boolean {
  const byType = new Map<string, Set<string>>();
  for (const key of [...keysA, ...keysB]) {
    const [type, ...rest] = key.split(":");
    if (type === undefined) continue;
    // grimmory_book_id keys embed their source instance as the first segment of
    // `rest` (see highIdentityKeys): two different Grimmory servers legitimately
    // assigning different local ids to what may be the same book is not a
    // conflict — only two different local ids reported by the SAME instance is.
    // Group by (type, instance) for this key so cross-instance differences don't
    // block an otherwise well-corroborated merge (e.g. via a shared ISBN).
    const isScopedGrimmoryKey = type.endsWith(".grimmory_book_id") && rest.length > 1;
    const groupKey = isScopedGrimmoryKey ? `${type}:${rest[0]}` : type;
    const value = isScopedGrimmoryKey ? rest.slice(1).join(":") : rest.join(":");
    const values = byType.get(groupKey) ?? new Set<string>();
    values.add(value);
    byType.set(groupKey, values);
  }
  return Array.from(byType.values()).some((values) => values.size > 1);
}

function titleAuthorKey(row: BookSourceRow): IdentityKey | null {
  const title = normalizeTitle(row.title);
  const author = normalizeTitle(row.author);
  const bucket = rowFormatBucket(row);
  if (bucket === "unknown") return null;
  return title && author ? `${bucket}.title_author:${title}||${author}` : null;
}

interface SeriesMatchInfo {
  // No contradictory series name/number between the two groups.
  compatible: boolean;
  // Both groups explicitly agree on series name AND number — strong corroborating
  // evidence that a title/author match is genuinely the same book.
  strongMatch: boolean;
}

// Set-based version of the series compatibility check — callers maintain
// per-root series name/number sets incrementally (see RootIndex below) instead
// of rescanning every row for every candidate pair, which is what made the
// original per-pair `rows.filter(...)` version quadratic on large libraries.
function seriesMatchFromSets(namesA: Set<string>, numbersA: Set<string>, namesB: Set<string>, numbersB: Set<string>): SeriesMatchInfo {
  const namesOverlap = namesA.size > 0 && namesB.size > 0 && Array.from(namesA).some((name) => namesB.has(name));
  const numbersOverlap = numbersA.size > 0 && numbersB.size > 0 && Array.from(numbersA).some((number) => numbersB.has(number));

  const nameConflict = namesA.size > 0 && namesB.size > 0 && !namesOverlap;
  const numberConflict = numbersA.size > 0 && numbersB.size > 0 && !numbersOverlap;

  return {
    compatible: !nameConflict && !numberConflict,
    strongMatch: namesOverlap && numbersOverlap
  };
}

// Per-root aggregate data used by the merge passes below, maintained incrementally
// (merged on every union) so no pass needs to rescan all rows for a candidate pair.
interface RootIndexEntry {
  highKeys: Set<IdentityKey>;
  titleAuthorKeys: Set<IdentityKey>;
  seriesNames: Set<string>;
  seriesNumbers: Set<string>;
  /** Known ("book"/"audiobook", never "unknown") format buckets seen among this
   * root's rows — used to block an ISBN match from merging two clusters that
   * are on opposite sides of the book/audiobook split (see the ISBN-merge loop
   * below). */
  formatBuckets: Set<"book" | "audiobook">;
}

// Absorbs the smaller set into the larger one and returns it (mutating), so a long
// merge chain costs O(n log n) element inserts instead of re-copying both sides on
// every union. Safe because unionRoots() always deletes the losing root's rootIndex
// entry right after calling this, so nothing else retains the pre-merge sets.
function mergeSets<T>(a: Set<T> | undefined, b: Set<T> | undefined): Set<T> {
  if (!a || a.size === 0) return b ?? new Set<T>();
  if (!b || b.size === 0) return a;
  const [large, small] = a.size >= b.size ? [a, b] : [b, a];
  for (const value of small) large.add(value);
  return large;
}

function mergeRootEntries(a: RootIndexEntry | undefined, b: RootIndexEntry | undefined): RootIndexEntry {
  return {
    highKeys: mergeSets(a?.highKeys, b?.highKeys),
    titleAuthorKeys: mergeSets(a?.titleAuthorKeys, b?.titleAuthorKeys),
    seriesNames: mergeSets(a?.seriesNames, b?.seriesNames),
    seriesNumbers: mergeSets(a?.seriesNumbers, b?.seriesNumbers),
    formatBuckets: mergeSets(a?.formatBuckets, b?.formatBuckets)
  };
}

function newer(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a >= b ? a : b;
}

// Score a source row for canonical value selection: prefer rows with more identity data
function sourceScore(row: BookSourceRow): number {
  return (row.cover_cache_path ? 8 : 0)
    + (row.cover_url ? 4 : 0)
    + (row.source_type === "hardcover" ? 2 : 0)
    + (row.source_type === "grimmory" ? 1 : 0);
}

function bestRow(rows: BookSourceRow[]): BookSourceRow {
  return [...rows].sort((a, b) => {
    const diff = sourceScore(b) - sourceScore(a);
    if (diff !== 0) return diff;
    return (b.last_modified_at ?? "").localeCompare(a.last_modified_at ?? "");
  })[0]!;
}

function coverSourcePriority(row: BookSourceRow): number {
  // Prefer Grimmory art whenever it exists. Manual poster selections in
  // Grimmory are fetched through the authenticated media endpoint and stored as
  // cached files, so they should outrank Hardcover edition art too.
  if (row.source_type === "grimmory" && (row.cover_url || row.cover_cache_path)) return 4;
  if (row.source_type === "hardcover") return 3;
  if (row.source_type === "grimmory") return 2;
  return 1;
}

function bestCoverRow(rows: BookSourceRow[]): BookSourceRow | null {
  const coverRows = rows.filter((row) => row.cover_cache_path || row.cover_url);
  if (coverRows.length === 0) return null;
  return [...coverRows].sort((a, b) => {
    const priorityDiff = coverSourcePriority(b) - coverSourcePriority(a);
    if (priorityDiff !== 0) return priorityDiff;
    const cacheDiff = Number(Boolean(b.cover_cache_path)) - Number(Boolean(a.cover_cache_path));
    if (cacheDiff !== 0) return cacheDiff;
    const urlDiff = Number(Boolean(b.cover_url)) - Number(Boolean(a.cover_url));
    if (urlDiff !== 0) return urlDiff;
    return (b.last_modified_at ?? "").localeCompare(a.last_modified_at ?? "");
  })[0]!;
}

function pick<T>(rows: BookSourceRow[], selector: (row: BookSourceRow) => T | null): T | null {
  for (const row of rows) {
    const value = selector(row);
    if (value !== null && value !== undefined && String(value).trim() !== "") return value;
  }
  return null;
}

function canonicalValues(rows: BookSourceRow[]) {
  const row = bestRow(rows);
  const coverRow = bestCoverRow(rows);
  return {
    mediaType: canonicalFormat(rows),
    title: row.title ?? "",
    author: row.author,
    coverUrl: coverRow?.cover_url ?? null,
    coverCachePath: coverRow?.cover_cache_path ?? null,
    isbn13: pick(rows, (r) => normalizeIsbn(r.isbn13)),
    isbn10: pick(rows, (r) => normalizeIsbn(r.isbn10)),
    seriesName: pick(rows, (r) => clean(r.series_name)),
    seriesNumber: pick(rows, (r) => clean(r.series_number)),
    lastSyncAt: rows.reduce<string | null>((latest, r) => newer(latest, r.last_sync_at), null),
    lastModifiedAt: rows.reduce<string | null>((latest, r) => newer(latest, r.last_modified_at), null)
  };
}

function stateHasProgress(row: Pick<UserBookStateMoveRow, "progress" | "progress_seconds" | "audiobookshelf_item_id">): boolean {
  return row.audiobookshelf_item_id !== null
    || row.progress_seconds !== null
    || (row.progress !== null && Math.abs(row.progress) > 0.001);
}

// Also used by hardcover-legacy-cleanup.ts, so a stranded state being migrated
// off a legacy row resolves a conflict with the live row's own state the same
// way a book merge would — preferring meaningful progress, then the newer
// timestamp — rather than a cleanup-specific rule that could discard the more
// current side.
export function shouldMoveState(source: UserBookStateMoveRow, existing: UserBookStateMoveRow): boolean {
  const sourceHasProgress = stateHasProgress(source);
  const existingHasProgress = stateHasProgress(existing);
  if (sourceHasProgress !== existingHasProgress) return sourceHasProgress;
  return (source.last_modified_at ?? "") >= (existing.last_modified_at ?? "");
}

export interface ReconcileScope {
  /** book_sources.id values that just changed and need identity resolution. */
  sourceIds: number[];
}

const SCOPE_EXPANSION_ROW_CAP = 20000;
const SCOPE_EXPANSION_ITERATION_CAP = 6;

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

// The identity-key values a row could be found by during scoped expansion —
// every key type the merge passes below can act on (high-confidence IDs, ISBN,
// file path, title+author). Deliberately over-inclusive: a value collision
// across unrelated key *types* just pulls in a harmless extra candidate, which
// the real merge passes below will correctly decline to merge — only a missed
// value would be dangerous.
function expansionKeyValues(row: BookSourceRow): string[] {
  const keys: IdentityKey[] = [...highIdentityKeys(row), ...isbnIdentityKeys(row), ...filePathIdentityKeys(row)];
  const titleKey = titleAuthorKey(row);
  if (titleKey) keys.push(titleKey);
  return Array.from(new Set(keys.map((key) => key.slice(key.indexOf(":") + 1))));
}

// Expands a set of just-changed book_sources ids into the full row set a
// correct reconcile pass needs: every row belonging to any book that could
// possibly merge with a touched row. This is a closure, not a heuristic — a
// multi-hop chain (row A shares an ISBN with book B, book B shares a
// title/author with book C) is still found, because candidate books discovered
// on one iteration have their own rows re-scanned for further candidates on
// the next, until a fixed point is reached.
//
// Known gap: the "corroborated Chaptarr->Goodreads bridge" merge pass further
// below keys off a Chaptarr row's own (possibly stale) source_goodreads_edition_id
// field, which is never persisted to book_identity_keys — Chaptarr's IDs aren't
// trusted as identity keys. A brand-new row that could *only* reach its match
// through that specific bridge, with no shared ISBN/high-key/file-path/title-
// author to ride along on, will not be discovered here. That bridge is already
// a narrow fallback for stale/conflicting data, and the daily full-reconcile
// maintenance job (scheduler.ts) closes any such gap within 24 hours.
//
// Returns null if the closure grows past a safety cap — the caller should fall
// back to a full reconcile in that case rather than silently truncate it.
// `caps` defaults to the module constants; it's only overridable so tests can
// exercise the cap-hit paths cheaply, without needing tens of thousands of
// rows or a genuinely 7-hop chain to prove the fallback triggers correctly.
export function expandScopeToRows(
  db: Database.Database,
  initialSourceIds: number[],
  caps: { rowCap?: number; iterationCap?: number } = {}
): BookSourceRow[] | null {
  const rowCap = caps.rowCap ?? SCOPE_EXPANSION_ROW_CAP;
  const iterationCap = caps.iterationCap ?? SCOPE_EXPANSION_ITERATION_CAP;
  const rowsById = new Map<number, BookSourceRow>();
  const visitedBookIds = new Set<number>();
  const processedKeyValues = new Set<string>();

  const fetchByIds = (column: "id" | "book_id", ids: number[]): BookSourceRow[] => {
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return [];
    const results: BookSourceRow[] = [];
    for (const batch of chunk(unique, 500)) {
      const placeholders = batch.map(() => "?").join(",");
      results.push(...(db.prepare(`SELECT * FROM book_sources WHERE ${column} IN (${placeholders})`).all(...batch) as BookSourceRow[]));
    }
    return results;
  };

  const candidateBookIdsForKeys = (values: string[]): number[] => {
    const results = new Set<number>();
    for (const batch of chunk(values, 500)) {
      const placeholders = batch.map(() => "?").join(",");
      for (const row of db.prepare(`SELECT DISTINCT book_id FROM book_identity_keys WHERE key_value IN (${placeholders})`).all(...batch) as { book_id: number }[]) {
        results.add(row.book_id);
      }
    }
    return Array.from(results);
  };

  // Adds rows and checks the row cap immediately, at every point rows are
  // added — not just once per iteration — so no fetch (including the very
  // last one before the iteration cap would trip) can push the closure past
  // the cap undetected.
  const addRows = (rows: BookSourceRow[]): boolean => {
    for (const row of rows) rowsById.set(row.id, row);
    return rowsById.size > rowCap;
  };

  if (addRows(fetchByIds("id", initialSourceIds))) return null;

  for (let iteration = 0; iteration < iterationCap; iteration++) {
    const newBookIds = Array.from(new Set(
      Array.from(rowsById.values())
        .map((row) => row.book_id)
        .filter((id): id is number => id !== null && !visitedBookIds.has(id))
    ));
    for (const id of newBookIds) visitedBookIds.add(id);
    if (addRows(fetchByIds("book_id", newBookIds))) return null;

    const keyValues = Array.from(new Set(Array.from(rowsById.values()).flatMap(expansionKeyValues)))
      .filter((value) => !processedKeyValues.has(value));
    // Fixed point: nothing new to expand from. This is the only path that
    // returns a result — every other exit (including exhausting the
    // iteration cap below) means the closure might still be incomplete, so
    // it must return null and let the caller fall back to a full reconcile
    // rather than silently return a partial scope.
    if (keyValues.length === 0) return Array.from(rowsById.values()).sort((a, b) => a.id - b.id);
    for (const value of keyValues) processedKeyValues.add(value);

    const newCandidateBookIds = candidateBookIdsForKeys(keyValues).filter((id) => !visitedBookIds.has(id));
    if (newCandidateBookIds.length === 0) return Array.from(rowsById.values()).sort((a, b) => a.id - b.id);

    if (addRows(fetchByIds("book_id", newCandidateBookIds))) return null;
  }

  return null;
}

export type ReconcileProgressPhase = "rows_loaded" | "groups_computed" | "transaction_committed" | "image_cache_cleaned";
export type ReconcileProgressCallback = (phase: ReconcileProgressPhase, details: Record<string, unknown>) => void;

export function reconcileBookIdentities(db: Database.Database, scope?: ReconcileScope, onProgress?: ReconcileProgressCallback): void {
  if (scope && scope.sourceIds.length === 0) return;

  let rows: BookSourceRow[];
  if (scope) {
    const expanded = expandScopeToRows(db, scope.sourceIds);
    if (expanded === null) {
      logger.warn("Scoped reconcile exceeded expansion cap; falling back to a full reconcile", {
        sourceIdCount: scope.sourceIds.length
      });
      reconcileBookIdentities(db, undefined, onProgress);
      return;
    }
    rows = expanded;
  } else {
    rows = db.prepare(`SELECT * FROM book_sources ORDER BY id`).all() as BookSourceRow[];
  }
  onProgress?.("rows_loaded", { rowCount: rows.length, scoped: Boolean(scope) });

  if (rows.length === 0) {
    if (!scope) cleanupOrphanedImageCache(db);
    return;
  }
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  // A book_sources row's book_id is FK-enforced (foreign_keys=ON, ON DELETE CASCADE),
  // so every non-null book_id appearing in `rows` is guaranteed to reference a book
  // that currently exists — no need for a separate `SELECT id FROM books` query, and
  // this stays correct whether `rows` is the full catalog or a scoped expansion.
  const validBookIds = new Set(
    rows.map((row) => row.book_id).filter((id): id is number => id !== null)
  );

  // Books that have at least one non-Chaptarr source are "canonical" — they were
  // resolved by Goodreads, Hardcover, or Grimmory and own their book record.
  // Used below to prevent Chaptarr-only groups from stealing or duplicating those books.
  const bookIdsReferencedByNonChaptarr = new Set(
    rows
      .filter((r) => r.source_type !== "chaptarr" && r.book_id !== null && validBookIds.has(r.book_id!))
      .map((r) => r.book_id!)
  );
  const canonicalBookIdsByFilePath = new Map<IdentityKey, number[]>();
  const scopedInstancesByCanonicalFilePath = new Map<IdentityKey, Set<number | null>>();
  for (const row of rows) {
    if (row.source_type === "chaptarr" || row.book_id === null || !bookIdsReferencedByNonChaptarr.has(row.book_id)) continue;
    for (const key of filePathIdentityKeys(row)) {
      const ids = canonicalBookIdsByFilePath.get(key) ?? [];
      if (!ids.includes(row.book_id)) ids.push(row.book_id);
      canonicalBookIdsByFilePath.set(key, ids);
      if (row.source_type === "grimmory" || row.source_type === "audiobookshelf") {
        const instances = scopedInstancesByCanonicalFilePath.get(key) ?? new Set<number | null>();
        instances.add(row.source_instance_id);
        scopedInstancesByCanonicalFilePath.set(key, instances);
      }
    }
  }

  const uf = new UnionFind();
  const byHighKey = new Map<IdentityKey, number>();
  const byIsbnKey = new Map<IdentityKey, number[]>();
  const byFilePathKey = new Map<IdentityKey, number[]>();

  // Aggregate data per current union-find root, merged incrementally on every union
  // instead of rescanning all rows for every candidate pair — reconcileBookIdentities
  // runs inside a write transaction on every sync, so an O(n) rescan per pair would be
  // a meaningful stall on large libraries.
  const rootIndex = new Map<number, RootIndexEntry>();
  const unionRoots = (a: number, b: number): void => {
    const rootA = uf.find(a);
    const rootB = uf.find(b);
    if (rootA === rootB) return;
    uf.union(a, b);
    const survivingRoot = uf.find(a);
    const losingRoot = survivingRoot === rootA ? rootB : rootA;
    rootIndex.set(survivingRoot, mergeRootEntries(rootIndex.get(rootA), rootIndex.get(rootB)));
    rootIndex.delete(losingRoot);
  };

  for (const row of rows) {
    uf.add(row.id);
    const highKeys = highIdentityKeys(row);
    const isbnKeys = isbnIdentityKeys(row);
    const filePathKeys = filePathIdentityKeys(row);
    const titleKey = titleAuthorKey(row);
    const seriesName = normalizeTitle(row.series_name);
    const seriesNumber = normalizeSeriesNumber(row.series_number);
    const rowBucket = rowFormatBucket(row);
    rootIndex.set(row.id, {
      highKeys: new Set(highKeys),
      titleAuthorKeys: new Set(titleKey ? [titleKey] : []),
      seriesNames: new Set(seriesName ? [seriesName] : []),
      seriesNumbers: new Set(seriesNumber ? [seriesNumber] : []),
      formatBuckets: new Set(rowBucket === "unknown" ? [] : [rowBucket])
    });

    for (const key of highKeys) {
      const existing = byHighKey.get(key);
      if (existing !== undefined) unionRoots(existing, row.id);
      else byHighKey.set(key, row.id);
    }

    for (const key of isbnKeys) {
      const ids = byIsbnKey.get(key) ?? [];
      ids.push(row.id);
      byIsbnKey.set(key, ids);
    }

    for (const key of filePathKeys) {
      const ids = byFilePathKey.get(key) ?? [];
      ids.push(row.id);
      byFilePathKey.set(key, ids);
    }
  }

  // A Goodreads/Grimmory ISBN match can otherwise be blocked by a stale
  // Goodreads ID stored in Grimmory. When that Grimmory row also shares an exact
  // same-format path with Chaptarr, the physical library provides independent
  // corroboration that the IDs describe the same local book.
  const corroboratedGrimmoryChaptarrFilePaths = new Set<IdentityKey>();
  for (const [key, ids] of byFilePathKey) {
    const sourceTypes = new Set(ids.map((id) => rowsById.get(id)?.source_type));
    const grimmoryInstances = new Set(ids
      .map((id) => rowsById.get(id))
      .filter((row): row is BookSourceRow => row?.source_type === "grimmory")
      .map((row) => row.source_instance_id));
    if (sourceTypes.has("grimmory") && sourceTypes.has("chaptarr") && grimmoryInstances.size <= 1) {
      corroboratedGrimmoryChaptarrFilePaths.add(key);
    }
  }

  for (const ids of byIsbnKey.values()) {
    for (const id of ids.slice(1)) {
      const rootA = uf.find(ids[0]!);
      const rootB = uf.find(id);
      if (rootA === rootB) continue;
      // An audiobook edition can genuinely report the same ISBN as its print/
      // ebook counterpart (a real Grimmory/Hardcover metadata quirk) — that's
      // not evidence they're the same canonical book. Book vs. audiobook are
      // deliberately different canonicals everywhere else in this codebase
      // (rowFormatBucket, the bucket-prefixed high keys above, the Hardcover
      // Owned-list/shared-sibling dual-row mechanism), so a cross-bucket ISBN
      // match must never be allowed to silently re-merge them. Skip only when
      // both sides have a *known* bucket and they disagree — an unknown
      // bucket carries no contradicting signal and must not block a
      // legitimate same-format merge just because format wasn't classified.
      const bucketsA = rootIndex.get(rootA)?.formatBuckets ?? new Set();
      const bucketsB = rootIndex.get(rootB)?.formatBuckets ?? new Set();
      if (bucketsA.size > 0 && bucketsB.size > 0 && ![...bucketsA].some((b) => bucketsB.has(b))) {
        logger.debug("Skipped ISBN-based book merge: opposite format buckets", { rootA, rootB });
        continue;
      }
      const keysA = rootIndex.get(rootA)?.highKeys ?? new Set<IdentityKey>();
      const keysB = rootIndex.get(rootB)?.highKeys ?? new Set<IdentityKey>();
      // A shared ISBN is strong corroborating evidence, but a conflicting authoritative
      // ID (e.g. different Hardcover/Goodreads IDs) normally blocks the merge.
      if (highKeyConflict(keysA, keysB)) {
        const firstRow = rowsById.get(ids[0]!);
        const secondRow = rowsById.get(id);
        const goodreadsRow = firstRow?.source_type === "goodreads" ? firstRow
          : secondRow?.source_type === "goodreads" ? secondRow : undefined;
        const grimmoryRow = firstRow?.source_type === "grimmory" ? firstRow
          : secondRow?.source_type === "grimmory" ? secondRow : undefined;
        const sameTitle = Boolean(goodreadsRow && grimmoryRow
          && normalizeTitle(goodreadsRow.title) === normalizeTitle(grimmoryRow.title));
        const corroboratedPath = Boolean(grimmoryRow && filePathIdentityKeys(grimmoryRow)
          .some((key) => corroboratedGrimmoryChaptarrFilePaths.has(key)));
        // sameTitle/corroboratedPath only vouch for firstRow and secondRow
        // specifically. unionRoots below merges their whole clusters, so
        // confirm the conflict is actually confined to these two rows —
        // otherwise an unrelated conflicting member already in one of the
        // clusters would get pulled into the merge on this pair's coattails.
        const residualKeysA = new Set([...keysA].filter((key) => !new Set(highIdentityKeys(firstRow!)).has(key)));
        const residualKeysB = new Set([...keysB].filter((key) => !new Set(highIdentityKeys(secondRow!)).has(key)));
        const conflictConfinedToThisPair = sameTitle && corroboratedPath
          && !highKeyConflict(residualKeysA, residualKeysB)
          && !highKeyConflict(residualKeysA, new Set(highIdentityKeys(secondRow!)))
          && !highKeyConflict(new Set(highIdentityKeys(firstRow!)), residualKeysB);
        if (conflictConfinedToThisPair) {
          unionRoots(rootA, rootB);
          logger.info("Merged ISBN match despite stale Grimmory identifier", {
            goodreadsSourceId: goodreadsRow!.id,
            grimmorySourceId: grimmoryRow!.id
          });
          continue;
        }
        logger.debug("Skipped ISBN-based book merge: conflicting authoritative identifiers", {
          rootA, rootB
        });
        continue;
      }
      unionRoots(rootA, rootB);
    }
  }

  // Chaptarr and Grimmory refer to the same managed library. An exact path in the
  // same media bucket is therefore the strongest evidence available, including when
  // Chaptarr still holds a stale upstream Goodreads or Hardcover identifier.
  // Other source combinations remain conservative: they still require compatible
  // authoritative IDs and title/author data.
  for (const ids of byFilePathKey.values()) {
    const chaptarrIds = ids.filter((id) => rowsById.get(id)?.source_type === "chaptarr");
    const grimmoryIds = ids.filter((id) => rowsById.get(id)?.source_type === "grimmory");
    const grimmoryInstances = new Set(grimmoryIds.map((id) => rowsById.get(id)?.source_instance_id));
    const canBridgeChaptarrToGrimmory = grimmoryInstances.size <= 1;
    if (canBridgeChaptarrToGrimmory) {
      for (const chaptarrId of chaptarrIds) {
        for (const grimmoryId of grimmoryIds) unionRoots(uf.find(chaptarrId), uf.find(grimmoryId));
      }
    }
    for (const id of ids.slice(1)) {
      const rootA = uf.find(ids[0]!);
      const rootB = uf.find(id);
      if (rootA === rootB) continue;
      const rowA = rowsById.get(ids[0]!);
      const rowB = rowsById.get(id);
      const isChaptarrGrimmoryPair = (rowA?.source_type === "chaptarr" && rowB?.source_type === "grimmory")
        || (rowA?.source_type === "grimmory" && rowB?.source_type === "chaptarr");
      // A bridgeable pair was already unioned above (rootA would equal rootB
      // and the loop would have continued at the top), so reaching here with
      // isChaptarrGrimmoryPair true only happens when the pair could NOT be
      // bridged (ambiguous Grimmory instance) — skip it rather than falling
      // through to the high-key conflict check below.
      if (isChaptarrGrimmoryPair) continue;
      const keysA = rootIndex.get(rootA)?.highKeys ?? new Set<IdentityKey>();
      const keysB = rootIndex.get(rootB)?.highKeys ?? new Set<IdentityKey>();
      if (highKeyConflict(keysA, keysB)) {
        logger.debug("Skipped file-path book merge: conflicting authoritative identifiers", { rootA, rootB });
        continue;
      }

      const titleKeysA = rootIndex.get(rootA)?.titleAuthorKeys ?? new Set<IdentityKey>();
      const titleKeysB = rootIndex.get(rootB)?.titleAuthorKeys ?? new Set<IdentityKey>();
      const bothHaveTitles = titleKeysA.size > 0 && titleKeysB.size > 0;
      const titlesAgree = Array.from(titleKeysA).some((key) => titleKeysB.has(key));
      if (bothHaveTitles && !titlesAgree) {
        logger.debug("Skipped file-path book merge: conflicting title/author", { rootA, rootB });
        continue;
      }

      unionRoots(rootA, rootB);
    }
  }

  // Chaptarr's upstream Hardcover and Goodreads IDs are not independently
  // trustworthy enough to merge on: its metadata can be stale or wrong. A
  // Goodreads edition ID becomes useful only when the same Chaptarr row is
  // corroborated by an exact, same-format Grimmory file path. This bridges
  // edition-specific Goodreads records without restoring Chaptarr IDs as
  // general high-confidence identity keys.
  const goodreadsByEditionId = new Map<string, number[]>();
  const grimmoryByFilePath = new Map<IdentityKey, number[]>();
  for (const row of rows) {
    if (row.source_type === "goodreads") {
      const editionId = normalizeExternalId(row.external_id);
      if (editionId) {
        const ids = goodreadsByEditionId.get(editionId) ?? [];
        ids.push(row.id);
        goodreadsByEditionId.set(editionId, ids);
      }
    }
    if (row.source_type === "grimmory") {
      const path = normalizePath(row.grimmory_primary_file_path);
      const bucket = rowFormatBucket(row);
      if (path && bucket !== "unknown") {
        const key = `${bucket}.file_path:${path}` as IdentityKey;
        const ids = grimmoryByFilePath.get(key) ?? [];
        ids.push(row.id);
        grimmoryByFilePath.set(key, ids);
      }
    }
  }

  let corroboratedBridgeCount = 0;
  for (const chaptarrRow of rows) {
    if (chaptarrRow.source_type !== "chaptarr") continue;
    const editionId = normalizeExternalId(chaptarrRow.source_goodreads_edition_id);
    const path = normalizePath(chaptarrRow.chaptarr_primary_file_path);
    const bucket = rowFormatBucket(chaptarrRow);
    if (!editionId || !path || bucket === "unknown") continue;

    const goodreadsRows = goodreadsByEditionId.get(editionId);
    const grimmoryRows = grimmoryByFilePath.get(`${bucket}.file_path:${path}` as IdentityKey);
    if (!goodreadsRows || !grimmoryRows) continue;
    const grimmoryInstances = new Set(grimmoryRows.map((id) => rowsById.get(id)?.source_instance_id));
    if (grimmoryInstances.size > 1) {
      logger.warn("Skipped corroborated Chaptarr Goodreads bridge across Grimmory profiles", { path, profiles: grimmoryInstances.size });
      continue;
    }

    for (const goodreadsRowId of goodreadsRows) {
      for (const grimmoryRowId of grimmoryRows) {
        unionRoots(chaptarrRow.id, goodreadsRowId);
        unionRoots(chaptarrRow.id, grimmoryRowId);
        corroboratedBridgeCount++;
      }
    }
  }
  if (corroboratedBridgeCount > 0) {
    logger.info("Merged sources via corroborated Chaptarr Goodreads identity bridge", { bridges: corroboratedBridgeCount });
  }

  // Title/author matches alone are not authoritative enough to auto-merge distinct
  // books: they are surfaced as "probable duplicates" for manual review instead
  // (see routes/books.ts). Only merge automatically when there is no conflicting
  // authoritative identifier AND the groups also explicitly agree on series name +
  // number — corroborating evidence that this is genuinely the same work.
  const byTitle = new Map<IdentityKey, number[]>();
  for (const row of rows) {
    const key = titleAuthorKey(row);
    if (!key) continue;
    const existingIds = byTitle.get(key) ?? [];
    for (const existing of existingIds) {
      const rootA = uf.find(existing);
      const rootB = uf.find(row.id);
      if (rootA === rootB) continue;

      const dataA = rootIndex.get(rootA);
      const dataB = rootIndex.get(rootB);
      const keysA = dataA?.highKeys ?? new Set<IdentityKey>();
      const keysB = dataB?.highKeys ?? new Set<IdentityKey>();
      if (highKeyConflict(keysA, keysB)) {
        logger.debug("Skipped title/author book merge: conflicting authoritative identifiers", { rootA, rootB });
        continue;
      }

      const series = seriesMatchFromSets(
        dataA?.seriesNames ?? new Set<string>(), dataA?.seriesNumbers ?? new Set<string>(),
        dataB?.seriesNames ?? new Set<string>(), dataB?.seriesNumbers ?? new Set<string>()
      );
      if (!series.compatible || !series.strongMatch) continue;

      unionRoots(existing, row.id);
    }
    existingIds.push(row.id);
    byTitle.set(key, existingIds);
  }

  const groups = new Map<number, BookSourceRow[]>();
  for (const row of rows) {
    const root = uf.find(row.id);
    const group = groups.get(root) ?? [];
    group.push(row);
    groups.set(root, group);
  }
  onProgress?.("groups_computed", { groupCount: groups.size });

  const insertBook = db.prepare(`
    INSERT INTO books (
      media_type, title, author, cover_url, cover_cache_path, isbn13, isbn10,
      series_name, series_number, duplicate_title_key, duplicate_author_key,
      last_sync_at, last_modified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `);
  const updateBook = db.prepare(`
    UPDATE books SET
      media_type = ?, title = ?, author = ?, cover_url = ?, cover_cache_path = ?,
      isbn13 = ?, isbn10 = ?, series_name = ?, series_number = ?,
      duplicate_title_key = ?, duplicate_author_key = ?,
      last_sync_at = ?, last_modified_at = COALESCE(?, datetime('now'))
    WHERE id = ?
  `);
  const updateSource = db.prepare("UPDATE book_sources SET book_id = ? WHERE id = ?");
  const selectRemainingSources = db.prepare("SELECT 1 FROM book_sources WHERE book_id = ? LIMIT 1");
  const updateSourcesByBookId = db.prepare("UPDATE book_sources SET book_id = ? WHERE book_id = ?");
  const deleteBook = db.prepare("DELETE FROM books WHERE id = ?");
  const deleteUserState = db.prepare("DELETE FROM user_book_states WHERE id = ?");
  const updateUserStateBook = db.prepare("UPDATE user_book_states SET book_id = ? WHERE id = ?");
  const selectUserStatesForBook = db.prepare("SELECT * FROM user_book_states WHERE book_id = ?");
  const selectUserStateConflict = db.prepare(`
    SELECT * FROM user_book_states
    WHERE book_id = ? AND profile_id = ? AND source_type = ?
  `);
  const clearKeys = db.prepare("DELETE FROM book_identity_keys");
  const clearKeysForBook = db.prepare("DELETE FROM book_identity_keys WHERE book_id = ?");
  const insertKey = db.prepare("INSERT OR IGNORE INTO book_identity_keys (book_id, key_type, key_value) VALUES (?, ?, ?)");
  const selectHasUserState = db.prepare("SELECT 1 FROM user_book_states WHERE book_id = ? LIMIT 1");

  const moveUserStates = (targetBookId: number, sourceBookId: number): void => {
    const states = selectUserStatesForBook.all(sourceBookId) as UserBookStateMoveRow[];
    for (const state of states) {
      const conflict = selectUserStateConflict.get(
        targetBookId,
        state.profile_id,
        state.source_type
      ) as UserBookStateMoveRow | undefined;
      if (!conflict) {
        updateUserStateBook.run(targetBookId, state.id);
        continue;
      }
      if (shouldMoveState(state, conflict)) {
        deleteUserState.run(conflict.id);
        updateUserStateBook.run(targetBookId, state.id);
        logger.warn("Replaced conflicting user state while moving books into a merged canonical", {
          keptId: state.id,
          discardedId: conflict.id,
          profileId: state.profile_id,
          sourceBookId,
          targetBookId,
          sourceType: state.source_type
        });
      } else {
        deleteUserState.run(state.id);
        logger.warn("Discarded stale user state while moving books into a merged canonical", {
          keptId: conflict.id,
          discardedId: state.id,
          profileId: state.profile_id,
          sourceBookId,
          targetBookId,
          sourceType: state.source_type
        });
      }
    }
  };

  const repairLinkedState = (
    row: UserBookStateMoveRow & { source_book_id: number },
    sourceLabel: "Audiobookshelf" | "Grimmory"
  ): void => {
    const conflict = selectUserStateConflict.get(
      row.source_book_id,
      row.profile_id,
      row.source_type
    ) as UserBookStateMoveRow | undefined;

    if (!conflict || conflict.id === row.id) {
      updateUserStateBook.run(row.source_book_id, row.id);
      return;
    }

    if (shouldMoveState(row, conflict)) {
      deleteUserState.run(conflict.id);
      updateUserStateBook.run(row.source_book_id, row.id);
      logger.warn(`Replaced conflicting ${sourceLabel} user state during identity repair`, {
        keptId: row.id,
        discardedId: conflict.id,
        profileId: row.profile_id,
        sourceBookId: row.book_id,
        targetBookId: row.source_book_id,
        sourceType: row.source_type
      });
    } else {
      deleteUserState.run(row.id);
      logger.warn(`Discarded stale ${sourceLabel} user state during identity repair`, {
        keptId: conflict.id,
        discardedId: row.id,
        profileId: row.profile_id,
        sourceBookId: row.book_id,
        targetBookId: row.source_book_id,
        sourceType: row.source_type
      });
    }
  };

  // scopeBookIds, when given, restricts the repair to book_sources rows whose
  // (already-reassigned-above) book_id is one this pass touched — a new mismatch
  // can only appear against a book_id this pass just wrote, so this is a
  // sufficient scope, not a heuristic. Any pre-existing mismatch elsewhere in
  // the catalog is left for the next full reconcile (see the daily maintenance
  // job in scheduler.ts).
  const repairAudiobookshelfStates = (scopeBookIds?: number[]): void => {
    if (scopeBookIds && scopeBookIds.length === 0) return;
    // Matched by (external_id AND instance) — a colliding local item id on a
    // different profile's ABS server must not move this profile's user state.
    const scopeClause = scopeBookIds ? `AND bs.book_id IN (${scopeBookIds.map(() => "?").join(",")})` : "";
    const rows = db.prepare(`
      SELECT ubs.*, bs.book_id AS source_book_id
      FROM user_book_states ubs
      JOIN book_sources bs
        ON bs.source_type = 'audiobookshelf'
       AND bs.source_instance_id = ubs.profile_id
       AND bs.external_id = ubs.audiobookshelf_item_id
      WHERE ubs.source_type = 'audiobookshelf'
        AND ubs.audiobookshelf_item_id IS NOT NULL
        AND bs.book_id IS NOT NULL
        AND ubs.book_id != bs.book_id
        ${scopeClause}
    `).all(...(scopeBookIds ?? [])) as Array<UserBookStateMoveRow & { source_book_id: number }>;

    for (const row of rows) {
      repairLinkedState(row, "Audiobookshelf");
    }
  };

  const repairGrimmoryStates = (scopeBookIds?: number[]): void => {
    if (scopeBookIds && scopeBookIds.length === 0) return;
    // Matched by (external_id AND instance) — a colliding local book id on a
    // different profile's Grimmory server must not move this profile's user state.
    const scopeClause = scopeBookIds ? `AND bs.book_id IN (${scopeBookIds.map(() => "?").join(",")})` : "";
    const rows = db.prepare(`
      SELECT ubs.*, bs.book_id AS source_book_id
      FROM user_book_states ubs
      JOIN book_sources bs
        ON bs.source_type = 'grimmory'
       AND bs.source_instance_id = ubs.profile_id
       AND CAST(bs.external_id AS INTEGER) = ubs.grimmory_book_id
      WHERE ubs.source_type = 'grimmory'
        AND ubs.grimmory_book_id IS NOT NULL
        AND bs.book_id IS NOT NULL
        AND ubs.book_id != bs.book_id
        ${scopeClause}
    `).all(...(scopeBookIds ?? [])) as Array<UserBookStateMoveRow & { source_book_id: number }>;

    for (const row of rows) {
      repairLinkedState(row, "Grimmory");
    }
  };

  const claimedBookIds = new Set<number>();
  let created = 0;
  let reassigned = 0;
  let merged = 0;
  let skippedCrossProfileGroups = 0;
  const CROSS_PROFILE_SAMPLE_LIMIT = 5;
  const skippedCrossProfileSample: Array<{ path: string; instanceIds: Array<number | null> }> = [];
  const trackSkippedCrossProfileGroup = (crossingKeys: IdentityKey[]): void => {
    skippedCrossProfileGroups++;
    if (skippedCrossProfileSample.length >= CROSS_PROFILE_SAMPLE_LIMIT) return;
    for (const key of crossingKeys) {
      if (skippedCrossProfileSample.length >= CROSS_PROFILE_SAMPLE_LIMIT) break;
      const path = key.slice(key.indexOf(".file_path:") + ".file_path:".length);
      const instanceIds = Array.from(scopedInstancesByCanonicalFilePath.get(key) ?? []);
      skippedCrossProfileSample.push({ path, instanceIds });
    }
  };
  const chaptarrOrphanReassignments = new Map<number, Set<number>>();
  const trackChaptarrOrphanReassignment = (oldBookId: number | null, targetBookId: number): void => {
    if (oldBookId === null || oldBookId === targetBookId) return;
    const targets = chaptarrOrphanReassignments.get(oldBookId) ?? new Set<number>();
    targets.add(targetBookId);
    chaptarrOrphanReassignments.set(oldBookId, targets);
  };

  const transaction = db.transaction(() => {
    // Unscoped: this pass reprocesses every row, so it's safe (and simplest) to
    // wipe and fully repopulate the whole table. Scoped: only the books whose
    // rows are in this pass's closure are being reprocessed, so only their keys
    // are cleared — an unconditional full wipe here would erase identity keys
    // for every book *outside* the scope, breaking the next scoped call's
    // candidate expansion.
    if (!scope) {
      clearKeys.run();
    } else {
      for (const bookId of validBookIds) clearKeysForBook.run(bookId);
    }

    for (const group of groups.values()) {
      const isChaptarrOnly = group.every((r) => r.source_type === "chaptarr");

      if (isChaptarrOnly) {
        // A Chaptarr row may already point at an ebook canonical record from a
        // previous loose match. An exact same-format file path is stronger than
        // that historical assignment, so move only this Chaptarr group to the
        // proven canonical record without collapsing the ebook and audiobook
        // records into each other.
        const groupFilePathKeys = group.flatMap((row) => filePathIdentityKeys(row));
        const crossingFilePathKeys = Array.from(new Set(
          groupFilePathKeys.filter(
            (key) => (scopedInstancesByCanonicalFilePath.get(key)?.size ?? 0) > 1
          )
        ));
        const crossesScopedProfiles = crossingFilePathKeys.length > 0;
        const unassignedCandidateIds = crossesScopedProfiles ? [] : Array.from(new Set(
          group
            .flatMap((row) => filePathIdentityKeys(row))
            .flatMap((key) => canonicalBookIdsByFilePath.get(key) ?? [])
            .filter((id) => !group.some((row) => row.book_id === id))
        ));
        if (unassignedCandidateIds.length > 1) {
          logger.warn("Ambiguous same-format file path matches multiple canonical books; picking one arbitrarily", {
            candidateBookIds: unassignedCandidateIds,
            sourceExternalIds: group.map((row) => row.external_id)
          });
        }
        const filePathCanonicalId = crossesScopedProfiles ? undefined : groupFilePathKeys
          .flatMap((key) => canonicalBookIdsByFilePath.get(key) ?? [])
          .find((id) => group.some((row) => row.book_id === id))
          ?? unassignedCandidateIds[0];
        if (crossesScopedProfiles) {
          trackSkippedCrossProfileGroup(crossingFilePathKeys);
        }
        if (filePathCanonicalId !== undefined) {
          for (const row of group) {
            if (row.book_id !== filePathCanonicalId) {
              reassigned++;
              trackChaptarrOrphanReassignment(row.book_id, filePathCanonicalId);
            }
            updateSource.run(filePathCanonicalId, row.id);
          }
          logger.info("Reassigned Chaptarr source to same-format file-path canonical book", {
            bookId: filePathCanonicalId,
            sourceCount: group.length
          });
          continue;
        }
      }

      const existingIds = Array.from(new Set(
        group.map((r) => r.book_id).filter((id): id is number => id !== null && validBookIds.has(id))
      )).sort((a, b) => a - b);

      let bookId = existingIds.find((id) => !claimedBookIds.has(id)) ?? null;
      const values = canonicalValues(group);

      if (bookId === null) {
        if (isChaptarrOnly) {
          // The Chaptarr sync already assigned these source rows to a canonical book.
          // If that book is owned by a non-Chaptarr group, redirecting here avoids
          // creating a phantom duplicate record for the same work.
          const canonicalId = existingIds.find((id) => bookIdsReferencedByNonChaptarr.has(id));
          if (canonicalId !== undefined) {
            for (const row of group) {
              if (row.book_id !== canonicalId) {
                reassigned++;
                trackChaptarrOrphanReassignment(row.book_id, canonicalId);
              }
              updateSource.run(canonicalId, row.id);
            }
            continue;
          }
        }
        const result = insertBook.run(
          values.mediaType, values.title, values.author, values.coverUrl, values.coverCachePath,
          values.isbn13, values.isbn10, values.seriesName, values.seriesNumber,
          probableDuplicateTitleKey(values.title), probableDuplicateAuthorKey(values.author),
          values.lastSyncAt, values.lastModifiedAt
        );
        bookId = Number(result.lastInsertRowid);
        validBookIds.add(bookId);
        created++;
      } else if (isChaptarrOnly && bookIdsReferencedByNonChaptarr.has(bookId)) {
        // Chaptarr-only group reached an unclaimed book that is also referenced by a
        // non-Chaptarr source. Don't claim or overwrite it — just redirect the source
        // rows so the non-Chaptarr group can still take ownership on its own pass.
        for (const row of group) {
          if (row.book_id !== bookId) {
            reassigned++;
            trackChaptarrOrphanReassignment(row.book_id, bookId);
          }
          updateSource.run(bookId, row.id);
        }
        continue;
      } else {
        updateBook.run(
          values.mediaType, values.title, values.author, values.coverUrl, values.coverCachePath,
          values.isbn13, values.isbn10, values.seriesName, values.seriesNumber,
          probableDuplicateTitleKey(values.title), probableDuplicateAuthorKey(values.author),
          values.lastSyncAt, values.lastModifiedAt, bookId
        );
      }

      claimedBookIds.add(bookId);

      // Merge duplicate book records into the surviving one
      if (existingIds.length > 1) {
        for (const duplicateId of existingIds.slice(1)) {
          if (duplicateId === bookId || claimedBookIds.has(duplicateId)) continue;
          // Reassign dependent rows before deleting the duplicate book. The
          // foreign key cascades, so deleting first would erase source rows.
          updateSourcesByBookId.run(bookId, duplicateId);
          moveUserStates(bookId, duplicateId);
          deleteBook.run(duplicateId);
          validBookIds.delete(duplicateId);
          merged++;
          logger.info("Merged duplicate book record during identity reconciliation", {
            keptBookId: bookId,
            mergedBookId: duplicateId,
            title: values.title,
            author: values.author,
            matchedKeys: Array.from(new Set(group.flatMap((row) => [...highIdentityKeys(row), ...isbnIdentityKeys(row), ...filePathIdentityKeys(row)])))
          });
        }
      }

      for (const row of group) {
        if (row.book_id !== bookId) {
          reassigned++;
          if (isChaptarrOnly) trackChaptarrOrphanReassignment(row.book_id, bookId);
        }
        updateSource.run(bookId, row.id);
      }

      for (const key of new Set(group.flatMap((row) => {
        const titleKey = titleAuthorKey(row);
        return [...highIdentityKeys(row), ...isbnIdentityKeys(row), ...filePathIdentityKeys(row), ...(titleKey ? [titleKey] : [])];
      }))) {
        const [keyType, ...rest] = key.split(":");
        insertKey.run(bookId, keyType, rest.join(":"));
      }
    }

    // A Chaptarr-only reassignment can leave its former book with no sources.
    // Move its state first, otherwise the stale-book cleanup below cascades it.
    for (const [oldBookId, targetBookIds] of chaptarrOrphanReassignments) {
      const remaining = selectRemainingSources.get(oldBookId);
      if (!remaining && targetBookIds.size === 1) moveUserStates([...targetBookIds][0]!, oldBookId);
      else if (!remaining && targetBookIds.size > 1) {
        logger.warn("Preserved user state for an ambiguously split Chaptarr canonical", { oldBookId, targetBookIds: [...targetBookIds] });
      }
    }

    // Clean up books that have no source rows. Scoped to the books this pass
    // touched — an unscoped LEFT JOIN here would scan the whole `books` table
    // on every scoped call, undoing the point of scoping.
    const staleBookIds = scope
      ? Array.from(validBookIds).filter((id) => !(selectRemainingSources.get(id)))
      : (db.prepare(`
          SELECT b.id FROM books b
          LEFT JOIN book_sources bs ON bs.book_id = b.id
          WHERE bs.id IS NULL
            AND NOT EXISTS (SELECT 1 FROM user_book_states ubs WHERE ubs.book_id = b.id)
        `).all() as { id: number }[]).map((row) => row.id);
    for (const staleId of staleBookIds) {
      if (scope && selectHasUserState.get(staleId)) continue;
      deleteBook.run(staleId);
    }

    repairAudiobookshelfStates(scope ? Array.from(validBookIds) : undefined);
    repairGrimmoryStates(scope ? Array.from(validBookIds) : undefined);
  });

  transaction();
  onProgress?.("transaction_committed", { created, reassigned, merged });
  if (!scope) {
    cleanupOrphanedImageCache(db);
    onProgress?.("image_cache_cleaned", {});
  }

  if (skippedCrossProfileGroups > 0) {
    logger.warn("Skipped Chaptarr file-path reassignment across scoped source profiles", {
      skippedGroups: skippedCrossProfileGroups,
      sample: skippedCrossProfileSample
    });
  }

  if (created > 0 || reassigned > 0 || merged > 0) {
    logger.info("Reconciled ShelfBridge book identities", { created, reassigned, merged, groups: groups.size });
  }
}
