import { normalizeExternalId } from "../identifiers.js";

/** The subset of a per-(book, profile) row needed to detect a cross-reference ID conflict. */
export interface IdentityReviewRow {
  profile_id: number;
  goodreads_book_id: string | null;
  grimmory_goodreads_id: string | null;
  hardcover_book_id: number | null;
  grimmory_hardcover_book_id: string | null;
}

function distinctClean(values: Array<string | number | null | undefined>): string[] {
  return Array.from(new Set(
    values
      .map((value) => normalizeExternalId(value))
      .filter((value): value is string => value !== null)
  ));
}

function distinctComparableIds(
  rows: Array<Pick<IdentityReviewRow, "goodreads_book_id" | "grimmory_goodreads_id" | "hardcover_book_id" | "grimmory_hardcover_book_id">>,
  source: "goodreads" | "hardcover"
): string[] {
  // Only the source's own authoritative ID belongs here — hasAggregateSourceReviewConflict
  // compares this set against Grimmory's cross-reference ID below. Folding
  // Grimmory's own ID into this set as well would make that comparison
  // tautological (the value would always be found "in" the set it came from),
  // masking real conflicts between the two.
  if (source === "goodreads") {
    const comparableRows = rows.filter((row) => normalizeExternalId(row.goodreads_book_id) !== null);
    return distinctClean(comparableRows.map((row) => row.goodreads_book_id));
  }

  // Only compare Grimmory's stored Hardcover ID when we also have a ShelfBridge
  // Hardcover source row for the canonical book. Grimmory can legitimately carry
  // a Hardcover cross-reference for books that never came from Hardcover.
  const comparableRows = rows.filter((row) => row.hardcover_book_id !== null);
  return distinctClean(comparableRows.map((row) => row.hardcover_book_id));
}

function hasAggregateSourceReviewConflict(
  rows: Array<Pick<IdentityReviewRow, "goodreads_book_id" | "grimmory_goodreads_id" | "hardcover_book_id" | "grimmory_hardcover_book_id">>,
  source: "goodreads" | "hardcover"
): boolean {
  const sourceIds = distinctComparableIds(rows, source);
  const grimmoryIds = source === "goodreads"
    ? distinctClean(rows.map((row) => row.grimmory_goodreads_id))
    : distinctClean(rows.map((row) => row.grimmory_hardcover_book_id));

  // If Grimmory doesn't carry an ID for this source, there is nothing actionable
  // to review here beyond the canonical merge itself.
  if (grimmoryIds.length === 0) return false;
  if (grimmoryIds.length > 1) return true;

  const [grimmoryId] = grimmoryIds;
  return grimmoryId !== undefined && sourceIds.length > 0 && !sourceIds.includes(grimmoryId);
}

// book_sources rows for Grimmory/Hardcover/Goodreads are now scoped per profile
// instance (see schema v14), so the same book can legitimately carry different
// cross-reference IDs on different profiles' own servers — that's not a conflict.
// Evaluate each profile's own rows independently rather than aggregating IDs
// across every profile sharing this book.
export function hasIdentityReviewConflict<T extends IdentityReviewRow>(rows: T[]): boolean {
  const byProfile = new Map<number, T[]>();
  for (const row of rows) {
    const group = byProfile.get(row.profile_id) ?? [];
    group.push(row);
    byProfile.set(row.profile_id, group);
  }
  return Array.from(byProfile.values()).some((profileRows) =>
    hasAggregateSourceReviewConflict(profileRows, "goodreads")
      || hasAggregateSourceReviewConflict(profileRows, "hardcover")
  );
}
