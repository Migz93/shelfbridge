import { Router } from "express";
import { getDb, getSetting, setSetting, setSettingForDb } from "../db/index.js";
import type Database from "better-sqlite3";
import { LOG_LEVELS, type AboutInfo, type AppSettings, type JobInfo, type LogsPageResponse } from "../../shared/types.js";
import { testGrimmoryServer } from "../sync/grimmory.js";
import { testChaptarrConnection } from "../sync/chaptarr.js";
import { testAudiobookshelfServer } from "../sync/audiobookshelf.js";
import { scheduler } from "../scheduler.js";
import { getRecentLogs, readRecentMachineLogs } from "../logger.js";
import { APP_VERSION, BUILD_CHANNEL, BUILD_COMMIT } from "../version.js";
import { logger } from "../logger.js";
import { validateIntegrationUrl } from "../security/outbound.js";
import {
  chaptarrTestSchema,
  integrationTestSchema,
  jobIntervalSchema,
  settingsPatchSchema,
  validationErrorResponse
} from "../validation.js";

const router = Router();

export function applySettingsPatch(
  db: Database.Database,
  body: ReturnType<typeof settingsPatchSchema.parse>
): void {
  db.transaction(() => {
    if (body.general?.trustProxy !== undefined) setSettingForDb(db, "app.trustProxy", String(body.general.trustProxy));
    if (body.grimmory?.baseUrl !== undefined) setSettingForDb(db, "grimmory.baseUrl", validateIntegrationUrl(body.grimmory.baseUrl));
    if (body.grimmory?.addMenuLink !== undefined) setSettingForDb(db, "grimmory.addMenuLink", String(body.grimmory.addMenuLink));
    if (body.download?.baseUrl !== undefined) setSettingForDb(db, "download.baseUrl", validateIntegrationUrl(body.download.baseUrl));
    if (body.download?.addMenuLink !== undefined) setSettingForDb(db, "download.addMenuLink", String(body.download.addMenuLink));
    if (body.sync?.startupSyncEnabled !== undefined) setSettingForDb(db, "sync.startupSyncEnabled", String(body.sync.startupSyncEnabled));
    if (body.sync?.historyRetentionDays !== undefined) setSettingForDb(db, "sync.historyRetentionDays", String(body.sync.historyRetentionDays));
    if (body.sync?.conflictStrategy !== undefined) setSettingForDb(db, "sync.conflictStrategy", body.sync.conflictStrategy);
    if (body.chaptarr?.baseUrl !== undefined) setSettingForDb(db, "chaptarr.baseUrl", validateIntegrationUrl(body.chaptarr.baseUrl));
    if (body.chaptarr?.apiKey !== undefined) setSettingForDb(db, "chaptarr.apiKey", body.chaptarr.apiKey);
    if (body.chaptarr?.addMenuLink !== undefined) setSettingForDb(db, "chaptarr.addMenuLink", String(body.chaptarr.addMenuLink));
    if (body.audiobookshelf?.baseUrl !== undefined) setSettingForDb(db, "audiobookshelf.baseUrl", validateIntegrationUrl(body.audiobookshelf.baseUrl));
    if (body.audiobookshelf?.addMenuLink !== undefined) setSettingForDb(db, "audiobookshelf.addMenuLink", String(body.audiobookshelf.addMenuLink));
  })();
}

function readSettings(): AppSettings {
  return {
    general: {
      trustProxy: getSetting("app.trustProxy", "false") === "true"
    },
    grimmory: {
      baseUrl: getSetting("grimmory.baseUrl", ""),
      addMenuLink: getSetting("grimmory.addMenuLink", "true") === "true"
    },
    download: {
      baseUrl: getSetting("download.baseUrl", ""),
      addMenuLink: getSetting("download.addMenuLink", "true") === "true",
    },
    sync: {
      startupSyncEnabled: getSetting("sync.startupSyncEnabled", "false") === "true",
      historyRetentionDays: parseInt(getSetting("sync.historyRetentionDays", "7"), 10),
      conflictStrategy: (getSetting("sync.conflictStrategy", "latest_wins") as AppSettings["sync"]["conflictStrategy"])
    },
    chaptarr: {
      baseUrl: getSetting("chaptarr.baseUrl", ""),
      apiKeyConfigured: Boolean(getSetting("chaptarr.apiKey", "").trim()),
      addMenuLink: getSetting("chaptarr.addMenuLink", "true") === "true",
    },
    audiobookshelf: {
      baseUrl: getSetting("audiobookshelf.baseUrl", ""),
      addMenuLink: getSetting("audiobookshelf.addMenuLink", "true") === "true",
    },
  };
}

