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

export function normalizeIsbn(value: string | number | null | undefined): string | null {
  const text = cleanIdentifier(value);
  if (!text) return null;
  const normalized = text.replace(/[\s-]/g, "").replace(/x$/i, "X");
  return normalized.length >= 10 ? normalized : null;
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
