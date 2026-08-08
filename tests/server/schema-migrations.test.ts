import assert from "node:assert/strict";
import BetterSqlite3 from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initSchema } from "../../src/server/db/schema.js";
import {
  backupBeforeMigrating,
  ForeignKeyViolationError,
  getPendingMigrations,
  LATEST_MIGRATION_VERSION,
  runGuardedStep,
  runMigrations,
  runTransactionalStep
} from "../../src/server/db/migrations.js";
import { createTestDatabase } from "./test-db.js";
import { logger } from "../../src/server/logger.js";

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

test("runTransactionalStep rolls back the whole step, not just detects it, when foreign_key_check finds a violation", () => {
  const { db, cleanup } = openRawDb();
  try {
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
      CREATE TABLE marker (id INTEGER PRIMARY KEY);
    `);

    // Enforcement is toggled off outside the call, exactly like the real
    // migration blocks that use runTransactionalStep — PRAGMA foreign_keys is a
    // no-op once a transaction is open, so it must be set before entering one.
    db.pragma("foreign_keys = OFF");
    try {
      assert.throws(() => {
        runTransactionalStep(db, "test step", undefined, () => {
          db.prepare("INSERT INTO child (id, parent_id) VALUES (1, 999)").run();
          db.prepare("INSERT INTO marker (id) VALUES (1)").run();
        });
      }, /foreign-key violation/);
    } finally {
      db.pragma("foreign_keys = ON");
    }

    const child = db.prepare("SELECT * FROM child").get();
    assert.equal(child, undefined, "the violating row must be rolled back, not merely detected");
    const marker = db.prepare("SELECT * FROM marker").get();
    assert.equal(marker, undefined, "everything in the same transaction must roll back together, not just the violating row");
  } finally {
    cleanup();
  }
});

test("runGuardedStep detects a foreign-key violation but cannot roll it back once step() has already committed", () => {
  const { db, cleanup } = openRawDb();
  try {
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
    `);

    db.pragma("foreign_keys = OFF");
    try {
      assert.throws(() => {
        runGuardedStep(db, "test step", undefined, () => {
          // step() commits on its own, with no transaction wrapper — matching how
          // the legacy handover's non-transactional sub-blocks (v3/v5/v6/v10-13)
          // behave, and why the outer runGuardedStep() around the whole legacy
          // chain can only abort startup, not undo this.
          db.prepare("INSERT INTO child (id, parent_id) VALUES (1, 999)").run();
        });
      }, /foreign-key violation/);
    } finally {
      db.pragma("foreign_keys = ON");
    }

    const child = db.prepare("SELECT * FROM child").get();
    assert.ok(child, "runGuardedStep has no transaction to roll back — the violating row legitimately survives");
  } finally {
    cleanup();
  }
});

test("runTransactionalStep does not fail over a pre-existing foreign-key violation the step did not introduce", () => {
  const { db, cleanup } = openRawDb();
  try {
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
      CREATE TABLE marker (id INTEGER PRIMARY KEY);
    `);

    // Seed a violation that exists *before* the guarded step runs — representing
    // historical data debt unrelated to this migration. A database like this must
    // still be able to apply new, unrelated migrations; only a violation the step
    // itself introduces should be fatal.
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO child (id, parent_id) VALUES (1, 999)").run();

    try {
      runTransactionalStep(db, "test step", undefined, () => {
        db.prepare("INSERT INTO marker (id) VALUES (1)").run();
      });
    } finally {
      db.pragma("foreign_keys = ON");
    }

    const marker = db.prepare("SELECT * FROM marker").get();
    assert.ok(marker, "a step that introduces no new violations must commit even if pre-existing ones remain");
    const child = db.prepare("SELECT * FROM child").get();
    assert.ok(child, "the pre-existing violation is untouched, not silently cleaned up");
  } finally {
    cleanup();
  }
});

test("runTransactionalStep still fails when a step introduces a new violation alongside a pre-existing one", () => {
  const { db, cleanup } = openRawDb();
  try {
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
    `);

    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO child (id, parent_id) VALUES (1, 999)").run(); // pre-existing

    try {
      assert.throws(() => {
        runTransactionalStep(db, "test step", undefined, () => {
          db.prepare("INSERT INTO child (id, parent_id) VALUES (2, 888)").run(); // newly introduced
        });
      }, (err: unknown) => {
        assert.ok(err instanceof ForeignKeyViolationError);
        // Exactly the one newly-introduced violation, not both — count and detail
        // live as structured fields on the error, not baked into the message.
        assert.equal(err.violations.length, 1);
        return true;
      });
    } finally {
      db.pragma("foreign_keys = ON");
    }

    const newRow = db.prepare("SELECT * FROM child WHERE id = 2").get();
    assert.equal(newRow, undefined, "the step that introduced a new violation must still roll back");
    const preExistingRow = db.prepare("SELECT * FROM child WHERE id = 1").get();
    assert.ok(preExistingRow, "the pre-existing violation from before the step is unaffected by its rollback");
  } finally {
    cleanup();
  }
});

