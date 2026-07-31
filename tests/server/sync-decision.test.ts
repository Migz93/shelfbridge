import assert from "node:assert/strict";
import test from "node:test";
import { computeSyncDecision, type ConflictStrategy } from "../../src/server/sync/engine.js";
import type { HardcoverUserBook } from "../../src/server/sync/hardcover.js";
import type { GrimmoryBook } from "../../src/server/sync/grimmory.js";

function hcBook(overrides: Partial<HardcoverUserBook> = {}): HardcoverUserBook {
  return {
    id: 1,
    edition_id: null,
    status_id: null,
    rating: null,
    updated_at: null,
    first_started_reading_date: null,
    last_read_date: null,
    book: { id: 1, title: "Test Book", slug: "test-book" },
    user_book_reads: null,
    ...overrides
  } as HardcoverUserBook;
}

function grBook(overrides: Partial<GrimmoryBook> = {}): GrimmoryBook {
  return { id: 1, title: "Test Book", ...overrides };
}

const STRATEGIES: ConflictStrategy[] = ["latest_wins", "grimmory_wins", "hardcover_wins"];

test("no Grimmory match -> missing, no writes, regardless of conflict strategy", () => {
  for (const conflictStrategy of STRATEGIES) {
    const result = computeSyncDecision({
      hcBook: hcBook({ status_id: 2 }),
      grBook: null,
      conflictStrategy,
      syncStatusEnabled: true,
      previousGrimmoryStatus: null,
      previousHardcoverStatusId: null
    });
    assert.deepEqual(result, { decision: "no_grimmory_match", syncHealth: "missing", writeGrimmory: false, writeHardcover: false });
  }
});

test("status sync disabled -> no_status_to_sync, no writes", () => {
  const result = computeSyncDecision({
    hcBook: hcBook({ status_id: 2 }),
    grBook: grBook({ readStatus: "READING" }),
    conflictStrategy: "latest_wins",
    syncStatusEnabled: false,
    previousGrimmoryStatus: null,
    previousHardcoverStatusId: null
  });
  assert.deepEqual(result, { decision: "no_status_to_sync", syncHealth: "synced", writeGrimmory: false, writeHardcover: false });
});

test("both sides have no status -> no_status_to_sync", () => {
  const result = computeSyncDecision({
    hcBook: hcBook({ status_id: null }),
    grBook: grBook({ readStatus: null }),
    conflictStrategy: "latest_wins",
    syncStatusEnabled: true,
    previousGrimmoryStatus: null,
    previousHardcoverStatusId: null
  });
  assert.deepEqual(result, { decision: "no_status_to_sync", syncHealth: "synced", writeGrimmory: false, writeHardcover: false });
});

test("statuses already map to each other -> already_synced, no writes", () => {
  // status_id 3 ("READ") maps to grimmory "READ" — already in agreement.
  const result = computeSyncDecision({
    hcBook: hcBook({ status_id: 3 }),
    grBook: grBook({ readStatus: "READ" }),
    conflictStrategy: "latest_wins",
    syncStatusEnabled: true,
    previousGrimmoryStatus: "READ",
    previousHardcoverStatusId: 3
  });
  assert.deepEqual(result, { decision: "already_synced", syncHealth: "synced", writeGrimmory: false, writeHardcover: false });
});

test("only Grimmory changed since last sync -> propagates to Hardcover", () => {
  const result = computeSyncDecision({
    hcBook: hcBook({ status_id: 1 }), // unchanged from previous
    grBook: grBook({ readStatus: "READING" }),
    conflictStrategy: "latest_wins",
    syncStatusEnabled: true,
    previousGrimmoryStatus: "UNREAD",
    previousHardcoverStatusId: 1
  });
  assert.deepEqual(result, { decision: "grimmory_status_changed", syncHealth: "synced", writeGrimmory: false, writeHardcover: true });
});

test("only Hardcover changed since last sync -> propagates to Grimmory", () => {
  const result = computeSyncDecision({
    hcBook: hcBook({ status_id: 2 }),
    grBook: grBook({ readStatus: "UNREAD" }), // unchanged from previous
    conflictStrategy: "latest_wins",
    syncStatusEnabled: true,
    previousGrimmoryStatus: "UNREAD",
    previousHardcoverStatusId: 1
  });
  assert.deepEqual(result, { decision: "hardcover_status_changed", syncHealth: "synced", writeGrimmory: true, writeHardcover: false });
});

test("both changed since last sync: hardcover_wins strategy writes to Grimmory", () => {
  const result = computeSyncDecision({
    hcBook: hcBook({ status_id: 2 }),
    grBook: grBook({ readStatus: "READ" }),
    conflictStrategy: "hardcover_wins",
    syncStatusEnabled: true,
    previousGrimmoryStatus: "UNREAD",
    previousHardcoverStatusId: 1
  });
  assert.deepEqual(result, { decision: "both_changed_hardcover_wins", syncHealth: "synced", writeGrimmory: true, writeHardcover: false });
});

test("both changed since last sync: grimmory_wins strategy writes to Hardcover", () => {
  const result = computeSyncDecision({
    hcBook: hcBook({ status_id: 2 }),
    grBook: grBook({ readStatus: "READ" }),
    conflictStrategy: "grimmory_wins",
    syncStatusEnabled: true,
    previousGrimmoryStatus: "UNREAD",
    previousHardcoverStatusId: 1
  });
  assert.deepEqual(result, { decision: "both_changed_grimmory_wins", syncHealth: "synced", writeGrimmory: false, writeHardcover: true });
});

