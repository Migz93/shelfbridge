import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "../../src/server/sync/concurrency.js";

test("a large author queue never exceeds its configured concurrency", async () => {
  let active = 0;
  let peak = 0;
  const authors = Array.from({ length: 100 }, (_, index) => index);

  const results = await mapWithConcurrency(authors, 3, async (author) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return author * 2;
  });

  assert.equal(peak, 3);
  assert.deepEqual(results, authors.map((author) => author * 2));
});
