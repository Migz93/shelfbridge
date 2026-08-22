import type { GrimmoryBook } from "./grimmory.js";
import { normalizeExternalId } from "../identifiers.js";
import { hasGrimmoryUserActivity } from "./sync-utils.js";

export function isActivelyReadingStatus(status: string | null | undefined): boolean {
  return status === "READING" || status === "RE_READING" || status === "PARTIALLY_READ";
}

function hardcoverIdForGrimmoryBook(book: GrimmoryBook): string | null {
  return normalizeExternalId(book.hardcoverBookId) ?? null;
}

/**
 * Deterministic tie-break between two actively-reading siblings of the same
 * format sharing one Hardcover record (e.g. two separate Grimmory entries
 * for the same audiobook). Picks whichever was read more recently; when
 * neither or both lack a usable lastReadTime, falls back to the higher
 * Grimmory book id so the result never depends on fetch/array order.
 */
function preferMoreRecentlyActive(a: GrimmoryBook, b: GrimmoryBook): GrimmoryBook {
  const aTime = a.lastReadTime ? Date.parse(a.lastReadTime) : NaN;
  const bTime = b.lastReadTime ? Date.parse(b.lastReadTime) : NaN;
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  if (aValid && bValid && aTime !== bTime) return aTime > bTime ? a : b;
  if (aValid !== bValid) return aValid ? a : b;
  return a.id >= b.id ? a : b;
}

export type SharedHardcoverOwner =
  | { kind: "book"; grimmoryBookId: number; reason: "active_book_sibling" }
  | { kind: "audiobook"; grimmoryBookId: number; reason: "active_audiobook_sibling" }
  | { kind: "abs"; reason: "abs_listening_activity" }
  | { kind: "none"; reason: "no_active_owner" };

export interface SharedHardcoverRecord {
  hardcoverBookId: string;
  activeBook: GrimmoryBook | null;
  activeAudiobook: GrimmoryBook | null;
  /** Any book/ebook Grimmory sibling sharing this Hardcover book, active or
   * not — unlike activeBook, existence (not reading activity) is what a
   * local-presence signal like the Owned-list fallback needs. */
  anyBook: GrimmoryBook | null;
  /** Any audiobook Grimmory sibling sharing this Hardcover book, active or not. */
  anyAudiobook: GrimmoryBook | null;
  /** Whether *any* Grimmory audiobook entry (active or not) shares this Hardcover
   * book — a work only counts as "shared" for bucketing purposes once both an
   * audio and a non-audio edition are actually present. */
  hasAudiobookSibling: boolean;
  /** True when *any* book/ebook sibling (not just the anyBook tie-break
   * winner — there can be duplicate Grimmory entries for the same format)
   * has real Grimmory activity of its own. Needed because anyBook is picked
   * for determinism (recency, then id), not activity, so it can land on an
   * untouched duplicate while a different sibling of the same format is the
   * one with real progress. */
  anyBookHasActivity: boolean;
  /** True when *any* audiobook sibling has real Grimmory activity of its own — see anyBookHasActivity. */
  anyAudiobookHasActivity: boolean;
  /** Runtime-validated Audiobookshelf match with real reported listening activity. */
  absOwned: boolean;
  owner: SharedHardcoverOwner;
}

export type SharedHardcoverOwnership = ReadonlyMap<string, SharedHardcoverRecord>;

/**
 * Resolves, once per sync run, which sibling format owns each shared
 * Hardcover record (a Hardcover book that multiple local Grimmory editions
 * map to). Every phase that needs to decide whether a book may write its
 * own status/progress/rating to a shared Hardcover user_book should consult
 * this instead of re-deriving the answer independently — that duplication
 * is what previously let an ABS-matched-but-never-opened audiobook
 * permanently block a finished ebook sibling from ever syncing (see the
 * ownership-consolidation issue this module resolves).
 *
 * Precedence: an actively-reading book/print sibling always wins, then an
 * actively-reading audiobook sibling, then ABS-reported listening activity
 * on a runtime-validated audiobook match. A finished or untouched sibling
 * never owns the record. When two siblings of the same format are both
 * actively reading (e.g. duplicate Grimmory entries for the same book), the
 * more recently read one wins, falling back to the higher Grimmory book id
 * so the result never depends on fetch/array order.
 */
