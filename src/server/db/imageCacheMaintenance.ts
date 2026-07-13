import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { logger } from "../logger.js";

const DATA_DIR = process.env["DATA_DIR"] ?? "./data";
const CACHE_DIR = path.resolve(DATA_DIR, "image-cache");

interface OrphanedImageCacheRow {
  id: number;
  cache_key: string;
  entity_id: string;
  local_file_path: string | null;
}

function isInsideCacheDir(filePath: string): boolean {
  const relative = path.relative(CACHE_DIR, path.resolve(filePath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function cleanupOrphanedImageCache(db: Database.Database): void {
  const orphaned = db.prepare(`
    SELECT ic.id, ic.cache_key, ic.entity_id, ic.local_file_path
    FROM image_cache ic
    LEFT JOIN book_sources bs ON bs.id = CAST(ic.entity_id AS INTEGER)
    WHERE bs.id IS NULL
  `).all() as OrphanedImageCacheRow[];

  if (orphaned.length === 0) return;

  const referencedFileCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM image_cache
    WHERE local_file_path = ? AND id != ?
  `);
  const deleteCacheRow = db.prepare("DELETE FROM image_cache WHERE id = ?");

  let filesDeleted = 0;
  let filesSkipped = 0;
  let rowsDeleted = 0;

  const transaction = db.transaction(() => {
    for (const row of orphaned) {
      if (row.local_file_path) {
        const reference = referencedFileCount.get(row.local_file_path, row.id) as { count: number };
        if (reference.count > 0) {
          filesSkipped++;
        } else if (!isInsideCacheDir(row.local_file_path)) {
          filesSkipped++;
          logger.warn("ImageCache: skipped orphaned cover file outside cache directory", {
            cacheKey: row.cache_key,
            filePath: row.local_file_path
          });
        } else {
          try {
            fs.unlinkSync(row.local_file_path);
            filesDeleted++;
          } catch (err) {
            filesSkipped++;
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
              logger.warn("ImageCache: failed to delete orphaned cover file", {
                cacheKey: row.cache_key,
                filePath: row.local_file_path,
                error: err instanceof Error ? err.message : String(err)
              });
            }
          }
        }
      }

      const result = deleteCacheRow.run(row.id);
      rowsDeleted += result.changes;
    }
  });

  transaction();
  logger.info("ImageCache: orphaned cover cache cleaned up", {
    rowsDeleted,
    filesDeleted,
    filesSkipped
  });
}