router.get("/", (_req, res) => {
  res.json(readSettings());
});

router.patch("/", (req, res) => {
  const parsed = settingsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    const unsafeUrlIssue = parsed.error.issues.find(
      (issue) => issue.code === "custom" && issue.path[issue.path.length - 1] === "baseUrl"
    );
    if (unsafeUrlIssue) {
      logger.warn("Rejected unsafe integration URL update", { error: unsafeUrlIssue.message });
    }
    res.status(400).json(validationErrorResponse(parsed.error));
    return;
  }
  const body = parsed.data;

  applySettingsPatch(getDb(), body);
  res.json(readSettings());
});

router.post("/grimmory/test", async (req, res) => {
  const parsed = integrationTestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(validationErrorResponse(parsed.error));
    return;
  }
  const { baseUrl } = parsed.data;
  const url = baseUrl ?? getSetting("grimmory.baseUrl", "");
  if (!url) {
    res.json({ ok: false, message: "No base URL configured" });
    return;
  }
  const result = await testGrimmoryServer(url);
  res.json(result);
});

router.post("/chaptarr/test", async (req, res) => {
  const parsed = chaptarrTestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(validationErrorResponse(parsed.error));
    return;
  }
  const { baseUrl, apiKey } = parsed.data;
  const url = baseUrl ?? getSetting("chaptarr.baseUrl", "");
  const key = apiKey?.trim() ? apiKey : getSetting("chaptarr.apiKey", "");
  if (!url || !key) {
    res.json({ ok: false, message: "Base URL and API key are required" });
    return;
  }
  const result = await testChaptarrConnection(url, key);
  res.json(result);
});

router.post("/audiobookshelf/test", async (req, res) => {
  const parsed = integrationTestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(validationErrorResponse(parsed.error));
    return;
  }
  const { baseUrl } = parsed.data;
  const url = (baseUrl ?? getSetting("audiobookshelf.baseUrl", "")).trim();
  if (!url) {
    res.json({ ok: false, message: "No base URL configured" });
    return;
  }
  const result = await testAudiobookshelfServer(url);
  res.json(result);
});

// Valid preset intervals in minutes. 0 = Disabled.
const SYNC_PRESETS_MINUTES = [0, 1, 2, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440];

function intervalDescription(minutes: number): string {
  if (minutes === 0) return "Disabled";
  if (minutes < 60) return `Every ${minutes} minute${minutes !== 1 ? "s" : ""}`;
  const h = minutes / 60;
  return `Every ${h} hour${h !== 1 ? "s" : ""}`;
}

router.get("/jobs", (_req, res) => {
  const intervalMinutes = parseInt(getSetting("sync.scheduleIntervalMinutes", "60"), 10);

  const jobs: JobInfo[] = [
    {
      id: "profile-sync",
      name: "Sync",
      intervalDescription: intervalDescription(intervalMinutes),
      isRunning: scheduler.isRunning("profile-sync"),
      nextRunAt: scheduler.getNextRunAt("profile-sync"),
      lastRunAt: scheduler.getLastRunAt("profile-sync"),
      lastRunStatus: scheduler.getLastRunStatus("profile-sync")
    },
    {
      id: "maintenance",
      name: "Maintenance",
      intervalDescription: "Daily at 3:00 AM",
      isRunning: scheduler.isRunning("maintenance"),
      nextRunAt: scheduler.getNextRunAt("maintenance"),
      lastRunAt: scheduler.getLastRunAt("maintenance"),
      lastRunStatus: scheduler.getLastRunStatus("maintenance")
    },
    {
      id: "image-cache-refresh",
      name: "Image Cache Refresh",
      intervalDescription: "Daily at 2:00 AM",
      isRunning: scheduler.isRunning("image-cache-refresh"),
      nextRunAt: scheduler.getNextRunAt("image-cache-refresh"),
      lastRunAt: scheduler.getLastRunAt("image-cache-refresh"),
      lastRunStatus: scheduler.getLastRunStatus("image-cache-refresh")
    }
  ];

  res.json(jobs);
});

