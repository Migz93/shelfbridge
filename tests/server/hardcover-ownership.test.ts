import assert from "node:assert/strict";
import test from "node:test";
import type { GrimmoryBook } from "../../src/server/sync/grimmory.js";
import {
  absOwnsSharedHardcoverRecord,
  bookOwnsSharedHardcoverRecord,
  hasActiveOwningBook,
  isOwnedBySomeoneElse,
  resolveSharedHardcoverOwnership,
  sharedHardcoverRecordFor
} from "../../src/server/sync/hardcover-ownership.js";

type OwnershipFixture = Pick<GrimmoryBook, "id" | "hardcoverBookId" | "mediaType" | "readStatus" | "lastReadTime">;

function ownershipFor(
  books: OwnershipFixture[],
  absOwnedHardcoverBookIds: ReadonlySet<string>
) {
  return resolveSharedHardcoverOwnership(
    books.map((book) => ({ title: "Test book", ...book })),
    absOwnedHardcoverBookIds
  );
}

function ownershipCheckBook(book: OwnershipFixture): GrimmoryBook {
  return { title: "Test book", ...book };
}

test("an active book sibling always outranks an active audiobook sibling", () => {
  const book = { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READING" };
  const audiobook = { id: 2, hardcoverBookId: "42", mediaType: "audiobook", readStatus: "READING" };
  const ownership = ownershipFor([book, audiobook], new Set());

  const record = sharedHardcoverRecordFor(ownership, "42");
  assert.equal(record?.owner.kind, "book");
  assert.equal(isOwnedBySomeoneElse(ownership, ownershipCheckBook(book)), false);
  assert.equal(isOwnedBySomeoneElse(ownership, ownershipCheckBook(audiobook)), true);
});

test("a runtime-validated audiobook match with no listening activity does not own the record", () => {
  // This is the exact shape of the ownership-resolver's original bug: ABS
  // confirms the file matches ("validated"), but nothing — not Grimmory, not
  // ABS — reports the user has ever opened it. A finished sibling must be
  // free to sync.
  const finishedEbook = { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READ" };
  const untouchedAudiobook = { id: 2, hardcoverBookId: "42", mediaType: "audiobook", readStatus: null };
  // absOwnedHardcoverBookIds intentionally does NOT include "42" here — the
  // caller (source-snapshots.ts) is responsible for only including a
  // Hardcover ID once real ABS listening activity is on record, which is
  // exactly the bug this resolver's caller had to fix.
  const ownership = ownershipFor([finishedEbook, untouchedAudiobook], new Set());

  assert.equal(isOwnedBySomeoneElse(ownership, ownershipCheckBook(finishedEbook)), false);
});

test("real ABS listening activity blocks a finished ebook sibling from overwriting it", () => {
  const finishedEbook = { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READ" };
  const untouchedAudiobook = { id: 2, hardcoverBookId: "42", mediaType: "audiobook", readStatus: null };
  const ownership = ownershipFor([finishedEbook, untouchedAudiobook], new Set(["42"]));

  const record = sharedHardcoverRecordFor(ownership, "42");
  assert.equal(record?.owner.kind, "abs");
  assert.equal(isOwnedBySomeoneElse(ownership, ownershipCheckBook(finishedEbook)), true);
  // The audiobook sibling itself is never blocked by ABS ownership of its own record.
  assert.equal(isOwnedBySomeoneElse(ownership, ownershipCheckBook(untouchedAudiobook)), false);
});

test("two genuinely finished siblings with no active owner: the unmatched one defers rather than competing to write", () => {
  // Unlike the "untouched audiobook" case above, BOTH siblings here have
  // real Grimmory activity of their own (both finished) — Phase F's matcher
  // already picked exactly one to own the write-back slot this run (via
  // matchedGrimmoryIds, outside this module's scope); the other must not
  // independently push a second, competing write into the same Hardcover
  // record just because neither is "actively reading" right now.
  const finishedBook = { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READ" };
  const finishedAudiobook = { id: 2, hardcoverBookId: "42", mediaType: "audiobook", readStatus: "READ" };
  const ownership = ownershipFor([finishedBook, finishedAudiobook], new Set());

  const record = sharedHardcoverRecordFor(ownership, "42");
  assert.equal(record?.owner.kind, "none", "neither finished sibling is actively reading, so there's no active owner");
  assert.equal(isOwnedBySomeoneElse(ownership, ownershipCheckBook(finishedBook)), true);
  assert.equal(isOwnedBySomeoneElse(ownership, ownershipCheckBook(finishedAudiobook)), true);
});

test("a duplicate untouched sibling of the same format must not mask a different sibling's real activity", () => {
  // Two ebook entries share hardcoverBookId "42": an untouched one with the
  // higher id (id 2) and no lastReadTime, and a genuinely finished one (id
  // 1). The anyBook/anyAudiobook tie-break (recency, then higher id) would
  // pick the untouched id-2 entry as its single representative — if the
  // no-active-owner activity check relied on that single representative, it
  // would wrongly conclude "the ebook side has no activity" and fail to
  // suppress the competing finished-audiobook write.
  const finishedEbook = { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READ" };
  const untouchedDuplicateEbook = { id: 2, hardcoverBookId: "42", mediaType: "ebook", readStatus: null };
  const finishedAudiobook = { id: 3, hardcoverBookId: "42", mediaType: "audiobook", readStatus: "READ" };
  const ownership = ownershipFor(
    [finishedEbook, untouchedDuplicateEbook, finishedAudiobook],
    new Set()
  );

  const record = sharedHardcoverRecordFor(ownership, "42");
  assert.equal(record?.owner.kind, "none");
  // Setup check: the tie-break representative really is the untouched one.
  assert.equal(record?.anyBook?.id, 2, "setup: the higher-id, no-lastReadTime entry wins the anyBook tie-break");
  assert.equal(isOwnedBySomeoneElse(ownership, ownershipCheckBook(finishedAudiobook)), true, "the ebook side's real activity (from a different sibling than the tie-break winner) must still suppress the competing audiobook write");
});

test("bookOwnsSharedHardcoverRecord requires a distinct audiobook sibling to exist", () => {
  const soloBook = { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READING" };
  const audiobook = { id: 2, hardcoverBookId: "42", mediaType: "audiobook", readStatus: "UNREAD" };

  assert.equal(bookOwnsSharedHardcoverRecord(ownershipFor([soloBook], new Set()), "42"), false);
  assert.equal(bookOwnsSharedHardcoverRecord(ownershipFor([soloBook, audiobook], new Set()), "42"), true);
});

test("hasActiveOwningBook ignores whether an audiobook sibling exists", () => {
  const book = { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READING" };
  assert.equal(hasActiveOwningBook(ownershipFor([book], new Set()), "42"), true);
});

test("absOwnsSharedHardcoverRecord is true whenever ABS owns and no book sibling is active, regardless of audiobook activity", () => {
  const inactiveBook = { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READ" };
  const activeAudiobook = { id: 2, hardcoverBookId: "42", mediaType: "audiobook", readStatus: "READING" };
  const ownership = ownershipFor([inactiveBook, activeAudiobook], new Set(["42"]));

  assert.equal(absOwnsSharedHardcoverRecord(ownership, "42"), true);
});

test("no record exists for a Hardcover ID nobody references", () => {
  const ownership = ownershipFor([], new Set());
  assert.equal(sharedHardcoverRecordFor(ownership, "42"), null);
  assert.equal(isOwnedBySomeoneElse(ownership, ownershipCheckBook({ id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READ" })), false);
});

test("two active siblings of the same format tie-break on recency, independent of input order", () => {
  const older = { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READING", lastReadTime: "2026-01-01T00:00:00Z" };
  const newer = { id: 2, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READING", lastReadTime: "2026-06-01T00:00:00Z" };

  const forward = ownershipFor([older, newer], new Set());
  const reversed = ownershipFor([newer, older], new Set());

  assert.equal(sharedHardcoverRecordFor(forward, "42")?.activeBook?.id, 2);
  assert.equal(sharedHardcoverRecordFor(reversed, "42")?.activeBook?.id, 2);
});

test("a tie-break with no usable lastReadTime falls back to the higher Grimmory book id, independent of input order", () => {
  const a = { id: 5, hardcoverBookId: "42", mediaType: "audiobook", readStatus: "READING", lastReadTime: null };
  const b = { id: 9, hardcoverBookId: "42", mediaType: "audiobook", readStatus: "READING", lastReadTime: "not-a-date" };

  const forward = ownershipFor([a, b], new Set());
  const reversed = ownershipFor([b, a], new Set());

  assert.equal(sharedHardcoverRecordFor(forward, "42")?.activeAudiobook?.id, 9);
  assert.equal(sharedHardcoverRecordFor(reversed, "42")?.activeAudiobook?.id, 9);
});
