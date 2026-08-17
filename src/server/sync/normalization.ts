/** Strip parenthetical series info, then lowercase and keep alphanumeric words. */
export function normalizeTitle(title: string): string {
  return title
    .replace(/\s*\(.*?\)\s*/g, " ")
    .toLowerCase()
    // Unicode-aware: an ASCII-only character class would strip every letter
    // out of a non-Latin title (Cyrillic, CJK, etc.), normalizing it to "" and
    // defeating title-based matching entirely for those libraries.
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSeriesNumber(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  const match = text.match(/\d+(?:\.\d+)?/);
  return match?.[0] ?? text.replace(/\s+/g, " ");
}
