import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { apiGet, apiPost } from "../lib/api";
import type { SyncStatus } from "../../shared/types";

type RunSyncButtonProps = {
  onStarted?: () => Promise<void> | void;
  onError?: (message: string) => void;
};

const SYNC_STATUS_POLL_MS = 2_000;

export function RunSyncButton({ onStarted, onError }: RunSyncButtonProps) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const wasRunningRef = useRef(false);
  const onStartedRef = useRef(onStarted);
  const onErrorRef = useRef(onError);

  const syncing = status?.isRunning ?? false;

  useEffect(() => {
    onStartedRef.current = onStarted;
    onErrorRef.current = onError;
  }, [onError, onStarted]);

  const refreshStatus = useCallback(async () => {
    const next = await apiGet<SyncStatus>("/api/sync/status");
    setStatus(next);
    if (wasRunningRef.current && !next.isRunning) {
      await onStartedRef.current?.();
    }
    wasRunningRef.current = next.isRunning;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadStatus() {
      try {
        const next = await apiGet<SyncStatus>("/api/sync/status");
        if (cancelled) return;
        setStatus(next);
        wasRunningRef.current = next.isRunning;
      } catch (e) {
        if (!cancelled) onErrorRef.current?.(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setChecking(false);
      }
    }

    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!syncing) return undefined;

    const timer = window.setInterval(() => {
      void refreshStatus().catch((e) => onErrorRef.current?.(e instanceof Error ? e.message : String(e)));
    }, SYNC_STATUS_POLL_MS);

    return () => window.clearInterval(timer);
  }, [onError, refreshStatus, syncing]);

  async function runSync() {
    if (syncing || checking) return;
    try {
      await apiPost("/api/sync/run", {});
      wasRunningRef.current = true;
      await refreshStatus();
    } catch (e) {
      onErrorRef.current?.(e instanceof Error ? e.message : String(e));
      await refreshStatus().catch(() => {});
    }
  }

  return (
    <button
      disabled={syncing || checking}
      onClick={() => void runSync()}
      aria-busy={syncing}
      className="flex items-center gap-2 bg-background-container-high hover:bg-background-bright disabled:opacity-50 text-on-surface text-sm font-medium rounded-xl px-4 py-2 transition-colors border border-outline-variant/20"
    >
      <RefreshCw size={15} className={syncing ? "animate-spin" : ""} />
      {syncing ? "Syncing..." : checking ? "Checking..." : "Run Sync"}
    </button>
  );
}
