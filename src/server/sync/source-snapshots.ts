import { logger } from "../logger.js";
import type { HardcoverEdition, HardcoverUserBook } from "./hardcover.js";
import type { SyncAdapters } from "./adapters.js";
import type { GrimmoryBook } from "./grimmory.js";
import { normalizeExternalId } from "../identifiers.js";
import type { getDb } from "../db/index.js";
import type { SourceSnapshotStatus } from "./pruning.js";
import { mapWithConcurrency } from "./concurrency.js";
import { resolveSharedHardcoverOwnership, type SharedHardcoverOwnership } from "./hardcover-ownership.js";

const GRIMMORY_PROGRESS_FETCH_CONCURRENCY = 8;

type Db = ReturnType<typeof getDb>;
export type SnapshotContext = {
  db: Db;
  profileId: number;
  runId: number;
  profile: Record<string, unknown>;
  adapters: SyncAdapters;
  counters: { sourceFailures: number };
  recordEvent: (db: Db, runId: number, profileId: number, bookTitle: string, eventType: string, direction: string | null, decision: string, details: Record<string, unknown>) => void;
  hasHardcover: boolean;
  hardcoverToken: string;
  baseUrl: string;
  username: string | null;
  password: string | null;
  hasGrimmory: boolean;
};

export interface SourceSnapshots {
  hcBooks: HardcoverUserBook[];
  hcEditions: Map<number, HardcoverEdition>;
  hcLists: Awaited<ReturnType<SyncAdapters["fetchHardcoverLists"]>>;
  hardcoverSnapshotStatus: SourceSnapshotStatus;
  grimmoryBooks: GrimmoryBook[];
  grimmoryAvailable: boolean;
  grimmorySnapshotStatus: SourceSnapshotStatus;
  grimmoryToken: string | null;
  absOwnedBookIds: Set<number>;
  absOwnedHardcoverBookIds: Set<string>;
  sharedHardcoverOwnership: SharedHardcoverOwnership;
  grimmoryProgressById: Map<number, { readProgress: number | null; lastReadTime: string | null; readStatus: string | null }>;
}

