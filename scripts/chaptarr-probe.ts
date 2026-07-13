/**
 * Chaptarr API Probe Script
 *
 * Dumps every identifier-bearing field from the Chaptarr API, then attempts
 * to match each book against ShelfBridge's existing book_links table so we can
 * decide how to do the integration.
 *
 * Usage:
 *   CHAPTARR_URL=http://chaptarr:8787 CHAPTARR_API_KEY=xxx npx tsx scripts/chaptarr-probe.ts
 *
 * Optional:
 *   SHELFBRIDGE_DB=/config/shelfbridge.db   (default: /config/shelfbridge.db)
 *   DUMP_RAW=1                              (print full raw JSON responses)
 */

import Database from "better-sqlite3";
import fs from "fs";

const CHAPTARR_URL = process.env.CHAPTARR_URL?.replace(/\/$/, "");
const CHAPTARR_API_KEY = process.env.CHAPTARR_API_KEY;
const DB_PATH = process.env.SHELFBRIDGE_DB ?? "/config/shelfbridge.db";
const DUMP_RAW = process.env.DUMP_RAW === "1";

if (!CHAPTARR_URL || !CHAPTARR_API_KEY) {
  console.error("Required: CHAPTARR_URL and CHAPTARR_API_KEY env vars");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function apiGet<T>(path: string): Promise<T> {
  const url = `${CHAPTARR_URL}${path}`;
  const res = await fetch(url, {
    headers: { "X-Api-Key": CHAPTARR_API_KEY! },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${path} → ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Utility: recursively extract anything that looks like an identifier field
// ---------------------------------------------------------------------------

function extractIdentifiers(obj: unknown, prefix = ""): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (obj === null || obj === undefined) return result;

  const ID_KEYWORDS = [
    "id", "foreignid", "foreignbookid", "foreignauthorid", "foreigneditionid",
    "hardcover", "goodreads", "isbn", "asin", "grid", "slug", "titleslug",
    "authorslug", "link", "url", "externalid",
  ];

  if (typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = k.toLowerCase();
      const fullKey = prefix ? `${prefix}.${k}` : k;

      // Always recurse into nested objects (non-array)
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        Object.assign(result, extractIdentifiers(v, fullKey));
      } else if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
        // Only recurse into first element of object arrays for brevity
        Object.assign(result, extractIdentifiers(v[0], `${fullKey}[0]`));
      } else if (ID_KEYWORDS.some((kw) => key.includes(kw)) && v !== null && v !== "" && v !== 0) {
        result[fullKey] = v;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Normalise title/author for fuzzy matching
// ---------------------------------------------------------------------------

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripSubtitle(title: string): string {
  return title.split(/:|\s+-\s+/)[0].trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(70));
  console.log("Chaptarr API Probe");
  console.log(`URL : ${CHAPTARR_URL}`);
  console.log(`DB  : ${DB_PATH}`);
  console.log("=".repeat(70));

  // -- 1. System status ------------------------------------------------------
  console.log("\n[1/5] System status...");
  try {
    const status = await apiGet<Record<string, unknown>>("/api/v1/system/status");
    console.log(`  appName    : ${status.appName ?? "n/a"}`);
    console.log(`  version    : ${status.version ?? "n/a"}`);
    console.log(`  instanceName: ${status.instanceName ?? "n/a"}`);
    const allKeys = Object.keys(status);
    console.log(`  All fields : ${allKeys.join(", ")}`);
  } catch (e) {
    console.warn(`  WARNING: ${(e as Error).message}`);
  }

  // -- 2. Fetch all books ----------------------------------------------------
  console.log("\n[2/5] Fetching all books (GET /api/v1/book)...");
  let books: Record<string, unknown>[] = [];
  try {
    books = await apiGet<Record<string, unknown>[]>("/api/v1/book");
    console.log(`  Total books: ${books.length}`);
    if (DUMP_RAW && books.length > 0) {
      console.log("\n  === RAW first book ===");
      console.log(JSON.stringify(books[0], null, 2));
      console.log("  === END RAW ===\n");
    }
  } catch (e) {
    console.error(`  ERROR: ${(e as Error).message}`);
  }

  // -- 3. Fetch all authors --------------------------------------------------
  console.log("\n[3/5] Fetching all authors (GET /api/v1/author)...");
  let authors: Record<string, unknown>[] = [];
  try {
    authors = await apiGet<Record<string, unknown>[]>("/api/v1/author");
    console.log(`  Total authors: ${authors.length}`);
    if (DUMP_RAW && authors.length > 0) {
      console.log("\n  === RAW first author ===");
      console.log(JSON.stringify(authors[0], null, 2));
      console.log("  === END RAW ===\n");
    }
  } catch (e) {
    console.error(`  ERROR: ${(e as Error).message}`);
  }

  // -- 4. Fetch book files ---------------------------------------------------
  console.log("\n[4/5] Fetching book files (GET /api/v1/bookfile)...");
  let bookFiles: Record<string, unknown>[] = [];
  try {
    bookFiles = await apiGet<Record<string, unknown>[]>("/api/v1/bookfile");
    console.log(`  Total book files: ${bookFiles.length}`);
    if (DUMP_RAW && bookFiles.length > 0) {
      console.log("\n  === RAW first bookfile ===");
      console.log(JSON.stringify(bookFiles[0], null, 2));
      console.log("  === END RAW ===\n");
    }
  } catch (e) {
    console.error(`  ERROR: ${(e as Error).message}`);
  }

  // -- Summarise identifiers found on books ----------------------------------
  console.log("\n--- Identifier fields found on books ---");
  if (books.length > 0) {
    // Collect all identifier keys seen across all books
    const keyCounts: Record<string, number> = {};
    const keyExamples: Record<string, unknown> = {};
    for (const book of books) {
      const ids = extractIdentifiers(book);
      for (const [k, v] of Object.entries(ids)) {
        keyCounts[k] = (keyCounts[k] ?? 0) + 1;
        if (keyExamples[k] === undefined) keyExamples[k] = v;
      }
    }
    const sorted = Object.entries(keyCounts).sort((a, b) => b[1] - a[1]);
    console.log(`  (${books.length} books scanned)\n`);
    for (const [k, count] of sorted) {
      const pct = Math.round((count / books.length) * 100);
      console.log(`  ${k.padEnd(50)} ${String(count).padStart(4)}/${books.length} (${pct}%)  e.g. ${JSON.stringify(keyExamples[k])}`);
    }
  }

  console.log("\n--- Identifier fields found on authors ---");
  if (authors.length > 0) {
    const keyCounts: Record<string, number> = {};
    const keyExamples: Record<string, unknown> = {};
    for (const author of authors) {
      const ids = extractIdentifiers(author);
      for (const [k, v] of Object.entries(ids)) {
        keyCounts[k] = (keyCounts[k] ?? 0) + 1;
        if (keyExamples[k] === undefined) keyExamples[k] = v;
      }
    }
    const sorted = Object.entries(keyCounts).sort((a, b) => b[1] - a[1]);
    console.log(`  (${authors.length} authors scanned)\n`);
    for (const [k, count] of sorted) {
      const pct = Math.round((count / authors.length) * 100);
      console.log(`  ${k.padEnd(50)} ${String(count).padStart(4)}/${authors.length} (${pct}%)  e.g. ${JSON.stringify(keyExamples[k])}`);
    }
  }

  console.log("\n--- Identifier fields found on book files ---");
  if (bookFiles.length > 0) {
    const keyCounts: Record<string, number> = {};
    const keyExamples: Record<string, unknown> = {};
    for (const bf of bookFiles) {
      const ids = extractIdentifiers(bf);
      for (const [k, v] of Object.entries(ids)) {
        keyCounts[k] = (keyCounts[k] ?? 0) + 1;
        if (keyExamples[k] === undefined) keyExamples[k] = v;
      }
    }
    const sorted = Object.entries(keyCounts).sort((a, b) => b[1] - a[1]);
    console.log(`  (${bookFiles.length} book files scanned)\n`);
    for (const [k, count] of sorted) {
      const pct = Math.round((count / bookFiles.length) * 100);
      console.log(`  ${k.padEnd(50)} ${String(count).padStart(4)}/${bookFiles.length} (${pct}%)  e.g. ${JSON.stringify(keyExamples[k])}`);
    }
  }

  // -- 5. Match against ShelfBridge DB --------------------------------------
  console.log("\n[5/5] Matching against ShelfBridge database...");

  if (!fs.existsSync(DB_PATH)) {
    console.log(`  DB not found at ${DB_PATH} — skipping match step`);
    console.log("  (Set SHELFBRIDGE_DB env var if your DB is elsewhere)");
    printSummary(books, [], [], []);
    return;
  }

  const db = new Database(DB_PATH, { readonly: true });

  // Load all book_links with their identifiers
  const rows = db.prepare(`
    SELECT
      id, title, author,
      isbn13, isbn10,
      hardcover_book_id, hardcover_slug,
      goodreads_book_id,
      grimmory_book_id,
      grimmory_hardcover_book_id,
      grimmory_goodreads_id,
      match_confidence
    FROM book_links
  `).all() as Array<{
    id: number;
    title: string | null;
    author: string | null;
    isbn13: string | null;
    isbn10: string | null;
    hardcover_book_id: string | null;
    hardcover_slug: string | null;
    goodreads_book_id: string | null;
    grimmory_book_id: string | null;
    grimmory_hardcover_book_id: string | null;
    grimmory_goodreads_id: string | null;
    match_confidence: string | null;
  }>;

  console.log(`  book_links rows in DB: ${rows.length}`);

  // Build lookup indices from DB
  const byHardcoverId = new Map<string, typeof rows[0]>();
  const byHardcoverSlug = new Map<string, typeof rows[0]>();
  const byGoodreadsId = new Map<string, typeof rows[0]>();
  const byIsbn13 = new Map<string, typeof rows[0]>();
  const byIsbn10 = new Map<string, typeof rows[0]>();
  const byTitleAuthor = new Map<string, typeof rows[0]>();
  const byRelaxedTitle = new Map<string, typeof rows[0]>();

  for (const row of rows) {
    if (row.hardcover_book_id) byHardcoverId.set(String(row.hardcover_book_id), row);
    if (row.grimmory_hardcover_book_id) byHardcoverId.set(String(row.grimmory_hardcover_book_id), row);
    if (row.hardcover_slug) byHardcoverSlug.set(row.hardcover_slug.toLowerCase(), row);
    if (row.goodreads_book_id) byGoodreadsId.set(String(row.goodreads_book_id), row);
    if (row.grimmory_goodreads_id) byGoodreadsId.set(String(row.grimmory_goodreads_id), row);
    if (row.isbn13) byIsbn13.set(row.isbn13.replace(/[^0-9X]/g, ""), row);
    if (row.isbn10) byIsbn10.set(row.isbn10.replace(/[^0-9X]/g, ""), row);
    if (row.title && row.author) {
      byTitleAuthor.set(`${normalise(row.title)}|${normalise(row.author)}`, row);
      byRelaxedTitle.set(`${normalise(stripSubtitle(row.title))}|${normalise(row.author)}`, row);
    }
  }

  // Attempt to match each Chaptarr book
  type MatchResult = {
    chaptarrId: unknown;
    foreignBookId: unknown;
    title: string;
    author: string;
    method: string;
    dbRow: typeof rows[0] | null;
  };

  const matched: MatchResult[] = [];
  const unmatched: MatchResult[] = [];
  const methodCounts: Record<string, number> = {};

  for (const book of books) {
    const title = String(book.title ?? "");
    // Author may be nested under book.author object
    const authorObj = book.author as Record<string, unknown> | undefined;
    const authorName = String(
      book.authorName ?? authorObj?.authorName ?? authorObj?.name ?? authorObj?.sortName ?? ""
    );
    const foreignBookId = book.foreignBookId ?? book.ForeignBookId ?? book.foreignId;
    const chaptarrId = book.id;

    // Gather ISBNs from editions array
    const editions = Array.isArray(book.editions) ? book.editions as Record<string, unknown>[] : [];
    const isbn13s = editions
      .map((e) => String(e.isbn13 ?? e.Isbn13 ?? "").replace(/[^0-9X]/g, ""))
      .filter(Boolean);
    const isbn10s = editions
      .map((e) => String(e.isbn ?? e.isbn10 ?? e.Isbn ?? "").replace(/[^0-9X]/g, ""))
      .filter(Boolean);

    let dbRow: typeof rows[0] | null = null;
    let method = "none";

    // Try matching by every available identifier, most-confident first
    if (foreignBookId) {
      // Could be Hardcover ID, Goodreads ID, or something else — try all
      const fid = String(foreignBookId);
      if (byHardcoverId.has(fid)) { dbRow = byHardcoverId.get(fid)!; method = "foreignBookId→hardcover_id"; }
      else if (byGoodreadsId.has(fid)) { dbRow = byGoodreadsId.get(fid)!; method = "foreignBookId→goodreads_id"; }
      else if (byHardcoverSlug.has(fid.toLowerCase())) { dbRow = byHardcoverSlug.get(fid.toLowerCase())!; method = "foreignBookId→hardcover_slug"; }
    }

    // Try ISBNs
    for (const isbn of isbn13s) {
      if (!dbRow && byIsbn13.has(isbn)) { dbRow = byIsbn13.get(isbn)!; method = "isbn13"; break; }
    }
    for (const isbn of isbn10s) {
      if (!dbRow && byIsbn10.has(isbn)) { dbRow = byIsbn10.get(isbn)!; method = "isbn10"; break; }
    }

    // Title + author
    if (!dbRow && title && authorName) {
      const key = `${normalise(title)}|${normalise(authorName)}`;
      if (byTitleAuthor.has(key)) { dbRow = byTitleAuthor.get(key)!; method = "title_author"; }
    }
    if (!dbRow && title && authorName) {
      const key = `${normalise(stripSubtitle(title))}|${normalise(authorName)}`;
      if (byRelaxedTitle.has(key)) { dbRow = byRelaxedTitle.get(key)!; method = "title_author_relaxed"; }
    }

    const result: MatchResult = { chaptarrId, foreignBookId, title, author: authorName, method, dbRow };
    if (dbRow) {
      matched.push(result);
      methodCounts[method] = (methodCounts[method] ?? 0) + 1;
    } else {
      unmatched.push(result);
    }
  }

  // Print match report
  console.log(`\n  Matched  : ${matched.length}/${books.length}`);
  console.log(`  Unmatched: ${unmatched.length}/${books.length}`);
  console.log("\n  Match breakdown by method:");
  for (const [method, count] of Object.entries(methodCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${method.padEnd(35)} ${count}`);
  }

  if (unmatched.length > 0) {
    console.log(`\n  Unmatched books (${unmatched.length}):`);
    for (const r of unmatched) {
      console.log(`    - "${r.title}" by "${r.author}"  foreignBookId=${JSON.stringify(r.foreignBookId)}`);
    }
  }

  printSummary(books, matched, unmatched, Object.entries(methodCounts));

  db.close();
}

function printSummary(
  books: unknown[],
  matched: unknown[],
  unmatched: unknown[],
  methods: [string, number][],
) {
  console.log("\n" + "=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));
  console.log(`Chaptarr books total : ${books.length}`);
  console.log(`Matched to ShelfBridge: ${matched.length}`);
  console.log(`Unmatched            : ${unmatched.length}`);
  if (methods.length > 0) {
    console.log("\nMatch methods:");
    for (const [m, c] of methods) console.log(`  ${m}: ${c}`);
  }
  console.log("\nNext step: review the identifier fields above, then decide on");
  console.log("the matching strategy for the full integration.");
  console.log("=".repeat(70));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
