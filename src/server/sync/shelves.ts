import type { getDb } from "../db/index.js";
import { logger } from "../logger.js";
import type { SyncAdapters } from "./adapters.js";
import { identifierVariants, normalizeIsbn } from "../identifiers.js";
import { normalizeTitle } from "./normalization.js";

type Db = ReturnType<typeof getDb>;

// Some supported SQLite builds retain the historical 999-variable limit. The
// reverse shelf query binds an ID list twice, so leave room for its fixed args.
const SQLITE_ID_BATCH_SIZE = 400;
const MAX_GOODREADS_SHELF_PAGES = 200;
const HARDCOVER_LIST_WRITE_FAILURE_BUDGET = 5;

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += SQLITE_ID_BATCH_SIZE) {
    result.push(values.slice(start, start + SQLITE_ID_BATCH_SIZE));
  }
  return result;
}

export async function syncGoodreadsShelvesToGrimmory(
  db: Db,
  profileId: number,
  goodreadsUserId: string,
  baseUrl: string,
  grimmoryToken: string,
  dryRun: boolean,
  adapters: SyncAdapters
): Promise<void> {
  type MappingRow = { id: number; source_list_name: string; grimmory_shelf_name: string; grimmory_shelf_id: number | null };
  const mappings = db.prepare(`
    SELECT id, source_list_name, grimmory_shelf_name, grimmory_shelf_id
    FROM shelf_mappings
    WHERE profile_id = ? AND source = 'goodreads' AND source_list_name IS NOT NULL AND enabled = 1
  `).all(profileId) as MappingRow[];

  if (mappings.length === 0) return;
  logger.info("Syncing Goodreads shelves to Grimmory", { profileId, count: mappings.length });

  // Build lookup: goodreads_book_id → grimmory_book_id
  const grimmoryByGoodreadsId: Record<string, number> = {};
  const grimmoryByIsbn13: Record<string, number> = {};
  const grimmoryByIsbn10: Record<string, number> = {};
  const grimmoryByTitle: Record<string, number> = {};

  // gr_src is scoped to this profile's own Grimmory instance — the resulting
  // grimmory_book_id is about to be sent to this profile's Grimmory server, and
  // another instance's local ID would point at an unrelated book there.
  const sourcePairs = db.prepare(`
    SELECT go_src.external_id as goodreads_id, go_src.isbn13 as go_isbn13, go_src.isbn10 as go_isbn10,
           go_src.title as go_title,
           CAST(gr_src.external_id AS INTEGER) as grimmory_book_id
    FROM book_sources go_src
    JOIN book_sources gr_src ON gr_src.book_id = go_src.book_id AND gr_src.source_type = 'grimmory' AND gr_src.source_instance_id = ?
    WHERE go_src.source_type = 'goodreads'
  `).all(profileId) as { goodreads_id: string; go_isbn13: string | null; go_isbn10: string | null; go_title: string | null; grimmory_book_id: number }[];

  for (const pair of sourcePairs) {
    for (const id of identifierVariants(pair.goodreads_id)) grimmoryByGoodreadsId[id] ??= pair.grimmory_book_id;
    const isbn13 = normalizeIsbn(pair.go_isbn13);
    const isbn10 = normalizeIsbn(pair.go_isbn10);
    if (isbn13) grimmoryByIsbn13[isbn13] ??= pair.grimmory_book_id;
    if (isbn10) grimmoryByIsbn10[isbn10] ??= pair.grimmory_book_id;
    const norm = pair.go_title ? normalizeTitle(pair.go_title) : "";
    if (norm) grimmoryByTitle[norm] ??= pair.grimmory_book_id;
  }

  for (const mapping of mappings) {
    const shelfName = mapping.source_list_name;
    const grimmoryBookIdSet = new Set<number>();

    try {
      let page = 1;
      let hasMore = true;
      while (hasMore && page <= MAX_GOODREADS_SHELF_PAGES) {
        const { books, hasMore: more } = await adapters.fetchShelfPage(goodreadsUserId, shelfName, page);
        for (const book of books) {
          let gId: number | undefined;
          const goodreadsId = identifierVariants(book.goodreadsId).find((id) => grimmoryByGoodreadsId[id] !== undefined);
          const isbn13 = normalizeIsbn(book.isbn13);
          const isbn10 = normalizeIsbn(book.isbn10);
          if (goodreadsId) gId = grimmoryByGoodreadsId[goodreadsId];
          else if (isbn13 && grimmoryByIsbn13[isbn13]) gId = grimmoryByIsbn13[isbn13];
          else if (isbn10 && grimmoryByIsbn10[isbn10]) gId = grimmoryByIsbn10[isbn10];
          else { const norm = normalizeTitle(book.title); if (norm && grimmoryByTitle[norm]) gId = grimmoryByTitle[norm]; }
          if (gId) grimmoryBookIdSet.add(gId);
        }
        hasMore = more;
        page++;
        if (hasMore) await new Promise((r) => setTimeout(r, 300));
      }
      if (hasMore) {
        logger.warn("Stopped Goodreads shelf pagination at the safety limit", { profileId, shelfName, maxPages: MAX_GOODREADS_SHELF_PAGES });
      }
    } catch (err) {
      logger.warn("Failed to fetch Goodreads shelf books for mapping", { profileId, shelfName, error: err });
      continue;
    }

    const grimmoryBookIds = [...grimmoryBookIdSet];
    if (grimmoryBookIds.length === 0) {
      logger.info("No matched Grimmory books for Goodreads shelf", { profileId, shelfName, grimmoryShelfName: mapping.grimmory_shelf_name });
    }

    if (dryRun && !mapping.grimmory_shelf_id) {
      logger.info("Dry run: mapped Grimmory shelf would be resolved or created", { profileId, shelfName, grimmoryShelfName: mapping.grimmory_shelf_name });
      continue;
    }

    let shelfId = mapping.grimmory_shelf_id;
    if (!shelfId) {
      try {
        shelfId = await adapters.ensureGrimmoryShelf(baseUrl, grimmoryToken, mapping.grimmory_shelf_name);
        db.prepare("UPDATE shelf_mappings SET grimmory_shelf_id = ? WHERE id = ?").run(shelfId, mapping.id);
      } catch (err) {
        logger.warn("Failed to resolve Grimmory shelf for Goodreads sync", { profileId, grimmoryShelfName: mapping.grimmory_shelf_name, error: err });
        continue;
      }
    }

    let currentIds: number[];
    try {
      currentIds = await adapters.fetchGrimmoryShelfBookIds(baseUrl, grimmoryToken, shelfId);
    } catch (err) {
      logger.warn("Failed to fetch Grimmory shelf for Goodreads sync", { profileId, shelfName, grimmoryShelfName: mapping.grimmory_shelf_name, error: err });
      continue;
    }

    const toAdd = grimmoryBookIds.filter((id) => !currentIds.includes(id));
    let confirmedAdded: number[] = [];
    if (toAdd.length > 0) {
      if (dryRun) {
        logger.info("Dry run: would add books to Grimmory shelf from Goodreads shelf", { profileId, shelfName, grimmoryShelfName: mapping.grimmory_shelf_name, count: toAdd.length });
      } else {
        try {
          await adapters.addBooksToGrimmoryShelf(baseUrl, grimmoryToken, toAdd, shelfId);
          confirmedAdded = toAdd;
          logger.info("Synced Goodreads shelf to Grimmory shelf", { profileId, shelfName, grimmoryShelfName: mapping.grimmory_shelf_name, added: toAdd.length });
        } catch (err) {
          logger.warn("Failed to add books to Grimmory shelf from Goodreads", { profileId, grimmoryShelfName: mapping.grimmory_shelf_name, error: err });
        }
      }
    } else {
      logger.info("Grimmory shelf already up to date for Goodreads shelf", { profileId, shelfName, grimmoryShelfName: mapping.grimmory_shelf_name });
    }

    // Record Grimmory shelf membership on user_book_states — only for ids
    // actually confirmed added above, not every id the write merely intended.
    const allOnShelf = [...new Set([...currentIds, ...confirmedAdded])];
    if (allOnShelf.length > 0 && !dryRun && !mapping.grimmory_shelf_name.includes(",")) {
      const grimmoryShelfName = mapping.grimmory_shelf_name;
      for (const ids of batches(allOnShelf)) {
        const shelfPlaceholders = ids.map(() => "?").join(",");
        db.prepare(`
        UPDATE user_book_states SET grimmory_shelves = CASE
          WHEN grimmory_shelves IS NULL THEN ?
          WHEN instr(',' || grimmory_shelves || ',', ',' || ? || ',') = 0 THEN grimmory_shelves || ',' || ?
          ELSE grimmory_shelves
        END
        WHERE profile_id = ? AND source_type = 'grimmory'
          AND book_id IN (
            SELECT book_id FROM book_sources
            WHERE source_type = 'grimmory' AND source_instance_id = ? AND CAST(external_id AS INTEGER) IN (${shelfPlaceholders})
          )
        `).run(grimmoryShelfName, grimmoryShelfName, grimmoryShelfName, profileId, profileId, ...ids);
      }
    } else if (allOnShelf.length > 0 && !dryRun) {
      logger.warn("Skipped comma-delimited shelf membership cache for shelf name containing a comma", { profileId, shelfName: mapping.grimmory_shelf_name });
    }
  }
}

