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
// The client is a same-origin Vite/React bundle with no inline scripts, but it does use
// inline `style` attributes, so that needs an explicit allowance. Fonts are bundled
// locally (see index.css), so no third-party font host needs to be whitelisted.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      styleSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
      // Disable upgrade-insecure-requests: this app runs over plain HTTP in
      // the default Docker setup, so this directive would cause browsers to
      // rewrite HTTP sub-requests to HTTPS and break the UI. Must be set to
      // null (not deleted) so Helmet's useDefaults logic doesn't re-add it.
      "upgrade-insecure-requests": null
    }
  },
  // Disable HSTS: not appropriate for a plain-HTTP self-hosted deployment.
  hsts: false
}));
logger.info("Transport security policy configured for plain-HTTP deployment", {
  upgradeInsecureRequests: false,
  hsts: false
});
app.use(express.json());
app.use(sessionMiddleware);
// Applies to every route (including /images and the static/catch-all client routes below),
// so file-serving and auth-checked routes outside /api aren't left unlimited.
const globalLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(globalLimiter);

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
