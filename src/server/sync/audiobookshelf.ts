import type { TestResult } from "../../shared/types.js";
import { logger } from "../logger.js";

// ─── ABS API response shapes (partial — extended as we confirm what the key exposes) ──

export interface AbsServerInfo {
  id: string;
  name: string;
  version: string;
}

export interface AbsStatusResponse {
  isInit: boolean;
  serverVersion: string;
  authMethods?: string[];
}

export interface AbsUser {
  id: string;
  username: string;
  type: string;
}

export interface AbsMeResponse {
  id: string;
  username: string;
  type: string;
  mediaProgress?: AbsMediaProgress[];
}

export interface AbsMediaProgress {
  id: string;
  libraryItemId: string;
  episodeId: string | null;
  duration: number;       // seconds
  progress: number;       // 0–1
  currentTime: number;    // seconds
  isFinished: boolean;
  lastUpdate: number;     // unix ms
  startedAt: number;      // unix ms
  finishedAt: number | null;
}

export interface AbsLibrary {
  id: string;
  name: string;
  mediaType: string;      // "book" | "podcast"
}

export interface AbsLibraryItem {
  id: string;
  ino: string;
  libraryId: string;
  mediaType: string;
  media: {
    metadata: {
      title: string;
      authorName: string | null;
      seriesName: string | null;
      asin: string | null;
      isbn: string | null;
      narrator: string | null;
      duration: number;   // seconds
    };
  };
  libraryFiles?: {
    ino: string;
    metadata: {
      filename: string;
      path: string;
      relPath: string;
    };
  }[];
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function absGet<T>(baseUrl: string, apiKey: string, path: string): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ABS ${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// ─── Server-level test (no API key needed) ────────────────────────────────────

export async function testAudiobookshelfServer(baseUrl: string): Promise<TestResult> {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/status`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      return { ok: false, message: `Server responded with HTTP ${res.status}` };
    }
    const status = await res.json() as AbsStatusResponse;
    const version = status.serverVersion ? ` v${status.serverVersion}` : "";
    logger.info("Audiobookshelf server test succeeded", { baseUrl, version: status.serverVersion });
    return { ok: true, message: `Connected — Audiobookshelf${version}` };
  } catch (err) {
    logger.warn("Audiobookshelf server test failed", { baseUrl, error: String(err) });
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Per-user connection test ─────────────────────────────────────────────────

export async function testAudiobookshelfToken(baseUrl: string, apiKey: string): Promise<TestResult> {
  try {
    const me = await absGet<AbsMeResponse>(baseUrl, apiKey, "/api/me");
    const username = me.username ?? me.id ?? "unknown";
    logger.info("Audiobookshelf token test succeeded", { baseUrl, username, userType: me.type });
    return { ok: true, message: `Connected as ${username}`, username };
  } catch (err) {
    logger.warn("Audiobookshelf token test failed", { baseUrl, error: String(err) });
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Library fetch (placeholder — extended during sync implementation) ────────

export async function fetchAudiobookshelfLibraries(
  baseUrl: string,
  apiKey: string
): Promise<AbsLibrary[]> {
  const res = await absGet<{ libraries: AbsLibrary[] }>(baseUrl, apiKey, "/api/libraries");
  return res.libraries ?? [];
}

export async function fetchAudiobookshelfLibraryItems(
  baseUrl: string,
  apiKey: string,
  libraryId: string
): Promise<AbsLibraryItem[]> {
  const res = await absGet<{ results: AbsLibraryItem[] }>(
    baseUrl,
    apiKey,
    `/api/libraries/${libraryId}/items?limit=0&mediaType=book`
  );
  return res.results ?? [];
}

export async function fetchAudiobookshelfProgress(
  baseUrl: string,
  apiKey: string,
  libraryItemId: string
): Promise<AbsMediaProgress | null> {
  try {
    const progress = await absGet<AbsMediaProgress>(
      baseUrl,
      apiKey,
      `/api/me/progress/${libraryItemId}`
    );
    return progress;
  } catch {
    return null;
  }
}

export async function fetchAudiobookshelfAllProgress(
  baseUrl: string,
  apiKey: string
): Promise<AbsMediaProgress[]> {
  const me = await absGet<AbsMeResponse>(baseUrl, apiKey, "/api/me");
  return (me.mediaProgress ?? []).filter((p) => p.episodeId === null);
}

export async function patchAudiobookshelfProgress(
  baseUrl: string,
  apiKey: string,
  libraryItemId: string,
  currentTime: number,
  duration: number,
  isFinished: boolean
): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/me/progress/${libraryItemId}`;
  const progress = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ currentTime, duration, progress, isFinished }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!res.ok) throw new Error(`ABS PATCH progress → HTTP ${res.status}`);
}
