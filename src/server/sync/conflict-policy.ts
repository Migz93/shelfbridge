import type { HardcoverUserBook } from "./hardcover.js";
import type { GrimmoryBook } from "./grimmory.js";
import { HARDCOVER_TO_GRIMMORY, GRIMMORY_TO_HARDCOVER } from "./matcher.js";
import { newerSource } from "./time-order.js";

export type ConflictStrategy = "latest_wins" | "grimmory_wins" | "hardcover_wins";

export interface SyncDecision {
  decision: string;
  syncHealth: string;
  writeGrimmory: boolean;
  writeHardcover: boolean;
}

/** Pure status-conflict policy; it deliberately has no database or network dependency. */
export function computeSyncDecision(opts: {
  hcBook: HardcoverUserBook;
  grBook: GrimmoryBook | null;
  conflictStrategy: ConflictStrategy;
  syncStatusEnabled: boolean;
  previousGrimmoryStatus: string | null;
  previousHardcoverStatusId: number | null;
}): SyncDecision {
  const { hcBook, grBook, conflictStrategy, syncStatusEnabled, previousGrimmoryStatus, previousHardcoverStatusId } = opts;
  if (!grBook) return { decision: "no_grimmory_match", syncHealth: "missing", writeGrimmory: false, writeHardcover: false };

  const hcStatusId = hcBook.status_id;
  const grStatus = grBook.readStatus ?? null;
  if (!syncStatusEnabled || (hcStatusId === null && !grStatus)) return { decision: "no_status_to_sync", syncHealth: "synced", writeGrimmory: false, writeHardcover: false };

  const mappedHcToGr = hcStatusId !== null ? HARDCOVER_TO_GRIMMORY[hcStatusId] : null;
  const mappedGrToHc = grStatus ? GRIMMORY_TO_HARDCOVER[grStatus] : null;
  if (mappedHcToGr === grStatus || mappedGrToHc === hcStatusId) return { decision: "already_synced", syncHealth: "synced", writeGrimmory: false, writeHardcover: false };

  const grimmoryChanged = previousGrimmoryStatus !== null && grStatus !== previousGrimmoryStatus;
  const hardcoverChanged = previousHardcoverStatusId !== null && hcStatusId !== previousHardcoverStatusId;
  if (grimmoryChanged && !mappedGrToHc && !hardcoverChanged) return { decision: "grimmory_status_ignored", syncHealth: "synced", writeGrimmory: false, writeHardcover: false };
  if (grimmoryChanged && !hardcoverChanged && mappedGrToHc) return { decision: "grimmory_status_changed", syncHealth: "synced", writeGrimmory: false, writeHardcover: true };
  if (hardcoverChanged && !grimmoryChanged && mappedHcToGr) return { decision: "hardcover_status_changed", syncHealth: "synced", writeGrimmory: true, writeHardcover: false };
  if (grimmoryChanged && hardcoverChanged) {
    if (conflictStrategy === "hardcover_wins") return { decision: "both_changed_hardcover_wins", syncHealth: "synced", writeGrimmory: true, writeHardcover: false };
    if (conflictStrategy === "grimmory_wins") return mappedGrToHc
      ? { decision: "both_changed_grimmory_wins", syncHealth: "synced", writeGrimmory: false, writeHardcover: true }
      : { decision: "grimmory_status_ignored", syncHealth: "synced", writeGrimmory: false, writeHardcover: false };
  }
  if (hcStatusId !== null && grStatus) {
    if (conflictStrategy === "hardcover_wins") return { decision: "hardcover_wins", syncHealth: "synced", writeGrimmory: true, writeHardcover: false };
    if (conflictStrategy === "grimmory_wins") return mappedGrToHc
      ? { decision: "grimmory_wins", syncHealth: "synced", writeGrimmory: false, writeHardcover: true }
      : { decision: "grimmory_status_ignored", syncHealth: "synced", writeGrimmory: false, writeHardcover: false };
    const latest = newerSource(hcBook.updated_at ?? null, grBook.lastReadTime ?? null);
    if (latest === "hardcover") return { decision: "latest_wins_hardcover", syncHealth: "synced", writeGrimmory: true, writeHardcover: false };
    if (latest === "grimmory") return mappedGrToHc
      ? { decision: "latest_wins_grimmory", syncHealth: "synced", writeGrimmory: false, writeHardcover: true }
      : { decision: "grimmory_status_ignored", syncHealth: "synced", writeGrimmory: false, writeHardcover: false };
    return { decision: "no_timestamps_hardcover_preferred", syncHealth: "synced", writeGrimmory: true, writeHardcover: false };
  }
  if (hcStatusId !== null) return { decision: "hardcover_only_status", syncHealth: "synced", writeGrimmory: true, writeHardcover: false };
  if (grStatus) return mappedGrToHc
    ? { decision: "grimmory_only_status", syncHealth: "synced", writeGrimmory: false, writeHardcover: true }
    : { decision: "grimmory_status_ignored", syncHealth: "synced", writeGrimmory: false, writeHardcover: false };
  return { decision: "nothing_to_sync", syncHealth: "synced", writeGrimmory: false, writeHardcover: false };
}
