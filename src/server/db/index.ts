import BetterSqlite3 from "better-sqlite3";
import path from "path";
import { initSchema } from "./schema.js";

const DATA_DIR = process.env["DATA_DIR"] ?? "./data";
const DB_PATH = path.join(DATA_DIR, "shelfbridge.db");

let _db: BetterSqlite3.Database | null = null;

export function getDb(): BetterSqlite3.Database {
  if (!_db) {
    _db = new BetterSqlite3(DB_PATH);
    initSchema(_db);
  }
  return _db;
}

// ─── Settings helpers ─────────────────────────────────────────────────────────

export function getSetting(key: string, fallback: string): string {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  setSettingForDb(getDb(), key, value);
}

export function setSettingForDb(db: BetterSqlite3.Database, key: string, value: string): void {
  db
    .prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}
