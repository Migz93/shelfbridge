import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { registerAuthRoutes, requireAuth, sessionMiddleware } from "./auth.js";
import { getDb, getSetting } from "./db/index.js";
import { logger } from "./logger.js";
import { initScheduler } from "./scheduler.js";
import settingsRouter from "./routes/settings.js";
import profilesRouter from "./routes/profiles.js";
import booksRouter from "./routes/books.js";
import dashboardRouter from "./routes/dashboard.js";
import historyRouter from "./routes/history.js";
import syncRouter from "./routes/sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const IS_PROD = process.env["NODE_ENV"] === "production";

const app = express();

// Enable when configured for reverse-proxy deployments. Trust only a single
// proxy hop so forwarded headers are honored without accepting arbitrary chains.
if (getSetting("app.trustProxy", "false") === "true") {
  app.set("trust proxy", 1);
  logger.info("Trust proxy enabled — using one trusted proxy hop for client IP identification");
}
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(sessionMiddleware);
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(
  "/api",
  apiLimiter
);

// Ensure DB is initialised, close out interrupted syncs, then start background jobs.
const db = getDb();
const interruptedRuns = db
  .prepare(
    `UPDATE sync_runs
     SET status = 'error',
         finished_at = COALESCE(finished_at, datetime('now')),
         summary = 'Sync interrupted',
         error = 'ShelfBridge restarted before this sync finished'
     WHERE status = 'running'`
  )
  .run();
if (interruptedRuns.changes > 0) {
  logger.warn("Marked interrupted sync runs as failed on startup", { count: interruptedRuns.changes });
}
initScheduler();

// Ensure image cache directory exists and serve it
const IMAGE_CACHE_DIR = path.join(process.env["DATA_DIR"] ?? "./data", "image-cache");
fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
app.use("/images", requireAuth, express.static(IMAGE_CACHE_DIR));

// API routes
const publicApi = express.Router();
registerAuthRoutes(publicApi);
app.use("/api", publicApi);

app.use("/api/settings", requireAuth, settingsRouter);
app.use("/api/profiles", requireAuth, profilesRouter);
app.use("/api/books", requireAuth, booksRouter);
app.use("/api/dashboard", requireAuth, dashboardRouter);
app.use("/api/history", requireAuth, historyRouter);
app.use("/api/sync", requireAuth, syncRouter);

// Health check
app.get("/api/health", (_req, res) => { res.json({ ok: true }); });

// Serve built client in production
if (IS_PROD) {
  const clientDist = path.join(__dirname, "../../client");
  app.use(express.static(clientDist));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.listen(PORT, () => {
  logger.info(`ShelfBridge listening on port ${PORT}`, { port: PORT, env: process.env["NODE_ENV"] });
});
