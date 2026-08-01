import assert from "node:assert/strict";
import test from "node:test";
import { syncListsToShelves } from "../../src/server/sync/shelves.js";
import { createTestDatabase } from "./test-db.js";
import { seedProfile } from "./test-helpers.js";

test("list shelf sync batches large reverse shelf lookups below SQLite's variable limit", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    db.prepare(`INSERT INTO shelf_mappings
      (profile_id, source, source_status, source_list_id, source_list_name, grimmory_shelf_name, grimmory_shelf_id, enabled)
      VALUES (?, 'hardcover', '', '1', 'Large list', 'Large shelf', 9, 1)`).run(profileId);

    const insertBook = db.transaction(() => {
      for (let id = 1; id <= 500; id++) {
        const bookId = Number(db.prepare("INSERT INTO books (title) VALUES (?)").run(`Book ${id}`).lastInsertRowid);
        db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id) VALUES (?, 'hardcover', ?, ?)").run(bookId, profileId, String(id));
        db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id) VALUES (?, 'grimmory', ?, ?)").run(bookId, profileId, String(id));
        db.prepare("INSERT INTO user_book_states (book_id, profile_id, source_type) VALUES (?, ?, 'grimmory')").run(bookId, profileId);
      }
    });
    insertBook();

    const added: number[] = [];
    await syncListsToShelves(db, profileId, "", "", [{ id: 1, name: "Large list", slug: null, bookIds: [], books: [], entries: [] }], "", false, false, {
      fetchGrimmoryShelfBookIds: async () => Array.from({ length: 500 }, (_, index) => index + 1),
      addBookToHardcoverList: async (_token, _listId, bookId) => { added.push(bookId); }
    } as any);

    assert.equal(added.length, 500);
    const membershipCount = db.prepare("SELECT COUNT(*) AS count FROM user_book_states WHERE grimmory_shelves = 'Large shelf'").get() as { count: number };
    assert.equal(membershipCount.count, 500);
  } finally {
    cleanup();
  }
});
