import type { TestResult } from "../../shared/types.js";
import { logger } from "../logger.js";
import { fetchIntegration } from "../security/outbound.js";

export interface GrimmoryBook {
  id: number;
  title: string;
  // authors can be strings or objects depending on Grimmory version
  authors?: Array<string | { name?: string }>;
  author?: string;
  isbn13?: string | null;
  isbn10?: string | null;
  seriesName?: string | null;
  seriesNumber?: string | null;
  readStatus?: string | null;
  personalRating?: number | null;
  rating?: number | null;
  lastReadTime?: string | null;
  dateFinished?: string | null;
  readProgress?: number | null;
  primaryFileId?: number | null;
  primaryFilePath?: string | null;
  coverImage?: string | null;
  cover?: string | null;
  coverUrl?: string | null;
  mediaType?: "physical" | "ebook" | "audiobook" | null;
  narrator?: string | null;
  // External IDs from admin endpoint metadata
  hardcoverId?: string | null;      // Hardcover slug
  hardcoverBookId?: string | null;  // Hardcover numeric book ID as string
  goodreadsId?: string | null;
  audibleAsin?: string | null;
  tags?: string[] | null;
}

interface GrimmoryAdminPage {
  content?: GrimmoryAdminBook[];
  page?: {
    totalPages?: number;
    number?: number;
  };
}

