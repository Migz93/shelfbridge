// Pure key derivation for probable-duplicate detection (flagging two separately
// -added books that are likely the same title for human review). Deliberately
// separate from bookIdentity.ts's identity keys, which merge same-book records
// across sources — duplicate keys instead group books that were never merged
// but probably should be reviewed as duplicates.
//
// Shared by the write side (books.duplicate_title_key/duplicate_author_key
// columns, populated in bookIdentity.ts's insertBook/updateBook) and the read
// side (routes/books.ts's indexed candidate lookup) so both stay in lockstep.

export function normalizeReviewText(value: string | null | undefined): string | null {
  const text = value
    ?.toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim() ?? null;
  return text || null;
}

export function probableDuplicateTitleKey(value: string | null | undefined): string | null {
  const stripped = value?.split(/:|\s+-\s+/)[0]?.trim();
  return normalizeReviewText(stripped);
}

export function probableDuplicateAuthorKey(value: string | null | undefined): string | null {
  return normalizeReviewText(value);
}

export function normalizeDuplicateSeriesNumber(value: string | null | undefined): string | null {
  const text = normalizeReviewText(value);
  if (!text) return null;
  return text.match(/\d+(?:\.\d+)?/)?.[0] ?? text;
}