test("runTransactionalStep rolls back a user_version pragma write, not just table data, on a violation after it", () => {
  const { db, cleanup } = openRawDb();
  try {
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
    `);
    db.pragma("user_version = 5");

    db.pragma("foreign_keys = OFF");
    try {
      assert.throws(() => {
        runTransactionalStep(db, "test step", undefined, () => {
          // The pragma write happens before the violation is introduced, exactly
          // like a real migration's `migration.up(db); db.pragma('user_version = N')`
          // — proving the rollback covers the version bump too, not only table rows.
          db.pragma("user_version = 6");
          db.prepare("INSERT INTO child (id, parent_id) VALUES (1, 999)").run();
        });
      }, /foreign-key violation/);
    } finally {
      db.pragma("foreign_keys = ON");
    }

    const userVersion = db.pragma("user_version", { simple: true }) as number;
    assert.equal(userVersion, 5, "the user_version pragma write must roll back along with everything else in the transaction");
  } finally {
    cleanup();
  }
});

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
    assert.equal(readdirSync(backupDir).length, 1, "exactly one backup should be taken per initSchema() run, not one per step");

    const legacyTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
    assert.equal(legacyTable, undefined, "the stale schema_version table should be dropped after handover");
  } finally {
    cleanup();
  }
});

test("legacy handover atomicity: a crash between DROP TABLE schema_version and the user_version bump rolls back cleanly", () => {
  const { db, cleanup } = openRawDb();
  try {
    seedLegacyBooksSchema(db, 13);
    db.exec("INSERT INTO books (id, title) VALUES (1, 'Book')");

    // Simulate a process crash landing exactly between the DROP and the PRAGMA
    // bump by making the PRAGMA call throw. If those two statements weren't
    // atomic with each other, this would leave schema_version dropped but
    // user_version still 0 — a state the next startup can't recover from (see
    // the comment on handleLegacySchemaVersionHandover).
    const restore = injectFailureOnce(db, "pragma", "user_version = 1");
    try {
      assert.throws(() => initSchema(db), /simulated crash/);
    } finally {
      restore();
    }

    const legacyTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
    assert.ok(legacyTable, "the transaction must roll back, leaving schema_version in place rather than dropped");
    const userVersionAfterCrash = db.pragma("user_version", { simple: true }) as number;
    assert.equal(userVersionAfterCrash, 0, "user_version must not advance if the transaction rolled back");

    // The next process start must be able to recover on its own.
    initSchema(db);
    const userVersionAfterRetry = db.pragma("user_version", { simple: true }) as number;
    assert.equal(userVersionAfterRetry, 1);
    const legacyTableAfterRetry = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
    assert.equal(legacyTableAfterRetry, undefined);
  } finally {
    cleanup();
  }
});

/**
 * Replaces `db[method]` so a call whose first argument === `matchArg` throws
 * once (simulating a process crash at that exact point), then falls through to
 * the real implementation on every other call. Returns a restore callback —
 * callers must invoke it (typically in a `finally`) even after the injected
 * throw, since the patched method stays installed until then.
 */
function injectFailureOnce<M extends "prepare" | "pragma">(db: BetterSqlite3.Database, method: M, matchArg: string): () => void {
  const original = db[method].bind(db) as (...args: unknown[]) => unknown;
  let injected = false;
  (db as unknown as Record<M, unknown>)[method] = ((arg: string, ...rest: unknown[]) => {
    if (!injected && arg === matchArg) {
      injected = true;
      throw new Error(`simulated crash before: ${method}(${JSON.stringify(matchArg)})`);
    }
    return original(arg, ...rest);
  }) as unknown as BetterSqlite3.Database[M];
  return () => {
    (db as unknown as Record<M, unknown>)[method] = original;
  };
}

test("v7 migration atomicity: a crash before the version bump rolls back the whole book_sources/user_book_states rebuild", () => {
  const { db, cleanup } = openRawDb();
  try {
    seedLegacyBooksSchema(db, 6);
    db.exec(`
      INSERT INTO books (id, title) VALUES (1, 'Book');
      INSERT INTO book_sources (id, book_id, source_type, external_id, title) VALUES (1, 1, 'grimmory', 'grim-1', 'Book');
    `);

    // Without the fix, a crash here leaves book_sources_v7 populated by the
    // INSERT...SELECT but the original book_sources not yet dropped — a state
    // where retrying re-runs that INSERT...SELECT against rows already copied
    // and fails with "UNIQUE constraint failed: book_sources_v7.id".
    const restore = injectFailureOnce(db, "prepare", "UPDATE schema_version SET version = 7");
    try {
      assert.throws(() => initSchema(db), /simulated crash/);
    } finally {
      restore();
    }

    // Rolled back: no leftover temp table, original book_sources untouched, version unchanged.
    const tempTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='book_sources_v7'").get();
    assert.equal(tempTable, undefined, "the transaction must roll back, leaving no book_sources_v7 temp table behind");
    const row = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    assert.equal(row.version, 6, "schema_version must not advance if the transaction rolled back");
    const source = db.prepare("SELECT title FROM book_sources WHERE external_id = 'grim-1'").get() as { title: string };
    assert.equal(source.title, "Book", "the original book_sources row must survive the rollback");

    // The next process start (a plain retry) must recover on its own, not throw again.
    initSchema(db);
    const userVersion = db.pragma("user_version", { simple: true }) as number;
    assert.equal(userVersion, LATEST_MIGRATION_VERSION);
    const survivingSource = db.prepare("SELECT title FROM book_sources WHERE external_id = 'grim-1'").get() as
      { title: string } | undefined;
    assert.equal(survivingSource?.title, "Book", "data must survive all the way through a successful retry");
  } finally {
    cleanup();
  }
});

test("a v7 sub-step failure during the legacy handover is logged once, not twice", () => {
  const { db, cleanup } = openRawDb();
  try {
    seedLegacyBooksSchema(db, 6);
    db.exec("INSERT INTO books (id, title) VALUES (1, 'Book')");

    // v7's failure propagates through two layers of guarding: the inner
    // runTransactionalStep wrapping v7 itself, then the outer runGuardedStep
    // wrapping the whole legacy handover. Without the LOGGED_BY_GUARDED_STEP
    // marker, logGuardedFailure would fire once at each layer for the same error.
    const originalError = logger.error.bind(logger);
    let errorCallCount = 0;
    (logger as unknown as { error: typeof logger.error }).error = ((message: string, meta?: unknown) => {
      errorCallCount++;
      return originalError(message, meta as Record<string, unknown>);
    }) as typeof logger.error;

    const restore = injectFailureOnce(db, "prepare", "UPDATE schema_version SET version = 7");
    try {
      assert.throws(() => initSchema(db), /simulated crash/);
    } finally {
      restore();
      (logger as unknown as { error: typeof logger.error }).error = originalError;
    }

    assert.equal(errorCallCount, 1, "the same failure must be logged exactly once, not once per guarding layer it propagates through");
  } finally {
    cleanup();
  }
});

test("legacy handover: the outer foreign-key backstop check runs before the drop+bump commits, not after", () => {
  const { db, cleanup } = openRawDb();
  try {
    // Seed already at v14 so every internal legacyMigrateToV14 sub-block is a
    // no-op (all guarded by `row.version < N`) — the only foreign_key_check
    // calls that happen come from the outer runGuardedStep wrapping the whole
    // legacyMigrateToV14() call, isolating exactly the sequencing this test cares about.
    seedLegacyBooksSchema(db, 14);
    db.exec("INSERT INTO books (id, title) VALUES (1, 'Book')");

    // If the drop+bump ran before (or as part of) the outer check, the check
    // would observe user_version already at 1. Capturing user_version at every
    // foreign_key_check call and keeping the last one tells us its value at the
    // outer check's "after" call — the one immediately preceding the decision
    // to commit the drop+bump or abort.
    const originalPragma = db.pragma.bind(db);
    let userVersionAtLastCheck: number | undefined;
    (db as unknown as { pragma: typeof db.pragma }).pragma = ((arg: string, options?: unknown) => {
      const result = (originalPragma as (a: string, o?: unknown) => unknown)(arg, options);
      if (arg === "foreign_key_check") {
        userVersionAtLastCheck = originalPragma("user_version", { simple: true }) as number;
      }
      return result;
    }) as typeof db.pragma;

    try {
      initSchema(db);
    } finally {
      (db as unknown as { pragma: typeof db.pragma }).pragma = originalPragma;
    }

    assert.equal(
      userVersionAtLastCheck,
      0,
      "the outer foreign-key check must observe user_version still at 0 — if it ran after the drop+bump instead, a " +
      "violation it catches would abort this one boot but leave the handover looking already-complete on the next restart"
    );
    assert.equal(db.pragma("user_version", { simple: true }), 1, "the handover must still complete normally when the check passes");
  } finally {
    cleanup();
  }
});

test("v8/v9 migration atomicity: a crash before the version bump rolls back the ALTER TABLE statements", () => {
  const { db, cleanup } = openRawDb();
  try {
    seedLegacyBooksSchema(db, 7);
    db.exec(`
      INSERT INTO books (id, title) VALUES (1, 'Book');
      INSERT INTO book_sources (id, book_id, source_type, external_id, title) VALUES (1, 1, 'grimmory', 'grim-1', 'Book');
    `);

    // Without the fix, a crash here leaves book_sources.hardcover_audio_seconds
    // already added but the version still < 8 — retrying re-issues the same bare
    // ALTER TABLE ADD COLUMN and fails with "duplicate column name".
    const restore = injectFailureOnce(db, "prepare", "UPDATE schema_version SET version = 8");
    try {
      assert.throws(() => initSchema(db), /simulated crash/);
    } finally {
      restore();
    }

    const cols = (db.prepare("PRAGMA table_info(book_sources)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(!cols.includes("hardcover_audio_seconds"), "the v8 ALTER must roll back along with the version bump");
    const row = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    assert.equal(row.version, 7);

    // The next process start must recover on its own and continue through v9 too.
    initSchema(db);
    const userVersion = db.pragma("user_version", { simple: true }) as number;
    assert.equal(userVersion, LATEST_MIGRATION_VERSION);
    const colsAfterRetry = (db.prepare("PRAGMA table_info(user_book_states)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(colsAfterRetry.includes("hardcover_edition_id"), "v9's columns must be present after a clean retry");
  } finally {
    cleanup();
  }
});

test("backupBeforeMigrating retains only the 5 most recent backups", () => {
  const { db, dataDir, cleanup } = openRawDb();
  try {
    db.exec("CREATE TABLE pre_existing (id INTEGER PRIMARY KEY)");
    const backupDir = path.join(dataDir, "backups");
    mkdirSync(backupDir, { recursive: true });

    // Seed 6 pre-existing backups with names that sort strictly before any real
    // timestamp (real stamps start with the current year), so the real backup
    // taken below pushes the total to 7 and pruning must drop the oldest 2 to
    // land back at the 5-backup retention limit.
    const dbBaseName = "test.db";
    for (let i = 0; i < 6; i++) {
      writeFileSync(path.join(backupDir, `${dbBaseName}.pre-migration-0000-00-0${i}T00-00-00-000Z.bak`), "");
    }

    const newBackupPath = backupBeforeMigrating(db);
    assert.ok(newBackupPath, "a backup should be created when the database already has tables");

    const remaining = readdirSync(backupDir);
    assert.equal(remaining.length, 5, "only the 5 most recently created backups should be retained");
    assert.ok(remaining.includes(path.basename(newBackupPath!)), "the just-created backup must survive pruning");
    assert.ok(!remaining.includes(`${dbBaseName}.pre-migration-0000-00-00T00-00-00-000Z.bak`), "the oldest seeded backup should be pruned");
    assert.ok(!remaining.includes(`${dbBaseName}.pre-migration-0000-00-01T00-00-00-000Z.bak`), "the second-oldest seeded backup should be pruned");
  } finally {
    cleanup();
  }
});

test("backupBeforeMigrating locks down the backups directory even if it already existed with looser permissions", { skip: process.platform === "win32" }, () => {
  const { db, dataDir, cleanup } = openRawDb();
  try {
    db.exec("CREATE TABLE pre_existing (id INTEGER PRIMARY KEY)");
    const backupDir = path.join(dataDir, "backups");

    // Simulate an already-deployed install: the directory exists from before this
    // hardening, at default (umask-affected) permissions. mkdirSync's `mode` is a
    // no-op on a directory that already exists, so without an explicit chmod this
    // directory would stay at its old, looser permissions forever. The explicit
    // chmodSync (rather than relying on mkdirSync's requested mode, which the
    // process umask can silently narrow) guarantees the starting state is
    // actually 0o755 regardless of the environment's umask.
    mkdirSync(backupDir, { recursive: true, mode: 0o755 });
    chmodSync(backupDir, 0o755);
    const before = statSync(backupDir).mode & 0o777;
    assert.notEqual(before, 0o700, "the test setup must start from a looser mode than the target, or this test proves nothing");

    backupBeforeMigrating(db);

    const after = statSync(backupDir).mode & 0o777;
    assert.equal(after, 0o700, "an already-existing backups directory must be locked down to owner-only too, not just newly-created ones");
  } finally {
    cleanup();
  }
});

test("getPendingMigrations/runMigrations reject a database newer than this build supports", () => {
  const { db, cleanup } = createTestDatabase();
  try {
    // Simulate an operator downgrading to an older image after upgrading: the
    // database's user_version is ahead of anything this build's migrations
    // array knows about.
    db.pragma(`user_version = ${LATEST_MIGRATION_VERSION + 1}`);

    assert.throws(
      () => getPendingMigrations(db),
      /is newer than this build supports/,
      "a downgrade must fail loudly instead of silently seeing nothing pending and booting into an unknown schema"
    );
    assert.throws(() => runMigrations(db), /is newer than this build supports/);
  } finally {
    cleanup();
  }
});

test("legacy handover is not re-run: a database already at user_version >= 1 is left alone", () => {
  const { db, dataDir, cleanup } = openRawDb();
  try {
    // Simulate a database that already went through the handover in a prior run.
    seedLegacyBooksSchema(db, 13);
    db.exec("INSERT INTO books (id, title) VALUES (1, 'Book')");
    initSchema(db);
    // The handover always targets user_version 1 (the v14 baseline) specifically,
    // not "whatever the latest migration is" — that's a distinct concept and the
    // two only happen to match today because there's a single migration so far.
    const versionAfterFirstRun = db.pragma("user_version", { simple: true }) as number;
    assert.equal(versionAfterFirstRun, 1);
    const backupDir = path.join(dataDir, "backups");
    assert.equal(readdirSync(backupDir).length, 1, "the first run should have taken exactly one backup");

    // Re-running must not touch schema_version again or re-apply migration 1.
    initSchema(db);
    const versionAfterSecondRun = db.pragma("user_version", { simple: true }) as number;
    assert.equal(versionAfterSecondRun, LATEST_MIGRATION_VERSION);
    assert.equal(
      readdirSync(backupDir).length,
      1,
      "a no-op second run must not take another backup — proof nothing was re-applied, not just that the version looks right"
    );
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

/**
 * Order-independent per-table {columns, indexes, foreignKeys} snapshot, plus
 * any views/triggers, so two databases built by different code paths can be
 * compared for equivalence without caring about column declaration order or
 * the order sqlite_master/PRAGMA calls list indexes or foreign keys in.
 */
function introspectSchema(db: BetterSqlite3.Database): {
  tables: Record<string, { columns: string[]; indexes: string[]; foreignKeys: string[] }>;
  viewsAndTriggers: string[];
} {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence'").all() as
      { name: string }[]
  ).map((t) => t.name);

  const schema: Record<string, { columns: string[]; indexes: string[]; foreignKeys: string[] }> = {};
  for (const table of tables) {
    // `pk` (the column's 1-based position in the primary key, 0 if not part of
    // one) is included so a primary-key difference between the two paths is
    // caught here rather than silently passing.
    const columns = (
      db.prepare(`PRAGMA table_info("${table}")`).all() as
        { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[]
    )
      .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? ""}:pk${c.pk}`)
      .sort();

    // Every index is compared by shape (uniqueness + ordered indexed columns),
    // including the implicit sqlite_autoindex_* entries SQLite generates for
    // inline UNIQUE/PK constraints — those are keyed by shape only (no name),
    // since SQLite numbers them by creation order, which legitimately differs
    // between the two code paths here. A named index keeps its name in the key,
    // so a rename or a same-named index over different columns is still caught.
    const indexes = (db.prepare(`PRAGMA index_list("${table}")`).all() as { name: string; unique: number }[])
      .map((i) => {
        const indexedColumns = (db.prepare(`PRAGMA index_info("${i.name}")`).all() as { name: string }[])
          .map((c) => c.name)
          .join(",");
        return i.name.startsWith("sqlite_autoindex_")
          ? `implicit:${i.unique}:${indexedColumns}`
          : `named:${i.name}:${i.unique}:${indexedColumns}`;
      })
      .sort();

    // A composite foreign key spans multiple PRAGMA foreign_key_list rows that
    // share the same `id`; group by id and join columns in `seq` order before
    // comparing, so a multi-column FK is compared as one logical constraint.
    const fkRows = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as
      { id: number; seq: number; table: string; from: string; to: string; on_delete: string }[];
    const fkGroups = new Map<number, typeof fkRows>();
    for (const row of fkRows) {
      const group = fkGroups.get(row.id) ?? [];
      group.push(row);
      fkGroups.set(row.id, group);
    }
    const foreignKeys = [...fkGroups.values()]
      .map((group) => {
        const sorted = [...group].sort((a, b) => a.seq - b.seq);
        const columnPairs = sorted.map((r) => `${r.from}->${r.to}`).join(",");
        return `${sorted[0]!.table}:${sorted[0]!.on_delete}:${columnPairs}`;
      })
      .sort();

    schema[table] = { columns, indexes, foreignKeys };
  }

  const viewsAndTriggers = (
    db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('view', 'trigger')").all() as
      { type: string; name: string; sql: string }[]
  )
    .map((o) => `${o.type}:${o.name}:${o.sql}`)
    .sort();

  return { tables: schema, viewsAndTriggers };
}