export async function testGrimmoryServer(baseUrl: string): Promise<TestResult> {
  try {
    const url = baseUrl.replace(/\/$/, "");
    const res = await fetchIntegration(`${url}/api/v1/actuator/health`, {
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      return { ok: true, message: "Grimmory server is reachable" };
    }
    // Some versions don't expose actuator — try the openapi endpoint
    const res2 = await fetchIntegration(`${url}/api/openapi.json`, { signal: AbortSignal.timeout(8000) });
    if (res2.ok) return { ok: true, message: "Grimmory server is reachable" };
    return { ok: false, message: `Server returned ${res.status}` };
  } catch (err) {
    logger.warn("Grimmory server test failed", { error: err });
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function testGrimmoryLogin(baseUrl: string, username: string, password: string): Promise<TestResult & { accessToken?: string; refreshToken?: string }> {
  try {
    const url = baseUrl.replace(/\/$/, "");
    const res = await fetchIntegration(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      return { ok: false, message: `Login failed: HTTP ${res.status}` };
    }
    const data = await res.json() as { accessToken?: string; refreshToken?: string };
    if (!data.accessToken) {
      return { ok: false, message: "Login response missing access token" };
    }
    return { ok: true, message: `Logged in as ${username}`, accessToken: data.accessToken, refreshToken: data.refreshToken };
  } catch (err) {
    logger.warn("Grimmory login test failed", { error: err });
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function getGrimmoryToken(baseUrl: string, username: string, password: string): Promise<string | null> {
  const result = await testGrimmoryLogin(baseUrl, username, password);
  return result.accessToken ?? null;
}

async function grimmoryGet<T>(baseUrl: string, token: string, path: string): Promise<T> {
  const url = baseUrl.replace(/\/$/, "");
  const res = await fetchIntegration(`${url}${path}`, {
    headers: { "Authorization": `Bearer ${token}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Grimmory API error: HTTP ${res.status} on ${path}`);
  return res.json() as Promise<T>;
}

async function grimmoryPut<T = unknown>(baseUrl: string, token: string, path: string, body: unknown): Promise<T | null> {
  const url = baseUrl.replace(/\/$/, "");
  const res = await fetchIntegration(`${url}${path}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Grimmory write error: HTTP ${res.status} on ${path}${text ? `: ${text}` : ""}`);
  }
  if (res.status === 204) return null;
  const text = await res.text().catch(() => "");
  if (!text) return null;
  return JSON.parse(text) as T;
}

const grimmoryMetadataLocks = new Map<string, Promise<void>>();

async function withGrimmoryMetadataLock<T>(baseUrl: string, bookId: number, fn: () => Promise<T>): Promise<T> {
  const key = `${baseUrl.replace(/\/$/, "").toLowerCase()}:${bookId}`;
  const previous = grimmoryMetadataLocks.get(key) ?? Promise.resolve();

  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const next = previous.then(() => current, () => current);
  grimmoryMetadataLocks.set(key, next);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (grimmoryMetadataLocks.get(key) === next) {
      grimmoryMetadataLocks.delete(key);
    }
  }
}

interface GrimmoryAdminBook {
  id: number;
  readStatus?: string | null;
  personalRating?: number | null;
  lastReadTime?: string | null;
  dateFinished?: string | null;
  readProgress?: number | null;
  metadata?: {
    title?: string | null;
    authors?: string[] | null;
    isbn13?: string | null;
    isbn10?: string | null;
    seriesName?: string | null;
    seriesNumber?: string | number | null;
    hardcoverId?: string | null;
    hardcoverBookId?: string | null;
    goodreadsId?: string | null;
    audibleAsin?: string | null;
    audibleId?: string | null;
    audibleASIN?: string | null;
    audible_id?: string | null;
    readingFormat?: string | null;
    reading_format?: string | null;
    mediaType?: string | null;
    media_type?: string | null;
    narrator?: string | null;
    tags?: string[] | null;
    coverImage?: string | null;
    cover?: string | null;
    coverUrl?: string | null;
  };
  primaryFile?: { id?: number | null; filePath?: string | null } | null;
}

function inferGrimmoryMediaType(metadata: GrimmoryAdminBook["metadata"], primaryFilePath: string | null | undefined): GrimmoryBook["mediaType"] {
  const filePath = primaryFilePath?.toLowerCase() ?? "";
  const rawMediaType = metadata?.mediaType ?? metadata?.media_type ?? metadata?.readingFormat ?? metadata?.reading_format ?? null;
  const mediaText = rawMediaType?.toLowerCase() ?? "";

  if (mediaText.includes("audio")) return "audiobook";
  if (mediaText.includes("ebook") || mediaText.includes("kindle") || mediaText.includes("epub")) return "ebook";
  if (mediaText.includes("physical") || mediaText.includes("paperback") || mediaText.includes("hardcover")) return "physical";
  if (filePath.endsWith(".m4b") || filePath.endsWith(".mp3") || filePath.endsWith(".m4a") || filePath.includes("/audiobook")) return "audiobook";
  if (filePath.endsWith(".epub") || filePath.endsWith(".mobi") || filePath.endsWith(".azw3") || filePath.endsWith(".pdf")) return "ebook";
  return null;
}

function adminBookToGrimmoryBook(book: GrimmoryAdminBook): GrimmoryBook {
  const metadata = book.metadata ?? {};
  const seriesNumber = metadata.seriesNumber == null ? null : String(metadata.seriesNumber);
  return {
    id: book.id,
    title: metadata.title ?? "",
    authors: metadata.authors ?? undefined,
    isbn13: metadata.isbn13 ?? null,
    isbn10: metadata.isbn10 ?? null,
    seriesName: metadata.seriesName ?? null,
    seriesNumber,
    readStatus: book.readStatus ?? null,
    personalRating: book.personalRating ?? null,
    lastReadTime: book.lastReadTime ?? null,
    dateFinished: book.dateFinished ?? null,
    readProgress: book.readProgress ?? null,
    primaryFileId: book.primaryFile?.id ?? null,
    primaryFilePath: book.primaryFile?.filePath ?? null,
    coverImage: metadata.coverImage ?? null,
    cover: metadata.cover ?? null,
    coverUrl: metadata.coverUrl ?? null,
    mediaType: inferGrimmoryMediaType(metadata, book.primaryFile?.filePath ?? null),
    narrator: metadata.narrator ?? null,
    hardcoverId: metadata.hardcoverId ?? null,
    hardcoverBookId: metadata.hardcoverBookId ?? null,
    goodreadsId: metadata.goodreadsId ?? null,
    audibleAsin: metadata.audibleAsin ?? metadata.audibleASIN ?? metadata.audibleId ?? metadata.audible_id ?? null,
    tags: metadata.tags ?? null
  };
}

async function fetchGrimmoryAdminDetail(baseUrl: string, token: string, bookId: number): Promise<GrimmoryAdminBook | null> {
  try {
    return await grimmoryGet<GrimmoryAdminBook>(baseUrl, token, `/api/v1/books/${bookId}`);
  } catch (err) {
    logger.warn("Grimmory admin detail fetch failed", { bookId, error: err });
    return null;
  }
}

function mergeAdminDetail(book: GrimmoryBook, detail: GrimmoryAdminBook | null): void {
  const metadata = detail?.metadata;
  if (!metadata) return;
  book.title = metadata.title ?? book.title;
  book.authors = metadata.authors ?? book.authors;
  book.isbn13 = metadata.isbn13 ?? book.isbn13 ?? null;
  book.isbn10 = metadata.isbn10 ?? book.isbn10 ?? null;
  book.seriesName = metadata.seriesName ?? book.seriesName ?? null;
  book.seriesNumber = metadata.seriesNumber == null ? book.seriesNumber ?? null : String(metadata.seriesNumber);
  book.coverImage = metadata.coverImage ?? book.coverImage ?? null;
  book.cover = metadata.cover ?? book.cover ?? null;
  book.coverUrl = metadata.coverUrl ?? book.coverUrl ?? null;
  book.mediaType = inferGrimmoryMediaType(metadata, detail?.primaryFile?.filePath ?? book.primaryFilePath ?? null) ?? book.mediaType ?? null;
  book.narrator = metadata.narrator ?? book.narrator ?? null;
  book.hardcoverId = metadata.hardcoverId ?? book.hardcoverId ?? null;
  book.hardcoverBookId = metadata.hardcoverBookId ?? book.hardcoverBookId ?? null;
  book.goodreadsId = metadata.goodreadsId ?? book.goodreadsId ?? null;
  book.audibleAsin = metadata.audibleAsin ?? metadata.audibleASIN ?? metadata.audibleId ?? metadata.audible_id ?? book.audibleAsin ?? null;
  book.tags = metadata.tags ?? book.tags ?? null;
  book.primaryFilePath = detail?.primaryFile?.filePath ?? book.primaryFilePath ?? null;
}

export async function fetchGrimmoryBooks(baseUrl: string, token: string): Promise<GrimmoryBook[]> {
  const allBooks: GrimmoryBook[] = [];
  let page = 0;
  const size = 250;

  while (true) {
    const data = await grimmoryGet<GrimmoryAdminPage>(
      baseUrl, token,
      `/api/v1/books/page?page=${page}&size=${size}`
    );

    const batch = (data.content ?? []).map(adminBookToGrimmoryBook);
    const totalPages = data.page?.totalPages ?? 1;

    allBooks.push(...batch);
    logger.info("Grimmory books batch fetched", { page, count: batch.length, totalPages });

    if (page >= totalPages - 1) break;
    page++;
  }

  const detailBatchSize = 10;
  for (let i = 0; i < allBooks.length; i += detailBatchSize) {
    const batch = allBooks.slice(i, i + detailBatchSize);
    const details = await Promise.all(batch.map((book) => fetchGrimmoryAdminDetail(baseUrl, token, book.id)));
    for (let j = 0; j < batch.length; j++) {
      mergeAdminDetail(batch[j]!, details[j] ?? null);
    }
  }

  logger.info("Grimmory admin books fetched and enriched", { count: allBooks.length });
  return allBooks;
}

export async function writeGrimmoryExternalIds(
  baseUrl: string,
  token: string,
  bookId: number,
  ids: { goodreadsId?: string | null; hardcoverBookId?: string | null; hardcoverId?: string | null }
): Promise<{ goodreadsId?: string | null; hardcoverBookId?: string | null; hardcoverId?: string | null }> {
  const metadata = {
    bookId,
    ...(ids.goodreadsId !== undefined ? { goodreadsId: ids.goodreadsId } : {}),
    ...(ids.hardcoverBookId !== undefined ? { hardcoverBookId: ids.hardcoverBookId } : {}),
    ...(ids.hardcoverId !== undefined ? { hardcoverId: ids.hardcoverId } : {})
  };

  const updated = await grimmoryPut<GrimmoryAdminBook["metadata"]>(
    baseUrl,
    token,
    `/api/v1/books/${bookId}/metadata?mergeCategories=false&replaceMode=REPLACE_WHEN_PROVIDED`,
    { metadata, clearFlags: {} }
  );

  if (ids.goodreadsId !== undefined && updated?.goodreadsId !== ids.goodreadsId) {
    throw new Error(`Grimmory accepted the write but returned Goodreads ID ${updated?.goodreadsId ?? "unset"}`);
  }
  if (ids.hardcoverBookId !== undefined && updated?.hardcoverBookId !== ids.hardcoverBookId) {
    throw new Error(`Grimmory accepted the write but returned Hardcover book ID ${updated?.hardcoverBookId ?? "unset"}`);
  }
  if (ids.hardcoverId !== undefined && ids.hardcoverId !== null && updated?.hardcoverId !== ids.hardcoverId) {
    throw new Error(`Grimmory accepted the write but returned Hardcover slug ${updated?.hardcoverId ?? "unset"}`);
  }

  return {
    goodreadsId: updated?.goodreadsId ?? null,
    hardcoverBookId: updated?.hardcoverBookId ?? null,
    hardcoverId: updated?.hardcoverId ?? null
  };
}

export async function addGrimmoryTag(baseUrl: string, token: string, bookId: number, tag: string): Promise<boolean> {
  const cleanedTag = tag.trim();
  if (!cleanedTag) return false;

  return withGrimmoryMetadataLock(baseUrl, bookId, async () => {
    const detail = await fetchGrimmoryAdminDetail(baseUrl, token, bookId);
    const existingTags = detail?.metadata?.tags ?? [];
    if (existingTags.some((existing) => existing.toLowerCase() === cleanedTag.toLowerCase())) {
      return false;
    }

    const tags = Array.from(new Set([...existingTags, cleanedTag]));
    const updated = await grimmoryPut<GrimmoryAdminBook["metadata"]>(
      baseUrl,
      token,
      `/api/v1/books/${bookId}/metadata?mergeCategories=false&replaceMode=REPLACE_WHEN_PROVIDED`,
      { metadata: { bookId, tags }, clearFlags: {} }
    );

    if (!updated?.tags?.some((existing) => existing.toLowerCase() === cleanedTag.toLowerCase())) {
      throw new Error(`Grimmory accepted the write but returned tags without ${cleanedTag}`);
    }

    return true;
  });
}

export function grimmoryAuthorName(book: GrimmoryBook): string | null {
  if (book.author) return book.author;
  if (!book.authors?.length) return null;
  const first = book.authors[0];
  if (typeof first === "string") return first;
  return first?.name ?? null;
}

export function grimmoryRating(book: GrimmoryBook): number | null {
  return book.personalRating ?? book.rating ?? null;
}

export function grimmoryCoverUrl(book: GrimmoryBook): string | null {
  return book.coverImage ?? book.cover ?? book.coverUrl ?? null;
}

export async function updateGrimmoryStatus(baseUrl: string, token: string, bookId: number, status: string): Promise<void> {
  await grimmoryPut(baseUrl, token, `/api/v1/app/books/${bookId}/status`, { status });
}

export async function updateGrimmoryRating(baseUrl: string, token: string, bookId: number, rating: number): Promise<void> {
  const updated = await grimmoryPut<Array<{ bookId?: number; personalRating?: number | null }>>(
    baseUrl,
    token,
    "/api/v1/books/personal-rating",
    { ids: [bookId], rating }
  );
  const updatedBook = updated?.find((book) => book.bookId === bookId);
  if (updatedBook && updatedBook.personalRating !== rating) {
    throw new Error(`Grimmory accepted the rating write but returned ${updatedBook.personalRating ?? "unset"}`);
  }
}

export interface GrimmoryProgress {
  readProgress: number | null;
  readStatus: string | null;
  lastReadTime: string | null;
}

export async function fetchGrimmoryProgress(baseUrl: string, token: string, bookId: number): Promise<GrimmoryProgress> {
  const data = await grimmoryGet<{
    readProgress?: number | null;
    readStatus?: string | null;
    lastReadTime?: string | null;
    epubProgress?: { percentage?: number | null; updatedAt?: string | null } | null;
    fileProgress?: { progressPercent?: number | null; updatedAt?: string | null } | null;
    audiobookProgress?: { percentage?: number | null; updatedAt?: string | null } | null;
  }>(baseUrl, token, `/api/v1/app/books/${bookId}/progress`);

  // Grimmory tracks progress in multiple stores: readProgress (set by external devices
  // like Kobo — no per-field timestamp), epubProgress (built-in reader), fileProgress,
  // and audiobookProgress (each with explicit updatedAt timestamps).
  //
  // We pick the most recently updated store. If the top-level lastReadTime matches one
  // of the per-source timestamps, that source is the freshest — use it. Only fall back
  // to readProgress (no per-field timestamp, e.g. Kobo sync) when no explicitly-
  // timestamped source was the most recent update.
  const topLastRead = data.lastReadTime ?? null;
  const explicitSources = [
    data.audiobookProgress?.percentage != null
      ? { progress: data.audiobookProgress.percentage, updatedAt: data.audiobookProgress.updatedAt ?? null }
      : null,
    data.fileProgress?.progressPercent != null
      ? { progress: data.fileProgress.progressPercent, updatedAt: data.fileProgress.updatedAt ?? null }
      : null,
    data.epubProgress?.percentage != null
      ? { progress: data.epubProgress.percentage, updatedAt: data.epubProgress.updatedAt ?? null }
      : null,
  ].filter((s): s is { progress: number; updatedAt: string | null } => s !== null);

  // The source whose updatedAt matches topLastRead is definitively the most recent.
  const matchedSource = topLastRead
    ? explicitSources.find(s => s.updatedAt === topLastRead)
    : null;

  // If no exact match, fall back to the most recently timestamped explicit source.
  const newestTimestamped = matchedSource
    ?? explicitSources
      .filter(s => s.updatedAt)
      .sort((a, b) => (b.updatedAt! > a.updatedAt! ? 1 : -1))[0]
    ?? null;

  // readProgress (Kobo/external) wins only when no explicit source was the most recent update.
  const progress = (newestTimestamped && newestTimestamped.updatedAt === topLastRead)
    ? newestTimestamped.progress
    : (data.readProgress ?? newestTimestamped?.progress ?? null);

  const lastReadTime = topLastRead
    ?? explicitSources.filter(s => s.updatedAt).sort((a, b) => (b.updatedAt! > a.updatedAt! ? 1 : -1))[0]?.updatedAt
    ?? null;

  return {
    readProgress: typeof progress === "number" ? progress : null,
    readStatus: data.readStatus ?? null,
    lastReadTime
  };
}

export async function updateGrimmoryProgress(
  baseUrl: string,
  token: string,
  bookId: number,
  fileId: number,
  progressPercent: number
): Promise<void> {
  await grimmoryPut(baseUrl, token, `/api/v1/app/books/${bookId}/progress`, {
    fileProgress: {
      bookFileId: fileId,
      progressPercent
    },
    progressValid: true
  });
}

export async function clearGrimmoryProgress(
  baseUrl: string,
  token: string,
  bookId: number,
  fileId?: number | null
): Promise<void> {
  await grimmoryPut(baseUrl, token, `/api/v1/app/books/${bookId}/progress`, {
    ...(fileId ? { fileProgress: { bookFileId: fileId, progressPercent: null } } : {}),
    progressValid: false
  });
}

// ── Shelf functions ───────────────────────────────────────────────────────────

export interface GrimmoryShelf {
  id: number;
  name: string;
}

export async function fetchGrimmoryShelfList(baseUrl: string, token: string): Promise<GrimmoryShelf[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/v1/app/shelves`;
  try {
    const res = await fetchIntegration(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
      logger.warn("Grimmory shelf list fetch failed", { status: res.status });
      return [];
    }
    const data = await res.json() as unknown;
    // Handle both array response and paginated { content: [...] } shape
    const items = Array.isArray(data) ? data : (data as { content?: unknown[] }).content ?? [];
    return (items as { id?: number; name?: string }[])
      .filter((s) => typeof s.id === "number" && typeof s.name === "string")
      .map((s) => ({ id: s.id as number, name: s.name as string }));
  } catch (err) {
    logger.warn("Error fetching Grimmory shelf list", { error: err });
    return [];
  }
}

export async function ensureGrimmoryShelf(baseUrl: string, token: string, name: string): Promise<number> {
  const shelves = await fetchGrimmoryShelfList(baseUrl, token);
  const existing = shelves.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  if (existing) return existing.id;

  const url = `${baseUrl.replace(/\/$/, "")}/api/v1/shelves`;
  const res = await fetchIntegration(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to create Grimmory shelf "${name}": HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  const created = await res.json() as { id?: number };
  if (typeof created.id !== "number") throw new Error(`Grimmory shelf create did not return an ID`);
  logger.info("Created Grimmory shelf", { name, id: created.id });
  return created.id;
}

export async function fetchGrimmoryShelfBookIds(baseUrl: string, token: string, shelfId: number): Promise<number[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/v1/shelves/${shelfId}/books`;
  try {
    const res = await fetchIntegration(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return [];
    const data = await res.json() as unknown;
    const items = Array.isArray(data) ? data : (data as { content?: unknown[] }).content ?? [];
    return (items as { id?: unknown }[])
      .map((b) => b.id)
      .filter((id): id is number => typeof id === "number");
  } catch {
    return [];
  }
}

export async function addBooksToGrimmoryShelf(baseUrl: string, token: string, bookIds: number[], shelfId: number): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/v1/books/shelves`;
  const res = await fetchIntegration(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ bookIds, shelvesToAssign: [shelfId], shelvesToUnassign: [] }),
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`Failed to add books to Grimmory shelf ${shelfId}: HTTP ${res.status}`);
}
