import winston from "winston";
import TransportStream from "winston-transport";
import path from "node:path";
import fs from "node:fs";
import DailyRotateFile from "winston-daily-rotate-file";
import { LOG_LEVELS, type LogEntry } from "../shared/types.js";

const DATA_DIR = process.env["DATA_DIR"] ?? "./data";
const SECRET_KEY_PATTERN = /(password|token|secret|credential|authorization|api[_-]?key)/i;
const LOG_RING_SIZE = 500;
const LOG_TAIL_BYTES = 1024 * 1024;

function localISOTimestamp(): string {
  const d = new Date();
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const hh = pad(Math.floor(Math.abs(offset) / 60));
  const mm = pad(Math.abs(offset) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`;
}

function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return value.startsWith("sbenc:v1:") ? "[REDACTED]" : value;
  }
  if (!value || typeof value !== "object") return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSecrets(item, seen)
    ])
  );
}

const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (key === "level" || key === "message" || key === "timestamp") continue;
    info[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSecrets(info[key]);
  }
  return info;
});

// ─── In-memory ring buffer ────────────────────────────────────────────────────

const ring: LogEntry[] = [];

class RingTransport extends TransportStream {
  log(info: Record<string, unknown>, callback: () => void) {
    setImmediate(() => this.emit("logged", info));

    const LOG_FIELDS = new Set(["timestamp", "level", "message"]);
    const meta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(info)) {
      if (!LOG_FIELDS.has(k)) meta[k] = v;
    }

    ring.push({
      timestamp: (info["timestamp"] as string) ?? new Date().toISOString(),
      level: info["level"] as LogEntry["level"],
      message: String(info["message"] ?? ""),
      ...(Object.keys(meta).length > 0 ? { meta } : {})
    });

    if (ring.length > LOG_RING_SIZE) ring.shift();
    callback();
  }
}

function clampLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
}

/** Returns a snapshot of recent log entries for the in-process log viewer API. */
export function getRecentLogs(limit = 200): LogEntry[] {
  const clamped = clampLimit(limit);
  return clamped === 0 ? [] : ring.slice(-clamped);
}

const LOG_DIR = path.join(DATA_DIR, "logs");

/** Stable path to the machine-readable JSON log file (via symlink). */
export const MACHINE_LOG_PATH = path.join(LOG_DIR, ".machinelogs.json");

/** Reads a bounded recent tail, avoiding a synchronous full-log read per request. */
export async function readRecentMachineLogs(filePath = MACHINE_LOG_PATH, limit = LOG_RING_SIZE): Promise<LogEntry[]> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);

    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) lines.shift(); // the tail can start part-way through a JSON line

    const entries: LogEntry[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed["timestamp"] !== "string" || typeof parsed["message"] !== "string") continue;
        if (!LOG_LEVELS.includes(String(parsed["level"]) as LogEntry["level"])) continue;
        const { timestamp, level, message, ...meta } = parsed;
        entries.push({
          timestamp,
          level: level as LogEntry["level"],
          message,
          ...(Object.keys(meta).length > 0 ? { meta } : {})
        });
      } catch {
        // A rotation or concurrent write can leave an incomplete line; ignore it.
      }
    }
    const clamped = clampLimit(limit);
    return clamped === 0 ? [] : entries.slice(-clamped);
  } finally {
    await handle.close();
  }
}

// ─── Logger ───────────────────────────────────────────────────────────────────

export type Logger = {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }),
  // In-memory ring buffer (fallback when log file is not yet available)
  new RingTransport()
];

// Add disk transports — skip gracefully if the log dir is not writable (dev without a mounted volume).
// mkdirSync alone doesn't catch this: it succeeds without error when LOG_DIR already exists but is
// unwritable, so an explicit access check is required — otherwise DailyRotateFile's async EACCES on
// its first write would go unhandled and crash the process instead of falling back cleanly.
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.accessSync(LOG_DIR, fs.constants.W_OK);

  transports.push(
    // Human-readable log file (7-day rotation)
    new DailyRotateFile({
      filename: path.join(LOG_DIR, "shelfbridge-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxFiles: "7d",
      maxSize: "20m",
      zippedArchive: true,
      createSymlink: true,
      symlinkName: "shelfbridge.log"
    }),
    // Machine-readable JSON log with a stable symlink for the log viewer API
    new DailyRotateFile({
      filename: path.join(LOG_DIR, ".machinelogs-%DATE%.json"),
      datePattern: "YYYY-MM-DD",
      maxFiles: "3d",
      maxSize: "20m",
      zippedArchive: true,
      createSymlink: true,
      symlinkName: ".machinelogs.json"
    })
  );
} catch { /* log dir not writable — console + ring buffer only */ }

export const logger = winston.createLogger({
  level: process.env["LOG_LEVEL"] ?? "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: localISOTimestamp }),
    winston.format.errors({ stack: true }),
    redactFormat(),
    winston.format.json()
  ),
  transports
});

// A disk transport can still fail after startup (disk full, permissions revoked underneath the
// mount) even though the access check above passed. Winston re-emits unhandled transport errors on
// the logger; without a listener here, Node treats that as an unhandled "error" event and crashes.
logger.on("error", (err) => {
  console.error("Logger transport error", err);
});
