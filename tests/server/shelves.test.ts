import assert from "node:assert/strict";
import test from "node:test";
import { syncListsToShelves } from "../../src/server/sync/shelves.js";
import { createTestDatabase } from "./test-db.js";
import { createFakeAdapters, seedProfile } from "./test-helpers.js";

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
    await syncListsToShelves(db, profileId, "", "", [{ id: 1, name: "Large list", slug: null, bookIds: [], books: [], entries: [] }], "", false, false, createFakeAdapters({
      fetchGrimmoryShelfBookIds: async () => Array.from({ length: 500 }, (_, index) => index + 1),
      addBookToHardcoverList: async (_token, _listId, bookId) => { added.push(bookId); }
    }));

    assert.equal(added.length, 500);
    const membershipCount = db.prepare("SELECT COUNT(*) AS count FROM user_book_states WHERE grimmory_shelves = 'Large shelf'").get() as { count: number };
    assert.equal(membershipCount.count, 500);
  } finally {
    cleanup();
  }
});

test("Grimmory shelf membership cache only reflects books confirmed added, not every intended addition", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    db.prepare(`INSERT INTO shelf_mappings
      (profile_id, source, source_status, source_list_id, source_list_name, grimmory_shelf_name, grimmory_shelf_id, enabled)
      VALUES (?, 'hardcover', '', '1', 'List', 'Shelf', 9, 1)`).run(profileId);

    const bookId = Number(db.prepare("INSERT INTO books (title) VALUES ('Book')").run().lastInsertRowid);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id) VALUES (?, 'hardcover', ?, '1')").run(bookId, profileId);
    db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id) VALUES (?, 'grimmory', ?, '1')").run(bookId, profileId);
    db.prepare("INSERT INTO user_book_states (book_id, profile_id, source_type) VALUES (?, ?, 'grimmory')").run(bookId, profileId);

    await syncListsToShelves(db, profileId, "", "", [{ id: 1, name: "List", slug: null, bookIds: [1], books: [], entries: [] }], "", false, false, createFakeAdapters({
      fetchGrimmoryShelfBookIds: async () => [],
      addBooksToGrimmoryShelf: async () => { throw new Error("Grimmory write failed"); }
    }));

    const state = db.prepare("SELECT grimmory_shelves FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = 'grimmory'").get(bookId, profileId) as { grimmory_shelves: string | null };
    assert.equal(state.grimmory_shelves, null, "a failed Grimmory write must not be recorded as shelf membership");
  } finally {
    cleanup();
  }
});

test("Hardcover list writes stop after a run of consecutive failures instead of retrying every remaining book", async () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const profileId = seedProfile(db);
    db.prepare(`INSERT INTO shelf_mappings
      (profile_id, source, source_status, source_list_id, source_list_name, grimmory_shelf_name, grimmory_shelf_id, enabled)
      VALUES (?, 'hardcover', '', '1', 'List', 'Shelf', 9, 1)`).run(profileId);

    const insertBook = db.transaction(() => {
      for (let id = 1; id <= 10; id++) {
        const bookId = Number(db.prepare("INSERT INTO books (title) VALUES (?)").run(`Book ${id}`).lastInsertRowid);
        // grimmory_hardcover_book_id lets the reverse Grimmory-shelf-to-Hardcover
        // lookup find a candidate to add without needing a separate hardcover
        // book_sources row.
        db.prepare("INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id, grimmory_hardcover_book_id) VALUES (?, 'grimmory', ?, ?, ?)").run(bookId, profileId, String(id), String(id));
        db.prepare("INSERT INTO user_book_states (book_id, profile_id, source_type) VALUES (?, ?, 'grimmory')").run(bookId, profileId);
      }
    });
    insertBook();

    let attempts = 0;
    await syncListsToShelves(db, profileId, "", "", [{ id: 1, name: "List", slug: null, bookIds: [], books: [], entries: [] }], "", false, false, createFakeAdapters({
      fetchGrimmoryShelfBookIds: async () => Array.from({ length: 10 }, (_, index) => index + 1),
      addBookToHardcoverList: async () => { attempts++; throw new Error("Hardcover write failed"); }
    }));

    assert.ok(attempts < 10, `expected the write loop to stop early after consecutive failures, but it attempted all ${attempts}`);
  } finally {
    cleanup();
  }
});
