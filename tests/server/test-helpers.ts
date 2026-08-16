import type Database from "better-sqlite3";
import type { SyncAdapters } from "../../src/server/sync/adapters.js";

export type LogEntry = { level: "debug" | "info" | "warn" | "error"; message: string; meta?: unknown };

export function createCapturingLogger() {
  const entries: LogEntry[] = [];
  const logger = {
    debug: (message: string, meta?: unknown) => entries.push({ level: "debug", message, meta }),
    info: (message: string, meta?: unknown) => entries.push({ level: "info", message, meta }),
    warn: (message: string, meta?: unknown) => entries.push({ level: "warn", message, meta }),
    error: (message: string, meta?: unknown) => entries.push({ level: "error", message, meta })
  };

  return { logger, entries };
}

/** Inserts a minimal profile row and returns its id. */
export function seedProfile(db: Database.Database, displayName = "Test Profile"): number {
  const result = db.prepare("INSERT INTO profiles (display_name) VALUES (?)").run(displayName);
  return Number(result.lastInsertRowid);
}

export function seedSyncSettings(
  db: Database.Database,
  profileId: number,
  overrides: Partial<{
    conflict_strategy: string;
    sync_status_enabled: number;
    sync_progress_enabled: number;
    sync_shelves_enabled: number;
    sync_goodreads_enabled: number;
    sync_write_tag_enabled: number;
  }> = {}
): void {
  const fields = {
    conflict_strategy: "latest_wins",
    sync_status_enabled: 1,
    sync_progress_enabled: 0,
    sync_shelves_enabled: 0,
    sync_goodreads_enabled: 0,
    sync_write_tag_enabled: 0,
    ...overrides
  };
  db.prepare(`
    INSERT INTO sync_settings (profile_id, conflict_strategy, sync_status_enabled, sync_progress_enabled, sync_shelves_enabled, sync_goodreads_enabled, sync_write_tag_enabled)
    VALUES (@profileId, @conflict_strategy, @sync_status_enabled, @sync_progress_enabled, @sync_shelves_enabled, @sync_goodreads_enabled, @sync_write_tag_enabled)
  `).run({ profileId, ...fields });
}

/** Inserts a Hardcover connection. */
export function seedHardcoverConnection(db: Database.Database, profileId: number, token = "hc-test-token"): void {
  db.prepare("INSERT INTO hardcover_connections (profile_id, api_token) VALUES (?, ?)").run(profileId, token);
}

/** Inserts a Grimmory connection. */
export function seedGrimmoryConnection(
  db: Database.Database,
  profileId: number,
  fields: { baseUrl?: string; username?: string; password?: string } = {}
): void {
  db.prepare(`
    INSERT INTO grimmory_connections (profile_id, base_url, username, password)
    VALUES (?, ?, ?, ?)
  `).run(profileId, fields.baseUrl ?? "https://grimmory.example.com", fields.username ?? "testuser", fields.password ?? "test-password");
}

export function insertSyncRun(db: Database.Database, profileId: number, dryRun = false): number {
  return Number(
    db.prepare("INSERT INTO sync_runs (profile_id, status, summary, dry_run) VALUES (?, 'running', 'Sync started', ?)")
      .run(profileId, dryRun ? 1 : 0)
      .lastInsertRowid
  );
}

/**
 * Builds a full SyncAdapters implementation where every method not present in
 * `overrides` throws — so a test fails loudly if the sync engine calls an
 * external adapter it wasn't expected to touch, instead of silently hitting a
 * `.foo is not a function` deep inside runSyncImpl.
 */
export function createFakeAdapters(overrides: Partial<SyncAdapters>): SyncAdapters {
  const names: (keyof SyncAdapters)[] = [
    "fetchHardcoverUserId", "fetchHardcoverLibrary", "fetchHardcoverEditions", "fetchHardcoverLists",
    "fetchEditionsForBook", "updateHardcoverUserBook", "insertHardcoverUserBook", "addBookToHardcoverList",
    "insertHardcoverUserBookRead", "updateHardcoverUserBookRead", "deleteHardcoverUserBookRead",
    "testGrimmoryLogin", "fetchGrimmoryBooks", "updateGrimmoryStatus", "updateGrimmoryRating",
    "fetchGrimmoryShelfBookIds", "fetchGrimmoryShelfList", "ensureGrimmoryShelf", "addBooksToGrimmoryShelf", "fetchGrimmoryProgress",
    "updateGrimmoryProgress", "clearGrimmoryProgress", "addGrimmoryTag", "fetchAllGoodreadsBooks",
    "fetchShelfPage", "syncChaptarrStatus", "fetchAudiobookshelfLibraries", "fetchAudiobookshelfLibraryItems",
    "fetchAudiobookshelfAllProgress"
  ];
  const stub: Record<string, unknown> = {
    // Chaptarr is a single global connection (not per-profile — see the v14 schema
    // migration comment), so runSyncImpl calls this unconditionally on every sync
    // regardless of whether Chaptarr is configured. Default it to a no-op so tests
    // that don't care about Chaptarr don't have to override it every time.
    syncChaptarrStatus: async () => {}
  };
  for (const name of names) {
    stub[name] = overrides[name] ?? stub[name] ?? (() => {
      throw new Error(`adapters.${name} should not have been called in this test`);
    });
  }
  return stub as unknown as SyncAdapters;
}
