import type { TestResult } from "../../shared/types.js";
import { logger } from "../logger.js";
import { fetchIntegration } from "../security/outbound.js";

export interface GoodreadsBook {
  goodreadsId: string;
  title: string;
  author: string | null;
  isbn10: string | null;
  isbn13: string | null;
  seriesName: string | null;
  seriesNumber: string | null;
  shelf: string;
  rating: number | null;
  readAt: string | null;
  dateAdded: string | null;
  updatedAt: string | null;
  bookLink: string;
  coverUrl: string | null;
}

function extractXmlField(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return null;
  const val = decodeXmlEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
  return val || null;
}

const XML_NAMED_ENTITIES: Record<string, string> = {
  quot: "\"",
  apos: "'",
  amp: "&",
  lt: "<",
  gt: ">"
};

// Decodes all entities in a single left-to-right pass so a literal sequence like
// "&amp;lt;" (the escaped form of the text "&lt;") isn't re-scanned and unescaped
// a second time into "<".
const MAX_UNICODE_CODEPOINT = 0x10ffff;

// XML 1.0's Char production (https://www.w3.org/TR/xml/#charsets) — excludes
// NUL and most other control characters, and the surrogate range, which are
// invalid in an XML document even though they're valid Unicode code points.
function isValidXmlCodePoint(codePoint: number): boolean {
  return codePoint === 0x9
    || codePoint === 0xa
    || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= MAX_UNICODE_CODEPOINT);
}

function codePointToChar(codePoint: number, fallback: string): string {
  if (!Number.isInteger(codePoint) || !isValidXmlCodePoint(codePoint)) return fallback;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

export function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:(quot|apos|amp|lt|gt)|#(\d+)|#x([0-9a-f]+));/gi, (fullMatch, name?: string, dec?: string, hex?: string) => {
    if (name) return XML_NAMED_ENTITIES[name.toLowerCase()] ?? fullMatch;
    if (dec) return codePointToChar(Number(dec), fullMatch);
    return codePointToChar(parseInt(hex!, 16), fullMatch);
  });
}

function parseGoodreadsItems(xml: string, fetchedShelf?: string): GoodreadsBook[] {
  const books: GoodreadsBook[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRe.exec(xml)) !== null) {
    const item = match[1];
    const goodreadsId = extractXmlField(item, "book_id");
    if (!goodreadsId) continue;

    const title = extractXmlField(item, "title") ?? "";
    const author = extractXmlField(item, "author_name");

    // Goodreads returns the string "null" when ISBN is absent
    const rawIsbn10 = extractXmlField(item, "isbn");
    const rawIsbn13 = extractXmlField(item, "isbn13");
    const isbn10 = !rawIsbn10 || rawIsbn10 === "null" ? null : rawIsbn10;
    const isbn13 = !rawIsbn13 || rawIsbn13 === "null" ? null : rawIsbn13;
    const seriesName = extractXmlField(item, "book_series_title")
      ?? extractXmlField(item, "series_title")
      ?? extractXmlField(item, "series_name")
      ?? extractXmlField(item, "book_series");
    const seriesNumber = extractXmlField(item, "book_series_position")
      ?? extractXmlField(item, "series_position")
      ?? extractXmlField(item, "series_number");

    // When fetching shelf=all (no fetchedShelf), use the first value from user_shelves
    // so each book records its primary custom shelf rather than the literal "all".
    const rawShelf = fetchedShelf ?? extractXmlField(item, "user_shelves");
    const shelf = (rawShelf ? rawShelf.split(",")[0].trim() : null) ?? "read";

    const rawRating = extractXmlField(item, "user_rating");
    const parsedRating = rawRating ? Number(rawRating) : 0;
    // 0 means no rating on Goodreads
    const rating = Number.isFinite(parsedRating) && parsedRating > 0 ? parsedRating : null;

    const rawReadAt = extractXmlField(item, "user_read_at");
    const readAt = rawReadAt || null;
    const dateAdded = extractXmlField(item, "user_date_added")
      ?? extractXmlField(item, "date_added")
      ?? null;
    const updatedAt = extractXmlField(item, "pubDate") ?? readAt ?? dateAdded;

    // Prefer large image, fall back through medium → small
    const rawCover = extractXmlField(item, "book_large_image_url")
      ?? extractXmlField(item, "book_medium_image_url")
      ?? extractXmlField(item, "book_small_image_url");
    // Goodreads serves a 1x1 transparent GIF for missing covers — discard those
    const coverUrl = rawCover && !rawCover.includes("nophoto") ? rawCover : null;

    books.push({
      goodreadsId,
      title,
      author,
      isbn10,
      isbn13,
      seriesName,
      seriesNumber,
      shelf,
      rating,
      readAt,
      dateAdded,
      updatedAt,
      bookLink: `https://www.goodreads.com/book/show/${goodreadsId}`,
      coverUrl
    });
  }
  return books;
}

