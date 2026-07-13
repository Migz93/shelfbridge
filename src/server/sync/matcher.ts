import type { HardcoverUserBook } from "./hardcover.js";
import type { GrimmoryBook } from "./grimmory.js";
import { grimmoryAuthorName } from "./grimmory.js";
import { identifierVariants, normalizeExternalId } from "../identifiers.js";

export type MatchConfidence = "high" | "medium" | "low" | "none";
export type MatchType = "hardcover_book_id" | "hardcover_slug" | "goodreads_id" | "isbn13" | "isbn10" | "title_author" | "title_author_relaxed";

export interface MatchResult {
  grimmoryBook: GrimmoryBook;
  confidence: MatchConfidence;
  matchType: MatchType;
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function normalizeTitleForRelaxedMatch(s: string): string {
  // Strip subtitle after colon before normalizeText so the colon position isn't lost
  const beforeColon = s.includes(":") ? s.split(":")[0].trim() : s;
  return normalizeText(beforeColon)
    .replace(/\s+(a|an|the)\s+(chilling|gripping|psychological|unmissable|ultra authentic|surprising|novel|thriller|bestseller|story|memoir|biography|autobiography).*/, "")
    .replace(/\s+book\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+).*/, "")
    .trim();
}

function normalizeSeriesNumber(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  const match = text.match(/\d+(?:\.\d+)?/);
  return match?.[0] ?? text.replace(/\s+/g, " ");
}

function firstHardcoverSeries(book: HardcoverUserBook): { name: string | null; number: string | null } {
  const seriesBook = book.book.book_series?.find((entry) => entry.series?.name?.trim());
  return {
    name: seriesBook?.series?.name?.trim() || null,
    number: normalizeSeriesNumber(seriesBook?.position)
  };
}

function seriesCompatible(hcBook: HardcoverUserBook, grBook: GrimmoryBook): boolean {
  const hcSeries = firstHardcoverSeries(hcBook);
  const grSeriesName = normalizeText(grBook.seriesName ?? "");
  const grSeriesNumber = normalizeSeriesNumber(grBook.seriesNumber);

  if (hcSeries.name && grBook.seriesName && normalizeText(hcSeries.name) !== grSeriesName) return false;
  if (hcSeries.number && grSeriesNumber && hcSeries.number !== grSeriesNumber) return false;
  return true;
}

// Build lookup indexes for fast matching
interface MatchIndex {
  byHardcoverBookId: Map<string, GrimmoryBook>;
  byHardcoverSlug: Map<string, GrimmoryBook>;
  byGoodreadsId: Map<string, GrimmoryBook>;
  byIsbn: Map<string, GrimmoryBook>;
  byTitleAuthor: Map<string, GrimmoryBook[]>;
  byRelaxedTitleAuthor: Map<string, GrimmoryBook[]>;
}

function pushIndex(index: Map<string, GrimmoryBook[]>, key: string, book: GrimmoryBook): void {
  const books = index.get(key) ?? [];
  books.push(book);
  index.set(key, books);
}

export function buildGrimmoryIndex(books: GrimmoryBook[]): MatchIndex {
  const byHardcoverBookId = new Map<string, GrimmoryBook>();
  const byHardcoverSlug = new Map<string, GrimmoryBook>();
  const byGoodreadsId = new Map<string, GrimmoryBook>();
  const byIsbn = new Map<string, GrimmoryBook>();
  const byTitleAuthor = new Map<string, GrimmoryBook[]>();
  const byRelaxedTitleAuthor = new Map<string, GrimmoryBook[]>();

  for (const book of books) {
    for (const id of identifierVariants(book.hardcoverBookId)) byHardcoverBookId.set(id, book);
    if (book.hardcoverId) byHardcoverSlug.set(book.hardcoverId.trim(), book);
    for (const id of identifierVariants(book.goodreadsId)) byGoodreadsId.set(id, book);
    if (book.isbn13) byIsbn.set(book.isbn13.trim(), book);
    if (book.isbn10) byIsbn.set(book.isbn10.trim(), book);

    const title = normalizeText(book.title ?? "");
    const relaxedTitle = normalizeTitleForRelaxedMatch(book.title ?? "");
    const author = normalizeText(grimmoryAuthorName(book) ?? "");
    if (title && author) {
      pushIndex(byTitleAuthor, `${title}||${author}`, book);
    }
    if (relaxedTitle && author) {
      pushIndex(byRelaxedTitleAuthor, `${relaxedTitle}||${author}`, book);
    }
  }

  return { byHardcoverBookId, byHardcoverSlug, byGoodreadsId, byIsbn, byTitleAuthor, byRelaxedTitleAuthor };
}

