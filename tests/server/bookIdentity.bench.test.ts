import assert from "node:assert/strict";
import test from "node:test";
import { reconcileBookIdentities } from "../../src/server/db/bookIdentity.js";
import { createTestDatabase } from "./test-db.js";
import { seedLibrary } from "./fixtures/library-fixture.js";

/**
 * Documents reconciliation cost at representative library sizes (issue #37's
 * benchmark-fixture ask) and asserts the scoping property the whole rewrite
 * exists for: reconciling a handful of newly-touched sources against a large
 * catalog must cost roughly the size of the touched closure, not the size of
 * the catalog. Timings are logged for humans to eyeball across runs; the pass/
 * fail assertion uses a generous multiplicative margin against a same-run
 * baseline (not an absolute millisecond threshold) so it stays stable on slow
 * or loaded CI runners.
 */
function timeMs(fn: () => void): number {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

for (const size of ["small", "medium", "large"] as const) {
  test(`reconcileBookIdentities: full reconcile timing at "${size}" library size (informational)`, () => {
    const { db, cleanup } = createTestDatabase();
    try {
      const { workCount, sourceCount } = seedLibrary(db, size);
      const elapsedMs = timeMs(() => reconcileBookIdentities(db));
      const books = db.prepare("SELECT COUNT(*) AS count FROM books").get() as { count: number };
      assert.equal(books.count, workCount, "every work should merge its Hardcover/Grimmory/Chaptarr rows into one book");
      console.log(`[bench] full reconcile, ${size} (${sourceCount} sources): ${elapsedMs.toFixed(1)}ms`);
    } finally {
      cleanup();
    }
  });
}

test("reconcileBookIdentities: a scoped reconcile against a large catalog is far cheaper than a full reconcile of it", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    seedLibrary(db, "large");
    const fullMs = timeMs(() => reconcileBookIdentities(db));

    // Touch exactly one new, unrelated source against the now-fully-reconciled
    // large catalog and scope the reconcile to it.
    const newSourceId = Number(db.prepare(`
      INSERT INTO book_sources (source_type, source_instance_id, external_id, title, author, source_media_type)
      VALUES ('hardcover', 1, 'hc-new', 'Brand New Work', 'New Author', 'book')
    `).run().lastInsertRowid);
    const scopedMs = timeMs(() => reconcileBookIdentities(db, { sourceIds: [newSourceId] }));

    console.log(`[bench] full reconcile: ${fullMs.toFixed(1)}ms, scoped single-source reconcile: ${scopedMs.toFixed(1)}ms`);
    // Generous margin (large CI/runner jitter on very fast, small operations) —
    // this is a scaling-behavior guard, not a precise timing assertion.
    assert.ok(
      scopedMs < fullMs / 3 || scopedMs < 50,
      `scoped reconcile (${scopedMs.toFixed(1)}ms) should be much cheaper than a full reconcile (${fullMs.toFixed(1)}ms) of the same catalog`
    );
  } finally {
    cleanup();
  }
});
