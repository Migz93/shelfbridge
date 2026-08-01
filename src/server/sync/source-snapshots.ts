import { logger } from "../logger.js";
import type { HardcoverEdition, HardcoverUserBook } from "./hardcover.js";
import type { SyncAdapters } from "./adapters.js";
import type { GrimmoryBook } from "./grimmory.js";
import { normalizeExternalId } from "../identifiers.js";
export async function fetchSourceSnapshots(context: any): Promise<any> {
  const { db, profileId, runId, profile, adapters, counters, recordEvent,
    hasHardcover, hardcoverToken, baseUrl, username, password, hasGrimmory } = context;
// ── Phase A: Fetch all libraries ────────────────────────────────────────

let hcBooks: HardcoverUserBook[] = [];
let hcEditions = new Map<number, HardcoverEdition>();
let hcLists: Awaited<ReturnType<SyncAdapters["fetchHardcoverLists"]>> = [];
let hardcoverSnapshotStatus: "complete" | "failed" = "failed";

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
  hardcoverSnapshotStatus = "complete";
} else {
  logger.info("Skipping Hardcover sync source because no API token is configured", { profileId });
}

let grimmoryToken: string | null = null;
let grimmoryBooks: GrimmoryBook[] = [];
let grimmoryAvailable = false;
let grimmorySnapshotStatus: "complete" | "failed" = "failed";

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
  for (const grBook of grimmoryBooks) {
    try {
      const progress = await adapters.fetchGrimmoryProgress(baseUrl, grimmoryToken, grBook.id);
      grimmoryProgressById.set(grBook.id, progress);
      grBook.readProgress = progress.readProgress;
      grBook.lastReadTime = progress.lastReadTime ?? grBook.lastReadTime ?? null;
    } catch (err) {
      logger.warn("Failed to fetch Grimmory progress", { profileId, grimmoryBookId: grBook.id, error: err });
    }
  }
}

// Books with a runtime-validated Audiobookshelf link are ABS-owned: ABS is
// the source of truth for their listening progress and status (Phase N).
// Computed from the DB as it stood at the end of the previous run — a
// stable snapshot — rather than anything derived from Hardcover's data
// this run, because Hardcover's "current edition" on a shared book can
// flip (e.g. editing any read record on it appears to retarget it) and
// must not be allowed to bounce this book's format classification between
// audiobook and print from one sync to the next.
const absOwnedBookIds = new Set(
  (db.prepare(`
    SELECT DISTINCT book_id FROM book_sources
    WHERE source_type = 'audiobookshelf' AND source_instance_id = ?
      AND book_id IS NOT NULL AND audiobookshelf_runtime_validated = 1
  `).all(profileId) as { book_id: number }[]).map((row) => row.book_id)
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
const absOwnedHardcoverBookIds = absOwnedBookIds.size > 0
  ? new Set(
      (db.prepare(`
        SELECT DISTINCT gr.grimmory_hardcover_book_id AS hardcover_book_id
        FROM book_sources gr
        WHERE gr.source_type = 'grimmory'
          AND gr.source_instance_id = ?
          AND gr.source_media_type = 'audiobook'
          AND gr.grimmory_hardcover_book_id IS NOT NULL
          AND gr.book_id IN (${Array.from(absOwnedBookIds).map(() => "?").join(",")})
      `).all(profileId, ...Array.from(absOwnedBookIds)) as { hardcover_book_id: string }[])
        .map((row) => normalizeExternalId(row.hardcover_book_id))
        .filter((id): id is string => id !== null)
    )
  : new Set<string>();

  return { hcBooks, hcEditions, hcLists, hardcoverSnapshotStatus, grimmoryBooks, grimmoryAvailable, grimmorySnapshotStatus, grimmoryToken, absOwnedBookIds, absOwnedHardcoverBookIds, grimmoryProgressById };
}
