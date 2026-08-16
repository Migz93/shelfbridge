import type { getDb } from "../db/index.js";
import type { GrimmoryBook } from "./grimmory.js";

export interface UserStateSnapshot {
  id?: number; status?: string | null; rating?: number | null; progress?: number | null;
  hardcover_status_id?: number | null; hardcover_rating?: number | null; hardcover_progress?: number | null;
  hardcover_edition_id?: number | null; hardcover_edition_pages?: number | null; grimmory_book_id?: number | null;
  grimmory_primary_file_id?: number | null; goodreads_shelf?: string | null; goodreads_rating?: number | null;
  goodreads_read_at?: string | null; sync_health?: string | null; match_confidence?: string | null; last_modified_at?: string | null;
}

type Db = ReturnType<typeof getDb>;

export function getBookSource(db: Db, sourceType: string, instanceId: number, externalId: string | number): { id: number; book_id: number | null; source_media_type: string | null; source_edition_id: string | null } | undefined {
  return db.prepare(
    "SELECT id, book_id, source_media_type, source_edition_id FROM book_sources WHERE source_type = ? AND source_instance_id = ? AND external_id = ?"
  ).get(sourceType, instanceId, String(externalId)) as { id: number; book_id: number | null; source_media_type: string | null; source_edition_id: string | null } | undefined;
}

/** Look up a user_book_states row by (book_id, profile_id, source_type) */
export function getUserState(db: Db, bookId: number, profileId: number, sourceType: string): UserStateSnapshot | undefined {
  return db.prepare(
    "SELECT * FROM user_book_states WHERE book_id = ? AND profile_id = ? AND source_type = ?"
  ).get(bookId, profileId, sourceType) as UserStateSnapshot | undefined;
}

export function getGoodreadsExternalId(db: Db, profileId: number, bookId: number): string | null {
  const row = db.prepare(
    "SELECT external_id FROM book_sources WHERE source_type = 'goodreads' AND source_instance_id = ? AND book_id = ? LIMIT 1"
  ).get(profileId, bookId) as { external_id: string } | undefined;
  return row?.external_id ?? null;
}

export function localGrimmoryBookForBookId(db: Db, profileId: number, bookId: number, grimmoryBooks: GrimmoryBook[]): GrimmoryBook | null {
  const rows = db.prepare(`
    SELECT CAST(external_id AS INTEGER) AS grimmory_book_id
    FROM book_sources
    WHERE source_type = 'grimmory' AND source_instance_id = ? AND book_id = ?
  `).all(profileId, bookId) as { grimmory_book_id: number }[];

  for (const row of rows) {
    const book = grimmoryBooks.find((candidate) => candidate.id === row.grimmory_book_id);
    if (book) return book;
  }
  return null;
}

/** Upsert a book_sources row, scoped to (source_type, source_instance_id, external_id). Returns the row id. */
export function upsertBookSource(db: Db, sourceType: string, instanceId: number, externalId: string | number, fields: Record<string, unknown>): number {
  const existing = getBookSource(db, sourceType, instanceId, externalId);
  if (existing) {
    const setClauses = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
    const modifiedFields = Object.entries(fields)
      .filter(([key]) => key !== "last_sync_at" && key !== "last_sync_decision");
    const hasMeaningfulChange = modifiedFields.length > 0
      ? modifiedFields.map(([key]) => `${key} IS NOT ?`).join(" OR ")
      : "0";
    db.prepare(`
      UPDATE book_sources SET ${setClauses},
        last_modified_at = CASE WHEN ${hasMeaningfulChange} THEN datetime('now') ELSE last_modified_at END
      WHERE id = ?
    `).run(...Object.values(fields), ...modifiedFields.map(([, value]) => value), existing.id);
    return existing.id;
  } else {
    const cols = ["source_type", "source_instance_id", "external_id", ...Object.keys(fields)].join(", ");
    const placeholders = Array(Object.keys(fields).length + 3).fill("?").join(", ");
    const result = db.prepare(`INSERT INTO book_sources (${cols}) VALUES (${placeholders})`)
      .run(sourceType, instanceId, String(externalId), ...Object.values(fields));
    return Number(result.lastInsertRowid);
  }
}

export function audiobookCandidateWhereSql(): string {
  return `book_id IS NOT NULL AND (
    source_media_type = 'audiobook'
    OR hardcover_audio_seconds IS NOT NULL
    OR audiobookshelf_asin IS NOT NULL
    OR LOWER(COALESCE(source_edition_format, '')) LIKE '%audio%'
    OR LOWER(COALESCE(grimmory_primary_file_path, '')) LIKE '%.m4b'
    OR LOWER(COALESCE(grimmory_primary_file_path, '')) LIKE '%.mp3'
    OR LOWER(COALESCE(grimmory_primary_file_path, '')) LIKE '%.m4a'
    OR LOWER(COALESCE(grimmory_primary_file_path, '')) LIKE '%.aac'
    OR LOWER(COALESCE(chaptarr_primary_file_path, '')) LIKE '%.m4b'
    OR LOWER(COALESCE(chaptarr_primary_file_path, '')) LIKE '%.mp3'
    OR LOWER(COALESCE(chaptarr_primary_file_path, '')) LIKE '%.m4a'
    OR LOWER(COALESCE(chaptarr_primary_file_path, '')) LIKE '%.aac'
  )`;
}
