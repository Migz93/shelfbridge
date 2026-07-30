import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CURRENT_SCHEMA_VERSION, initSchema } from "../../src/server/db/schema.js";
import { createTestDatabase } from "./test-db.js";

function openRawDb(): { db: BetterSqlite3.Database; cleanup: () => void } {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "shelfbridge-migration-test-"));
  const db = new BetterSqlite3(path.join(dataDir, "test.db"));
  return { db, cleanup: () => { db.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

/**
 * Creates `books` + a pre-v14 `book_sources` (the full column set the v7 rebuild's
 * explicit SELECT expects, but without source_instance_id and with the old
 * (source_type, external_id) uniqueness) so initSchema can be run from any
 * pre-v14 starting version against a realistic legacy shape.
 */
function seedLegacyBooksSchema(db: BetterSqlite3.Database, startingVersion: number): void {
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (${startingVersion});

    CREATE TABLE books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_type TEXT NOT NULL DEFAULT 'unknown',
      title TEXT NOT NULL DEFAULT '',
      author TEXT, cover_url TEXT, cover_cache_path TEXT, isbn13 TEXT, isbn10 TEXT,
      series_name TEXT, series_number TEXT, last_sync_at TEXT,
      last_modified_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE book_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT, author TEXT, cover_url TEXT, cover_cache_path TEXT, isbn13 TEXT, isbn10 TEXT,
      series_name TEXT, series_number TEXT,
      source_hardcover_book_id TEXT, source_hardcover_slug TEXT, source_goodreads_book_id TEXT,
      source_goodreads_work_id TEXT, source_goodreads_edition_id TEXT, source_edition_id TEXT,
      source_edition_format TEXT, source_media_type TEXT, source_narrator TEXT, source_asin TEXT,
      source_audible_asin TEXT, hardcover_slug TEXT,
      grimmory_hardcover_book_id TEXT, grimmory_goodreads_id TEXT, grimmory_hardcover_id TEXT,
      grimmory_primary_file_path TEXT, goodreads_book_link TEXT,
      chaptarr_monitored INTEGER, chaptarr_has_file INTEGER, chaptarr_id_mismatch INTEGER,
      chaptarr_primary_file_path TEXT,
      last_sync_at TEXT, last_sync_decision TEXT,
      last_modified_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_type, external_id)
    );
  `);
}

test("initSchema on a fresh database lands on the current schema version", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const row = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    assert.equal(row.version, CURRENT_SCHEMA_VERSION);

    const fkViolations = db.pragma("foreign_key_check") as unknown[];
    assert.deepEqual(fkViolations, []);
  } finally {
    cleanup();
  }
});

test("initSchema is idempotent: running it twice makes no further changes", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    initSchema(db);
    const row = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    assert.equal(row.version, CURRENT_SCHEMA_VERSION);

    const versionRows = db.prepare("SELECT COUNT(*) AS count FROM schema_version").get() as { count: number };
    assert.equal(versionRows.count, 1, "schema_version should never accumulate extra rows");
  } finally {
    cleanup();
  }
});

test("v14 migration: rebuilds book_sources with a per-instance unique constraint and preserves rows", () => {
  const { db, cleanup } = openRawDb();
  try {
    seedLegacyBooksSchema(db, 13);
    db.exec(`
      INSERT INTO books (id, title) VALUES (1, 'Old Book');
      INSERT INTO book_sources (id, book_id, source_type, external_id, title) VALUES
        (1, 1, 'chaptarr', 'chap-1', 'Old Book'),
        (2, 1, 'grimmory', 'grim-1', 'Old Book');
    `);

    initSchema(db);

    const row = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    assert.equal(row.version, CURRENT_SCHEMA_VERSION);

    const cols = (db.prepare("PRAGMA table_info(book_sources)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes("source_instance_id"), "source_instance_id column should be added");

    const sources = db.prepare("SELECT id, source_type, source_instance_id FROM book_sources ORDER BY id").all() as
      { id: number; source_type: string; source_instance_id: number | null }[];
    assert.equal(sources.length, 2, "existing rows must survive the rebuild");

    const chaptarrRow = sources.find((s) => s.source_type === "chaptarr")!;
    assert.equal(chaptarrRow.source_instance_id, 0, "chaptarr is a single global connection, backfilled to instance 0");

    const grimmoryRow = sources.find((s) => s.source_type === "grimmory")!;
    assert.equal(grimmoryRow.source_instance_id, null, "per-profile sources are left unscoped rather than guessed");

    const fkViolations = db.pragma("foreign_key_check") as unknown[];
    assert.deepEqual(fkViolations, []);
  } finally {
    cleanup();
  }
});

test("v3 migration: deletes orphan title-less books that have no non-chaptarr source", () => {
  const { db, cleanup } = openRawDb();
  try {
    seedLegacyBooksSchema(db, 2);
    db.exec(`
      -- Orphan: empty title, chaptarr-only source -> should be deleted by v3.
      INSERT INTO books (id, title) VALUES (1, '');
      INSERT INTO book_sources (book_id, source_type, external_id, title) VALUES (1, 'chaptarr', 'chap-orphan', '');

      -- Legitimate: has a non-chaptarr source -> must survive.
      INSERT INTO books (id, title) VALUES (2, 'Real Book');
      INSERT INTO book_sources (book_id, source_type, external_id, title) VALUES (2, 'grimmory', 'grim-real', 'Real Book');
    `);

    initSchema(db);

    // initSchema also runs reconcileBookIdentities() at the end, which may re-cluster
    // rows into fresh book ids — assert on titles/content rather than the original ids.
    const remaining = db.prepare("SELECT title FROM books ORDER BY id").all() as { title: string }[];
    assert.deepEqual(remaining.map((r) => r.title), ["Real Book"], "the title-less chaptarr-only orphan must not survive");
  } finally {
    cleanup();
  }
});

test("v13 migration: repairs book_sources rows with the literal string \"datetime('now')\" as last_sync_at", () => {
  const { db, cleanup } = openRawDb();
  try {
    seedLegacyBooksSchema(db, 12);
    db.exec(`
      INSERT INTO books (id, title) VALUES (1, 'Buggy Book');
      INSERT INTO book_sources (book_id, source_type, external_id, last_sync_at) VALUES
        (1, 'grimmory', 'grim-1', 'datetime(''now'')');
    `);

    initSchema(db);

    const source = db.prepare("SELECT last_sync_at FROM book_sources WHERE external_id = 'grim-1'").get() as
      { last_sync_at: string | null };
    assert.equal(source.last_sync_at, null);
  } finally {
    cleanup();
  }
});