function parseGoodreadsUsername(xml: string, fallback: string): string | null {
  const channelMatch = xml.match(/<channel>([\s\S]*?)<\/channel>/i);
  const channel = channelMatch?.[1] ?? xml;
  const title = extractXmlField(channel, "title");
  if (!title) return null;

  const cleaned = title
    .replace(/['’]s bookshelf:?.*$/i, "")
    .replace(/['’]s bookshelves:?.*$/i, "")
    .trim();

  if (!cleaned || cleaned.toLowerCase().includes("goodreads") || cleaned === fallback) return null;
  return cleaned;
}

export async function fetchShelfPage(
  userId: string,
  shelf: string,
  page: number
): Promise<{ books: GoodreadsBook[]; hasMore: boolean }> {
  const url = `https://www.goodreads.com/review/list_rss/${encodeURIComponent(userId)}?shelf=${encodeURIComponent(shelf)}&per_page=200&page=${page}`;
  const res = await fetchIntegration(url, {
    headers: { "User-Agent": "ShelfBridge/0.1 (book sync app)" },
    signal: AbortSignal.timeout(15000)
  });

  if (res.status === 404) throw new Error("Goodreads user not found or profile is private");
  if (!res.ok) throw new Error(`Goodreads returned HTTP ${res.status} for shelf "${shelf}"`);

  const text = await res.text();
  const books = parseGoodreadsItems(text, shelf);
  return { books, hasMore: books.length === 200 };
}

export const GOODREADS_MANDATORY_SHELVES = ["read", "currently-reading", "to-read", "did-not-finish"];

export async function fetchAllGoodreadsBooks(userId: string, shelves?: string[]): Promise<GoodreadsBook[]> {
  const allBooks: GoodreadsBook[] = [];
  const seenIds = new Set<string>();

  const shelvesToFetch = shelves ?? GOODREADS_MANDATORY_SHELVES;
  for (const shelf of shelvesToFetch) {
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const { books, hasMore: more } = await fetchShelfPage(userId, shelf, page);
      for (const book of books) {
        if (!seenIds.has(book.goodreadsId)) {
          seenIds.add(book.goodreadsId);
          allBooks.push(book);
        }
      }
      hasMore = more;
      page++;
      if (hasMore) await new Promise((r) => setTimeout(r, 300));
    }
  }

  // When no shelf filter is configured, also fetch shelf=all to capture books that
  // are only on custom shelves and never appear in the mandatory shelf feeds.
  // Parses user_shelves from each item (first value) so we record the actual shelf.
  // Books already seen from mandatory shelves are skipped via seenIds.
  if (!shelves) {
    try {
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        const url = `https://www.goodreads.com/review/list_rss/${encodeURIComponent(userId)}?shelf=all&per_page=200&page=${page}`;
        const res = await fetchIntegration(url, {
          headers: { "User-Agent": "ShelfBridge/0.1 (book sync app)" },
          signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) break;
        const text = await res.text();
        // Pass no fetchedShelf so parseGoodreadsItems reads user_shelves from each item
        const books = parseGoodreadsItems(text);
        let added = 0;
        for (const book of books) {
          if (!seenIds.has(book.goodreadsId)) {
            seenIds.add(book.goodreadsId);
            allBooks.push(book);
            added++;
          }
        }
        hasMore = books.length === 200;
        page++;
        if (hasMore) await new Promise((r) => setTimeout(r, 300));
        if (added === 0 && books.length > 0) break; // All already seen, no need to continue
      }
      logger.info("Goodreads shelf=all fetch complete", { userId, total: allBooks.length });
    } catch (err) {
      // shelf=all may not be supported on all profiles — non-fatal
      logger.warn("Goodreads shelf=all fetch failed (custom shelf books may be missed)", { userId, error: err });
    }
  }

  logger.info("Goodreads shelves fetched", { userId, shelves: shelves ?? "all+mandatory", count: allBooks.length });
  return allBooks;
}

const MANDATORY_SHELVES = new Set(GOODREADS_MANDATORY_SHELVES);

function extractShelvesList(itemXml: string): string[] {
  // user_shelves contains comma-separated shelf names for this book
  const raw = extractXmlField(itemXml, "user_shelves");
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// Fetch all custom (non-mandatory) shelf names for a user.
// Strategy: fetch shelf=all (every book regardless of exclusive shelf) and collect
// shelf names from user_shelves. Falls back to paginating mandatory shelves if
// shelf=all is unsupported. Books shelved only under a custom shelf (never touched
// the mandatory ones) will only appear via shelf=all.
export async function fetchGoodreadsCustomShelves(userId: string): Promise<string[]> {
  const customShelves = new Set<string>();

  async function drainShelf(shelf: string): Promise<boolean> {
    let page = 1;
    let hasMore = true;
    let anyBooks = false;
    while (hasMore) {
      const url = `https://www.goodreads.com/review/list_rss/${encodeURIComponent(userId)}?shelf=${encodeURIComponent(shelf)}&per_page=200&page=${page}`;
      const res = await fetchIntegration(url, {
        headers: { "User-Agent": "ShelfBridge/0.1 (book sync app)" },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) return false;
      const text = await res.text();
      const itemRe = /<item>([\s\S]*?)<\/item>/gi;
      let match;
      let count = 0;
      while ((match = itemRe.exec(text)) !== null) {
        anyBooks = true;
        count++;
        for (const name of extractShelvesList(match[1])) {
          if (!MANDATORY_SHELVES.has(name)) customShelves.add(name);
        }
      }
      hasMore = count === 200;
      page++;
      if (hasMore) await new Promise((r) => setTimeout(r, 300));
    }
    return anyBooks;
  }

  // shelf=all returns every book the user has shelved, regardless of exclusive shelf.
  // This is the only way to discover shelves that have no overlap with mandatory shelves.
  let usedAll = false;
  try {
    usedAll = await drainShelf("all");
  } catch {
    usedAll = false;
  }

  // Fall back to mandatory shelves if shelf=all returned nothing or failed
  if (!usedAll) {
    for (const shelf of ["read", "currently-reading", "to-read"]) {
      try { await drainShelf(shelf); } catch { /* non-fatal */ }
    }
  }

  logger.info("Goodreads custom shelves discovered", { userId, count: customShelves.size, method: usedAll ? "all" : "mandatory-shelves" });
  return Array.from(customShelves).sort();
}

export async function testGoodreadsUser(userId: string): Promise<TestResult> {
  if (!userId?.trim()) return { ok: false, message: "No user ID provided" };
  try {
    const url = `https://www.goodreads.com/review/list_rss/${encodeURIComponent(userId)}?shelf=read&per_page=1`;
    const res = await fetchIntegration(url, {
      headers: { "User-Agent": "ShelfBridge/0.1 (book sync app)" },
      signal: AbortSignal.timeout(12000)
    });
    if (res.status === 404) return { ok: false, message: "Goodreads user not found or profile is private" };
    if (!res.ok) return { ok: false, message: `Goodreads returned HTTP ${res.status}` };
    const text = await res.text();
    if (!text.includes("<rss") && !text.includes("<channel")) {
      return { ok: false, message: "Unexpected response from Goodreads — profile may be private" };
    }
    const username = parseGoodreadsUsername(text, userId);
    return {
      ok: true,
      message: username ? `Goodreads profile found for ${username}` : `Goodreads profile found for ID ${userId}`,
      ...(username ? { username } : {})
    };
  } catch (err) {
    logger.warn("Goodreads user test failed", { error: err });
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
