import { getDb, getSetting } from "../db/index.js";
import { logger } from "../logger.js";
import { identifierVariants, normalizeExternalId } from "../identifiers.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchIntegration } from "../security/outbound.js";
import { stageFetchedIds, deleteOrphanedBooks } from "./pruning.js";

const DEFAULT_BOOKFILE_CONCURRENCY = 5;
const MAX_BOOKFILE_CONCURRENCY = 10;

function bookfileConcurrency(): number {
  const configured = Number(process.env["CHAPTARR_BOOKFILE_CONCURRENCY"] ?? DEFAULT_BOOKFILE_CONCURRENCY);
  return Number.isInteger(configured) && configured > 0
    ? Math.min(configured, MAX_BOOKFILE_CONCURRENCY)
    : DEFAULT_BOOKFILE_CONCURRENCY;
}

async function chaptarrGet<T>(baseUrl: string, apiKey: string, path: string): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const res = await fetchIntegration(url, {
    headers: { "X-Api-Key": apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chaptarr ${path} → ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export async function testChaptarrConnection(baseUrl: string, apiKey: string): Promise<{ ok: boolean; message: string }> {
  try {
    const status = await chaptarrGet<Record<string, unknown>>(baseUrl, apiKey, "/api/v1/system/status");
    const appName = String(status["appName"] ?? status["instanceName"] ?? "Chaptarr");
    const version = String(status["version"] ?? "?");
    return { ok: true, message: `Connected to ${appName} v${version}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function stripSubtitle(title: string): string {
  return title.split(/:|\s+-\s+/)[0].trim();
}

function comparableTitle(title: string): string {
  return normalise(stripSubtitle(title).replace(/\s*\([^)]*\)\s*/g, " "));
}

function cleanIdentifier(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text || null;
}

function setIdentifierLookup(index: Map<string, number>, value: string | number | null | undefined, bookId: number): void {
  for (const id of identifierVariants(value)) index.set(id, bookId);
}

function getIdentifierLookup(index: Map<string, number>, value: string | number | null | undefined): number | undefined {
  const normalized = normalizeExternalId(value);
  return normalized ? index.get(normalized) : undefined;
}

/**
 * A Hardcover work ID can deliberately be shared by distinct local media
 * identities (for example, an ebook and its audiobook). A path match keeps
 * those canonicals separate, so seeing the same upstream ID on both is not an
 * ID mismatch by itself.
 */
export function hasKnownHardcoverIdentity(
  hardcoverIdsByBookId: ReadonlyMap<number, ReadonlySet<string>>,
  bookId: number,
  candidateId: string | number | null | undefined
): boolean {
  const normalized = normalizeExternalId(candidateId);
  return normalized !== null && hardcoverIdsByBookId.get(bookId)?.has(normalized) === true;
}

function stripPrefix(value: string | null, prefix: string): string | null {
  if (!value) return null;
  return value.toLowerCase().startsWith(prefix) ? value.slice(prefix.length) : value;
}

function cleanGoodreadsEditionId(value: string | null): string | null {
  const withoutPrefix = stripPrefix(value, "gr:");
  return withoutPrefix?.replace(/-[a-z]+$/i, "") ?? null;
}

function parseChaptarrSeriesTitle(value: string | null): { name: string | null; number: string | null } {
  if (!value) return { name: null, number: null };
  const match = value.match(/^(.*?)\s+#\s*(\d+(?:\.\d+)?)\s*$/);
  if (!match) return { name: value, number: null };
  return {
    name: match[1]?.trim() || value,
    number: match[2]?.trim() || null
  };
}

function stringField(record: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return null;
}

function inferChaptarrMediaType(book: Record<string, unknown>, filePath: string | null): "physical" | "ebook" | "audiobook" | null {
  const raw = String(book["mediaType"] ?? "").trim().toLowerCase();
  if (raw === "audiobook" || book["audiobookMonitored"] === true) return "audiobook";
  if (raw === "ebook" || book["ebookMonitored"] === true) return "ebook";

  const path = filePath?.toLowerCase() ?? "";
  if (path.endsWith(".m4b") || path.endsWith(".mp3") || path.endsWith(".m4a") || path.includes("/audiobook")) return "audiobook";
  if (path.endsWith(".epub") || path.endsWith(".mobi") || path.endsWith(".azw3") || path.endsWith(".pdf")) return "ebook";
  return null;
}

function chaptarrSeries(book: Record<string, unknown>): { name: string | null; number: string | null } {
  const seriesObj = book["series"] as Record<string, unknown> | undefined;
  const rawName = stringField(book, ["seriesTitle", "seriesName", "series"])
    ?? stringField(seriesObj, ["title", "name"]);
  const rawNumber = stringField(book, ["seriesPosition", "seriesNumber", "positionInSeries"])
    ?? stringField(seriesObj, ["position", "seriesNumber"]);
  const parsed = parseChaptarrSeriesTitle(rawName);

  return {
    name: parsed.name,
    number: rawNumber ?? parsed.number
  };
}

function chaptarrBookHasFile(book: Record<string, unknown>, filePaths: string[] = []): boolean {
  const stats = book["statistics"] as Record<string, unknown> | undefined;
  return book["hasFiles"] === true
    || Number(stats?.["bookFileCount"] ?? 0) > 0
    || filePaths.length > 0;
}

// ── Live sync pass ────────────────────────────────────────────────────────────

/**
 * Fetches the current Chaptarr library and writes chaptarr status fields into
 * matching book_sources rows (type='chaptarr'). Creates new chaptarr book_sources
 * rows for matched books that don't have one yet. Also promotes 'missing'
 * Grimmory user_book_states to 'pending_download' when Chaptarr has the book
 * monitored but the file hasn't landed yet.
 *
 * Matching is done against the book-level book_sources table (not per-profile).
 * A Chaptarr book matching any known ShelfBridge book will be recorded once,
 * regardless of how many profiles use that book.
 *
 * Returns the ids of every book_sources row this pass wrote (created or
 * updated), so the caller can reconcile identities scoped to just those rows
 * instead of the whole catalog — chaptarr.ts's own matching (above) resolves
 * a book_id directly from simpler identifier lookups, but reconcileBookIdentities'
 * union-find still needs to run over these rows to apply its stronger
 * conflict/file-path-bridge checks (e.g. an ebook/audiobook split).
 */
export async function syncChaptarrStatus(profileId: number): Promise<number[]> {
  const baseUrl = getSetting("chaptarr.baseUrl", "");
  const apiKey = getSetting("chaptarr.apiKey", "");

  if (!baseUrl || !apiKey) {
    logger.info("Chaptarr not configured, skipping status pass", { profileId });
    return [];
  }

  const db = getDb();

  logger.info("Chaptarr status pass started", { profileId });

  let allBooks: Record<string, unknown>[] = [];
  try {
    allBooks = await chaptarrGet<Record<string, unknown>[]>(baseUrl, apiKey, "/api/v1/book");
    const monitored = allBooks.filter((book) => book["monitored"] === true).length;
    logger.info("Chaptarr books fetched", { profileId, total: allBooks.length, monitored });
  } catch (err) {
    logger.warn("Chaptarr books fetch failed; skipping status pass", { profileId, error: err });
    return [];
  }

  const authorNameById = new Map<number, string>();
  // chaptarrBookId → on-disk file paths (from /api/v1/bookfile, fetched per author in parallel)
  const chaptarrFilePathsByBookId = new Map<number, string[]>();
  // authors whose /api/v1/bookfile request failed: their books' file-path inventory is
  // incomplete, not empty, so a missing entry there must not be read as "no file".
  const uncertainFileInventoryAuthorIds = new Set<number>();
  try {
    const authors = await chaptarrGet<Record<string, unknown>[]>(baseUrl, apiKey, "/api/v1/author");
    const returnedAuthorIds = new Set<number>();
    for (const a of authors) {
      const id = typeof a["id"] === "number" ? a["id"] : Number(a["id"]);
      const name = String(a["authorName"] ?? a["name"] ?? "");
      if (!Number.isInteger(id) || id <= 0) continue;
      returnedAuthorIds.add(id);
      if (name) authorNameById.set(id, name);
    }

    // Fetch book file paths with a bounded pool (one request per author).
    // Both Chaptarr and Grimmory point at the same NAS share, so matching paths
    // are an unambiguous identity signal for books that failed ID/ISBN/title matching.
    const authorIds = [...returnedAuthorIds];
    for (const book of allBooks) {
      const authorId = typeof book["authorId"] === "number" ? book["authorId"] : Number(book["authorId"] ?? 0);
      if (authorId && !returnedAuthorIds.has(authorId)) uncertainFileInventoryAuthorIds.add(authorId);
    }
    const bookfileResults = await mapWithConcurrency(
      authorIds,
      bookfileConcurrency(),
      async (authorId) =>
        chaptarrGet<Record<string, unknown>[]>(baseUrl, apiKey, `/api/v1/bookfile?authorId=${authorId}`)
          .catch((error) => {
            uncertainFileInventoryAuthorIds.add(authorId);
            logger.warn("Chaptarr bookfile fetch failed; preserving prior file state", { profileId, authorId, error });
            return [] as Record<string, unknown>[];
          })
    );
    for (const files of bookfileResults) {
      for (const f of files) {
        const bookId = typeof f["bookId"] === "number" ? f["bookId"] : Number(f["bookId"]);
        const filePath = String(f["path"] ?? "").trim();
        if (bookId && filePath) {
          const paths = chaptarrFilePathsByBookId.get(bookId) ?? [];
          if (!paths.includes(filePath)) paths.push(filePath);
          chaptarrFilePathsByBookId.set(bookId, paths);
        }
      }
    }
    const filePathCount = Array.from(chaptarrFilePathsByBookId.values()).reduce((total, paths) => total + paths.length, 0);
    logger.info("Chaptarr book file paths fetched", { profileId, count: filePathCount, booksWithFiles: chaptarrFilePathsByBookId.size });
  } catch (error) {
    logger.warn("Chaptarr file inventory discovery failed; preserving prior file state", { profileId, error });
    for (const book of allBooks) {
      const authorId = typeof book["authorId"] === "number" ? book["authorId"] : Number(book["authorId"] ?? 0);
      if (authorId) uncertainFileInventoryAuthorIds.add(authorId);
    }
  }

  // Previously recorded hasFile state, keyed by Chaptarr book id. Used to avoid
  // downgrading a book to "no file" when this run's file-path inventory for its
  // author is incomplete rather than genuinely empty.
  const previousHasFileByChaptarrId = new Map<string, boolean>();
  for (const row of db.prepare(
    "SELECT external_id, chaptarr_has_file FROM book_sources WHERE source_type = 'chaptarr'"
  ).all() as { external_id: string; chaptarr_has_file: number }[]) {
    previousHasFileByChaptarrId.set(row.external_id, row.chaptarr_has_file === 1);
  }

  function resolveChaptarrHasFile(book: Record<string, unknown>, filePaths: string[]): boolean {
    if (chaptarrBookHasFile(book, filePaths)) return true;
    const authorId = typeof book["authorId"] === "number" ? book["authorId"] : Number(book["authorId"] ?? 0);
    if (!uncertainFileInventoryAuthorIds.has(authorId)) return false;
    const chaptarrId = typeof book["id"] === "number" ? book["id"] : Number(book["id"]);
    return previousHasFileByChaptarrId.get(String(chaptarrId)) ?? false;
  }

  // Chaptarr exposes unmonitored catalogue entries for known authors. Ignore
  // those unless they own an imported file: a downloaded book remains present
  // in Chaptarr even if an automation or metadata refresh unmonitors it.
  const books = allBooks.filter((book) => {
    const chaptarrId = typeof book["id"] === "number" ? book["id"] : Number(book["id"]);
    return book["monitored"] === true
      || resolveChaptarrHasFile(book, chaptarrFilePathsByBookId.get(chaptarrId) ?? []);
  });
  logger.info("Chaptarr active books selected", {
    profileId,
    count: books.length,
    monitored: books.filter((book) => book["monitored"] === true).length,
    fileBacked: books.filter((book) => {
      const chaptarrId = typeof book["id"] === "number" ? book["id"] : Number(book["id"]);
      return resolveChaptarrHasFile(book, chaptarrFilePathsByBookId.get(chaptarrId) ?? []);
    }).length
  });

  // Load book_sources rows to build lookup indexes (book-level, not per-profile)
  type SourceRow = {
    book_id: number;
    hardcover_book_id: string | null;
    hardcover_slug: string | null;
    goodreads_book_id: string | null;
    grimmory_hardcover_book_id: string | null;
    grimmory_goodreads_id: string | null;
    source_hardcover_book_id: string | null;
    source_hardcover_slug: string | null;
    source_goodreads_book_id: string | null;
    source_goodreads_work_id: string | null;
    source_goodreads_edition_id: string | null;
    grimmory_primary_file_path: string | null;
    isbn13: string | null;
    isbn10: string | null;
    title: string | null;
    author: string | null;
  };
  const rows = db.prepare(`
    SELECT
      b.id AS book_id,
      b.title,
      b.author,
      b.isbn13,
      b.isbn10,
      hc_src.external_id   AS hardcover_book_id,
      hc_src.hardcover_slug,
      gr_src.external_id   AS goodreads_book_id,
      grim_src.grimmory_hardcover_book_id,
      grim_src.grimmory_goodreads_id,
      COALESCE(hc_src.source_hardcover_book_id, grim_src.source_hardcover_book_id, gr_src.source_hardcover_book_id) AS source_hardcover_book_id,
      COALESCE(hc_src.source_hardcover_slug, grim_src.source_hardcover_slug, gr_src.source_hardcover_slug) AS source_hardcover_slug,
      COALESCE(hc_src.source_goodreads_book_id, grim_src.source_goodreads_book_id, gr_src.source_goodreads_book_id) AS source_goodreads_book_id,
      COALESCE(hc_src.source_goodreads_work_id, grim_src.source_goodreads_work_id, gr_src.source_goodreads_work_id) AS source_goodreads_work_id,
      COALESCE(hc_src.source_goodreads_edition_id, grim_src.source_goodreads_edition_id, gr_src.source_goodreads_edition_id) AS source_goodreads_edition_id,
      grim_src.grimmory_primary_file_path
    FROM books b
    LEFT JOIN book_sources hc_src   ON hc_src.book_id   = b.id AND hc_src.source_type   = 'hardcover'
    LEFT JOIN book_sources gr_src   ON gr_src.book_id   = b.id AND gr_src.source_type   = 'goodreads'
    LEFT JOIN book_sources grim_src ON grim_src.book_id = b.id AND grim_src.source_type = 'grimmory'
  `).all() as SourceRow[];

  const byHardcoverId = new Map<string, number>();
  const byGoodreadsId = new Map<string, number>();
  const byHardcoverSlug = new Map<string, number>();
  const byIsbn13 = new Map<string, number>();
  const byIsbn10 = new Map<string, number>();
  const byTitleAuthor = new Map<string, number>();
  const byRelaxedTitle = new Map<string, number>();
  const byGrimmoryFilePath = new Map<string, number | null>();
  const titleByBookId = new Map<number, string>();
  const hardcoverIdsByBookId = new Map<number, Set<string>>();

  for (const row of rows) {
    if (row.title) titleByBookId.set(row.book_id, row.title);
    setIdentifierLookup(byHardcoverId, row.hardcover_book_id, row.book_id);
    setIdentifierLookup(byHardcoverId, row.grimmory_hardcover_book_id, row.book_id);
    setIdentifierLookup(byHardcoverId, row.source_hardcover_book_id, row.book_id);
    const knownHardcoverIds = hardcoverIdsByBookId.get(row.book_id) ?? new Set<string>();
    for (const value of [row.hardcover_book_id, row.grimmory_hardcover_book_id, row.source_hardcover_book_id]) {
      for (const identifier of identifierVariants(value)) knownHardcoverIds.add(identifier);
    }
    hardcoverIdsByBookId.set(row.book_id, knownHardcoverIds);
    if (row.hardcover_slug) byHardcoverSlug.set(row.hardcover_slug.toLowerCase(), row.book_id);
    if (row.source_hardcover_slug) byHardcoverSlug.set(row.source_hardcover_slug.toLowerCase(), row.book_id);
    setIdentifierLookup(byGoodreadsId, row.goodreads_book_id, row.book_id);
    setIdentifierLookup(byGoodreadsId, row.grimmory_goodreads_id, row.book_id);
    setIdentifierLookup(byGoodreadsId, row.source_goodreads_book_id, row.book_id);
    setIdentifierLookup(byGoodreadsId, row.source_goodreads_work_id, row.book_id);
    setIdentifierLookup(byGoodreadsId, row.source_goodreads_edition_id, row.book_id);
    if (row.isbn13) byIsbn13.set(row.isbn13.replace(/[^0-9X]/g, ""), row.book_id);
    if (row.isbn10) byIsbn10.set(row.isbn10.replace(/[^0-9X]/g, ""), row.book_id);
    if (row.grimmory_primary_file_path) {
      const filePath = row.grimmory_primary_file_path.trim();
      const existing = byGrimmoryFilePath.get(filePath);
      byGrimmoryFilePath.set(filePath, existing === undefined || existing === row.book_id ? row.book_id : null);
    }
    if (row.title && row.author) {
      byTitleAuthor.set(`${normalise(row.title)}|${normalise(row.author)}`, row.book_id);
      byRelaxedTitle.set(`${normalise(stripSubtitle(row.title))}|${normalise(row.author)}`, row.book_id);
    }
  }

  // Validates that a candidate book's title matches the Chaptarr book's title.
  // Chaptarr sometimes stores wrong IDs (metadata resolution failures). Checking
  // the title prevents cross-book contamination when IDs are unreliable.
  function titleMatchesBook(chaptarrTitle: string, candidateBookId: number): boolean {
    const dbTitle = titleByBookId.get(candidateBookId);
    if (!dbTitle) return false;
    const normChaptarr = comparableTitle(chaptarrTitle);
    const normDb = comparableTitle(dbTitle);
    return normChaptarr === normDb || normChaptarr.includes(normDb) || normDb.includes(normChaptarr);
  }

  // Chaptarr is a single global connection (not configured per profile), so it always
  // uses a fixed source_instance_id of 0 — see schema.ts v14 migration.
  const upsertChaptarrSource = db.prepare(`
    INSERT INTO book_sources (
      book_id, source_type, source_instance_id, external_id, title, author, series_name, series_number,
      source_hardcover_book_id, source_goodreads_book_id, source_goodreads_work_id,
      source_goodreads_edition_id, source_edition_id, source_media_type, source_edition_format,
      source_narrator, source_asin, source_audible_asin,
      chaptarr_monitored, chaptarr_has_file, chaptarr_id_mismatch, chaptarr_primary_file_path,
      last_sync_at, last_modified_at
    )
    VALUES (?, 'chaptarr', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(source_type, source_instance_id, external_id) DO UPDATE SET
      book_id                    = excluded.book_id,
      title                      = excluded.title,
      author                     = excluded.author,
      series_name                = excluded.series_name,
      series_number              = excluded.series_number,
      source_hardcover_book_id   = excluded.source_hardcover_book_id,
      source_goodreads_book_id   = excluded.source_goodreads_book_id,
      source_goodreads_work_id   = excluded.source_goodreads_work_id,
      source_goodreads_edition_id = excluded.source_goodreads_edition_id,
      source_edition_id          = excluded.source_edition_id,
      source_media_type          = excluded.source_media_type,
      source_edition_format      = excluded.source_edition_format,
      source_narrator            = excluded.source_narrator,
      source_asin                = excluded.source_asin,
      source_audible_asin        = excluded.source_audible_asin,
      chaptarr_monitored         = excluded.chaptarr_monitored,
      chaptarr_has_file          = excluded.chaptarr_has_file,
      chaptarr_id_mismatch       = excluded.chaptarr_id_mismatch,
      chaptarr_primary_file_path = excluded.chaptarr_primary_file_path,
      last_sync_at               = excluded.last_sync_at,
      last_modified_at = CASE WHEN
        book_id IS NOT excluded.book_id
        OR title IS NOT excluded.title
        OR author IS NOT excluded.author
        OR series_name IS NOT excluded.series_name
        OR series_number IS NOT excluded.series_number
        OR source_hardcover_book_id IS NOT excluded.source_hardcover_book_id
        OR source_goodreads_book_id IS NOT excluded.source_goodreads_book_id
        OR source_goodreads_work_id IS NOT excluded.source_goodreads_work_id
        OR source_goodreads_edition_id IS NOT excluded.source_goodreads_edition_id
        OR source_edition_id IS NOT excluded.source_edition_id
        OR source_media_type IS NOT excluded.source_media_type
        OR source_edition_format IS NOT excluded.source_edition_format
        OR source_narrator IS NOT excluded.source_narrator
        OR source_asin IS NOT excluded.source_asin
        OR source_audible_asin IS NOT excluded.source_audible_asin
        OR chaptarr_monitored IS NOT excluded.chaptarr_monitored
        OR chaptarr_has_file IS NOT excluded.chaptarr_has_file
        OR chaptarr_id_mismatch IS NOT excluded.chaptarr_id_mismatch
        OR chaptarr_primary_file_path IS NOT excluded.chaptarr_primary_file_path
      THEN datetime('now') ELSE last_modified_at END
    RETURNING id
  `);

  const matchedChaptarrIds = new Set<string>();
  const touchedSourceIds: number[] = [];
  let matched = 0;
  let unmatched = 0;

  for (const book of books) {
    const chaptarrId = typeof book["id"] === "number" ? book["id"] : Number(book["id"]);
    const monitored = book["monitored"] === true ? 1 : 0;
    const chaptarrFilePaths = chaptarrFilePathsByBookId.get(chaptarrId) ?? [];
    const hasFile = resolveChaptarrHasFile(book, chaptarrFilePaths) ? 1 : 0;

    const hardcoverBookIdRaw = cleanIdentifier(book["hardcoverBookId"] ?? book["baseBookId"]);
    const hardcoverBookId = hardcoverBookIdRaw?.startsWith("gr:") ? "" : stripPrefix(hardcoverBookIdRaw, "hc:") ?? "";
    const foreignBookIdRaw = cleanIdentifier(book["foreignBookId"]);
    const foreignBookId = foreignBookIdRaw?.startsWith("gr:") ? "" : stripPrefix(foreignBookIdRaw, "hc:") ?? "";
    const foreignBookIdAsGoodreads = foreignBookIdRaw?.startsWith("gr:") ? foreignBookIdRaw.slice(3) : "";
    const goodreadsBookId = stripPrefix(cleanIdentifier(book["goodreadsBookId"]), "gr:");
    const goodreadsWorkId = stripPrefix(cleanIdentifier(book["goodreadsWorkId"]), "gr:") ?? "";
    const foreignEditionIdRaw = cleanIdentifier(book["foreignEditionId"]);
    const goodreadsEditionId = cleanGoodreadsEditionId(foreignEditionIdRaw) ?? "";
    const asin = cleanIdentifier(book["asin"]);
    const audibleAsin = cleanIdentifier(book["audibleASIN"]);
    const titleSlug = String(book["titleSlug"] ?? "");
    const title = String(book["title"] ?? "");
    const authorObj = book["author"] as Record<string, unknown> | undefined;
    const authorId = typeof book["authorId"] === "number" ? book["authorId"] : Number(book["authorId"] ?? 0);
    const authorName = String(
      book["authorName"] ?? authorObj?.["authorName"] ?? authorObj?.["name"] ?? authorObj?.["sortName"]
      ?? (authorId ? authorNameById.get(authorId) : undefined) ?? ""
    );
    const editions = Array.isArray(book["editions"]) ? book["editions"] as Record<string, unknown>[] : [];
    const isbn13s = editions.map((e) => String(e["isbn13"] ?? e["Isbn13"] ?? "").replace(/[^0-9X]/g, "")).filter(Boolean);
    const isbn10s = editions.map((e) => String(e["isbn"] ?? e["isbn10"] ?? e["Isbn"] ?? "").replace(/[^0-9X]/g, "")).filter(Boolean);
    const series = chaptarrSeries(book);

    let bookId: number | undefined;
    let rejectedIdCandidate: number | undefined;
    const titleValidatedIdCandidates = new Map<number, string>();

    // Preserve the mismatch signal even when the local path wins matching. The
    // path is authoritative for canonical assignment, but a stale Chaptarr
    // Hardcover ID still needs to be surfaced for review.
    for (const [label, candidateId] of [["hardcoverBookId", hardcoverBookId], ["foreignBookId", foreignBookId]] as const) {
      if (!candidateId) continue;
      const candidate = getIdentifierLookup(byHardcoverId, candidateId);
      if (candidate !== undefined && titleMatchesBook(title, candidate)) {
        titleValidatedIdCandidates.set(candidate, candidateId);
      } else if (candidate !== undefined) {
        rejectedIdCandidate ??= candidate;
        logger.info("Chaptarr upstream ID match rejected: title mismatch", {
          profileId, chaptarrId, label, chaptarrTitle: title, candidateId,
          matchedTitle: titleByBookId.get(candidate) ?? null,
        });
      }
    }

    // An exact NAS path identifies the actual local file and therefore takes
    // precedence over Chaptarr's upstream IDs. Those IDs can point at a shared
    // work whose ebook and audiobook canonicals are distinct.
    const filePathCandidates = new Set(
      chaptarrFilePaths.map((path) => byGrimmoryFilePath.get(path)).filter((id): id is number => id !== undefined && id !== null)
    );
    const matchedFilePath = filePathCandidates.size === 1
      ? chaptarrFilePaths.find((path) => byGrimmoryFilePath.get(path) === [...filePathCandidates][0])
      : undefined;
    bookId = filePathCandidates.size === 1 ? [...filePathCandidates][0] : undefined;
    if (filePathCandidates.size > 1) {
      logger.warn("Chaptarr book has file paths mapped to conflicting canonicals; falling back to identifiers", {
        profileId, chaptarrId, title, candidateBookIds: [...filePathCandidates]
      });
    }
    if (bookId !== undefined) {
      logger.info("Chaptarr book matched via file path", { profileId, chaptarrId, title, filePath: matchedFilePath });
      const conflictingIdCandidate = [...titleValidatedIdCandidates]
        .find(([candidate, candidateId]) => candidate !== bookId && !hasKnownHardcoverIdentity(hardcoverIdsByBookId, bookId!, candidateId))
        ?.[0];
      if (conflictingIdCandidate !== undefined) {
        // Path remains the assignment authority: it distinguishes local ebook
        // and audiobook siblings. Mark any independently title-validated ID
        // disagreement so a stale path or stale upstream metadata is reviewable.
        rejectedIdCandidate ??= conflictingIdCandidate;
        logger.warn("Chaptarr file-path match conflicts with a title-validated upstream ID", {
          profileId, chaptarrId, bookId, idCandidateBookId: conflictingIdCandidate, filePath: matchedFilePath
        });
      }
    }

    if (!bookId && hardcoverBookId) {
      const candidate = getIdentifierLookup(byHardcoverId, hardcoverBookId);
      if (candidate !== undefined && titleMatchesBook(title, candidate)) {
        bookId = candidate;
      } else if (candidate !== undefined) {
        rejectedIdCandidate ??= candidate;
        logger.info("Chaptarr hardcoverBookId match rejected: title mismatch", {
          profileId, chaptarrId, chaptarrTitle: title, hardcoverBookId,
          matchedTitle: titleByBookId.get(candidate) ?? null,
        });
      }
    }
    if (!bookId && foreignBookId) {
      const candidate = getIdentifierLookup(byHardcoverId, foreignBookId);
      if (candidate !== undefined && titleMatchesBook(title, candidate)) {
        bookId = candidate;
      } else if (candidate !== undefined && !rejectedIdCandidate) {
        rejectedIdCandidate = candidate;
      }
    }
    if (!bookId && goodreadsBookId) bookId = getIdentifierLookup(byGoodreadsId, goodreadsBookId);
    if (!bookId && goodreadsWorkId) bookId = getIdentifierLookup(byGoodreadsId, goodreadsWorkId);
    if (!bookId && goodreadsEditionId) bookId = getIdentifierLookup(byGoodreadsId, goodreadsEditionId);
    if (!bookId && foreignBookIdAsGoodreads) bookId = getIdentifierLookup(byGoodreadsId, foreignBookIdAsGoodreads);
    if (!bookId && titleSlug) bookId = byHardcoverSlug.get(titleSlug.toLowerCase());
    for (const isbn of isbn13s) { if (!bookId) bookId = byIsbn13.get(isbn); }
    for (const isbn of isbn10s) { if (!bookId) bookId = byIsbn10.get(isbn); }

    if (!bookId && title && authorName) bookId = byTitleAuthor.get(`${normalise(title)}|${normalise(authorName)}`);
    if (!bookId && title && authorName) bookId = byRelaxedTitle.get(`${normalise(stripSubtitle(title))}|${normalise(authorName)}`);
    // titleSlug is derived from the book's canonical title before Chaptarr overwrites the display
    // title via metadata refresh. Normalising it recovers matches when the display title diverges
    // (e.g. Chaptarr shows "Number 10 Affair" but slug "no.-10-affair" maps back to "No. 10 Affair").
    if (!bookId && titleSlug && authorName) {
      const slugAsTitle = titleSlug.replace(/-/g, " ");
      bookId = byTitleAuthor.get(`${normalise(slugAsTitle)}|${normalise(authorName)}`);
      if (!bookId) bookId = byRelaxedTitle.get(`${normalise(stripSubtitle(slugAsTitle))}|${normalise(authorName)}`);
      if (bookId !== undefined) {
        logger.info("Chaptarr book matched via titleSlug normalisation", { profileId, chaptarrId, title, titleSlug, authorName });
      }
    }

    const idMismatch = rejectedIdCandidate !== undefined && rejectedIdCandidate !== bookId ? 1 : 0;
    const chaptarrFilePath = bookId !== undefined
      ? chaptarrFilePaths.find((path) => byGrimmoryFilePath.get(path) === bookId) ?? chaptarrFilePaths[0] ?? null
      : chaptarrFilePaths[0] ?? null;
    const mediaType = inferChaptarrMediaType(book, chaptarrFilePath);

    if (bookId !== undefined) {
      const written = upsertChaptarrSource.get(
        bookId, String(chaptarrId), title || null, authorName || null, series.name, series.number,
        hardcoverBookId || foreignBookId || null,
        goodreadsBookId || foreignBookIdAsGoodreads || null,
        goodreadsWorkId || null,
        goodreadsEditionId || null,
        foreignEditionIdRaw,
        mediaType,
        mediaType === "audiobook" ? "Audiobook" : mediaType === "ebook" ? "Ebook" : null,
        cleanIdentifier(book["narrator"]),
        asin,
        audibleAsin,
        monitored, hasFile, idMismatch, chaptarrFilePath
      ) as { id: number };
      touchedSourceIds.push(written.id);
      matchedChaptarrIds.add(String(chaptarrId));
      matched++;
    } else {
      unmatched++;
      logger.info("Chaptarr book unmatched in book_sources", {
        profileId, chaptarrId, title, authorName,
        hasFilePath: chaptarrFilePath !== null,
      });
    }
  }

  // Clear Chaptarr book_sources rows for books no longer present in Chaptarr.
  // Staged into a temp table rather than an inline NOT IN (...) list, which
  // could otherwise exceed SQLite's bound-parameter limit for a large library.
  if (matchedChaptarrIds.size > 0) {
    stageFetchedIds(db, matchedChaptarrIds);
    const staleBookIds = (db.prepare(`
      SELECT DISTINCT book_id FROM book_sources
      WHERE source_type = 'chaptarr' AND external_id NOT IN (SELECT id FROM shelfbridge_fetched_ids) AND book_id IS NOT NULL
    `).all() as { book_id: number }[]).map((row) => row.book_id);
    db.prepare(`
      DELETE FROM book_sources
      WHERE source_type = 'chaptarr' AND external_id NOT IN (SELECT id FROM shelfbridge_fetched_ids)
    `).run();
    deleteOrphanedBooks(db, staleBookIds);
  } else {
    const staleBookIds = (db.prepare(`
      SELECT DISTINCT book_id FROM book_sources WHERE source_type = 'chaptarr' AND book_id IS NOT NULL
    `).all() as { book_id: number }[]).map((row) => row.book_id);
    db.prepare("DELETE FROM book_sources WHERE source_type = 'chaptarr'").run();
    deleteOrphanedBooks(db, staleBookIds);
  }

  // Promote 'missing' Grimmory user_book_states to 'pending_download' when Chaptarr
  // has the book monitored but the file hasn't arrived yet
  db.prepare(`
    UPDATE user_book_states SET sync_health = 'pending_download', last_modified_at = datetime('now')
    WHERE source_type = 'grimmory'
      AND sync_health = 'missing'
      AND EXISTS (
        SELECT 1 FROM book_sources cs
        WHERE cs.book_id = user_book_states.book_id
          AND cs.source_type = 'chaptarr'
          AND cs.chaptarr_monitored = 1
          AND cs.chaptarr_has_file = 0
      )
  `).run();

  // Revert pending_download back to 'missing' once the file has landed (Grimmory hasn't
  // picked it up yet — the next full sync will resolve it)
  db.prepare(`
    UPDATE user_book_states SET sync_health = 'missing', last_modified_at = datetime('now')
    WHERE source_type = 'grimmory'
      AND sync_health = 'pending_download'
      AND NOT EXISTS (
        SELECT 1 FROM book_sources cs
        WHERE cs.book_id = user_book_states.book_id
          AND cs.source_type = 'chaptarr'
          AND cs.chaptarr_monitored = 1
          AND cs.chaptarr_has_file = 0
      )
  `).run();

  logger.info("Chaptarr status pass complete", { profileId, matched, unmatched });
  return touchedSourceIds;
}
