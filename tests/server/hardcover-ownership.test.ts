import assert from "node:assert/strict";
import test from "node:test";
import {
  absOwnsSharedHardcoverRecord,
  bookOwnsSharedHardcoverRecord,
  hasActiveOwningBook,
  isOwnedBySomeoneElse,
  resolveSharedHardcoverOwnership,
  sharedHardcoverRecordFor
} from "../../src/server/sync/hardcover-ownership.js";

test("an active book sibling always outranks an active audiobook sibling", () => {
  const book = { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READING" };
  const audiobook = { id: 2, hardcoverBookId: "42", mediaType: "audiobook", readStatus: "READING" };
  const ownership = resolveSharedHardcoverOwnership([book, audiobook] as any, new Set());

  const record = sharedHardcoverRecordFor(ownership, "42");
  assert.equal(record?.owner.kind, "book");
  assert.equal(isOwnedBySomeoneElse(ownership, book as any), false);
  assert.equal(isOwnedBySomeoneElse(ownership, audiobook as any), true);
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
  const ownership = resolveSharedHardcoverOwnership([finishedEbook, untouchedAudiobook] as any, new Set());

  assert.equal(isOwnedBySomeoneElse(ownership, finishedEbook as any), false);
});

test("real ABS listening activity blocks a finished ebook sibling from overwriting it", () => {
  const finishedEbook = { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READ" };
  const untouchedAudiobook = { id: 2, hardcoverBookId: "42", mediaType: "audiobook", readStatus: null };
  const ownership = resolveSharedHardcoverOwnership([finishedEbook, untouchedAudiobook] as any, new Set(["42"]));

  const record = sharedHardcoverRecordFor(ownership, "42");
  assert.equal(record?.owner.kind, "abs");
  assert.equal(isOwnedBySomeoneElse(ownership, finishedEbook as any), true);
  // The audiobook sibling itself is never blocked by ABS ownership of its own record.
  assert.equal(isOwnedBySomeoneElse(ownership, untouchedAudiobook as any), false);
});

test("bookOwnsSharedHardcoverRecord requires a distinct audiobook sibling to exist", () => {
  const soloBook = { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READING" };
  const audiobook = { id: 2, hardcoverBookId: "42", mediaType: "audiobook", readStatus: "UNREAD" };

  assert.equal(bookOwnsSharedHardcoverRecord(resolveSharedHardcoverOwnership([soloBook] as any, new Set()), "42"), false);
  assert.equal(bookOwnsSharedHardcoverRecord(resolveSharedHardcoverOwnership([soloBook, audiobook] as any, new Set()), "42"), true);
});

test("hasActiveOwningBook ignores whether an audiobook sibling exists", () => {
  const book = { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READING" };
  assert.equal(hasActiveOwningBook(resolveSharedHardcoverOwnership([book] as any, new Set()), "42"), true);
});

test("absOwnsSharedHardcoverRecord is true whenever ABS owns and no book sibling is active, regardless of audiobook activity", () => {
  const inactiveBook = { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READ" };
  const activeAudiobook = { id: 2, hardcoverBookId: "42", mediaType: "audiobook", readStatus: "READING" };
  const ownership = resolveSharedHardcoverOwnership([inactiveBook, activeAudiobook] as any, new Set(["42"]));

  assert.equal(absOwnsSharedHardcoverRecord(ownership, "42"), true);
});

test("no record exists for a Hardcover ID nobody references", () => {
  const ownership = resolveSharedHardcoverOwnership([], new Set());
  assert.equal(sharedHardcoverRecordFor(ownership, "42"), null);
  assert.equal(isOwnedBySomeoneElse(ownership, { id: 1, hardcoverBookId: "42", mediaType: "ebook", readStatus: "READ" } as any), false);
});
