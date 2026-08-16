import { logger } from "../logger.js";
import type { SyncAdapters } from "./adapters.js";

/** Adds the matched books from one source to its configured Grimmory shelf. */
export async function syncMatchedSourceBooksToGrimmoryShelf(
  profileId: number,
  baseUrl: string,
  grimmoryToken: string,
  source: "hardcover" | "goodreads",
  targetShelfName: string | null,
  grimmoryBookIds: Set<number>,
  dryRun: boolean,
  adapters: SyncAdapters
): Promise<void> {
  const shelfName = targetShelfName?.trim();
  if (!shelfName || grimmoryBookIds.size === 0) return;
  try {
    let shelfId: number;
    if (dryRun) {
      // Look up without creating — ensureGrimmoryShelf would create a missing
      // shelf even on a dry run.
      const shelves = await adapters.fetchGrimmoryShelfList(baseUrl, grimmoryToken);
      const existing = shelves.find((s) => s.name.toLowerCase() === shelfName.toLowerCase());
      if (!existing) {
        logger.info("Dry run: would create Grimmory target shelf", { profileId, source, shelfName, count: grimmoryBookIds.size });
        return;
      }
      shelfId = existing.id;
    } else {
      shelfId = await adapters.ensureGrimmoryShelf(baseUrl, grimmoryToken, shelfName);
    }
    const currentIds = await adapters.fetchGrimmoryShelfBookIds(baseUrl, grimmoryToken, shelfId);
    const toAdd = Array.from(grimmoryBookIds).filter((id) => !currentIds.includes(id));
    if (toAdd.length === 0) { logger.info("Grimmory target shelf already up to date for source sync", { profileId, source, shelfName }); return; }
    if (dryRun) { logger.info("Dry run: would add matched source books to Grimmory target shelf", { profileId, source, shelfName, count: toAdd.length }); return; }
    await adapters.addBooksToGrimmoryShelf(baseUrl, grimmoryToken, toAdd, shelfId);
    logger.info("Added matched source books to Grimmory target shelf", { profileId, source, shelfName, added: toAdd.length });
  } catch (error) {
    logger.warn("Failed to synchronize matched source books to Grimmory target shelf", { profileId, source, shelfName, error });
  }
}