export function matchHardcoverBook(hcBook: HardcoverUserBook, index: MatchIndex, opts: { goodreadsId?: string | null } = {}): MatchResult | null {
  // 1. Hardcover book ID match (exact external ID stored in Grimmory — highest confidence)
  const hcBookIdStr = String(hcBook.book.id);
  const byId = index.byHardcoverBookId.get(hcBookIdStr);
  if (byId) return { grimmoryBook: byId, confidence: "high", matchType: "hardcover_book_id" };

  // 2. Goodreads ID match (trusted external ID when Hardcover has already been enriched)
  if (opts.goodreadsId) {
    const byGoodreadsId = index.byGoodreadsId.get(normalizeExternalId(opts.goodreadsId) ?? opts.goodreadsId.trim());
    if (byGoodreadsId) return { grimmoryBook: byGoodreadsId, confidence: "high", matchType: "goodreads_id" };
  }

  // 3. Hardcover slug match (slug stored in Grimmory as hardcoverId)
  if (hcBook.book.slug) {
    const bySlug = index.byHardcoverSlug.get(hcBook.book.slug.trim());
    if (bySlug) return { grimmoryBook: bySlug, confidence: "high", matchType: "hardcover_slug" };
  }

  // 4. ISBN match via default_physical_edition
  const edition = hcBook.book.default_physical_edition;
  const candidateIsbns: Array<{ isbn: string; type: MatchType }> = [];
  if (edition?.isbn_13) candidateIsbns.push({ isbn: edition.isbn_13.trim(), type: "isbn13" });
  if (edition?.isbn_10) candidateIsbns.push({ isbn: edition.isbn_10.trim(), type: "isbn10" });

  for (const { isbn, type } of candidateIsbns) {
    const match = index.byIsbn.get(isbn);
    if (match) return { grimmoryBook: match, confidence: "high", matchType: type };
  }

  // 5. Title + first author match (medium confidence)
  const hcTitle = normalizeText(hcBook.book.title ?? "");
  const relaxedHcTitle = normalizeTitleForRelaxedMatch(hcBook.book.title ?? "");
  const hcAuthor = normalizeText(hcBook.book.contributions?.[0]?.author?.name ?? "");
  if (hcTitle && hcAuthor) {
    const match = index.byTitleAuthor.get(`${hcTitle}||${hcAuthor}`)
      ?.find((book) => seriesCompatible(hcBook, book));
    if (match) return { grimmoryBook: match, confidence: "medium", matchType: "title_author" };
  }
  if (relaxedHcTitle && hcAuthor) {
    const match = index.byRelaxedTitleAuthor.get(`${relaxedHcTitle}||${hcAuthor}`)
      ?.find((book) => seriesCompatible(hcBook, book));
    if (match) return { grimmoryBook: match, confidence: "low", matchType: "title_author_relaxed" };
  }

  return null;
}

// Status mapping tables
export const HARDCOVER_TO_GRIMMORY: Record<number, string> = {
  1: "UNREAD",
  2: "READING",
  3: "READ",
  4: "PAUSED",
  5: "ABANDONED",
  6: "WONT_READ"
};

export const GRIMMORY_TO_HARDCOVER: Record<string, number> = {
  READING: 2,
  RE_READING: 2,
  PARTIALLY_READ: 2,
  READ: 3,
  PAUSED: 4,
  ABANDONED: 5,
  WONT_READ: 6
};

// Goodreads mandatory shelf names → Grimmory read statuses (Goodreads → Grimmory only)
export const GOODREADS_TO_GRIMMORY: Record<string, string> = {
  "to-read": "UNREAD",
  "currently-reading": "READING",
  "read": "READ",
  "did-not-finish": "ABANDONED"
};