export function resolveSharedHardcoverOwnership(
  grimmoryBooks: GrimmoryBook[],
  absOwnedHardcoverBookIds: ReadonlySet<string>
): SharedHardcoverOwnership {
  const records = new Map<string, SharedHardcoverRecord>();

  const recordFor = (hardcoverBookId: string): SharedHardcoverRecord => {
    let record = records.get(hardcoverBookId);
    if (!record) {
      record = {
        hardcoverBookId,
        activeBook: null,
        activeAudiobook: null,
        anyBook: null,
        anyAudiobook: null,
        hasAudiobookSibling: false,
        anyBookHasActivity: false,
        anyAudiobookHasActivity: false,
        absOwned: absOwnedHardcoverBookIds.has(hardcoverBookId),
        owner: { kind: "none", reason: "no_active_owner" }
      };
      records.set(hardcoverBookId, record);
    }
    return record;
  };

  for (const book of grimmoryBooks) {
    const hardcoverBookId = hardcoverIdForGrimmoryBook(book);
    if (!hardcoverBookId) continue;
    const record = recordFor(hardcoverBookId);
    if (book.mediaType === "audiobook") {
      record.hasAudiobookSibling = true;
      record.anyAudiobook = record.anyAudiobook ? preferMoreRecentlyActive(record.anyAudiobook, book) : book;
      if (hasGrimmoryUserActivity(book)) record.anyAudiobookHasActivity = true;
      if (isActivelyReadingStatus(book.readStatus)) {
        record.activeAudiobook = record.activeAudiobook ? preferMoreRecentlyActive(record.activeAudiobook, book) : book;
      }
    } else {
      record.anyBook = record.anyBook ? preferMoreRecentlyActive(record.anyBook, book) : book;
      if (hasGrimmoryUserActivity(book)) record.anyBookHasActivity = true;
      if (isActivelyReadingStatus(book.readStatus)) {
        record.activeBook = record.activeBook ? preferMoreRecentlyActive(record.activeBook, book) : book;
      }
    }
  }

  // absOwnedHardcoverBookIds can name a Hardcover book with no matching
  // audiobook entry in *this run's* live Grimmory fetch (e.g. Grimmory is
  // temporarily unavailable but the previous run's ABS link snapshot still
  // stands) — make sure a record exists for those too.
  for (const hardcoverBookId of absOwnedHardcoverBookIds) recordFor(hardcoverBookId);

  for (const record of records.values()) {
    if (record.activeBook) {
      record.owner = { kind: "book", grimmoryBookId: record.activeBook.id, reason: "active_book_sibling" };
    } else if (record.activeAudiobook) {
      record.owner = { kind: "audiobook", grimmoryBookId: record.activeAudiobook.id, reason: "active_audiobook_sibling" };
    } else if (record.absOwned) {
      record.owner = { kind: "abs", reason: "abs_listening_activity" };
    }
  }

  return records;
}

export function sharedHardcoverRecordFor(
  ownership: SharedHardcoverOwnership,
  hardcoverBookId: number | string | null | undefined
): SharedHardcoverRecord | null {
  const id = normalizeExternalId(hardcoverBookId);
  return id ? ownership.get(id) ?? null : null;
}

/**
 * True when grBook must back off from writing its own status/progress to
 * a shared Hardcover record because another sibling — or ABS listening
 * activity on the audiobook sibling — already owns it.
 *
 * Callers only invoke this for a grBook Phase F did *not* match to its
 * hcBook this run (see grimmory-state.ts's Phase G fallback, the only
 * caller). When no active owner exists either (`owner.kind === "none"`,
 * e.g. both siblings finished/inactive), a real Hardcover write is only
 * suppressed if *some* sibling of the opposite format has genuine Grimmory
 * activity of its own (`anyBookHasActivity`/`anyAudiobookHasActivity` —
 * checked across every sibling of that format, not just the `anyBook`/
 * `anyAudiobook` tie-break representative, since a duplicate untouched
 * Grimmory entry of the same format could otherwise win that tie-break and
 * mask a different, genuinely active sibling) — Phase F's matcher already
 * picked exactly one side to own the write-back slot this run, so the
 * other side must defer rather than push a second, competing write into
 * the same Hardcover record, mirroring the `'shared'` book_sources
 * bucket's local-only, no-write-back guarantee (see hardcover-sources.ts /
 * docs/sync.md's Hardcover Owned-List Import). An opposite format with
 * zero activity across every one of its siblings must not block this
 * grBook — that's the original ABS-ownership-consolidation case this
 * module was built to fix (a finished sibling must stay free to sync
 * against an ABS-matched-but-never-opened audiobook).
 */
export function isOwnedBySomeoneElse(ownership: SharedHardcoverOwnership, grBook: GrimmoryBook): boolean {
  const record = sharedHardcoverRecordFor(ownership, grBook.hardcoverBookId);
  if (!record) return false;
  if (record.owner.kind === "book" || record.owner.kind === "audiobook") {
    return record.owner.grimmoryBookId !== grBook.id;
  }
  if (record.owner.kind === "abs") {
    return grBook.mediaType !== "audiobook";
  }
  return grBook.mediaType === "audiobook" ? record.anyBookHasActivity : record.anyAudiobookHasActivity;
}

/**
 * True when an active print/ebook Grimmory sibling owns a Hardcover work it
 * shares with a distinct audiobook sibling — used to keep the shared
 * book_sources row bucketed as physical/ebook regardless of which edition
 * Hardcover currently reports as "current" for it.
 */
export function bookOwnsSharedHardcoverRecord(
  ownership: SharedHardcoverOwnership,
  hardcoverBookId: number | string | null | undefined
): boolean {
  const record = sharedHardcoverRecordFor(ownership, hardcoverBookId);
  return !!record && record.hasAudiobookSibling && record.owner.kind === "book";
}

/**
 * True when an active print/ebook Grimmory sibling owns this Hardcover
 * work, whether or not a distinct audiobook sibling exists.
 */
export function hasActiveOwningBook(
  ownership: SharedHardcoverOwnership,
  hardcoverBookId: number | string | null | undefined
): boolean {
  return sharedHardcoverRecordFor(ownership, hardcoverBookId)?.owner.kind === "book";
}

/**
 * True when this Hardcover work's audiobook edition is owned by ABS
 * listening activity or an active Grimmory audiobook sibling rather than by
 * an active book/print sibling.
 */
export function absOwnsSharedHardcoverRecord(
  ownership: SharedHardcoverOwnership,
  hardcoverBookId: number | string | null | undefined
): boolean {
  const record = sharedHardcoverRecordFor(ownership, hardcoverBookId);
  return !!record && record.owner.kind !== "book" && record.absOwned;
}