test("both changed, grimmory_wins, but Grimmory status has no Hardcover mapping -> ignored", () => {
  const result = computeSyncDecision({
    hcBook: hcBook({ status_id: 2 }),
    grBook: grBook({ readStatus: "UNREAD" }), // GRIMMORY_TO_HARDCOVER has no UNREAD entry
    conflictStrategy: "grimmory_wins",
    syncStatusEnabled: true,
    previousGrimmoryStatus: "READING",
    previousHardcoverStatusId: 1
  });
  assert.deepEqual(result, { decision: "grimmory_status_ignored", syncHealth: "synced", writeGrimmory: false, writeHardcover: false });
});

test("steady-state conflict (no prior status recorded): hardcover_wins always writes Grimmory", () => {
  const result = computeSyncDecision({
    hcBook: hcBook({ status_id: 2 }),
    grBook: grBook({ readStatus: "READ" }),
    conflictStrategy: "hardcover_wins",
    syncStatusEnabled: true,
    previousGrimmoryStatus: null,
    previousHardcoverStatusId: null
  });
  assert.deepEqual(result, { decision: "hardcover_wins", syncHealth: "synced", writeGrimmory: true, writeHardcover: false });
});

test("steady-state conflict: grimmory_wins writes Hardcover when mappable", () => {
  const result = computeSyncDecision({
    hcBook: hcBook({ status_id: 2 }),
    grBook: grBook({ readStatus: "READ" }),
    conflictStrategy: "grimmory_wins",
    syncStatusEnabled: true,
    previousGrimmoryStatus: null,
    previousHardcoverStatusId: null
  });
  assert.deepEqual(result, { decision: "grimmory_wins", syncHealth: "synced", writeGrimmory: false, writeHardcover: true });
});

test("steady-state conflict: latest_wins picks the side with the newer timestamp (hardcover newer)", () => {
  const result = computeSyncDecision({
    hcBook: hcBook({ status_id: 2, updated_at: "2026-01-02T00:00:00Z" }),
    grBook: grBook({ readStatus: "READ", lastReadTime: "2026-01-01T00:00:00Z" }),
    conflictStrategy: "latest_wins",
    syncStatusEnabled: true,
    previousGrimmoryStatus: null,
    previousHardcoverStatusId: null
  });
  assert.deepEqual(result, { decision: "latest_wins_hardcover", syncHealth: "synced", writeGrimmory: true, writeHardcover: false });
});

test("steady-state conflict: latest_wins picks the side with the newer timestamp (grimmory newer)", () => {
  const result = computeSyncDecision({
    hcBook: hcBook({ status_id: 2, updated_at: "2026-01-01T00:00:00Z" }),
    grBook: grBook({ readStatus: "READ", lastReadTime: "2026-01-02T00:00:00Z" }),
    conflictStrategy: "latest_wins",
    syncStatusEnabled: true,
    previousGrimmoryStatus: null,
    previousHardcoverStatusId: null
  });
  assert.deepEqual(result, { decision: "latest_wins_grimmory", syncHealth: "synced", writeGrimmory: false, writeHardcover: true });
});

test("steady-state conflict: latest_wins with no timestamps on either side prefers Hardcover", () => {
  const result = computeSyncDecision({
    hcBook: hcBook({ status_id: 2, updated_at: null }),
    grBook: grBook({ readStatus: "READ", lastReadTime: null }),
    conflictStrategy: "latest_wins",
    syncStatusEnabled: true,
    previousGrimmoryStatus: null,
    previousHardcoverStatusId: null
  });
  assert.deepEqual(result, { decision: "no_timestamps_hardcover_preferred", syncHealth: "synced", writeGrimmory: true, writeHardcover: false });
});

test("Hardcover has a status, Grimmory has none -> hardcover_only_status writes Grimmory", () => {
  const result = computeSyncDecision({
    hcBook: hcBook({ status_id: 2 }),
    grBook: grBook({ readStatus: null }),
    conflictStrategy: "latest_wins",
    syncStatusEnabled: true,
    previousGrimmoryStatus: null,
    previousHardcoverStatusId: null
  });
  assert.deepEqual(result, { decision: "hardcover_only_status", syncHealth: "synced", writeGrimmory: true, writeHardcover: false });
});

test("Grimmory has a status, Hardcover has none, and it maps -> grimmory_only_status writes Hardcover", () => {
  const result = computeSyncDecision({
    hcBook: hcBook({ status_id: null }),
    grBook: grBook({ readStatus: "READ" }),
    conflictStrategy: "latest_wins",
    syncStatusEnabled: true,
    previousGrimmoryStatus: null,
    previousHardcoverStatusId: null
  });
  assert.deepEqual(result, { decision: "grimmory_only_status", syncHealth: "synced", writeGrimmory: false, writeHardcover: true });
});

test("Grimmory has a status with no Hardcover mapping, Hardcover has none -> ignored", () => {
  const result = computeSyncDecision({
    hcBook: hcBook({ status_id: null }),
    grBook: grBook({ readStatus: "UNREAD" }),
    conflictStrategy: "latest_wins",
    syncStatusEnabled: true,
    previousGrimmoryStatus: null,
    previousHardcoverStatusId: null
  });
  assert.deepEqual(result, { decision: "grimmory_status_ignored", syncHealth: "synced", writeGrimmory: false, writeHardcover: false });
});
