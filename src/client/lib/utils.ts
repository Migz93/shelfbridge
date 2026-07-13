// SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" with no timezone marker.
// Without a Z the browser parses it as local time, making everything appear offset.
// Normalise to a UTC ISO string before any Date construction.
export function toUtcDate(iso: string): Date {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso)) {
    return new Date(iso.replace(" ", "T") + "Z");
  }
  return new Date(iso);
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - toUtcDate(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs >= 0) {
    if (secs < 60) return "just now";
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
  }
  // Future time
  const absSecs = Math.abs(secs);
  if (absSecs < 60) return "in a moment";
  const absMins = Math.floor(absSecs / 60);
  if (absMins < 60) return `in ${absMins}m`;
  const absHours = Math.floor(absMins / 60);
  if (absHours < 24) return `in ${absHours}h`;
  const absDays = Math.floor(absHours / 24);
  return `in ${absDays}d`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return toUtcDate(iso).toLocaleString();
}

export function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  return toUtcDate(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function statusLabel(status: string | null | undefined): string {
  const map: Record<string, string> = {
    UNREAD: "Unread",
    READING: "Reading",
    READ: "Read",
    ABANDONED: "Did Not Finish",
    RE_READING: "Re-reading",
    PARTIALLY_READ: "Partially Read",
    PAUSED: "Paused",
    WONT_READ: "Won't Read",
    UNSET: "Unset"
  };
  return map[status ?? ""] ?? status ?? "—";
}

export function hardcoverStatusLabel(statusId: number | null | undefined): string {
  const map: Record<number, string> = {
    1: "Want to Read",
    2: "Currently Reading",
    3: "Read",
    4: "Paused",
    5: "Did Not Finish",
    6: "Ignored"
  };
  return statusId !== null && statusId !== undefined ? (map[statusId] ?? String(statusId)) : "—";
}
