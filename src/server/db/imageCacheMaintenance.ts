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

function deleteOrphanedRows(db: Database.Database, orphaned: OrphanedImageCacheRow[]): { rowsDeleted: number; filesDeleted: number; filesSkipped: number } {
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
  return { rowsDeleted, filesDeleted, filesSkipped };
}

export function cleanupOrphanedImageCache(db: Database.Database): void {
  const orphaned = db.prepare(`
    SELECT ic.id, ic.cache_key, ic.entity_id, ic.local_file_path
    FROM image_cache ic
    LEFT JOIN book_sources bs ON bs.id = CAST(ic.entity_id AS INTEGER)
    WHERE bs.id IS NULL
  `).all() as OrphanedImageCacheRow[];

  if (orphaned.length === 0) return;

  const { rowsDeleted, filesDeleted, filesSkipped } = deleteOrphanedRows(db, orphaned);
  logger.info("ImageCache: orphaned cover cache cleaned up", {
    rowsDeleted,
    filesDeleted,
    filesSkipped
  });
}

/**
 * Scoped variant for a set of book_sources ids the caller just deleted (e.g.
 * source pruning) — since those ids are already gone, any image_cache row
 * referencing one of them is unconditionally orphaned, so this looks them up
 * directly by entity_id instead of the full LEFT JOIN scan
 * cleanupOrphanedImageCache does. Safe to call on every prune, even a
 * frequent one, without reintroducing a full-table scan on that hot path.
 */
export function cleanupImageCacheForSourceIds(db: Database.Database, sourceIds: number[]): void {
  if (sourceIds.length === 0) return;
  const orphaned: OrphanedImageCacheRow[] = [];
  for (let i = 0; i < sourceIds.length; i += 500) {
    const batch = sourceIds.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(",");
    orphaned.push(...(db.prepare(`
      SELECT id, cache_key, entity_id, local_file_path
      FROM image_cache
      WHERE entity_id IN (${placeholders})
    `).all(...batch.map((id) => String(id))) as OrphanedImageCacheRow[]));
  }
  if (orphaned.length === 0) return;

  const { rowsDeleted, filesDeleted, filesSkipped } = deleteOrphanedRows(db, orphaned);
  logger.info("ImageCache: orphaned cover cache cleaned up after source removal", {
    rowsDeleted,
    filesDeleted,
    filesSkipped
  });
}