test("schema equivalence: a fresh install (migration 1) and a full legacy v3-v14 chain produce the same schema", () => {
  const fresh = createTestDatabase();
  const legacy = openRawDb();
  try {
    // Start from the earliest realistic historical shape (pre-v3) so the legacy
    // chain actually exercises every version block, not just the later ones.
    seedLegacyBooksSchema(legacy.db, 2);
    legacy.db.exec("INSERT INTO books (id, title) VALUES (1, 'Book')");
    initSchema(legacy.db);

    const fresh_ = introspectSchema(fresh.db);
    const legacy_ = introspectSchema(legacy.db);

    assert.deepEqual(
      Object.keys(legacy_.tables).sort(),
      Object.keys(fresh_.tables).sort(),
      "both code paths must produce the same set of tables"
    );
    for (const table of Object.keys(fresh_.tables)) {
      assert.deepEqual(
        legacy_.tables[table]!.columns,
        fresh_.tables[table]!.columns,
        `columns for "${table}" must match between a fresh install and a full legacy chain + handover`
      );
      assert.deepEqual(
        legacy_.tables[table]!.indexes,
        fresh_.tables[table]!.indexes,
        `indexes for "${table}" must match between a fresh install and a full legacy chain + handover`
      );
      assert.deepEqual(
        legacy_.tables[table]!.foreignKeys,
        fresh_.tables[table]!.foreignKeys,
        `foreign keys for "${table}" must match between a fresh install and a full legacy chain + handover`
      );
    }
    assert.deepEqual(
      legacy_.viewsAndTriggers,
      fresh_.viewsAndTriggers,
      "views and triggers must match between a fresh install and a full legacy chain + handover"
    );
  } finally {
    fresh.cleanup();
    legacy.cleanup();
  }
});
