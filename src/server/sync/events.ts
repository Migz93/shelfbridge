import type { getDb } from "../db/index.js";

type Db = ReturnType<typeof getDb>;

/** Records one auditable decision made during a sync run. */
export function recordSyncEvent(
  db: Db, runId: number, profileId: number, bookTitle: string, eventType: string,
  direction: string | null, decision: string, details: Record<string, unknown>
): void {
  db.prepare(`
    INSERT INTO sync_events (sync_run_id, profile_id, book_title, event_type, direction, decision, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(runId, profileId, bookTitle, eventType, direction, decision, JSON.stringify(details));
}
