import type { SyncStatus } from "../../shared/types.js";

// Serialises everything that mutates shared book-identity state (profile
// syncs, the daily full-reconcile job, and — after a cover finishes caching
// in the background — a scoped reconcile of that one source) through a single
// queue, so none of them ever interleave with each other at an await point.
// Lives in its own module rather than engine.ts so covers.ts (which engine.ts
// itself imports) can use it too, without a circular import.
let queue = Promise.resolve();
const activeSyncRuns = new Map<number, { profileId: number; startedAt: string }>();

export function getActiveSyncStatus(): SyncStatus {
  const rows = Array.from(activeSyncRuns.entries()).map(([runId, run]) => ({
    runId,
    ...run
  })).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId - b.runId);

  return {
    isRunning: rows.length > 0,
    runIds: rows.map((row) => row.runId),
    profileIds: Array.from(new Set(rows.map((row) => row.profileId))),
    startedAt: rows[0]?.startedAt ?? null
  };
}

export function trackActiveSyncRun(runId: number, profileId: number): void {
  activeSyncRuns.set(runId, { profileId, startedAt: new Date().toISOString() });
}

export function untrackActiveSyncRun(runId: number): void {
  activeSyncRuns.delete(runId);
}

/**
 * Runs `task` serialized against every profile sync (and every other
 * `runExclusiveOfSyncs` caller) via the same queue — never overlapping a sync
 * in progress or letting one start while `task` runs. A sync yields to the
 * event loop on every await (remote I/O), and anything mutating book
 * identities that ran unserialized during one of those gaps could
 * merge/reassign a book_id a paused sync is mid-write against.
 */
export function runExclusiveOfSyncs<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.then(() => undefined, () => undefined);
  return result;
}
