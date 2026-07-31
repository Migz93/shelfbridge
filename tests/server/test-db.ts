import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initSchema } from "../../src/server/db/schema.js";

export function createTestDatabase(): { db: BetterSqlite3.Database; cleanup: () => void } {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "shelfbridge-db-test-"));
  const db = new BetterSqlite3(path.join(dataDir, "test.db"));
  initSchema(db);

  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  };
}
