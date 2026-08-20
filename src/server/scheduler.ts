import { JobScheduler } from "./job-scheduler.js";
import { getDb, getSetting } from "./db/index.js";
import { logger } from "./logger.js";
import { getActiveSyncStatus, runSync, runExclusiveOfSyncs } from "./sync/engine.js";
import { refreshStaleCachedCovers } from "./image-cache.js";
import { refreshStaleGrimmoryCovers } from "./sync/engine.js";
import { reconcileBookIdentities, type ReconcileProgressPhase } from "./db/bookIdentity.js";
import { cleanupLegacyHardcoverSources } from "./sync/hardcover-legacy-cleanup.js";

export const scheduler = new JobScheduler();

export function initScheduler(): void {
  const db = getDb();

  scheduler.setLogger(logger);

  scheduler.setPersistence({
    load: (id) => {
      const row = db
        .prepare("SELECT last_run_at, last_run_status FROM job_run_state WHERE job_id = ?")
        .get(id) as { last_run_at: string | null; last_run_status: string | null } | undefined;
      if (!row) return null;
      return {
        lastRunAt: row.last_run_at,
        lastRunStatus: row.last_run_status as "success" | "error" | null
      };
    },
    save: (id, state) => {
      db.prepare(`
        INSERT INTO job_run_state (job_id, last_run_at, last_run_status)
        VALUES (?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          last_run_at = excluded.last_run_at,
          last_run_status = excluded.last_run_status
      `).run(id, state.lastRunAt, state.lastRunStatus);
    }
  });

  const intervalMinutes = parseInt(
    getSetting("sync.scheduleIntervalMinutes", "60"),
    10
  );
  // 0 means "Disabled" — register with placeholder interval but disabled
  const syncEnabled = intervalMinutes > 0;

  scheduler.registerRecurringJob({
    id: "profile-sync",
    intervalMs: (syncEnabled ? intervalMinutes : 60) * 60 * 1000,
    enabled: syncEnabled,
    task: runProfileSync
  });

  // Maintenance: prune old sync history. Runs daily at 3 AM.
  scheduler.registerDailyJob({
    id: "maintenance",
    hour: 3,
    minute: 0,
    task: runMaintenance
  });

  // Image Cache Refresh: re-fetch stale cover images. Runs daily at 2 AM.
  scheduler.registerDailyJob({
    id: "image-cache-refresh",
    hour: 2,
    minute: 0,
    task: async () => {
      await refreshStaleCachedCovers();
      await refreshStaleGrimmoryCovers();
    }
  });

  // Full Reconciliation: periodic full-catalog identity reconcile. Every write
  // path already reconciles its own scope on the fly (see bookIdentity.ts), so
  // this is a correction pass for the narrow gaps scoped reconciliation
  // intentionally accepts (see expandScopeToRows's doc comment) — not the
  // primary mechanism keeping identities correct. Runs daily at 4 AM.
  scheduler.registerDailyJob({
    id: "full-reconcile",
    hour: 4,
    minute: 0,
    task: runFullReconcile
  });

  logger.info("Job scheduler initialised", {
    syncEnabled,
    intervalMinutes: syncEnabled ? intervalMinutes : 0
  });

  // Kick off the sync job immediately on startup if configured, regardless of
  // the scheduled interval. Only runs if the sync job itself is enabled.
  const startupSyncEnabled = getSetting("sync.startupSyncEnabled", "false") === "true";
  if (startupSyncEnabled && syncEnabled) {
    logger.info("Startup sync enabled; triggering initial profile sync");
    scheduler.runNow("profile-sync");
  }
}

async function runProfileSync(): Promise<void> {
  const db = getDb();
  const activeSync = getActiveSyncStatus();
  if (activeSync.isRunning) {
    logger.warn("Scheduled profile sync skipped because a sync is already active", {
      runIds: activeSync.runIds,
      profileIds: activeSync.profileIds,
      startedAt: activeSync.startedAt
    });
    return;
  }

  const profiles = db
    .prepare(
      `SELECT ss.profile_id
       FROM sync_settings ss
       JOIN profiles p ON ss.profile_id = p.id
       WHERE ss.schedule_enabled = 1 AND p.enabled = 1`
    )
    .all() as { profile_id: number }[];

  if (profiles.length === 0) {
    logger.info("No profiles with schedule enabled; skipping scheduled sync");
    return;
  }

  const dryRun = false;

  logger.info("Scheduled profile sync starting", { profileCount: profiles.length });

  for (const { profile_id } of profiles) {
    const result = db
      .prepare(
        "INSERT INTO sync_runs (profile_id, status, summary, dry_run) VALUES (?, 'running', 'Scheduled sync started', ?)"
      )
      .run(profile_id, dryRun ? 1 : 0);
    const runId = result.lastInsertRowid as number;

    logger.info("Starting scheduled sync for profile", { profileId: profile_id, runId });
    await runSync(profile_id, runId, dryRun);
  }

  logger.info("Scheduled profile sync completed", { profileCount: profiles.length });
}

async function runFullReconcile(): Promise<void> {
  // Serialized against every profile sync (see runExclusiveOfSyncs) — this
  // mutates shared book identity state exactly like a sync does, and a sync
  // yields to the event loop between remote I/O calls, so it must never run
  // unserialized while a sync could be mid-flight.
  await runExclusiveOfSyncs(async () => {
    const db = getDb();

    // Runs here, immediately before the full reconcile pass, so any book left
    // sourceless by the cleanup is picked up by the same pass's stale-book
    // cleanup rather than lingering until the next scheduled run.
    cleanupLegacyHardcoverSources(db);

    const bookCount = (db.prepare("SELECT COUNT(*) AS count FROM books").get() as { count: number }).count;
    const sourceCount = (db.prepare("SELECT COUNT(*) AS count FROM book_sources").get() as { count: number }).count;
    logger.info("Full reconcile starting", { bookCount, sourceCount });

    const startedAt = Date.now();
    let lastPhaseAt = startedAt;
    reconcileBookIdentities(db, undefined, (phase: ReconcileProgressPhase, details) => {
      const now = Date.now();
      logger.info("Full reconcile progress", { phase, ...details, phaseMs: now - lastPhaseAt, elapsedMs: now - startedAt });
      lastPhaseAt = now;
    });

    logger.info("Full reconcile complete", { elapsedMs: Date.now() - startedAt });
  });
}

async function runMaintenance(): Promise<void> {
  const retentionDays = parseInt(getSetting("sync.historyRetentionDays", "7"), 10);
  const db = getDb();

  // sync_events are deleted automatically via ON DELETE CASCADE from sync_runs
  const result = db
    .prepare(
      `DELETE FROM sync_runs WHERE started_at < datetime('now', ? || ' days')`
    )
    .run(`-${retentionDays}`);

  const deleted = (result as { changes: number }).changes;
  logger.info("Maintenance: pruned old sync history", { deleted, retentionDays });
}