export async function syncListsToShelves(
  db: Db,
  profileId: number,
  baseUrl: string,
  grimmoryToken: string,
  hcLists: Awaited<ReturnType<SyncAdapters["fetchHardcoverLists"]>>,
  hardcoverToken: string,
  dryRun: boolean,
  clearFirst: boolean,
  adapters: SyncAdapters
): Promise<void> {
  if (clearFirst) {
    db.prepare("UPDATE user_book_states SET grimmory_shelves = NULL WHERE profile_id = ? AND source_type = 'grimmory'").run(profileId);
  }

  interface MappingRow {
    id: number;
    source_list_id: string;
    source_list_name: string;
    grimmory_shelf_name: string;
    grimmory_shelf_id: number | null;
  }

  const mappings = db.prepare(`
    SELECT id, source_list_id, source_list_name, grimmory_shelf_name, grimmory_shelf_id
    FROM shelf_mappings
    WHERE profile_id = ? AND source = 'hardcover' AND source_list_id IS NOT NULL AND enabled = 1
  `).all(profileId) as MappingRow[];

  if (mappings.length === 0) return;
  logger.info("Syncing mapped Hardcover lists and Grimmory shelves", { profileId, count: mappings.length });

  for (const mapping of mappings) {
    const hcList = hcLists.find((l) => String(l.id) === mapping.source_list_id);
    if (!hcList) {
      logger.warn("Hardcover list not found for mapping — may have been deleted", { profileId, mappingId: mapping.id, listId: mapping.source_list_id });
      continue;
    }

    let grimmoryBookIds: number[] = [];
    if (hcList.bookIds.length > 0) {
      const ids = new Set<number>();
      for (const bookIds of batches(hcList.bookIds)) {
        const placeholders = bookIds.map(() => "?").join(",");
        const matched = db.prepare(`
        SELECT DISTINCT CAST(gr_src.external_id AS INTEGER) as grimmory_book_id
        FROM book_sources hc_src
        JOIN book_sources gr_src ON gr_src.book_id = hc_src.book_id AND gr_src.source_type = 'grimmory' AND gr_src.source_instance_id = ?
        WHERE hc_src.source_type = 'hardcover'
          AND (
            CAST(hc_src.external_id AS INTEGER) IN (${placeholders})
            OR gr_src.grimmory_hardcover_book_id IN (${placeholders})
          )
        `).all(profileId, ...bookIds, ...bookIds.map(String)) as { grimmory_book_id: number }[];
        for (const row of matched) ids.add(row.grimmory_book_id);
      }
      grimmoryBookIds = Array.from(ids);
    }

    if (hcList.bookIds.length > 0 && grimmoryBookIds.length === 0) {
      logger.info("No matched Grimmory books for Hardcover list", { profileId, listName: hcList.name, hardcoverBookCount: hcList.bookIds.length });
    }

    if (dryRun && !mapping.grimmory_shelf_id) {
      logger.info("Dry run: mapped Grimmory shelf would be resolved or created", { profileId, listName: hcList.name, shelfName: mapping.grimmory_shelf_name });
      continue;
    }

    let shelfId = mapping.grimmory_shelf_id;
    if (!shelfId) {
      try {
        shelfId = await adapters.ensureGrimmoryShelf(baseUrl, grimmoryToken, mapping.grimmory_shelf_name);
        db.prepare("UPDATE shelf_mappings SET grimmory_shelf_id = ? WHERE id = ?").run(shelfId, mapping.id);
      } catch (err) {
        logger.warn("Failed to resolve Grimmory shelf for list sync", { profileId, shelfName: mapping.grimmory_shelf_name, error: err });
        continue;
      }
    }

    let currentIds: number[];
    try {
      currentIds = await adapters.fetchGrimmoryShelfBookIds(baseUrl, grimmoryToken, shelfId);
    } catch (err) {
      logger.warn("Failed to fetch Grimmory shelf for Hardcover list sync", { profileId, listName: hcList.name, shelfName: mapping.grimmory_shelf_name, error: err });
      continue;
    }

    const toAdd = grimmoryBookIds.filter((id) => !currentIds.includes(id));
    let confirmedAdded: number[] = [];
    if (toAdd.length > 0) {
      if (dryRun) {
        logger.info("Dry run: would add books to Grimmory shelf from Hardcover list", { profileId, listName: hcList.name, shelfName: mapping.grimmory_shelf_name, count: toAdd.length });
      } else {
        try {
          await adapters.addBooksToGrimmoryShelf(baseUrl, grimmoryToken, toAdd, shelfId);
          confirmedAdded = toAdd;
          logger.info("Synced Hardcover list to Grimmory shelf", { profileId, listName: hcList.name, shelfName: mapping.grimmory_shelf_name, added: toAdd.length });
        } catch (err) {
          logger.warn("Failed to add books to Grimmory shelf", { profileId, shelfName: mapping.grimmory_shelf_name, error: err });
        }
      }
    } else {
      logger.info("Grimmory shelf already up to date for list", { profileId, shelfName: mapping.grimmory_shelf_name });
    }

    // Record Grimmory shelf membership — only for ids actually confirmed
    // added above, not every id the write merely intended.
    const allOnShelf = [...new Set([...currentIds, ...confirmedAdded])];
    if (allOnShelf.length > 0 && !dryRun && !mapping.grimmory_shelf_name.includes(",")) {
      const shelfName = mapping.grimmory_shelf_name;
      for (const ids of batches(allOnShelf)) {
        const shelfPlaceholders = ids.map(() => "?").join(",");
        db.prepare(`
        UPDATE user_book_states SET grimmory_shelves = CASE
          WHEN grimmory_shelves IS NULL THEN ?
          WHEN instr(',' || grimmory_shelves || ',', ',' || ? || ',') = 0 THEN grimmory_shelves || ',' || ?
          ELSE grimmory_shelves
        END
        WHERE profile_id = ? AND source_type = 'grimmory'
          AND book_id IN (
            SELECT book_id FROM book_sources
            WHERE source_type = 'grimmory' AND source_instance_id = ? AND CAST(external_id AS INTEGER) IN (${shelfPlaceholders})
          )
        `).run(shelfName, shelfName, shelfName, profileId, profileId, ...ids);
      }
    } else if (allOnShelf.length > 0 && !dryRun) {
      logger.warn("Skipped comma-delimited shelf membership cache for shelf name containing a comma", { profileId, shelfName: mapping.grimmory_shelf_name });
    }

    if (currentIds.length === 0) continue;

    // Find Hardcover book IDs for books on this Grimmory shelf via two paths:
    // 1. Books already matched through the book_sources join (canonical match)
    // 2. Books whose Grimmory record carries a grimmory_hardcover_book_id (unmatched
    //    but Grimmory knows the Hardcover ID — covers books added directly in Grimmory)
    // Both Grimmory-side lookups are scoped to this profile's own Grimmory instance,
    // since currentIds are local IDs from this profile's own shelf fetch.
    const hardcoverBookIds = new Set<number>();
    for (const ids of batches(currentIds)) {
      const reversePlaceholders = ids.map(() => "?").join(",");
      const matched = db.prepare(`
      SELECT DISTINCT hardcover_book_id FROM (
        SELECT CAST(hc_src.external_id AS INTEGER) AS hardcover_book_id
        FROM book_sources gr_src
        JOIN book_sources hc_src ON hc_src.book_id = gr_src.book_id AND hc_src.source_type = 'hardcover'
        WHERE gr_src.source_type = 'grimmory' AND gr_src.source_instance_id = ?
          AND CAST(gr_src.external_id AS INTEGER) IN (${reversePlaceholders})
        UNION
        SELECT CAST(grimmory_hardcover_book_id AS INTEGER) AS hardcover_book_id
        FROM book_sources
        WHERE source_type = 'grimmory' AND source_instance_id = ?
          AND CAST(external_id AS INTEGER) IN (${reversePlaceholders})
          AND grimmory_hardcover_book_id IS NOT NULL
          AND grimmory_hardcover_book_id != ''
      )
      WHERE hardcover_book_id IS NOT NULL AND hardcover_book_id > 0
      `).all(profileId, ...ids, profileId, ...ids) as { hardcover_book_id: number | null }[];
      for (const row of matched) {
        if (typeof row.hardcover_book_id === "number" && row.hardcover_book_id > 0) hardcoverBookIds.add(row.hardcover_book_id);
      }
    }

    const currentHardcoverIds = new Set(hcList.bookIds);
    const toAddToHardcover = Array.from(hardcoverBookIds).filter((id) => !currentHardcoverIds.has(id));

    if (toAddToHardcover.length === 0) {
      logger.info("Hardcover list already up to date for Grimmory shelf", { profileId, listName: hcList.name, shelfName: mapping.grimmory_shelf_name });
      continue;
    }

    if (dryRun) {
      logger.info("Dry run: would add books to Hardcover list from Grimmory shelf", { profileId, listName: hcList.name, shelfName: mapping.grimmory_shelf_name, count: toAddToHardcover.length });
      continue;
    }

    let addedToHardcover = 0;
    let consecutiveFailures = 0;
    for (const hardcoverBookId of toAddToHardcover) {
      try {
        await adapters.addBookToHardcoverList(hardcoverToken, Number.parseInt(mapping.source_list_id, 10), hardcoverBookId);
        addedToHardcover++;
        consecutiveFailures = 0;
      } catch (err) {
        logger.warn("Failed to add book to Hardcover list", { profileId, listName: hcList.name, hardcoverBookId, error: err });
        consecutiveFailures++;
        // A run of failures usually means the API/token is down rather than
        // one bad book — stop hammering it with the rest of a large batch.
        if (consecutiveFailures >= HARDCOVER_LIST_WRITE_FAILURE_BUDGET) {
          logger.warn("Aborting remaining Hardcover list writes after consecutive failures", {
            profileId, listName: hcList.name, consecutiveFailures, remaining: toAddToHardcover.length - addedToHardcover - consecutiveFailures
          });
          break;
        }
      }
    }

    if (addedToHardcover > 0) {
      logger.info("Synced Grimmory shelf to Hardcover list", { profileId, listName: hcList.name, shelfName: mapping.grimmory_shelf_name, added: addedToHardcover });
    }
  }
}
