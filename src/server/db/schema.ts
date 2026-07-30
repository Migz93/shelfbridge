import type Database from "better-sqlite3";
import { reconcileBookIdentities } from "./bookIdentity.js";
import { migrateCredentialStorage } from "../security/credentials.js";
import { logger } from "../logger.js";

export const CURRENT_SCHEMA_VERSION = 14;

export function initSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id         TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS grimmory_connections (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id            INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      base_url              TEXT NOT NULL DEFAULT '',
      username              TEXT NOT NULL DEFAULT '',
      encrypted_password    TEXT NOT NULL DEFAULT '',
      encrypted_refresh_token TEXT,
      grimmory_user_id      TEXT,
      status                TEXT NOT NULL DEFAULT 'untested',
      last_tested_at        TEXT,
      last_success_at       TEXT,
      UNIQUE(profile_id)
    );

    CREATE TABLE IF NOT EXISTS hardcover_connections (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id          INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      encrypted_api_token TEXT NOT NULL DEFAULT '',
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

    CREATE TABLE IF NOT EXISTS audiobookshelf_connections (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id            INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      encrypted_api_key     TEXT NOT NULL DEFAULT '',
      abs_user_id           TEXT,
      abs_username          TEXT,
      status                TEXT NOT NULL DEFAULT 'untested',
      last_tested_at        TEXT,
      last_success_at       TEXT,
      UNIQUE(profile_id)
    );

    CREATE TABLE IF NOT EXISTS goodreads_connections (
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

    CREATE TABLE IF NOT EXISTS sync_settings (
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
    CREATE TABLE IF NOT EXISTS books (
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

    -- One row per (book × source system). No profile_id — this is book-level identity data.
    -- external_id is the source's own ID for this book.
    -- book_id is nullable until reconcileBookIdentities() assigns it.
    CREATE TABLE IF NOT EXISTS book_sources (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id          INTEGER REFERENCES books(id) ON DELETE CASCADE,
      source_type      TEXT NOT NULL CHECK(source_type IN ('hardcover','goodreads','grimmory','chaptarr')),
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
      -- Sync metadata
      last_sync_at     TEXT,
      last_sync_decision TEXT,
      last_modified_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_type, external_id)
    );

    -- One row per (book × profile × source) where the profile has user activity.
    CREATE TABLE IF NOT EXISTS user_book_states (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id          INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      profile_id       INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      source_type      TEXT NOT NULL CHECK(source_type IN ('hardcover','goodreads','grimmory')),
      -- Generic reading state (mapped from source-specific values)
      status           TEXT,
      rating           REAL,
      progress         REAL,
      progress_pages   INTEGER,
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
      last_sync_at     TEXT,
      last_modified_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(book_id, profile_id, source_type)
    );

    CREATE TABLE IF NOT EXISTS book_identity_keys (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      key_type  TEXT NOT NULL,
      key_value TEXT NOT NULL,
      UNIQUE(key_type, key_value)
    );

    CREATE TABLE IF NOT EXISTS book_duplicate_dismissals (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id_low    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      book_id_high   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      dismissed_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(book_id_low, book_id_high),
      CHECK(book_id_low < book_id_high)
    );

    CREATE TABLE IF NOT EXISTS chaptarr_id_mismatch_dismissals (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      chaptarr_external_id  TEXT NOT NULL UNIQUE,
      dismissed_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shelf_mappings (
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

    CREATE TABLE IF NOT EXISTS sync_runs (
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

    CREATE TABLE IF NOT EXISTS sync_events (
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

    CREATE TABLE IF NOT EXISTS job_run_state (
      job_id          TEXT PRIMARY KEY,
      last_run_at     TEXT,
      last_run_status TEXT
    );

    CREATE TABLE IF NOT EXISTS image_cache (
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

    CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
    CREATE INDEX IF NOT EXISTS idx_book_sources_book ON book_sources(book_id);
    CREATE INDEX IF NOT EXISTS idx_book_sources_type ON book_sources(source_type);
    CREATE INDEX IF NOT EXISTS idx_book_identity_keys_book ON book_identity_keys(book_id);
    CREATE INDEX IF NOT EXISTS idx_book_duplicate_dismissals_low ON book_duplicate_dismissals(book_id_low);
    CREATE INDEX IF NOT EXISTS idx_book_duplicate_dismissals_high ON book_duplicate_dismissals(book_id_high);
    CREATE INDEX IF NOT EXISTS idx_user_book_states_book ON user_book_states(book_id);
    CREATE INDEX IF NOT EXISTS idx_user_book_states_profile ON user_book_states(profile_id);
    CREATE INDEX IF NOT EXISTS idx_user_book_states_profile_source ON user_book_states(profile_id, source_type);
    CREATE INDEX IF NOT EXISTS idx_sync_runs_profile ON sync_runs(profile_id);
    CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sync_events_run ON sync_events(sync_run_id);
    CREATE INDEX IF NOT EXISTS idx_image_cache_key ON image_cache(cache_key);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
  `);

  db.prepare("DELETE FROM auth_sessions WHERE expires_at <= datetime('now')").run();

  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  if (!row) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(CURRENT_SCHEMA_VERSION);
  }

  // Add file-path columns to book_sources if they don't exist yet
  const bookCols = db.prepare("PRAGMA table_info(books)").all() as { name: string }[];
  if (!bookCols.some((c) => c.name === "media_type")) {
    db.exec("ALTER TABLE books ADD COLUMN media_type TEXT NOT NULL DEFAULT 'unknown'");
  }
  if (!bookCols.some((c) => c.name === "series_name")) {
    db.exec("ALTER TABLE books ADD COLUMN series_name TEXT");
  }
  if (!bookCols.some((c) => c.name === "series_number")) {
    db.exec("ALTER TABLE books ADD COLUMN series_number TEXT");
  }

  const bookSourceCols = db.prepare("PRAGMA table_info(book_sources)").all() as { name: string }[];
  if (!bookSourceCols.some((c) => c.name === "series_name")) {
    db.exec("ALTER TABLE book_sources ADD COLUMN series_name TEXT");
  }
  if (!bookSourceCols.some((c) => c.name === "series_number")) {
    db.exec("ALTER TABLE book_sources ADD COLUMN series_number TEXT");
  }
  if (!bookSourceCols.some((c) => c.name === "grimmory_primary_file_path")) {
    db.exec("ALTER TABLE book_sources ADD COLUMN grimmory_primary_file_path TEXT");
  }
  if (!bookSourceCols.some((c) => c.name === "chaptarr_primary_file_path")) {
    db.exec("ALTER TABLE book_sources ADD COLUMN chaptarr_primary_file_path TEXT");
  }
  const sourceIdentifierColumns = [
    "source_hardcover_book_id",
    "source_hardcover_slug",
    "source_goodreads_book_id",
    "source_goodreads_work_id",
    "source_goodreads_edition_id",
    "source_edition_id",
    "source_edition_format",
    "source_media_type",
    "source_narrator",
    "source_asin",
    "source_audible_asin"
  ];
  for (const col of sourceIdentifierColumns) {
    if (!bookSourceCols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE book_sources ADD COLUMN ${col} TEXT`);
    }
  }

  const hardcoverCols = db.prepare("PRAGMA table_info(hardcover_connections)").all() as { name: string }[];
  if (!hardcoverCols.some((c) => c.name === "target_shelf_name")) {
    db.exec("ALTER TABLE hardcover_connections ADD COLUMN target_shelf_name TEXT");
  }

  const goodreadsCols = db.prepare("PRAGMA table_info(goodreads_connections)").all() as { name: string }[];
  if (!goodreadsCols.some((c) => c.name === "target_shelf_name")) {
    db.exec("ALTER TABLE goodreads_connections ADD COLUMN target_shelf_name TEXT");
  }

  // v3: clean up orphan books and duplicate grimmory sources produced by the
  // profile-sync race condition (diagnosed 2026-05-11).
  if (!row || row.version < 3) {
    // Orphan books: empty title, no non-chaptarr source (created when two
    // profile syncs ran concurrently and reconcile remapped grimmory sources
    // away from the stub book_id mid-sync).
    db.exec(`
      DELETE FROM books WHERE id IN (
        SELECT b.id FROM books b
        WHERE b.title = ''
          AND NOT EXISTS (
            SELECT 1 FROM book_sources
            WHERE book_id = b.id AND source_type != 'chaptarr'
          )
      )
    `);

    // Duplicate grimmory book_sources: keep only the earliest row per
    // external_id (concurrent reconcile runs could assign the same grimmory
    // external_id to different book_id values).
    db.exec(`
      DELETE FROM book_sources
      WHERE source_type = 'grimmory'
        AND id NOT IN (
          SELECT MIN(id) FROM book_sources
          WHERE source_type = 'grimmory'
          GROUP BY external_id
        )
    `);

    db.prepare("UPDATE schema_version SET version = 3").run();
    logger.info("Schema migrated to version 3: orphan books and duplicate grimmory sources cleaned up");
  }

  if (!row || row.version < 4) {
    db.prepare("UPDATE schema_version SET version = 4").run();
    logger.info("Schema migrated to version 4: source edition and media metadata columns available");
  }

  if (!row || row.version < 5) {
    db.prepare(`
      UPDATE books
      SET media_type = CASE
        WHEN EXISTS (
          SELECT 1 FROM book_sources
          WHERE book_id = books.id AND source_media_type = 'audiobook'
        ) THEN 'audiobook'
        WHEN EXISTS (
          SELECT 1 FROM book_sources
          WHERE book_id = books.id AND source_media_type IN ('book', 'ebook', 'physical')
        ) THEN 'book'
        ELSE 'unknown'
      END
    `).run();
    db.prepare("UPDATE schema_version SET version = 5").run();
    logger.info("Schema migrated to version 5: canonical book media types added");
  }

  // v6: Audiobookshelf integration — connection table + book_sources columns
  const absConnectionExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='audiobookshelf_connections'"
  ).get();
  if (!absConnectionExists) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audiobookshelf_connections (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id            INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        encrypted_api_key     TEXT NOT NULL DEFAULT '',
        abs_user_id           TEXT,
        abs_username          TEXT,
        status                TEXT NOT NULL DEFAULT 'untested',
        last_tested_at        TEXT,
        last_success_at       TEXT,
        UNIQUE(profile_id)
      )
    `);
  }

  const absBookSourceCols = db.prepare("PRAGMA table_info(book_sources)").all() as { name: string }[];
  const absColumns = [
    "audiobookshelf_duration",
    "audiobookshelf_file_path",
    "audiobookshelf_asin",
    "audiobookshelf_runtime_validated",
    "audiobookshelf_runtime_delta",
  ];
  for (const col of absColumns) {
    if (!absBookSourceCols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE book_sources ADD COLUMN ${col} ${col.endsWith("_validated") ? "INTEGER" : col.endsWith("_delta") || col.endsWith("_duration") ? "INTEGER" : "TEXT"}`);
    }
  }

  // Expand book_sources source_type CHECK to include audiobookshelf
  // SQLite does not support modifying CHECK constraints; the constraint is
  // not enforced on existing rows and new inserts are validated at the app level.

  const ubsAbs = db.prepare("PRAGMA table_info(user_book_states)").all() as { name: string }[];
  const ubsAbsColumns = [
    "audiobookshelf_item_id",
    "audiobookshelf_updated_at",
    "audiobookshelf_current_time",
    "audiobookshelf_duration",
  ];
  for (const col of ubsAbsColumns) {
    if (!ubsAbs.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE user_book_states ADD COLUMN ${col} ${col.endsWith("_time") || col.endsWith("_duration") ? "INTEGER" : "TEXT"}`);
    }
  }

  if (!row || row.version < 6) {
    db.prepare("UPDATE schema_version SET version = 6").run();
    logger.info("Schema migrated to version 6: Audiobookshelf integration tables and columns added");
  }

  // v7: Rebuild book_sources to drop the CHECK constraint on source_type so
  // 'audiobookshelf' rows can be inserted. Also rebuild user_book_states to
  // drop its CHECK constraint for the same reason.
  if (!row || row.version < 7) {
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE IF NOT EXISTS book_sources_v7 (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id          INTEGER REFERENCES books(id) ON DELETE CASCADE,
        source_type      TEXT NOT NULL,
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
        source_narrator            TEXT,
        source_asin                TEXT,
        source_audible_asin        TEXT,
        hardcover_slug   TEXT,
        grimmory_hardcover_book_id   TEXT,
        grimmory_goodreads_id        TEXT,
        grimmory_hardcover_id        TEXT,
        grimmory_primary_file_path   TEXT,
        goodreads_book_link TEXT,
        chaptarr_monitored         INTEGER,
        chaptarr_has_file          INTEGER,
        chaptarr_id_mismatch       INTEGER,
        chaptarr_primary_file_path TEXT,
        audiobookshelf_duration    INTEGER,
        audiobookshelf_file_path   TEXT,
        audiobookshelf_asin        TEXT,
        audiobookshelf_runtime_validated INTEGER,
        audiobookshelf_runtime_delta     INTEGER,
        last_sync_at     TEXT,
        last_sync_decision TEXT,
        last_modified_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source_type, external_id)
      );
      INSERT INTO book_sources_v7
        SELECT id, book_id, source_type, external_id, title, author,
               cover_url, cover_cache_path, isbn13, isbn10, series_name, series_number,
               source_hardcover_book_id, source_hardcover_slug, source_goodreads_book_id,
               source_goodreads_work_id, source_goodreads_edition_id, source_edition_id,
               source_edition_format, source_media_type, source_narrator, source_asin,
               source_audible_asin, hardcover_slug,
               grimmory_hardcover_book_id, grimmory_goodreads_id, grimmory_hardcover_id,
               grimmory_primary_file_path, goodreads_book_link,
               chaptarr_monitored, chaptarr_has_file, chaptarr_id_mismatch,
               chaptarr_primary_file_path,
               audiobookshelf_duration, audiobookshelf_file_path, audiobookshelf_asin,
               audiobookshelf_runtime_validated, audiobookshelf_runtime_delta,
               last_sync_at, last_sync_decision, last_modified_at, created_at
        FROM book_sources;
      DROP TABLE book_sources;
      ALTER TABLE book_sources_v7 RENAME TO book_sources;

      CREATE TABLE IF NOT EXISTS user_book_states_v7 (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id          INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        profile_id       INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        source_type      TEXT NOT NULL,
        status           TEXT,
        rating           REAL,
        progress         REAL,
        progress_pages   INTEGER,
        last_read_date   TEXT,
        date_finished    TEXT,
        sync_health      TEXT NOT NULL DEFAULT 'pending',
        has_superseded   INTEGER NOT NULL DEFAULT 0,
        match_confidence TEXT NOT NULL DEFAULT 'none',
        match_type       TEXT,
        last_sync_decision TEXT,
        hardcover_status_id  INTEGER,
        hardcover_read_id    INTEGER,
        hardcover_updated_at TEXT,
        hardcover_list_id    INTEGER,
        hardcover_pages      INTEGER,
        goodreads_shelf      TEXT,
        goodreads_read_at    TEXT,
        goodreads_updated_at TEXT,
        goodreads_match_type TEXT,
        goodreads_book_link  TEXT,
        grimmory_last_read_time TEXT,
        grimmory_primary_file_id INTEGER,
        grimmory_shelves     TEXT,
        audiobookshelf_item_id   TEXT,
        audiobookshelf_updated_at TEXT,
        audiobookshelf_current_time INTEGER,
        audiobookshelf_duration INTEGER,
        last_sync_at     TEXT,
        last_modified_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(book_id, profile_id, source_type)
      );
      INSERT INTO user_book_states_v7
        SELECT id, book_id, profile_id, source_type, status, rating, progress, progress_pages,
               last_read_date, date_finished, sync_health, has_superseded, match_confidence,
               match_type, last_sync_decision, hardcover_status_id, hardcover_read_id,
               hardcover_updated_at, hardcover_list_id, hardcover_pages,
               goodreads_shelf, goodreads_read_at, goodreads_updated_at, goodreads_match_type,
               goodreads_book_link, grimmory_last_read_time, grimmory_primary_file_id,
               grimmory_shelves,
               audiobookshelf_item_id, audiobookshelf_updated_at, audiobookshelf_current_time,
               audiobookshelf_duration,
               last_sync_at, last_modified_at, created_at
        FROM user_book_states;
      DROP TABLE user_book_states;
      ALTER TABLE user_book_states_v7 RENAME TO user_book_states;

      CREATE INDEX IF NOT EXISTS idx_book_sources_book ON book_sources(book_id);
      CREATE INDEX IF NOT EXISTS idx_book_sources_type ON book_sources(source_type);
      CREATE INDEX IF NOT EXISTS idx_user_book_states_book ON user_book_states(book_id);
      CREATE INDEX IF NOT EXISTS idx_user_book_states_profile ON user_book_states(profile_id);
      CREATE INDEX IF NOT EXISTS idx_user_book_states_profile_source ON user_book_states(profile_id, source_type);
    `);
    db.pragma("foreign_keys = ON");
    db.prepare("UPDATE schema_version SET version = 7").run();
    logger.info("Schema migrated to version 7: removed source_type CHECK constraints to allow audiobookshelf rows");
  }

  // v8: Add hardcover_audio_seconds to book_sources and hardcover_user_book_id + progress_seconds to user_book_states
  if (!row || row.version < 8) {
    db.exec(`
      ALTER TABLE book_sources ADD COLUMN hardcover_audio_seconds INTEGER;
      ALTER TABLE user_book_states ADD COLUMN hardcover_user_book_id INTEGER;
      ALTER TABLE user_book_states ADD COLUMN progress_seconds INTEGER;
    `);
    db.prepare("UPDATE schema_version SET version = 8").run();
    logger.info("Schema migrated to version 8: added hardcover_audio_seconds, hardcover_user_book_id, progress_seconds");
  }

  // v9: Cache the resolved Hardcover edition for progress tracking.
  // hardcover_edition_id: the edition we've matched and will pass in progress writes.
  // hardcover_edition_pages: the page count we matched against — if hcPages drifts from
  // this (e.g. user switches edition or file is replaced), we know to re-resolve.
  if (!row || row.version < 9) {
    db.exec(`
      ALTER TABLE user_book_states ADD COLUMN hardcover_edition_id INTEGER;
      ALTER TABLE user_book_states ADD COLUMN hardcover_edition_pages INTEGER;
    `);
    db.prepare("UPDATE schema_version SET version = 9").run();
    logger.info("Schema migrated to version 9: added hardcover_edition_id, hardcover_edition_pages");
  }

  if (!row || row.version < 10) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS book_duplicate_dismissals (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id_low    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        book_id_high   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        dismissed_at   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(book_id_low, book_id_high),
        CHECK(book_id_low < book_id_high)
      );
      CREATE INDEX IF NOT EXISTS idx_book_duplicate_dismissals_low ON book_duplicate_dismissals(book_id_low);
      CREATE INDEX IF NOT EXISTS idx_book_duplicate_dismissals_high ON book_duplicate_dismissals(book_id_high);
    `);
    db.prepare("UPDATE schema_version SET version = 10").run();
    logger.info("Schema migrated to version 10: added duplicate dismissal tracking");
  }

  if (!row || row.version < 11) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chaptarr_id_mismatch_dismissals (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        chaptarr_external_id  TEXT NOT NULL UNIQUE,
        dismissed_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare("UPDATE schema_version SET version = 11").run();
    logger.info("Schema migrated to version 11: added Chaptarr ID mismatch dismissal tracking");
  }

  if (!row || row.version < 12) {
    const userStateCols = db.prepare("PRAGMA table_info(user_book_states)").all() as { name: string }[];
    if (!userStateCols.some((col) => col.name === "grimmory_book_id")) {
      db.exec("ALTER TABLE user_book_states ADD COLUMN grimmory_book_id INTEGER;");
    }
    db.prepare("UPDATE schema_version SET version = 12").run();
    logger.info("Schema migrated to version 12: added Grimmory book identity tracking on user states");
  }

  if (!row || row.version < 13) {
    // A prior bug bound "datetime('now')" as a plain parameter instead of evaluating it as
    // SQL, so some rows have the literal string stored instead of a real timestamp. Treat
    // those as unknown rather than guessing a time — NULL sorts/compares safely either way.
    const repaired = db
      .prepare("UPDATE book_sources SET last_sync_at = NULL WHERE last_sync_at = ?")
      .run("datetime('now')");
    if (repaired.changes > 0) {
      logger.warn("Repaired book_sources rows with literal last_sync_at value", { count: repaired.changes });
    }
    db.prepare("UPDATE schema_version SET version = 13").run();
    logger.info("Schema migrated to version 13: repaired literal last_sync_at values");
  }

  // v14: Scope book_sources uniqueness to (source_type, source_instance_id, external_id).
  // Previously (source_type, external_id) was globally unique, which collided when a
  // user configured two instances of the same integration (e.g. two Grimmory servers)
  // that happen to reuse the same local ID for different books.
  if (!row || row.version < 14) {
    const existingCols = db.prepare("PRAGMA table_info(book_sources)").all() as {
      name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
    }[];
    const colNames = existingCols.map((c) => c.name);
    const colDefs = existingCols.map((c) => {
      if (c.name === "id") return "id INTEGER PRIMARY KEY AUTOINCREMENT";
      if (c.name === "book_id") return "book_id INTEGER REFERENCES books(id) ON DELETE CASCADE";
      let def = `${c.name} ${c.type}`;
      if (c.notnull) def += " NOT NULL";
      if (c.dflt_value !== null) def += ` DEFAULT (${c.dflt_value})`;
      return def;
    });

    // foreign_keys is a no-op inside a transaction, so it must be toggled outside the
    // BEGIN/COMMIT below. The rebuild + backfill + version bump run as a single
    // transaction so a mid-migration failure can't leave book_sources half-rebuilt.
    db.pragma("foreign_keys = OFF");
    try {
      const migrateV14 = db.transaction(() => {
        db.exec(`
          CREATE TABLE book_sources_v14 (
            ${colDefs.join(",\n            ")},
            source_instance_id INTEGER,
            UNIQUE(source_type, source_instance_id, external_id)
          );
          INSERT INTO book_sources_v14 (${colNames.join(", ")})
            SELECT ${colNames.join(", ")} FROM book_sources;
          DROP TABLE book_sources;
          ALTER TABLE book_sources_v14 RENAME TO book_sources;

          CREATE INDEX IF NOT EXISTS idx_book_sources_book ON book_sources(book_id);
          CREATE INDEX IF NOT EXISTS idx_book_sources_type ON book_sources(source_type);
          CREATE INDEX IF NOT EXISTS idx_book_sources_instance ON book_sources(source_type, source_instance_id);
        `);

        // Chaptarr is a single global connection (not per-profile), so it always gets a
        // fixed instance id — future upserts target the same row instead of duplicating.
        db.prepare(`
          UPDATE book_sources SET source_instance_id = 0
          WHERE source_type = 'chaptarr' AND source_instance_id IS NULL
        `).run();

        // Per-profile sources (Grimmory/Hardcover/Goodreads/Audiobookshelf) are
        // deliberately left unscoped (source_instance_id = NULL) rather than guessed from
        // the currently configured connections. Even a single currently-configured
        // connection isn't reliable proof of historical ownership — a second connection
        // could have existed and been deleted, or the connection could have been
        // reconfigured to point at a different server, before the upgrade. An unscoped
        // row simply won't match any profile's upsert lookup, so each profile creates a
        // fresh, correctly-scoped row for its own data on its next sync; identity
        // reconciliation still clusters it with the same canonical book via ISBN/ID
        // matching. Unscoped rows are not touched by per-instance pruning, so existing
        // installs may carry a bounded amount of unscoped leftover data until cleaned up
        // separately — safer than risking a misattributed row being overwritten by an
        // unrelated book on a live connection.
        const unscopedCount = (db.prepare(`
          SELECT COUNT(*) AS count FROM book_sources
          WHERE source_type IN ('grimmory', 'hardcover', 'goodreads', 'audiobookshelf')
            AND source_instance_id IS NULL
        `).get() as { count: number }).count;
        if (unscopedCount > 0) {
          logger.warn("Existing per-profile book_sources rows left unscoped after v14 migration; each profile's next sync creates fresh scoped rows and leaves these as inert historical rows", {
            count: unscopedCount
          });
        }

        db.prepare("UPDATE schema_version SET version = 14").run();
      });
      migrateV14();
    } finally {
      db.pragma("foreign_keys = ON");
    }
    logger.info("Schema migrated to version 14: scoped book_sources uniqueness to (source_type, source_instance_id, external_id)");
  }

  migrateCredentialStorage(db);
  reconcileBookIdentities(db);
}
