export function cleanIdentifier(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function normalizeExternalId(value: string | number | null | undefined): string | null {
  const text = cleanIdentifier(value);
  if (!text) return null;
  // Grimmory sometimes stores numeric external IDs with a human-readable suffix
  // after a separator, e.g. `78129-Killing_Floor` or `78129.Killing_Floor`.
  const numericPrefix = text.match(/^(\d+)(?:[._-].*)?$/);
  return numericPrefix?.[1] ?? text;
}

function isbn10ChecksumValid(isbn: string): boolean {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const char = isbn[i];
    const digit = char === "X" ? 10 : Number(char);
    sum += digit * (10 - i);
  }
  return sum % 11 === 0;
}

function isbn13ChecksumValid(isbn: string): boolean {
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    sum += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}

// A checksum-invalid ISBN is most likely a typo in source metadata. Treat it
// like a missing ISBN (return null) rather than throwing, so it falls back to
// other identity signals instead of becoming a bad merge key.
export function normalizeIsbn(value: string | number | null | undefined): string | null {
  const text = cleanIdentifier(value);
  if (!text) return null;
  const normalized = text.replace(/[\s\-\u2010-\u2015]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(normalized)) return isbn10ChecksumValid(normalized) ? normalized : null;
  if (/^\d{13}$/.test(normalized)) return isbn13ChecksumValid(normalized) ? normalized : null;
  return null;
}

export function identifierVariants(value: string | number | null | undefined): string[] {
  const raw = cleanIdentifier(value);
  const normalized = normalizeExternalId(raw);
  return Array.from(new Set([raw, normalized].filter((id): id is string => id !== null)));
}

export function identifiersEqual(
  a: string | number | null | undefined,
  b: string | number | null | undefined
): boolean {
  const left = normalizeExternalId(a);
  const right = normalizeExternalId(b);
  return left !== null && right !== null && left === right;
}
