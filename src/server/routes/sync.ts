import { Router } from "express";
import { getDb } from "../db/index.js";
import { logger } from "../logger.js";
import { getActiveSyncStatus, runSync } from "../sync/engine.js";
import { syncRunSchema, validationErrorResponse } from "../validation.js";

const router = Router();

router.get("/status", (_req, res) => {
  res.json(getActiveSyncStatus());
});

// POST /api/sync/run  — manual sync (all profiles or single profile)
router.post("/run", async (req, res) => {
  const parsed = syncRunSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(validationErrorResponse(parsed.error));
    return;
  }
  const { profileId, dryRun = false } = parsed.data;
  const db = getDb();

  if (profileId !== undefined && !db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(profileId)) {
    res.status(404).json({ ok: false, message: "Profile not found" });
    return;
  }

  const isDryRun = dryRun;
  const currentStatus = getActiveSyncStatus();
  if (currentStatus.isRunning) {
    logger.warn("Manual sync request ignored because a sync is already running", {
      requestedProfileId: profileId ?? null,
      runningRunIds: currentStatus.runIds,
      runningProfileIds: currentStatus.profileIds
    });
    res.status(409).json({
      ok: false,
      message: "A sync is already running",
      status: currentStatus
    });
    return;
  }

  const profileIds: number[] = profileId !== undefined
    ? [profileId]
    : (db.prepare("SELECT id FROM profiles WHERE enabled = 1").all() as { id: number }[]).map((r) => r.id);

  if (profileIds.length === 0) {
    res.json({ ok: false, message: "No enabled profiles to sync" });
    return;
  }

  // Start sync in background, return run IDs immediately
  const runIds: number[] = [];
  for (const pid of profileIds) {
    const result = db.prepare(
      "INSERT INTO sync_runs (profile_id, status, summary, dry_run) VALUES (?, 'running', 'Sync started', ?)"
    ).run(pid, isDryRun ? 1 : 0);
    runIds.push(result.lastInsertRowid as number);
  }

  logger.info("Manual sync queued", {
    profileIds,
    runIds,
    dryRun: isDryRun
  });

  // Run async without awaiting — fire and forget
  void (async () => {
    for (let i = 0; i < profileIds.length; i++) {
      await runSync(profileIds[i]!, runIds[i]!, isDryRun);
    }
  })();

  res.json({ ok: true, runIds });
});

export default router;
