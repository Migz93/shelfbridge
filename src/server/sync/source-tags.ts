import { logger } from "../logger.js";
import { syncMatchedSourceBooksToGrimmoryShelf } from "./target-shelf.js";
export async function applySourceTags(context: any): Promise<void> {
  const { db, profileId, grimmoryAvailable, grimmoryBooks, taggedSourceGrimmoryIds, taggedSourceTitles, writeTagEnabled, hasGrimmory, grimmoryToken, writeTagName, dryRun, recordEvent, counters, adapters, baseUrl, runId, profile, hardcoverSourceGrimmoryIds, goodreadsSourceGrimmoryIds } = context;
// ── Phase I: Write tag ───────────────────────────────────────────────────
if (grimmoryAvailable) {
  const currentGrimmoryIds = new Set(grimmoryBooks.map((b: any) => b.id));
  for (const grimmoryBookId of taggedSourceGrimmoryIds) {
    if (!currentGrimmoryIds.has(grimmoryBookId)) {
      taggedSourceGrimmoryIds.delete(grimmoryBookId);
      taggedSourceTitles.delete(grimmoryBookId);
    }
  }
}

if (writeTagEnabled && grimmoryAvailable && hasGrimmory && grimmoryToken && taggedSourceGrimmoryIds.size > 0) {
  logger.info("Applying Grimmory source tag", { profileId, tag: writeTagName, count: taggedSourceGrimmoryIds.size });
  for (const grimmoryBookId of taggedSourceGrimmoryIds) {
    const bookTitle = taggedSourceTitles.get(grimmoryBookId) ?? "";
    if (dryRun) {
      recordEvent(db, runId, profileId, bookTitle, "written", "source_to_grimmory", "would_write_tag", { grimmoryBookId, tag: writeTagName, dryRun });
      counters.written++;
      continue;
    }
    try {
      const changed = await adapters.addGrimmoryTag(baseUrl, grimmoryToken, grimmoryBookId, writeTagName);
      if (changed) {
        recordEvent(db, runId, profileId, bookTitle, "written", "source_to_grimmory", "tag_written", { grimmoryBookId, tag: writeTagName });
        counters.written++;
        logger.info("Wrote Grimmory source tag", { profileId, grimmoryBookId, tag: writeTagName });
      } else {
        recordEvent(db, runId, profileId, bookTitle, "skipped_no_change", "source_to_grimmory", "tag_already_present", { grimmoryBookId, tag: writeTagName });
        counters.skipped++;
      }
    } catch (writeErr) {
      logger.warn("Failed to write Grimmory source tag", { profileId, grimmoryBookId, tag: writeTagName, error: writeErr });
      recordEvent(db, runId, profileId, bookTitle, "api_failure", "source_to_grimmory", "tag_write_failed", { grimmoryBookId, tag: writeTagName, error: String(writeErr) });
      counters.skipped++;
    }
  }
}

if (grimmoryAvailable && hasGrimmory && grimmoryToken) {
  await syncMatchedSourceBooksToGrimmoryShelf(
    profileId,
    baseUrl,
    grimmoryToken,
    "hardcover",
    profile["hardcover_target_shelf_name"] as string | null,
    hardcoverSourceGrimmoryIds,
    dryRun,
    adapters
  );
  await syncMatchedSourceBooksToGrimmoryShelf(
    profileId,
    baseUrl,
    grimmoryToken,
    "goodreads",
    profile["goodreads_target_shelf_name"] as string | null,
    goodreadsSourceGrimmoryIds,
    dryRun,
    adapters
  );
}

}
