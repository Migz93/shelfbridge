import type Database from "better-sqlite3";
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";

export interface Migration {
  version: number;
  description: string;
  up(db: Database.Database): void;
}

// Migration 1 is the flattened v14 shape ShelfBridge reached under the old
// schema_version + sequential ALTER TABLE approach. It is the shape every
// already-deployed database is handed over to (see handleLegacySchemaVersionHandover
// in schema.ts) and the shape a brand-new install reaches in a single migration.
// Add new migrations after it — never edit this one once it has shipped.
const migration1: Migration = {
  version: 1,
  description: "Baseline schema (flattened v14 shape)",
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE auth_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE profiles (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        display_name TEXT NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE grimmory_connections (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id            INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        base_url              TEXT NOT NULL DEFAULT '',
        username              TEXT NOT NULL DEFAULT '',
        password              TEXT NOT NULL DEFAULT '',
        refresh_token         TEXT,
        grimmory_user_id      TEXT,
        status                TEXT NOT NULL DEFAULT 'untested',
        last_tested_at        TEXT,
        last_success_at       TEXT,
        UNIQUE(profile_id)
      );

      CREATE TABLE hardcover_connections (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id          INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        api_token           TEXT NOT NULL DEFAULT '',
        hardcover_user_id   TEXT,
        hardcover_username  TEXT,
        sync_list_id        TEXT,
        sync_list_name      TEXT,
        target_shelf_name   TEXT,
        status              TEXT NOT NULL DEFAULT 'untested',
        last_tested_at      TEXT,
        last_success_at     TEXT,
        UNIQUE(profile_id)
      );

      CREATE TABLE audiobookshelf_connections (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id            INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        api_key               TEXT NOT NULL DEFAULT '',
        abs_user_id           TEXT,
        abs_username          TEXT,
        status                TEXT NOT NULL DEFAULT 'untested',
        last_tested_at        TEXT,
        last_success_at       TEXT,
        UNIQUE(profile_id)
      );

      CREATE TABLE goodreads_connections (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id        INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        goodreads_user_id TEXT NOT NULL DEFAULT '',
        goodreads_username TEXT,
        sync_shelf_name   TEXT,
        target_shelf_name TEXT,
        enabled           INTEGER NOT NULL DEFAULT 1,
        status            TEXT NOT NULL DEFAULT 'untested',
        last_tested_at    TEXT,
        last_success_at   TEXT,
        UNIQUE(profile_id)
      );

      CREATE TABLE sync_settings (
        id                              INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id                      INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        sync_status_enabled             INTEGER NOT NULL DEFAULT 1,
        sync_progress_enabled           INTEGER NOT NULL DEFAULT 1,
        sync_shelves_enabled            INTEGER NOT NULL DEFAULT 1,
        sync_goodreads_enabled          INTEGER NOT NULL DEFAULT 0,
        sync_goodreads_status_enabled   INTEGER NOT NULL DEFAULT 0,
        sync_goodreads_shelves_enabled  INTEGER NOT NULL DEFAULT 0,
        sync_write_tag_enabled          INTEGER NOT NULL DEFAULT 0,
        conflict_strategy               TEXT NOT NULL DEFAULT 'latest_wins',
        schedule_enabled                INTEGER NOT NULL DEFAULT 1,
        schedule_cron                   TEXT,
        dry_run_default                 INTEGER NOT NULL DEFAULT 1,
        UNIQUE(profile_id)
      );

      -- Master book record. Canonical title/author/ISBNs/cover aggregated from all sources.
      CREATE TABLE books (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        media_type       TEXT NOT NULL DEFAULT 'unknown',
        title            TEXT NOT NULL DEFAULT '',
        author           TEXT,
        cover_url        TEXT,
        cover_cache_path TEXT,
        isbn13           TEXT,
        isbn10           TEXT,
        series_name      TEXT,
        series_number    TEXT,
        last_sync_at     TEXT,
        last_modified_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- One row per (book x source system x source instance). external_id is the
      -- source's own ID for this book, scoped by source_instance_id since two
      -- configured instances of the same integration (e.g. two Grimmory servers) can
      -- reuse the same local ID for different books.
      -- book_id is nullable until reconcileBookIdentities() assigns it.
      CREATE TABLE book_sources (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id          INTEGER REFERENCES books(id) ON DELETE CASCADE,
        source_type      TEXT NOT NULL,
        source_instance_id INTEGER,
        external_id      TEXT NOT NULL,
        title            TEXT,
        author           TEXT,
        cover_url        TEXT,
        cover_cache_path TEXT,
        isbn13           TEXT,
        isbn10           TEXT,
        series_name      TEXT,
        series_number    TEXT,
        -- Cross-source identifiers observed on this source row. These preserve
        -- source-provided IDs even when they are not this row's own external_id.
        source_hardcover_book_id   TEXT,
        source_hardcover_slug      TEXT,
        source_goodreads_book_id   TEXT,
        source_goodreads_work_id   TEXT,
        source_goodreads_edition_id TEXT,
        source_edition_id          TEXT,
        source_edition_format      TEXT,
        source_media_type          TEXT,
        source_narrator           TEXT,
        source_asin                TEXT,
        source_audible_asin        TEXT,
        -- Hardcover-specific
        hardcover_slug   TEXT,
        hardcover_audio_seconds INTEGER,
        -- Grimmory cross-references stored inside Grimmory metadata
        grimmory_hardcover_book_id   TEXT,
        grimmory_goodreads_id        TEXT,
        grimmory_hardcover_id        TEXT,
        grimmory_primary_file_path   TEXT,
        -- Goodreads-specific
        goodreads_book_link TEXT,
        -- Chaptarr-specific
        chaptarr_monitored         INTEGER,
        chaptarr_has_file          INTEGER,
        chaptarr_id_mismatch       INTEGER,
        chaptarr_primary_file_path TEXT,
        -- Audiobookshelf-specific
        audiobookshelf_duration          INTEGER,
        audiobookshelf_file_path         TEXT,
        audiobookshelf_asin              TEXT,
        audiobookshelf_runtime_validated INTEGER,
        audiobookshelf_runtime_delta     INTEGER,
        -- Sync metadata
        last_sync_at     TEXT,
        last_sync_decision TEXT,
        last_modified_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source_type, source_instance_id, external_id)
      );

      -- One row per (book x profile x source) where the profile has user activity.
      CREATE TABLE user_book_states (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id          INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        profile_id       INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        source_type      TEXT NOT NULL,
        -- Generic reading state (mapped from source-specific values)
        status           TEXT,
        rating           REAL,
        progress         REAL,
        progress_pages   INTEGER,
        progress_seconds INTEGER,
        last_read_date   TEXT,
        date_finished    TEXT,
        -- Sync metadata
        sync_health      TEXT NOT NULL DEFAULT 'pending',
        has_superseded   INTEGER NOT NULL DEFAULT 0,
        match_confidence TEXT NOT NULL DEFAULT 'none',
        match_type       TEXT,
        last_sync_decision TEXT,
        -- Hardcover-specific
        hardcover_status_id  INTEGER,
        hardcover_read_id    INTEGER,
        hardcover_updated_at TEXT,
        hardcover_list_id    INTEGER,
        hardcover_pages      INTEGER,
        hardcover_user_book_id INTEGER,
        hardcover_edition_id INTEGER,
        hardcover_edition_pages INTEGER,
        -- Goodreads-specific
        goodreads_shelf      TEXT,
        goodreads_read_at    TEXT,
        goodreads_updated_at TEXT,
        goodreads_match_type TEXT,
        goodreads_book_link  TEXT,
        -- Grimmory-specific
        grimmory_book_id        INTEGER,
        grimmory_last_read_time TEXT,
        grimmory_primary_file_id INTEGER,
        grimmory_shelves     TEXT,
        -- Audiobookshelf-specific
        audiobookshelf_item_id      TEXT,
        audiobookshelf_updated_at   TEXT,
        audiobookshelf_current_time INTEGER,
        audiobookshelf_duration     INTEGER,
        last_sync_at     TEXT,
        last_modified_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(book_id, profile_id, source_type)
      );

      CREATE TABLE book_identity_keys (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        key_type  TEXT NOT NULL,
        key_value TEXT NOT NULL,
        UNIQUE(key_type, key_value)
      );

      CREATE TABLE book_duplicate_dismissals (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id_low    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        book_id_high   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        dismissed_at   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(book_id_low, book_id_high),
        CHECK(book_id_low < book_id_high)
      );

      CREATE TABLE chaptarr_id_mismatch_dismissals (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        chaptarr_external_id  TEXT NOT NULL UNIQUE,
        dismissed_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE shelf_mappings (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id           INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        source               TEXT NOT NULL CHECK(source IN ('goodreads', 'hardcover')),
        source_status        TEXT NOT NULL,
        source_list_id       TEXT,
        source_list_name     TEXT,
        grimmory_shelf_id    INTEGER,
        grimmory_shelf_name  TEXT,
        grimmory_status      TEXT,
        enabled              INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE sync_runs (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id       INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
        started_at       TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at      TEXT,
        status           TEXT NOT NULL DEFAULT 'running',
        summary          TEXT NOT NULL DEFAULT '',
        error            TEXT,
        dry_run          INTEGER NOT NULL DEFAULT 0,
        changes_written  INTEGER NOT NULL DEFAULT 0,
        changes_skipped  INTEGER NOT NULL DEFAULT 0,
        changes_superseded INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE sync_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_run_id INTEGER NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
        profile_id  INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
        book_title  TEXT,
        event_type  TEXT NOT NULL,
        direction   TEXT,
        decision    TEXT,
        details     TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE job_run_state (
        job_id          TEXT PRIMARY KEY,
        last_run_at     TEXT,
        last_run_status TEXT
      );

      CREATE TABLE image_cache (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        cache_key        TEXT NOT NULL UNIQUE,
        entity_id        TEXT NOT NULL,
        source_url       TEXT,
        local_file_path  TEXT,
        local_web_path   TEXT,
        cached_at        TEXT,
        last_refresh_at  TEXT,
        refresh_after    TEXT,
        last_attempted_at TEXT,
        last_error       TEXT
      );

      CREATE INDEX idx_books_title ON books(title);
      CREATE INDEX idx_book_sources_book ON book_sources(book_id);
      CREATE INDEX idx_book_sources_type ON book_sources(source_type);
      CREATE INDEX idx_book_sources_instance ON book_sources(source_type, source_instance_id);
      CREATE INDEX idx_book_identity_keys_book ON book_identity_keys(book_id);
      CREATE INDEX idx_book_duplicate_dismissals_low ON book_duplicate_dismissals(book_id_low);
      CREATE INDEX idx_book_duplicate_dismissals_high ON book_duplicate_dismissals(book_id_high);
      CREATE INDEX idx_user_book_states_book ON user_book_states(book_id);
      CREATE INDEX idx_user_book_states_profile ON user_book_states(profile_id);
      CREATE INDEX idx_user_book_states_profile_source ON user_book_states(profile_id, source_type);
      CREATE INDEX idx_sync_runs_profile ON sync_runs(profile_id);
      CREATE INDEX idx_sync_runs_started ON sync_runs(started_at DESC);
      CREATE INDEX idx_sync_events_run ON sync_events(sync_run_id);
      CREATE INDEX idx_image_cache_key ON image_cache(cache_key);
      CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at);
    `);
  }
};

// Records what was actually mismatched at dismissal time (Chaptarr's raw
// upstream Hardcover/Goodreads book ids), so a dismissal only keeps
// suppressing the mismatch it was raised against — if Chaptarr's reported
// upstream ids change on a later sync, the row re-arms as an active mismatch
// instead of staying silently dismissed forever.
const migration2: Migration = {
  version: 2,
  description: "Re-arm Chaptarr ID mismatch dismissals when the observed mismatch changes",
  up(db: Database.Database): void {
    db.exec(`
      ALTER TABLE chaptarr_id_mismatch_dismissals ADD COLUMN dismissed_hardcover_book_id TEXT;
      ALTER TABLE chaptarr_id_mismatch_dismissals ADD COLUMN dismissed_goodreads_book_id TEXT;
    `);
  }
};

// Backs indexed identity-key lookups so reconciliation can scope its reads to
// rows sharing a key with the changed set instead of scanning every book_sources
// row on every call (see reconcileBookIdentities in bookIdentity.ts).
const migration3: Migration = {
  version: 3,
  description: "Indexes for identifier-based reconciliation and duplicate lookups",
  up(db: Database.Database): void {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
      CREATE INDEX IF NOT EXISTS idx_books_series ON books(series_name, series_number);
      CREATE INDEX IF NOT EXISTS idx_books_isbn13 ON books(isbn13);
      CREATE INDEX IF NOT EXISTS idx_books_isbn10 ON books(isbn10);
      CREATE INDEX IF NOT EXISTS idx_book_sources_isbn13 ON book_sources(isbn13);
      CREATE INDEX IF NOT EXISTS idx_book_sources_isbn10 ON book_sources(isbn10);
      CREATE INDEX IF NOT EXISTS idx_book_sources_hardcover_book_id ON book_sources(source_hardcover_book_id);
      CREATE INDEX IF NOT EXISTS idx_book_sources_goodreads_book_id ON book_sources(source_goodreads_book_id);
      CREATE INDEX IF NOT EXISTS idx_book_sources_asin ON book_sources(source_asin);
      CREATE INDEX IF NOT EXISTS idx_book_identity_keys_value ON book_identity_keys(key_value);
    `);
  }
};

// Backs the duplicate-candidate lookup in routes/books.ts so it can do an
// indexed WHERE match instead of scanning every books row per request. No
// backfill UPDATE needed here: initSchema() always runs a full, unscoped
// reconcileBookIdentities(db) right after migrations (schema.ts:30), and that
// touches every book row via insertBook/updateBook, populating these columns
// on the same startup this migration applies on.
const migration4: Migration = {
  version: 4,
  description: "Duplicate-detection key columns on books",
  up(db: Database.Database): void {
    db.exec(`
      ALTER TABLE books ADD COLUMN duplicate_title_key TEXT;
      ALTER TABLE books ADD COLUMN duplicate_author_key TEXT;
      CREATE INDEX IF NOT EXISTS idx_books_duplicate_key ON books(duplicate_title_key, duplicate_author_key);
    `);
  }
};

// book_identity_keys previously had UNIQUE(key_type, key_value) — a key value
// legitimately shared by two canonicals that were intentionally kept apart
// (e.g. same title/author but conflicting hardcover_book_id) could only ever
// be recorded against whichever book's INSERT OR IGNORE landed first. Scoped
// reconciliation's candidate expansion (bookIdentity.ts's expandScopeToRows)
// looks up candidates by key value, so the second canonical was silently
// undiscoverable by any scoped call — only a full reconcile would find it.
// Re-keyed to UNIQUE(book_id, key_type, key_value) so every book that legitimately
// carries a key gets its own row. No backfill needed: this table is a fully
// derived cache, rebuilt by the unscoped reconcile initSchema() always runs
// immediately after migrations (schema.ts) — dropping and recreating it here
// is simpler and just as correct as trying to migrate its (already partially
// wrong, pre-this-fix) existing contents.
const migration5: Migration = {
  version: 5,
  description: "Allow multiple canonicals to share an identity key in book_identity_keys",
  up(db: Database.Database): void {
    db.exec(`
      DROP TABLE book_identity_keys;
      CREATE TABLE book_identity_keys (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        key_type  TEXT NOT NULL,
        key_value TEXT NOT NULL,
        UNIQUE(book_id, key_type, key_value)
      );
      CREATE INDEX idx_book_identity_keys_book ON book_identity_keys(book_id);
      CREATE INDEX idx_book_identity_keys_value ON book_identity_keys(key_value);
    `);
  }
};

// Widens book_sources's uniqueness so a single Hardcover book can contribute
// up to two local rows for the same profile — one for the user's current
// reading-status edition ('primary', today's only case) and a second,
// secondary row for a format the user owns in a different way. That second
// row is bucket 'owned' when it comes from the user's Hardcover "Owned" list
// disagreeing with the current edition's format (e.g. reading a physical
// copy but owning the audiobook too), or bucket 'shared' when a real
// Grimmory sibling of the opposite format already exists for the same
// Hardcover book (see docs/sync.md's Hardcover Owned-List Import section).
// Every existing row keeps 'primary'. The 'owned' path only ever applies
// once a profile turns on the new "Owned Import" setting; the 'shared' path
// is not gated by that setting at all — it applies whenever a real opposite-
// format Grimmory sibling already exists, regardless of the toggle. Either
// way, behavior for a profile with no such sibling and the setting off is
// unchanged. SQLite can't ALTER an existing UNIQUE constraint, so this is a table
// rebuild preserving every row and column exactly, plus the new column and
// the indexes migration1/migration3 created (dropping the table drops them).
// Also adds hardcover_connections.owned_import_enabled, the per-profile
// opt-in for reading a Hardcover user's "Owned" list (a reserved system
// list, slug "owned") as a second, independent format-ownership signal
// alongside the current reading-status edition — see hardcover-sources.ts.
// Off by default: nothing changes for a profile until the user turns it on.
// Bundled into this same migration rather than a separate one since neither
// has shipped yet — both are new to this branch's still-open PR.
const migration6: Migration = {
  version: 6,
  description: "Add source_bucket to book_sources and owned_import_enabled to hardcover_connections",
  up(db: Database.Database): void {
    // Column list read live rather than hardcoded (same reasoning as
    // repository.ts's bookSourceColumns()): a database that reached this point
    // via the legacy pre-v14 handover chain isn't guaranteed to carry every
    // column the "flattened v14 shape" baseline lists — columns not present on
    // the existing table are simply skipped in the copy and land on their
    // default/NULL in the rebuilt table, same as they'd have been before.
    const existingColumns = new Set(
      (db.prepare("PRAGMA table_info(book_sources)").all() as { name: string }[]).map((c) => c.name)
    );
    const copyColumns = [
      "id", "book_id", "source_type", "source_instance_id", "external_id", "title", "author",
      "cover_url", "cover_cache_path", "isbn13", "isbn10", "series_name", "series_number",
      "source_hardcover_book_id", "source_hardcover_slug", "source_goodreads_book_id",
      "source_goodreads_work_id", "source_goodreads_edition_id", "source_edition_id",
      "source_edition_format", "source_media_type", "source_narrator", "source_asin",
      "source_audible_asin", "hardcover_slug", "hardcover_audio_seconds",
      "grimmory_hardcover_book_id", "grimmory_goodreads_id", "grimmory_hardcover_id",
      "grimmory_primary_file_path", "goodreads_book_link", "chaptarr_monitored",
      "chaptarr_has_file", "chaptarr_id_mismatch", "chaptarr_primary_file_path",
      "audiobookshelf_duration", "audiobookshelf_file_path", "audiobookshelf_asin",
      "audiobookshelf_runtime_validated", "audiobookshelf_runtime_delta",
      "last_sync_at", "last_sync_decision", "last_modified_at", "created_at"
    ];
    const droppedColumns = [...existingColumns].filter((column) => !copyColumns.includes(column));
    if (droppedColumns.length > 0) {
      // Not necessarily a bug — this rebuild's target shape is the flattened
      // v14 baseline, so an old column genuinely retired since then is
      // expected to be dropped here. But an unrecognized column could also
      // mean copyColumns is stale relative to a newer schema, so surface it
      // rather than silently discarding whatever data it held.
      logger.warn("Migration 6: dropping book_sources column(s) not in the target schema", { columns: droppedColumns });
    }
    const columnList = copyColumns.filter((column) => existingColumns.has(column)).join(", ");

    db.exec(`
      CREATE TABLE book_sources_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id          INTEGER REFERENCES books(id) ON DELETE CASCADE,
        source_type      TEXT NOT NULL,
        source_instance_id INTEGER,
        external_id      TEXT NOT NULL,
        title            TEXT,
        author           TEXT,
        cover_url        TEXT,
        cover_cache_path TEXT,
        isbn13           TEXT,
        isbn10           TEXT,
        series_name      TEXT,
        series_number    TEXT,
        source_hardcover_book_id   TEXT,
        source_hardcover_slug      TEXT,
        source_goodreads_book_id   TEXT,
        source_goodreads_work_id   TEXT,
        source_goodreads_edition_id TEXT,
        source_edition_id          TEXT,
        source_edition_format      TEXT,
        source_media_type          TEXT,
        source_narrator           TEXT,
        source_asin                TEXT,
        source_audible_asin        TEXT,
        hardcover_slug   TEXT,
        hardcover_audio_seconds INTEGER,
        grimmory_hardcover_book_id   TEXT,
        grimmory_goodreads_id        TEXT,
        grimmory_hardcover_id        TEXT,
        grimmory_primary_file_path   TEXT,
        goodreads_book_link TEXT,
        chaptarr_monitored         INTEGER,
        chaptarr_has_file          INTEGER,
        chaptarr_id_mismatch       INTEGER,
        chaptarr_primary_file_path TEXT,
        audiobookshelf_duration          INTEGER,
        audiobookshelf_file_path         TEXT,
        audiobookshelf_asin              TEXT,
        audiobookshelf_runtime_validated INTEGER,
        audiobookshelf_runtime_delta     INTEGER,
        last_sync_at     TEXT,
        last_sync_decision TEXT,
        last_modified_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        -- 'primary' for every existing row and every non-Hardcover source;
        -- 'owned' or 'shared' only for a second Hardcover row (see the
        -- migration comment above).
        source_bucket    TEXT NOT NULL DEFAULT 'primary',
        UNIQUE(source_type, source_instance_id, external_id, source_bucket)
      );

      INSERT INTO book_sources_new (${columnList}, source_bucket)
      SELECT ${columnList}, 'primary'
      FROM book_sources;

      DROP TABLE book_sources;
      ALTER TABLE book_sources_new RENAME TO book_sources;

      CREATE INDEX idx_book_sources_book ON book_sources(book_id);
      CREATE INDEX idx_book_sources_type ON book_sources(source_type);
      CREATE INDEX idx_book_sources_instance ON book_sources(source_type, source_instance_id);
      CREATE INDEX idx_book_sources_isbn13 ON book_sources(isbn13);
      CREATE INDEX idx_book_sources_isbn10 ON book_sources(isbn10);
      CREATE INDEX idx_book_sources_hardcover_book_id ON book_sources(source_hardcover_book_id);
      CREATE INDEX idx_book_sources_goodreads_book_id ON book_sources(source_goodreads_book_id);
      CREATE INDEX idx_book_sources_asin ON book_sources(source_asin);

      -- Per-profile opt-in for reading a Hardcover user's "Owned" list (a
      -- reserved system list, slug "owned") as a second, independent
      -- format-ownership signal alongside the current reading-status
      -- edition — see hardcover-sources.ts. Off by default: nothing changes
      -- for a profile until the user turns it on.
      ALTER TABLE hardcover_connections ADD COLUMN owned_import_enabled INTEGER NOT NULL DEFAULT 0;
    `);
  }
};

export const migrations: Migration[] = [migration1, migration2, migration3, migration4, migration5, migration6];

// Guards against a typo'd version number: a duplicate would let two migrations
// silently race to apply at the same version, and a gap (e.g. 1, 3 — skipping
// 2) would mean a database that stopped exactly at version 2 for any reason
// can never reach version 3, since getPendingMigrations() only ever looks for
// `version > currentVersion`, not sequential coverage.
const sortedVersions = migrations.map((m) => m.version).sort((a, b) => a - b);
for (let i = 0; i < sortedVersions.length; i++) {
  const expected = i + 1;
  if (sortedVersions[i] !== expected) {
    throw new Error(
      sortedVersions[i] === sortedVersions[i - 1]
        ? `Duplicate migration version ${sortedVersions[i]} in the migrations registry`
        : `Migration versions must be contiguous starting at 1 with no gaps; expected ${expected}, found ${sortedVersions[i]}`
    );
  }
}

export const LATEST_MIGRATION_VERSION = Math.max(...migrations.map((m) => m.version));

/**
 * Returns every migration newer than the database's current PRAGMA user_version,
 * ascending. Rejects a database whose user_version is newer than this build
 * knows about — otherwise a downgrade (rolling back to an older image after an
 * upgrade) would silently see no pending migrations and boot straight into a
 * schema it doesn't understand, risking corruption on write.
 */
export function getPendingMigrations(db: Database.Database): Migration[] {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  if (currentVersion > LATEST_MIGRATION_VERSION) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than this build supports (${LATEST_MIGRATION_VERSION}). Downgrading to this version is not supported.`
    );
  }
  return migrations.filter((m) => m.version > currentVersion).sort((a, b) => a.version - b.version);
}

// How many pre-migration backups to keep per database. Migrations are rare
// (one per shipped schema change), so this bounds disk use without needing a
// time-based retention setting like sync_runs has.
const MAX_RETAINED_BACKUPS = 5;

// Housekeeping only — a prune failure (e.g. a permissions issue on one stale
// file) must never block startup when the actual backup just above it
// succeeded. Log and move on rather than letting the error propagate.
function pruneOldBackups(backupDir: string, dbBaseName: string): void {
  try {
    const prefix = `${dbBaseName}.pre-migration-`;
    const backups = readdirSync(backupDir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
      .sort(); // the ISO timestamp in the filename sorts chronologically
    const stale = backups.slice(0, Math.max(0, backups.length - MAX_RETAINED_BACKUPS));
    for (const name of stale) {
      rmSync(path.join(backupDir, name), { force: true });
    }
    if (stale.length > 0) {
      logger.info("Pruned old pre-migration database backups", { pruned: stale.length, retained: MAX_RETAINED_BACKUPS });
    } else {
      logger.debug("No old pre-migration database backups to prune", { count: backups.length, retained: MAX_RETAINED_BACKUPS });
    }
  } catch (err) {
    logger.warn("Failed to prune old pre-migration database backups", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

// Hardening only — never let a permissions failure block startup or the backup
// itself. chmodSync throws EPERM if another UID owns an already-existing
// directory (plausible with a UID/GID mismatch in a container deployment) and
// throws outright on filesystems that don't support POSIX modes (e.g. a
// CIFS/SMB bind mount) — an install that boots fine today must not stop
// booting because this hardening couldn't apply.
function restrictPermissions(target: string, mode: number): void {
  try {
    chmodSync(target, mode);
  } catch (err) {
    logger.warn("Could not restrict permissions on a pre-migration backup path", {
      target,
      mode: mode.toString(8),
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Snapshots the database via VACUUM INTO before schema changes, so a failed
 * migration or handover has a restore point. Call this once per initSchema()
 * run (schema.ts threads the resulting path into both the legacy handover and
 * runMigrations() rather than each taking its own backup) — VACUUM INTO on an
 * already-open database is not free, and one snapshot already covers whatever
 * runs after it in the same startup.
 */
export function backupBeforeMigrating(db: Database.Database): string | undefined {
  const dbPath = db.name;
  if (!dbPath || dbPath === ":memory:") return undefined;

  const hasExistingTables = (
    db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get() as { count: number }
  ).count > 0;
  if (!hasExistingTables) return undefined; // nothing to protect on a brand-new database file

  const backupDir = path.join(path.dirname(dbPath), "backups");
  // Backups are full copies of the database — API tokens, refresh tokens, and
  // passwords included — so the directory is owner-only. mkdirSync's `mode` is
  // only applied when it actually creates the directory: with `recursive: true`
  // it silently no-ops (no chmod) on a directory that already exists, which
  // every already-deployed install has had since this feature's first commit.
  // The explicit chmod makes this retroactive instead of new-installs-only.
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  restrictPermissions(backupDir, 0o700);
  const dbBaseName = path.basename(dbPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `${dbBaseName}.pre-migration-${stamp}.bak`);

  db.prepare("VACUUM INTO ?").run(backupPath);
  // The directory is already owner-only, but lock the file down too — defense
  // in depth in case it's ever copied or the directory permissions loosen.
  restrictPermissions(backupPath, 0o600);
  pruneOldBackups(backupDir, dbBaseName);
  logger.info("Created pre-migration database backup", { backupPath });
  return backupPath;
}

/**
 * Thrown when a guarded step's `PRAGMA foreign_key_check` finds violations it
 * introduced. `label` and `violations` are kept as structured fields (not
 * baked into the message string) so callers that log this error can pass them
 * as meta rather than parsing them back out of free text.
 */
export class ForeignKeyViolationError extends Error {
  constructor(public readonly label: string, public readonly violations: ForeignKeyViolation[]) {
    super("Guarded migration step introduced new foreign-key violation(s)");
    this.name = "ForeignKeyViolationError";
  }
}

interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

function foreignKeyViolationKey(v: ForeignKeyViolation): string {
  return `${v.table}:${v.rowid}:${v.parent}:${v.fkid}`;
}

/**
 * Returns only the violations in `after` that weren't already present in
 * `before`. A database can carry pre-existing foreign-key inconsistencies
 * unrelated to migrations (historical data issues from before this crash-safety
 * system existed) — those must not newly block every future migration or
 * startup. Only violations a step actually introduces are worth failing over.
 */
function newForeignKeyViolations(before: ForeignKeyViolation[], after: ForeignKeyViolation[]): ForeignKeyViolation[] {
  const beforeKeys = new Set(before.map(foreignKeyViolationKey));
  return after.filter((v) => !beforeKeys.has(foreignKeyViolationKey(v)));
}

// Marks an error as already logged, so a guarded step nested inside another
// guarded step (the legacy handover's v7/v8/v9/v14 sub-steps, each wrapped in
// their own runTransactionalStep, all running inside the outer runGuardedStep
// around the whole handover) doesn't log the same failure a second time as it
// propagates outward.
const LOGGED_BY_GUARDED_STEP = Symbol("loggedByGuardedStep");

/**
 * Logs a migration/handover failure with recovery guidance, deduplicating via
 * LOGGED_BY_GUARDED_STEP so the same error isn't logged twice as it propagates
 * through nested guarded steps. Exported so callers with a step that needs
 * this same recovery-guidance logging, but doesn't need (or shouldn't get) a
 * full foreign-key check of its own — e.g. schema.ts's drop-schema_version-
 * and-bump-version step, which touches no foreign-key-bearing data — can use
 * it directly instead of wrapping in another runGuardedStep()/runTransactionalStep().
 */
export function logGuardedFailure(label: string, backupPath: string | undefined, err: unknown): void {
  if (err && typeof err === "object" && LOGGED_BY_GUARDED_STEP in err) return;

  const recovery = backupPath
    ? `Restore from the pre-migration backup at ${backupPath} and investigate before retrying.`
    : "No pre-migration backup was available (fresh database) — investigate before retrying.";
  if (err instanceof ForeignKeyViolationError) {
    logger.error(err.message, { label: err.label, count: err.violations.length, violations: err.violations, recovery });
  } else {
    logger.error("Guarded migration step failed", { label, error: err instanceof Error ? err.message : String(err), recovery });
  }

  if (err && typeof err === "object") {
    Object.defineProperty(err, LOGGED_BY_GUARDED_STEP, { value: true, enumerable: false });
  }
}

function logPreExistingViolationsIfAny(label: string, violations: ForeignKeyViolation[]): void {
  if (violations.length === 0) return;
  logger.warn("Guarded migration step completed with pre-existing foreign-key violations it did not introduce", {
    label,
    count: violations.length,
    violations
  });
}

/**
 * Runs `step` and a `PRAGMA foreign_key_check` inside one transaction, so a
 * newly-introduced violation rolls back `step`'s changes atomically instead of
 * merely being detected after they already committed. This is the preferred
 * guard for any new, self-contained migration step — used by runMigrations()
 * and by the legacy handover's own v7/v8/v9/v14 sub-steps in schema.ts.
 *
 * Only violations introduced by `step` itself are fatal — see
 * newForeignKeyViolations(). Pre-existing violations are logged, not thrown.
 *
 * `step` must not itself open a nested transaction that toggles `PRAGMA
 * foreign_keys` — that pragma is a silent no-op inside an already-open
 * transaction, so a step relying on it (e.g. a table rebuild) needs the
 * pragma toggled by its caller *before* calling this function, not inside it.
 */
export function runTransactionalStep(db: Database.Database, label: string, backupPath: string | undefined, step: () => void): void {
  const before = db.pragma("foreign_key_check") as ForeignKeyViolation[];

  const guarded = db.transaction(() => {
    step();
    const after = db.pragma("foreign_key_check") as ForeignKeyViolation[];
    const introduced = newForeignKeyViolations(before, after);
    if (introduced.length > 0) {
      throw new ForeignKeyViolationError(label, introduced);
    }
    logPreExistingViolationsIfAny(label, after);
  });

  try {
    guarded();
  } catch (err) {
    logGuardedFailure(label, backupPath, err);
    throw err;
  }
}

/**
 * Runs `step` (which manages its own transactionality, or is a sequence of
 * several independently-committed statements that cannot be wrapped in one
 * outer transaction — e.g. the legacy schema_version upgrade chain as a
 * whole, which toggles `PRAGMA foreign_keys` around some of its own
 * sub-steps), then checks `PRAGMA foreign_key_check` afterward.
 *
 * Only violations introduced by `step` itself are fatal — see
 * newForeignKeyViolations(). Because `step` has already committed by the time
 * this runs, an introduced violation here can only abort startup with recovery
 * guidance — it cannot roll anything back. Prefer runTransactionalStep() over
 * this for any new, self-contained migration step; this function exists for
 * the cases where that genuinely isn't possible.
 */
export function runGuardedStep(db: Database.Database, label: string, backupPath: string | undefined, step: () => void): void {
  const before = db.pragma("foreign_key_check") as ForeignKeyViolation[];

  try {
    step();
  } catch (err) {
    logGuardedFailure(label, backupPath, err);
    throw err;
  }

  const after = db.pragma("foreign_key_check") as ForeignKeyViolation[];
  const introduced = newForeignKeyViolations(before, after);
  if (introduced.length > 0) {
    const err = new ForeignKeyViolationError(label, introduced);
    logGuardedFailure(label, backupPath, err);
    throw err;
  }
  logPreExistingViolationsIfAny(label, after);
}

/**
 * Applies every migration newer than the database's current `PRAGMA user_version`,
 * in ascending order, each via runTransactionalStep() — one transaction per
 * migration covering both its schema/data changes and the `user_version` bump,
 * with a `foreign_key_check` before commit — so a mid-migration failure or a
 * foreign-key regression rolls back cleanly instead of partially applying.
 *
 * If `precomputedBackupPath` is passed, it's used as-is (the caller already took
 * a backup this startup — schema.ts's `initSchema()` does this so the legacy
 * handover and a pending migration 2+ share one VACUUM INTO snapshot instead of
 * each taking their own). If omitted and there's anything pending, this function
 * takes its own backup via backupBeforeMigrating().
 */
export function runMigrations(db: Database.Database, precomputedBackupPath?: string): void {
  const pending = getPendingMigrations(db);
  if (pending.length === 0) return;

  const backupPath = precomputedBackupPath ?? backupBeforeMigrating(db);

  for (const migration of pending) {
    logger.info("Starting schema migration", { version: migration.version, description: migration.description });

    runTransactionalStep(db, `Schema migration to version ${migration.version}`, backupPath, () => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });

    logger.info("Schema migrated", { version: migration.version, description: migration.description });
  }
}
