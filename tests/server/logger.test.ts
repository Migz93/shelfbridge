import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getRecentLogs, logger, readRecentMachineLogs } from "../../src/server/logger.js";

test("recent log reader parses a bounded tail of an oversized machine log", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shelfbridge-logs-test-"));
  const filePath = path.join(dir, "machine.json");
  try {
    const older = JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", level: "info", message: "old" });
    const padding = "x".repeat(1024 * 1024);
    const newest = [
      JSON.stringify({ timestamp: "2026-01-02T00:00:00Z", level: "warn", message: "recent warning" }),
      "not json",
      JSON.stringify({ timestamp: "2026-01-03T00:00:00Z", level: "error", message: "recent error" })
    ];
    writeFileSync(filePath, `${older}\n${padding}\n${newest.join("\n")}\n`);

    const entries = await readRecentMachineLogs(filePath, 2);
    assert.deepEqual(entries.map((entry) => entry.message), ["recent warning", "recent error"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getRecentLogs clamps a negative or non-finite limit instead of returning the whole ring", () => {
  assert.deepEqual(getRecentLogs(-5), []);
  assert.deepEqual(getRecentLogs(0), []);
  assert.deepEqual(getRecentLogs(NaN), []);
  // Infinity is not finite, so clampLimit treats it the same as NaN — an
  // empty result, not "no limit" (which `array.length >= 0` would let pass
  // vacuously regardless of the actual returned contents).
  assert.deepEqual(getRecentLogs(Infinity), []);
});

test("readRecentMachineLogs clamps a negative limit to an empty result", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shelfbridge-logs-test-"));
  const filePath = path.join(dir, "machine.json");
  try {
    writeFileSync(filePath, `${JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", level: "info", message: "old" })}\n`);
    const entries = await readRecentMachineLogs(filePath, -1);
    assert.deepEqual(entries, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRecentMachineLogs falls back to the ring buffer instead of throwing when the file is missing", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shelfbridge-logs-test-"));
  const missingPath = path.join(dir, "does-not-exist.json");
  rmSync(dir, { recursive: true, force: true }); // the containing directory is gone too, not just the file

  // An empty ring would make [] === getRecentLogs(3) trivially true even for an implementation
  // that doesn't actually fall back — log a marker first so the assertion proves the ring was read.
  const marker = "machine-log-fallback-marker";
  logger.info(marker);
  const entries = await readRecentMachineLogs(missingPath, 3);
  assert.ok(entries.some((entry) => entry.message === marker));
});
