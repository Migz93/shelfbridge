import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase } from "./test-db.js";

/**
 * Mirrors the dismissal-join fragment in routes/books.ts: a dismissal only
 * suppresses the mismatch it was raised against, by signature
 * (chaptarr_external_id, dismissed_hardcover_book_id, dismissed_goodreads_book_id).
 */
function isDismissed(
  db: ReturnType<typeof createTestDatabase>["db"],
  chaptarrExternalId: string
): boolean {
  const row = db.prepare(`
    SELECT CASE WHEN chap_dismiss.id IS NULL THEN 0 ELSE 1 END AS dismissed
    FROM book_sources chap_src
    LEFT JOIN chaptarr_id_mismatch_dismissals chap_dismiss
      ON chap_dismiss.chaptarr_external_id = chap_src.external_id
      AND chap_dismiss.dismissed_hardcover_book_id IS chap_src.source_hardcover_book_id
      AND chap_dismiss.dismissed_goodreads_book_id IS chap_src.source_goodreads_book_id
    WHERE chap_src.source_type = 'chaptarr' AND chap_src.external_id = ?
  `).get(chaptarrExternalId) as { dismissed: number };
  return row.dismissed === 1;
}

test("a Chaptarr ID mismatch dismissal re-arms once the observed mismatch changes", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const bookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Book')").run().lastInsertRowid);
    db.prepare(`
      INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, title, chaptarr_id_mismatch, source_hardcover_book_id)
      VALUES (?, 'chaptarr', 0, 'chap-1', 'Book', 1, 'hc-old')
    `).run(bookId);

    // Dismiss the mismatch as it stands today (hc-old).
    db.prepare(`
      INSERT INTO chaptarr_id_mismatch_dismissals (chaptarr_external_id, dismissed_hardcover_book_id, dismissed_goodreads_book_id)
      VALUES ('chap-1', 'hc-old', NULL)
    `).run();
    assert.equal(isDismissed(db, "chap-1"), true, "the dismissal should suppress the mismatch it was raised against");

    // A later Chaptarr sync reports a different upstream Hardcover id.
    db.prepare("UPDATE book_sources SET source_hardcover_book_id = 'hc-new' WHERE external_id = 'chap-1'").run();
    assert.equal(isDismissed(db, "chap-1"), false, "a changed upstream id must re-arm the mismatch instead of staying silently dismissed");

    // Re-dismissing the new mismatch suppresses it again.
    db.prepare(`
      INSERT INTO chaptarr_id_mismatch_dismissals (chaptarr_external_id, dismissed_hardcover_book_id, dismissed_goodreads_book_id)
      VALUES ('chap-1', 'hc-new', NULL)
      ON CONFLICT(chaptarr_external_id) DO UPDATE SET
        dismissed_hardcover_book_id = excluded.dismissed_hardcover_book_id,
        dismissed_goodreads_book_id = excluded.dismissed_goodreads_book_id
    `).run();
    assert.equal(isDismissed(db, "chap-1"), true, "re-dismissing against the new mismatch should suppress it again");
  } finally {
    cleanup();
  }
});
