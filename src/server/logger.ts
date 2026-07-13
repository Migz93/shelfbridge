import winston from "winston";
import TransportStream from "winston-transport";
import path from "node:path";
import fs from "node:fs";
import DailyRotateFile from "winston-daily-rotate-file";
import type { LogEntry } from "../shared/types.js";

const DATA_DIR = process.env["DATA_DIR"] ?? "./data";
const SECRET_KEY_PATTERN = /(password|token|secret|credential|authorization|api[_-]?key)/i;
const LOG_RING_SIZE = 500;

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

/** Returns a snapshot of recent log entries for the in-process log viewer API. */
export function getRecentLogs(limit = 200): LogEntry[] {
  return ring.slice(-limit);
}

/** Stable path to the machine-readable JSON log file (via symlink). */
export const MACHINE_LOG_PATH = path.join(DATA_DIR, ".machinelogs.json");

// ─── Logger ───────────────────────────────────────────────────────────────────

export type Logger = {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

// Ensure DATA_DIR exists before setting up file transports
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

export const logger = winston.createLogger({
  level: process.env["LOG_LEVEL"] ?? "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: localISOTimestamp }),
    winston.format.errors({ stack: true }),
    redactFormat(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    // Human-readable log file (7-day rotation)
    new DailyRotateFile({
      filename: path.join(DATA_DIR, "shelfbridge-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxFiles: "7d",
      maxSize: "20m"
    }),
    // Machine-readable JSON log with a stable symlink for the log viewer API
    new DailyRotateFile({
      filename: path.join(DATA_DIR, ".machinelogs-%DATE%.json"),
      datePattern: "YYYY-MM-DD",
      maxFiles: "3d",
      maxSize: "20m",
      createSymlink: true,
      symlinkName: ".machinelogs.json"
    }),
    // In-memory ring buffer (fallback when log file is not yet available)
    new RingTransport()
  ]
});
