import { Router } from "express";
import { getDb } from "../db/index.js";
import type { SyncEvent, SyncRun, SyncRunDetail, SyncHistoryPageResponse } from "../../shared/types.js";

const router = Router();

interface DbSyncRun {
  id: number;
  profile_id: number | null;
  profile_name: string | null;
  started_at: string;
  finished_at: string | null;
  status: string;
  summary: string;
  error: string | null;
  dry_run: number;
  changes_written: number;
  changes_skipped: number;
  changes_superseded: number;
}

interface DbSyncEvent {
  id: number;
  sync_run_id: number;
  profile_id: number | null;
  book_title: string | null;
  event_type: string;
  direction: string | null;
  decision: string | null;
  details: string | null;
  created_at: string;
}

function dbToRun(row: DbSyncRun): SyncRun {
  return {
    id: row.id,
    profileId: row.profile_id,
    profileName: row.profile_name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as SyncRun["status"],
    summary: row.summary,
    error: row.error,
    dryRun: Boolean(row.dry_run),
    changesWritten: row.changes_written,
    changesSkipped: row.changes_skipped,
    changesSuperseded: row.changes_superseded
  };
}

// GET /api/history
router.get("/", (req, res) => {
  const db = getDb();
  const page = Math.max(1, parseInt(req.query["page"] as string ?? "1", 10));
  const pageSize = Math.min(100, parseInt(req.query["pageSize"] as string ?? "25", 10));
  const profileId = req.query["profileId"] ? parseInt(req.query["profileId"] as string, 10) : null;
  const status = req.query["status"] as string | undefined;
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (profileId !== null) { conditions.push("sr.profile_id = ?"); params.push(profileId); }
  if (status && status !== "all") { conditions.push("sr.status = ?"); params.push(status); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) as c FROM sync_runs sr ${where}`).get(...params) as { c: number }).c;

  const rows = db.prepare(`
    SELECT sr.*, p.display_name as profile_name
    FROM sync_runs sr
    LEFT JOIN profiles p ON sr.profile_id = p.id
    ${where}
    ORDER BY sr.started_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset) as DbSyncRun[];

  const response: SyncHistoryPageResponse = {
    results: rows.map(dbToRun),
    pageInfo: {
      page,
      pageSize,
      total,
      pages: Math.max(1, Math.ceil(total / pageSize))
    }
  };

  res.json(response);
});

// GET /api/history/:id
router.get("/:id", (req, res) => {
  const db = getDb();
  const id = parseInt(req.params["id"] ?? "0", 10);
  const run = db.prepare(`
    SELECT sr.*, p.display_name as profile_name
    FROM sync_runs sr
    LEFT JOIN profiles p ON sr.profile_id = p.id
    WHERE sr.id = ?
  `).get(id) as DbSyncRun | undefined;

  if (!run) { res.status(404).json({ error: "Not found" }); return; }

  const eventRows = db.prepare("SELECT * FROM sync_events WHERE sync_run_id = ? ORDER BY id").all(id) as DbSyncEvent[];
  const events: SyncEvent[] = eventRows.map((e) => ({
    id: e.id,
    syncRunId: e.sync_run_id,
    profileId: e.profile_id,
    bookTitle: e.book_title,
    eventType: e.event_type as SyncEvent["eventType"],
    direction: e.direction,
    decision: e.decision,
    details: e.details ? (JSON.parse(e.details) as Record<string, unknown>) : null,
    createdAt: e.created_at
  }));

  const detail: SyncRunDetail = { ...dbToRun(run), events };
  res.json(detail);
});

export default router;