router.post("/jobs/:id/run", (req, res) => {
  const { id } = req.params;
  const known = ["profile-sync", "maintenance", "image-cache-refresh"];
  if (!known.includes(id)) {
    res.status(404).json({ error: "Unknown job." });
    return;
  }
  const triggered = scheduler.runNow(id);
  if (!triggered) {
    res.status(409).json({ error: "Job is already running." });
    return;
  }
  res.json({ triggered: true });
});

router.patch("/jobs/:id", (req, res) => {
  const { id } = req.params;
  const parsed = jobIntervalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(validationErrorResponse(parsed.error));
    return;
  }
  const body = parsed.data;

  if (id === "profile-sync") {
    const minutes = body.intervalMinutes;
    if (!SYNC_PRESETS_MINUTES.includes(minutes)) {
      res.status(400).json({ error: "Invalid interval value." });
      return;
    }
    setSetting("sync.scheduleIntervalMinutes", String(minutes));
    if (minutes === 0) {
      scheduler.updateJob("profile-sync", { enabled: false });
    } else {
      scheduler.updateJob("profile-sync", {
        intervalMs: minutes * 60 * 1000,
        enabled: true
      });
    }
    res.json({ updated: true });
  } else {
    res.status(404).json({ error: "Unknown job or missing intervalMinutes." });
  }
});

// ─── Log viewer ───────────────────────────────────────────────────────────────

const LEVEL_ORDER = LOG_LEVELS;
type LogLevel = (typeof LEVEL_ORDER)[number];
const isLogLevel = (v: unknown): v is LogLevel =>
  typeof v === "string" && (LEVEL_ORDER as readonly string[]).includes(v);

router.get("/logs", async (req, res) => {
  const rawPage = typeof req.query["page"] === "string" ? Number(req.query["page"]) : 1;
  const page = Math.max(1, Number.isFinite(rawPage) ? rawPage : 1);
  const rawPageSize = typeof req.query["pageSize"] === "string" ? Number(req.query["pageSize"]) : 25;
  const pageSize = Math.min(100, Math.max(1, Number.isFinite(rawPageSize) ? rawPageSize : 25));

  const filterParam: LogLevel = isLogLevel(req.query["filter"]) ? req.query["filter"] : "debug";
  const filterIndex = LEVEL_ORDER.indexOf(filterParam);
  const allowed = new Set<string>(LEVEL_ORDER.slice(filterIndex));

  const rawSearch = req.query["search"];
  const search: string = typeof rawSearch === "string" ? rawSearch.slice(0, 200) : "";

  let entries: LogsPageResponse["results"] = [];

  try {
    entries = await readRecentMachineLogs();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn("Failed to read machine log file, falling back to in-memory ring buffer", { error: err });
    }
    entries = getRecentLogs(500);
  }

  entries = entries.filter((entry) => {
    if (!allowed.has(entry.level)) return false;
    if (!search) return true;
    const needle = search.toLowerCase();
    return entry.message.toLowerCase().includes(needle)
      || (entry.meta !== undefined && JSON.stringify(entry.meta).toLowerCase().includes(needle));
  });

  // Newest first, then paginate
  entries.reverse();
  const total = entries.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const skip = (page - 1) * pageSize;
  const results = entries.slice(skip, skip + pageSize);

  const response: LogsPageResponse = {
    results,
    windowed: true,
    pageInfo: { page, pageSize, pages, total }
  };
  res.json(response);
});

router.get("/about", (_req, res) => {
  // Read the database's actual PRAGMA user_version rather than the code's
  // LATEST_MIGRATION_VERSION constant — this is the last migration version
  // successfully applied during database initialization, which is what
  // actually matters for troubleshooting a specific running instance.
  const dbVersion = getDb().pragma("user_version", { simple: true }) as number;
  const info: AboutInfo = {
    version: APP_VERSION,
    buildChannel: BUILD_CHANNEL,
    commitSha: BUILD_COMMIT,
    dataDir: process.env["DATA_DIR"] ?? "./data",
    tz: process.env["TZ"] ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    dbVersion
  };
  res.json(info);
});

export default router;