export async function fetchSourceSnapshots(context: SnapshotContext): Promise<SourceSnapshots> {
  const { db, profileId, runId, profile, adapters, counters, recordEvent,
    hasHardcover, hardcoverToken, baseUrl, username, password, hasGrimmory } = context;
// ── Phase A: Fetch all libraries ────────────────────────────────────────

let hcBooks: HardcoverUserBook[] = [];
let hcEditions = new Map<number, HardcoverEdition>();
let hcLists: Awaited<ReturnType<SyncAdapters["fetchHardcoverLists"]>> = [];
let hardcoverSnapshotStatus: SourceSnapshotStatus = "failed";

if (hasHardcover) {
  try {
    logger.info("Fetching Hardcover user ID", { profileId });
    const hardcoverUserId = await adapters.fetchHardcoverUserId(hardcoverToken);

    logger.info("Fetching Hardcover library", { profileId, hardcoverUserId });
    hcBooks = await adapters.fetchHardcoverLibrary(hardcoverToken, hardcoverUserId);
    logger.info("Hardcover library fetched", { profileId, count: hcBooks.length });

    logger.info("Fetching Hardcover lists", { profileId });
    hcLists = await adapters.fetchHardcoverLists(hardcoverToken);
    logger.info("Hardcover lists fetched", { profileId, count: hcLists.length });
  } catch (err) {
    logger.error("Hardcover unavailable; aborting sync before local data changes", { profileId, error: err });
    recordEvent(db, runId, profileId, "Hardcover", "api_failure", "hardcover", "source_unavailable", {
      source: "hardcover", error: String(err)
    });
    throw err;
  }

  const hardcoverSyncListId = profile["hardcover_sync_list_id"] as string | null;
  const hardcoverSyncListName = profile["hardcover_sync_list_name"] as string | null;

  let listsForListOnlyBooks = hcLists;
  if (hardcoverSyncListId?.trim()) {
    const selectedList = hcLists.find((list) => String(list.id) === hardcoverSyncListId);
    if (!selectedList) {
      throw new Error(`Selected Hardcover sync list was not found: ${hardcoverSyncListName ?? hardcoverSyncListId}`);
    }
    listsForListOnlyBooks = [selectedList];
  }

  const libraryBookIds = new Set(hcBooks.map((b) => b.book.id));
  const listOnlyBooksById = new Map<number, { book: HardcoverUserBook["book"]; editionId: number | null; edition: HardcoverEdition | null }>();
  for (const list of listsForListOnlyBooks) {
    for (const entry of list.entries) {
      const book = entry.book;
      if (!libraryBookIds.has(book.id) && !listOnlyBooksById.has(book.id)) {
        listOnlyBooksById.set(book.id, entry);
      }
    }
  }

  if (listOnlyBooksById.size > 0) {
    const stubs: HardcoverUserBook[] = Array.from(listOnlyBooksById.values()).map((entry) => ({
      id: 0,
      edition_id: entry.editionId,
      status_id: null,
      rating: null,
      updated_at: null,
      first_started_reading_date: null,
      last_read_date: null,
      book: entry.book,
      user_book_reads: null
    }));
    hcBooks = [...hcBooks, ...stubs];
    for (const entry of listOnlyBooksById.values()) {
      if (entry.editionId && entry.edition) hcEditions.set(entry.editionId, entry.edition);
    }
    logger.info("Added list-only Hardcover books", { profileId, count: stubs.length });
  }

  if (hardcoverSyncListId?.trim()) {
    const selectedList = listsForListOnlyBooks[0]!;
    const allowedBookIds = new Set(selectedList.bookIds);
    const beforeCount = hcBooks.length;
    hcBooks = hcBooks.filter((book) => allowedBookIds.has(book.book.id));
    logger.info("Hardcover sync list applied", {
      profileId, listId: selectedList.id, listName: selectedList.name,
      beforeCount, afterCount: hcBooks.length
    });
  }

  const editionIds = hcBooks.map((book) => book.edition_id ?? 0).filter((id) => id > 0);
  if (editionIds.length > 0) {
    try {
      const fetchedEditions = await adapters.fetchHardcoverEditions(hardcoverToken, editionIds);
      for (const [editionId, edition] of fetchedEditions) hcEditions.set(editionId, edition);
      logger.info("Hardcover edition details fetched", { profileId, requested: editionIds.length, fetched: fetchedEditions.size });
    } catch (err) {
      logger.warn("Hardcover edition detail fetch failed; falling back to default edition metadata", { profileId, error: err });
    }
  }
  hardcoverSnapshotStatus = hardcoverSyncListId?.trim() ? "partial" : "complete";
} else {
  logger.info("Skipping Hardcover sync source because no API token is configured", { profileId });
}

let grimmoryToken: string | null = null;
let grimmoryBooks: GrimmoryBook[] = [];
let grimmoryAvailable = false;
let grimmorySnapshotStatus: SourceSnapshotStatus = "failed";

if (hasGrimmory) {
  logger.info("Authenticating with Grimmory", { profileId, username });
  const loginResult = await adapters.testGrimmoryLogin(baseUrl, username!, password!);
  grimmoryToken = loginResult.accessToken ?? null;
  if (!loginResult.ok || !grimmoryToken) {
    counters.sourceFailures++;
    const eventType = loginResult.message.toLowerCase().includes("login failed") ? "credential_failure" : "api_failure";
    logger.warn("Grimmory unavailable; preserving Grimmory data for this sync run", { profileId, message: loginResult.message });
    recordEvent(db, runId, profileId, "Grimmory", eventType, "grimmory", "source_unavailable", {
      source: "grimmory", message: loginResult.message
    });
  } else {
    try {
      logger.info("Fetching Grimmory library", { profileId });
      grimmoryBooks = await adapters.fetchGrimmoryBooks(baseUrl, grimmoryToken);
      grimmoryAvailable = true;
      grimmorySnapshotStatus = "complete";
      logger.info("Grimmory library fetched", { profileId, count: grimmoryBooks.length });
    } catch (err) {
      counters.sourceFailures++;
      grimmoryToken = null;
      logger.warn("Grimmory library fetch failed; preserving Grimmory data for this sync run", { profileId, error: err });
      recordEvent(db, runId, profileId, "Grimmory", "api_failure", "grimmory", "source_unavailable", {
        source: "grimmory", error: String(err)
      });
    }
  }
}

// Fetch Grimmory progress (needed for Phase B Grimmory user state)
const grimmoryProgressById = new Map<number, { readProgress: number | null; lastReadTime: string | null; readStatus: string | null }>();
if (grimmoryAvailable && grimmoryToken && profile["sync_progress_enabled"] !== 0) {
  await mapWithConcurrency(grimmoryBooks, GRIMMORY_PROGRESS_FETCH_CONCURRENCY, async (grBook) => {
    try {
      const progress = await adapters.fetchGrimmoryProgress(baseUrl, grimmoryToken, grBook.id);
      grimmoryProgressById.set(grBook.id, progress);
      grBook.readProgress = progress.readProgress;
      grBook.lastReadTime = progress.lastReadTime ?? grBook.lastReadTime ?? null;
      // The bulk library fetch's readStatus can lag behind this per-book
      // endpoint (e.g. a book just marked READING before the library list
      // was cached) — apply it here too so ownership resolution and every
      // other consumer of grBook.readStatus see the freshest value.
      grBook.readStatus = progress.readStatus ?? grBook.readStatus ?? null;
    } catch (err) {
      logger.warn("Failed to fetch Grimmory progress", { profileId, grimmoryBookId: grBook.id, error: err });
    }
  });
}

// Books with a runtime-validated Audiobookshelf link AND at least some
// ABS-reported listening activity are ABS-owned: ABS is the source of truth
// for their listening progress and status (Phase N). A runtime-validated
// match only means the file was correctly identified — it says nothing
// about whether the user has ever opened it, so ownership additionally
// requires a persisted 'audiobookshelf' user_book_states row, which Phase N
// only creates once ABS reports a real progress entry for the item. Without
// this, an unstarted audiobook a user merely owns a file for would silently
// block a finished/in-progress ebook sibling from ever syncing status to
// their shared Hardcover record.
// Computed from the DB as it stood at the end of the previous run — a
// stable snapshot — rather than anything derived from Hardcover's data
// this run, because Hardcover's "current edition" on a shared book can
// flip (e.g. editing any read record on it appears to retarget it) and
// must not be allowed to bounce this book's format classification between
// audiobook and print from one sync to the next.
const absOwnedBookIds = new Set(
  (db.prepare(`
    SELECT DISTINCT bs.book_id FROM book_sources bs
    WHERE bs.source_type = 'audiobookshelf' AND bs.source_instance_id = ?
      AND bs.book_id IS NOT NULL AND bs.audiobookshelf_runtime_validated = 1
      AND EXISTS (
        SELECT 1 FROM user_book_states ubs
        WHERE ubs.book_id = bs.book_id AND ubs.profile_id = ? AND ubs.source_type = 'audiobookshelf'
      )
  `).all(profileId, profileId) as { book_id: number }[]).map((row) => row.book_id)
);

// The Hardcover book ID shared by an ABS-owned audiobook, anchored via
// Grimmory's own audiobook row rather than the 'hardcover' source row's
// book_id. The Grimmory<->Audiobookshelf link (matched by file path/ASIN,
// independent of anything Hardcover reports) stays consistently clustered
// together across runs; the 'hardcover' row's book_id is the one that
// drifts when Hardcover's mutable "current edition" flips, so anchoring
// off it directly would let a single bad run break this signal for good
// instead of self-healing on the next one. A print/ebook Grimmory sibling
// of the same Hardcover book must not push its own status/progress into
// that shared book outside of Phase N, and Phase C below must keep
// routing this Hardcover book to its audiobook sibling regardless of
// which edition Hardcover currently reports as "current" for it.
const absOwnedHardcoverBookIds = new Set<string>();
if (absOwnedBookIds.size > 0) {
  const ids = Array.from(absOwnedBookIds);
  for (let start = 0; start < ids.length; start += 400) {
    const batch = ids.slice(start, start + 400);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db.prepare(`
        SELECT DISTINCT gr.grimmory_hardcover_book_id AS hardcover_book_id
        FROM book_sources gr
        WHERE gr.source_type = 'grimmory'
          AND gr.source_instance_id = ?
          AND gr.source_media_type = 'audiobook'
          AND gr.grimmory_hardcover_book_id IS NOT NULL
          AND gr.book_id IN (${placeholders})
      `).all(profileId, ...batch) as { hardcover_book_id: string }[];
    for (const row of rows) {
      const id = normalizeExternalId(row.hardcover_book_id);
      if (id !== null) absOwnedHardcoverBookIds.add(id);
    }
  }
}

  // Resolved once here — after the Grimmory/ABS-activity snapshots are both
  // known — so every later phase agrees on who owns a shared Hardcover
  // record instead of each re-deriving its own answer from a different
  // subset of this same data.
  const sharedHardcoverOwnership = resolveSharedHardcoverOwnership(grimmoryBooks, absOwnedHardcoverBookIds);

  return { hcBooks, hcEditions, hcLists, hardcoverSnapshotStatus, grimmoryBooks, grimmoryAvailable, grimmorySnapshotStatus, grimmoryToken, absOwnedBookIds, absOwnedHardcoverBookIds, sharedHardcoverOwnership, grimmoryProgressById };
}
