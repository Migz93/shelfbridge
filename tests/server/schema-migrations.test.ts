import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initSchema } from "../../src/server/db/schema.js";
import { LATEST_MIGRATION_VERSION, runMigrations } from "../../src/server/db/migrations.js";
import { createTestDatabase } from "./test-db.js";

function openRawDb(): { db: BetterSqlite3.Database; dataDir: string; cleanup: () => void } {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "shelfbridge-migration-test-"));
  const db = new BetterSqlite3(path.join(dataDir, "test.db"));
  return { db, dataDir, cleanup: () => { db.close(); rmSync(dataDir, { recursive: true, force: true }); } };
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

test("initSchema on a fresh database applies migration 1 and lands on the latest migration version", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    const userVersion = db.pragma("user_version", { simple: true }) as number;
    assert.equal(userVersion, LATEST_MIGRATION_VERSION);

    // A fresh install never creates the legacy schema_version table.
    const legacyTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
    assert.equal(legacyTable, undefined);

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
    const userVersion = db.pragma("user_version", { simple: true }) as number;
    assert.equal(userVersion, LATEST_MIGRATION_VERSION);
  } finally {
    cleanup();
  }
});

test("legacy handover: a pre-existing schema_version database is migrated to v14 then handed over to user_version = 1", () => {
  const { db, dataDir, cleanup } = openRawDb();
  try {
    seedLegacyBooksSchema(db, 13);
    db.exec(`
      INSERT INTO books (id, title) VALUES (1, 'Old Book');
      INSERT INTO book_sources (id, book_id, source_type, external_id, title) VALUES
        (1, 1, 'chaptarr', 'chap-1', 'Old Book'),
        (2, 1, 'grimmory', 'grim-1', 'Old Book');
    `);

    initSchema(db);

    const userVersion = db.pragma("user_version", { simple: true }) as number;
    assert.equal(userVersion, 1, "handover lands on migration 1, which is the v14 baseline");

    const cols = (db.prepare("PRAGMA table_info(book_sources)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes("source_instance_id"), "source_instance_id column should be added by the legacy v14 rebuild");

    const sources = db.prepare("SELECT id, source_type, source_instance_id FROM book_sources ORDER BY id").all() as
      { id: number; source_type: string; source_instance_id: number | null }[];
    assert.equal(sources.length, 2, "existing rows must survive the rebuild");

    const chaptarrRow = sources.find((s) => s.source_type === "chaptarr")!;
    assert.equal(chaptarrRow.source_instance_id, 0, "chaptarr is a single global connection, backfilled to instance 0");

    const grimmoryRow = sources.find((s) => s.source_type === "grimmory")!;
    assert.equal(grimmoryRow.source_instance_id, null, "per-profile sources are left unscoped rather than guessed");

    // The v14 constraint must scope external IDs to an integration instance,
    // allowing different servers to reuse an ID while rejecting a local duplicate.
    db.exec("INSERT INTO books (id, title) VALUES (2, 'Instance One'), (3, 'Instance Two'), (4, 'Duplicate')");
    const insertSource = db.prepare(`
      INSERT INTO book_sources (book_id, source_type, source_instance_id, external_id)
      VALUES (?, 'grimmory', ?, 'shared-id')
    `);
    insertSource.run(2, 1);
    insertSource.run(3, 2);
    assert.throws(() => insertSource.run(4, 1), /UNIQUE constraint failed/);

    const fkViolations = db.pragma("foreign_key_check") as unknown[];
    assert.deepEqual(fkViolations, []);

    const backupDir = path.join(dataDir, "backups");
    assert.ok(existsSync(backupDir), "the legacy handover must be backed up before it rebuilds book_sources");
    assert.ok(readdirSync(backupDir).length > 0, "a backup file should exist from the legacy handover");
  } finally {
    cleanup();
  }
});

test("legacy handover is not re-run: a database already at user_version >= 1 is left alone", () => {
  const { db, cleanup } = openRawDb();
  try {
    // Simulate a database that already went through the handover in a prior run.
    seedLegacyBooksSchema(db, 13);
    db.exec("INSERT INTO books (id, title) VALUES (1, 'Book')");
    initSchema(db);
    const versionAfterFirstRun = db.pragma("user_version", { simple: true }) as number;
    assert.equal(versionAfterFirstRun, 1);

    // Re-running must not touch schema_version again or re-apply migration 1.
    initSchema(db);
    const versionAfterSecondRun = db.pragma("user_version", { simple: true }) as number;
    assert.equal(versionAfterSecondRun, LATEST_MIGRATION_VERSION);
  } finally {
    cleanup();
  }
});

test("legacy v3 migration: deletes orphan title-less books that have no non-chaptarr source", () => {
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

test("legacy v13 migration: repairs book_sources rows with the literal string \"datetime('now')\" as last_sync_at", () => {
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

test("runMigrations backs up an already-populated database before applying a pending migration, and fresh installs skip it", () => {
  {
    // A database with an arbitrary pre-existing table but no user_version yet has
    // migration 1 pending — exercising the same "existing data, pending migration"
    // path a future migration 2+ would hit, without depending on one existing yet.
    const { db, dataDir, cleanup } = openRawDb();
    try {
      db.exec("CREATE TABLE pre_existing (id INTEGER PRIMARY KEY)");
      runMigrations(db);

      const backupDir = path.join(dataDir, "backups");
      assert.ok(existsSync(backupDir), "a backup directory should be created before migrating an existing database");
      const backups = readdirSync(backupDir);
      assert.ok(backups.length > 0, "a backup file should be written before migrating an existing database");
    } finally {
      cleanup();
    }
  }

  {
    const { dataDir, cleanup } = createTestDatabase();
    try {
      const backupDir = path.join(dataDir, "backups");
      assert.ok(!existsSync(backupDir), "a brand-new database has nothing to protect and should not be backed up");
    } finally {
      cleanup();
    }
  }
});
