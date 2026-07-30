import type Database from "better-sqlite3";
import { cleanupOrphanedImageCache } from "./imageCacheMaintenance.js";
import { logger } from "../logger.js";
import { normalizeExternalId } from "../identifiers.js";

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

interface UserBookStateMoveRow {
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

function normalizeIsbn(value: string | null | undefined): string | null {
  const text = clean(value)?.replace(/[^0-9Xx]/g, "").toUpperCase() ?? null;
  return text && text.length >= 10 ? text : null;
}

function normalizeTitle(value: string | null | undefined): string | null {
  const text = clean(value)
    ?.toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
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

function rowFormatBucket(row: Pick<BookSourceRow,
  "source_type" | "source_media_type" | "source_edition_format" | "source_narrator" | "grimmory_primary_file_path" | "chaptarr_primary_file_path"
>): FormatBucket {
  const editionBucket = inferEditionFormatBucket(row.source_edition_format);
  if (row.source_type === "hardcover" && editionBucket !== "unknown") return editionBucket;

  if (row.source_media_type === "audiobook") return "audiobook";
  if (row.source_media_type === "ebook" || row.source_media_type === "physical" || row.source_media_type === "book") return "book";

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

function isbnIdentityKeys(row: BookSourceRow): IdentityKey[] {
  const bucket = rowFormatBucket(row);
  const pairs: Array<[string, string | null]> = [
    ["isbn13", normalizeIsbn(row.isbn13)],
    ["isbn10", normalizeIsbn(row.isbn10)],
  ];

  return Array.from(new Set(
    pairs
      .filter((pair): pair is [string, string] => pair[1] !== null)
      .map(([type, value]) => `${bucket}.${type}:${value}` as IdentityKey)
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
    const values = byType.get(type) ?? new Set<string>();
    values.add(rest.join(":"));
    byType.set(type, values);
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

function groupTitleAuthorKeys(rows: BookSourceRow[], uf: UnionFind, root: number): Set<IdentityKey> {
  return new Set(
    rows
      .filter((row) => uf.find(row.id) === root)
      .map(titleAuthorKey)
      .filter((key): key is IdentityKey => key !== null)
  );
}

interface SeriesMatchInfo {
  // No contradictory series name/number between the two groups.
  compatible: boolean;
  // Both groups explicitly agree on series name AND number — strong corroborating
  // evidence that a title/author match is genuinely the same book.
  strongMatch: boolean;
}

function seriesMatchInfo(rows: BookSourceRow[], uf: UnionFind, rootA: number, rootB: number): SeriesMatchInfo {
  const namesA = new Set<string>();
  const namesB = new Set<string>();
  const numbersA = new Set<string>();
  const numbersB = new Set<string>();

  for (const row of rows) {
    const root = uf.find(row.id);
    if (root !== rootA && root !== rootB) continue;

    const seriesName = normalizeTitle(row.series_name);
    const seriesNumber = normalizeSeriesNumber(row.series_number);
    if (root === rootA) {
      if (seriesName) namesA.add(seriesName);
      if (seriesNumber) numbersA.add(seriesNumber);
    } else {
      if (seriesName) namesB.add(seriesName);
      if (seriesNumber) numbersB.add(seriesNumber);
    }
  }

  const namesOverlap = namesA.size > 0 && namesB.size > 0 && Array.from(namesA).some((name) => namesB.has(name));
  const numbersOverlap = numbersA.size > 0 && numbersB.size > 0 && Array.from(numbersA).some((number) => numbersB.has(number));

  const nameConflict = namesA.size > 0 && namesB.size > 0 && !namesOverlap;
  const numberConflict = numbersA.size > 0 && numbersB.size > 0 && !numbersOverlap;

  return {
    compatible: !nameConflict && !numberConflict,
    strongMatch: namesOverlap && numbersOverlap
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

function shouldMoveState(source: UserBookStateMoveRow, existing: UserBookStateMoveRow): boolean {
  const sourceHasProgress = stateHasProgress(source);
  const existingHasProgress = stateHasProgress(existing);
  if (sourceHasProgress !== existingHasProgress) return sourceHasProgress;
  return (source.last_modified_at ?? "") >= (existing.last_modified_at ?? "");
}

export function reconcileBookIdentities(db: Database.Database): void {
  const rows = db.prepare(`SELECT * FROM book_sources ORDER BY id`).all() as BookSourceRow[];
  if (rows.length === 0) {
    cleanupOrphanedImageCache(db);
    return;
  }
  const validBookIds = new Set(
    (db.prepare("SELECT id FROM books").all() as { id: number }[]).map((row) => row.id)
  );

  // Books that have at least one non-Chaptarr source are "canonical" — they were
  // resolved by Goodreads, Hardcover, or Grimmory and own their book record.
  // Used below to prevent Chaptarr-only groups from stealing or duplicating those books.
  const bookIdsReferencedByNonChaptarr = new Set(
    rows
      .filter((r) => r.source_type !== "chaptarr" && r.book_id !== null && validBookIds.has(r.book_id!))
      .map((r) => r.book_id!)
  );

  const uf = new UnionFind();
  const byHighKey = new Map<IdentityKey, number>();
  const byIsbnKey = new Map<IdentityKey, number[]>();
  const byFilePathKey = new Map<IdentityKey, number[]>();
  const highKeysByRow = new Map<number, Set<IdentityKey>>();

  for (const row of rows) {
    uf.add(row.id);
    const highKeys = highIdentityKeys(row);
    const isbnKeys = isbnIdentityKeys(row);
    const filePathKeys = filePathIdentityKeys(row);
    highKeysByRow.set(row.id, new Set(highKeys));

    for (const key of highKeys) {
      const existing = byHighKey.get(key);
      if (existing !== undefined) uf.union(existing, row.id);
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

  for (const ids of byIsbnKey.values()) {
    for (const id of ids.slice(1)) {
      const rootA = uf.find(ids[0]!);
      const rootB = uf.find(id);
      if (rootA === rootB) continue;
      const keysA = new Set(rows.filter((row) => uf.find(row.id) === rootA).flatMap((row) => Array.from(highKeysByRow.get(row.id) ?? [])));
      const keysB = new Set(rows.filter((row) => uf.find(row.id) === rootB).flatMap((row) => Array.from(highKeysByRow.get(row.id) ?? [])));
      // A shared ISBN is strong corroborating evidence, but a conflicting authoritative
      // ID (e.g. different Hardcover/Goodreads IDs) always blocks the merge — matching
      // titles must never override an explicit identifier conflict.
      if (highKeyConflict(keysA, keysB)) {
        logger.debug("Skipped ISBN-based book merge: conflicting authoritative identifiers", {
          rootA, rootB
        });
        continue;
      }
      uf.union(rootA, rootB);
    }
  }

  // A shared file path is only useful to bridge Grimmory/Audiobookshelf rows to the
  // global Chaptarr instance managing the same library — it is not proof on its own,
  // since two independent server instances can expose the same relative path for
  // unrelated books. Require no conflicting authoritative ID (like ISBN) AND, when
  // both sides have title/author data, that it doesn't explicitly disagree.
  for (const ids of byFilePathKey.values()) {
    for (const id of ids.slice(1)) {
      const rootA = uf.find(ids[0]!);
      const rootB = uf.find(id);
      if (rootA === rootB) continue;
      const keysA = new Set(rows.filter((row) => uf.find(row.id) === rootA).flatMap((row) => Array.from(highKeysByRow.get(row.id) ?? [])));
      const keysB = new Set(rows.filter((row) => uf.find(row.id) === rootB).flatMap((row) => Array.from(highKeysByRow.get(row.id) ?? [])));
      if (highKeyConflict(keysA, keysB)) {
        logger.debug("Skipped file-path book merge: conflicting authoritative identifiers", { rootA, rootB });
        continue;
      }

      const titleKeysA = groupTitleAuthorKeys(rows, uf, rootA);
      const titleKeysB = groupTitleAuthorKeys(rows, uf, rootB);
      const bothHaveTitles = titleKeysA.size > 0 && titleKeysB.size > 0;
      const titlesAgree = Array.from(titleKeysA).some((key) => titleKeysB.has(key));
      if (bothHaveTitles && !titlesAgree) {
        logger.debug("Skipped file-path book merge: conflicting title/author", { rootA, rootB });
        continue;
      }

      uf.union(rootA, rootB);
    }
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

      const keysA = new Set(rows.filter((r) => uf.find(r.id) === rootA).flatMap((r) => Array.from(highKeysByRow.get(r.id) ?? [])));
      const keysB = new Set(rows.filter((r) => uf.find(r.id) === rootB).flatMap((r) => Array.from(highKeysByRow.get(r.id) ?? [])));
      if (highKeyConflict(keysA, keysB)) {
        logger.debug("Skipped title/author book merge: conflicting authoritative identifiers", { rootA, rootB });
        continue;
      }

      const series = seriesMatchInfo(rows, uf, rootA, rootB);
      if (!series.compatible || !series.strongMatch) continue;

      uf.union(existing, row.id);
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

  const insertBook = db.prepare(`
    INSERT INTO books (
      media_type, title, author, cover_url, cover_cache_path, isbn13, isbn10,
      series_name, series_number, last_sync_at, last_modified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `);
  const updateBook = db.prepare(`
    UPDATE books SET
      media_type = ?, title = ?, author = ?, cover_url = ?, cover_cache_path = ?,
      isbn13 = ?, isbn10 = ?, series_name = ?, series_number = ?,
      last_sync_at = ?, last_modified_at = COALESCE(?, datetime('now'))
    WHERE id = ?
  `);
  const updateSource = db.prepare("UPDATE book_sources SET book_id = ? WHERE id = ?");
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
  const insertKey = db.prepare("INSERT OR IGNORE INTO book_identity_keys (book_id, key_type, key_value) VALUES (?, ?, ?)");

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
      } else {
        deleteUserState.run(state.id);
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

  const repairAudiobookshelfStates = (): void => {
    // Matched by (external_id AND instance) — a colliding local item id on a
    // different profile's ABS server must not move this profile's user state.
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
    `).all() as Array<UserBookStateMoveRow & { source_book_id: number }>;

    for (const row of rows) {
      repairLinkedState(row, "Audiobookshelf");
    }
  };

  const repairGrimmoryStates = (): void => {
    // Matched by (external_id AND instance) — a colliding local book id on a
    // different profile's Grimmory server must not move this profile's user state.
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
    `).all() as Array<UserBookStateMoveRow & { source_book_id: number }>;

    for (const row of rows) {
      repairLinkedState(row, "Grimmory");
    }
  };

  const claimedBookIds = new Set<number>();
  let created = 0;
  let reassigned = 0;
  let merged = 0;

  const transaction = db.transaction(() => {
    clearKeys.run();

    for (const group of groups.values()) {
      const isChaptarrOnly = group.every((r) => r.source_type === "chaptarr");

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
              if (row.book_id !== canonicalId) reassigned++;
              updateSource.run(canonicalId, row.id);
            }
            continue;
          }
        }
        const result = insertBook.run(
          values.mediaType, values.title, values.author, values.coverUrl, values.coverCachePath,
          values.isbn13, values.isbn10, values.seriesName, values.seriesNumber,
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
          if (row.book_id !== bookId) reassigned++;
          updateSource.run(bookId, row.id);
        }
        continue;
      } else {
        updateBook.run(
          values.mediaType, values.title, values.author, values.coverUrl, values.coverCachePath,
          values.isbn13, values.isbn10, values.seriesName, values.seriesNumber,
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
        if (row.book_id !== bookId) reassigned++;
        updateSource.run(bookId, row.id);
      }

      for (const key of new Set(group.flatMap((row) => [...highIdentityKeys(row), ...isbnIdentityKeys(row), ...filePathIdentityKeys(row)]))) {
        const [keyType, ...rest] = key.split(":");
        insertKey.run(bookId, keyType, rest.join(":"));
      }
    }

    // Clean up books that have no source rows
    const staleBooks = db.prepare(`
      SELECT b.id FROM books b
      LEFT JOIN book_sources bs ON bs.book_id = b.id
      WHERE bs.id IS NULL
    `).all() as { id: number }[];
    for (const stale of staleBooks) deleteBook.run(stale.id);

    repairAudiobookshelfStates();
    repairGrimmoryStates();
  });

  transaction();
  cleanupOrphanedImageCache(db);

  if (created > 0 || reassigned > 0 || merged > 0) {
    logger.info("Reconciled ShelfBridge book identities", { created, reassigned, merged, groups: groups.size });
  }
}
