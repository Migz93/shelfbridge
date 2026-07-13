import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertCircle, CheckCircle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock, XCircle
} from "lucide-react";
import { apiGet } from "../lib/api";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { formatDateTime, formatRelativeTime, toUtcDate } from "../lib/utils";
import { RunSyncButton } from "../components/RunSyncButton";
import type { SyncHistoryPageResponse, SyncRun, SyncRunDetail, SyncEvent, SyncEventType } from "../../shared/types";

type StatusFilter = "all" | "running" | "success" | "error";

const VALID_STATUSES: StatusFilter[] = ["all", "running", "success", "error"];
const VALID_PAGE_SIZES = [10, 25, 50, 100];
const FAST_REFRESH_MS = 2_500;
const IDLE_REFRESH_MS = 15_000;

const EVENT_TYPE_LABELS: Record<SyncEventType, string> = {
  written: "Written",
  skipped_no_change: "Skipped (no change)",
  superseded: "Superseded (stale data blocked)",
  conflict: "Conflict",
  missing_match: "No match found",
  credential_failure: "Credential failure",
  api_failure: "API failure"
};

const EVENT_TYPE_TONE: Record<SyncEventType, "success" | "warning" | "error" | "neutral"> = {
  written: "success",
  skipped_no_change: "neutral",
  superseded: "warning",
  conflict: "warning",
  missing_match: "warning",
  credential_failure: "error",
  api_failure: "error"
};

export default function SyncHistory() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = (VALID_STATUSES.includes(searchParams.get("status") as StatusFilter)
    ? searchParams.get("status") : "all") as StatusFilter;
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const pageSize = VALID_PAGE_SIZES.includes(Number(searchParams.get("pageSize")))
    ? Number(searchParams.get("pageSize")) : 10;

  function setParam(key: string, value: string, resetPage = false) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set(key, value);
      if (resetPage) next.delete("page");
      return next;
    }, { replace: true });
  }

  const [data, setData] = useState<SyncHistoryPageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (background = false) => {
    setLoading((cur) => cur || !background);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), status });
      const result = await apiGet<SyncHistoryPageResponse>(`/api/history?${params.toString()}`);
      setData(result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, status]);

  const runs = data?.results ?? [];
  const pageInfo = data?.pageInfo;
  const hasRunningSync = runs.some((r) => r.status === "running");
  const getIntervalMs = useCallback(
    () => (hasRunningSync ? FAST_REFRESH_MS : IDLE_REFRESH_MS),
    [hasRunningSync]
  );

  const { refreshNow } = useLiveRefresh(async () => { await load(true); }, { getIntervalMs });
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-headline font-bold text-2xl text-on-surface">Sync History</h1>
        <RunSyncButton
          onStarted={refreshNow}
          onError={(message) => setError(message)}
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <div className="flex rounded-lg overflow-hidden border border-outline-variant/30">
          {VALID_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setParam("status", s, true)}
              className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                status === s
                  ? "bg-primary-dim text-on-surface"
                  : "bg-background-container text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        <select
          value={pageSize}
          onChange={(e) => setParam("pageSize", e.target.value, true)}
          className="ml-auto px-3 py-1.5 rounded-lg bg-background-container border border-outline-variant/30 text-xs text-on-surface focus:outline-none"
        >
          {VALID_PAGE_SIZES.map((n) => (
            <option key={n} value={n}>{n} / page</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm mb-4">{error}</div>
      )}

      {loading && !data ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-on-surface-variant text-sm">Loading history...</div>
        </div>
      ) : runs.length > 0 ? (
        <div className="space-y-2">
          {runs.map((run) => <RunRow key={run.id} run={run} />)}
        </div>
      ) : (
        <div className="bg-background-container rounded-2xl border border-outline-variant/20 flex items-center justify-center py-16">
          <p className="text-on-surface-variant text-sm">No sync history matches the current filter.</p>
        </div>
      )}

      {/* Pagination */}
      {pageInfo && pageInfo.total > 0 && (
        <div className="flex items-center justify-between mt-4 text-xs text-on-surface-variant">
          <span>
            {`${(pageInfo.page - 1) * pageInfo.pageSize + 1}–${Math.min(pageInfo.page * pageInfo.pageSize, pageInfo.total)} of ${pageInfo.total}`}
          </span>
          <div className="flex gap-1 items-center">
            <button
              disabled={page <= 1}
              onClick={() => setParam("page", String(page - 1))}
              className="p-1.5 rounded-lg bg-background-container disabled:opacity-40 hover:bg-background-container-high transition-colors"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="px-2">Page {page} / {pageInfo.pages}</span>
            <button
              disabled={page >= pageInfo.pages}
              onClick={() => setParam("page", String(page + 1))}
              className="p-1.5 rounded-lg bg-background-container disabled:opacity-40 hover:bg-background-container-high transition-colors"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDuration(run: SyncRun, now = Date.now()): string | null {
  const end = run.finishedAt ? toUtcDate(run.finishedAt).getTime() : now;
  const ms = Math.max(0, end - toUtcDate(run.startedAt).getTime());
  const s = Math.floor(ms / 1000);
  if (run.status === "running") {
    if (s < 60) return `Running for ${s}s`;
    return `Running for ${Math.floor(s / 60)}m`;
  }
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function RunRow({ run }: { run: SyncRun }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<SyncRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const loadDetail = useCallback(async (background = false) => {
    setDetailLoading((cur) => cur || !background);
    try {
      const result = await apiGet<SyncRunDetail>(`/api/history/${run.id}`);
      setDetail(result);
      setDetailError(null);
    } catch (e) {
      if (!background) setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!background) setDetailLoading(false);
    }
  }, [run.id]);

  function handleExpand() {
    if (!expanded) void loadDetail();
    setExpanded((v) => !v);
  }

  const liveRun = detail ?? run;
  const getDetailIntervalMs = useCallback(
    () => (expanded && liveRun.status === "running" ? FAST_REFRESH_MS : null),
    [expanded, liveRun.status]
  );

  useLiveRefresh(async () => { await loadDetail(true); }, { enabled: expanded, getIntervalMs: getDetailIntervalMs });

  useEffect(() => {
    if (liveRun.status !== "running") return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [liveRun.status, liveRun.startedAt]);

  const statusConfig = {
    success: {
      icon: <CheckCircle size={18} className="text-success" />,
      badge: "text-success bg-success/10 border-success/20"
    },
    error: {
      icon: <XCircle size={18} className="text-error" />,
      badge: "text-error bg-error/10 border-error/20"
    },
    running: {
      icon: <Clock size={18} className="text-warning animate-pulse" />,
      badge: "text-warning bg-warning/10 border-warning/20"
    }
  } as const;

  const fallbackConfig = {
    icon: <AlertCircle size={18} className="text-on-surface-variant" />,
    badge: "text-on-surface-variant bg-background-container-high border-outline-variant/20"
  };

  const config = statusConfig[liveRun.status as keyof typeof statusConfig] ?? fallbackConfig;
  const profileLabel = liveRun.profileName ?? "All users";

  return (
    <div className="bg-background-container rounded-xl border border-outline-variant/20 overflow-hidden">
      <button
        onClick={handleExpand}
        className="w-full flex items-center gap-4 p-4 text-left hover:bg-background-container-high/50 transition-colors"
      >
        {config.icon}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-on-surface text-sm">{profileLabel}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded-full border font-medium ${config.badge}`}>
              {liveRun.status.charAt(0).toUpperCase() + liveRun.status.slice(1)}
            </span>
            {liveRun.dryRun && (
              <span className="text-xs px-1.5 py-0.5 rounded-full border font-medium text-primary bg-primary/10 border-primary/20">
                Dry run
              </span>
            )}
          </div>
          <div className="text-on-surface-variant text-xs mt-0.5 truncate">{liveRun.summary}</div>
        </div>
        <div className="flex-shrink-0 text-right mr-2">
          <div className="text-on-surface-variant text-xs">{formatRelativeTime(liveRun.startedAt)}</div>
          <div className="text-on-surface-variant text-xs mt-0.5">{formatDuration(liveRun, now)}</div>
        </div>
        {expanded
          ? <ChevronUp size={16} className="text-on-surface-variant flex-shrink-0" />
          : <ChevronDown size={16} className="text-on-surface-variant flex-shrink-0" />
        }
      </button>

      {expanded && (
        <div className="border-t border-outline-variant/20 bg-background-container-low">
          {/* Run metadata */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs px-4 py-3">
            <div>
              <span className="text-on-surface-variant">Started</span>
              <div className="text-on-surface mt-0.5">{formatDateTime(liveRun.startedAt)}</div>
            </div>
            {liveRun.finishedAt && (
              <div>
                <span className="text-on-surface-variant">Finished</span>
                <div className="text-on-surface mt-0.5">{formatDateTime(liveRun.finishedAt)}</div>
              </div>
            )}
            <div>
              <span className="text-on-surface-variant">Written</span>
              <div className="text-on-surface mt-0.5">{liveRun.changesWritten}</div>
            </div>
            <div>
              <span className="text-on-surface-variant">Skipped</span>
              <div className="text-on-surface mt-0.5">{liveRun.changesSkipped}</div>
            </div>
            {liveRun.changesSuperseded > 0 && (
              <div>
                <span className="text-on-surface-variant">Superseded</span>
                <div className="text-warning mt-0.5">{liveRun.changesSuperseded}</div>
              </div>
            )}
          </div>

          {liveRun.error && (
            <div className="mx-4 mb-3 bg-error/5 border border-error/20 rounded-lg px-3 py-2 text-xs text-error">
              {liveRun.error}
            </div>
          )}

          {/* Events */}
          <div className="px-4 pb-3">
            {detailLoading ? (
              <div className="text-xs text-on-surface-variant py-2">Loading events...</div>
            ) : detailError ? (
              <div className="py-2">
                <div className="text-xs text-error">{detailError}</div>
                <button
                  onClick={() => void loadDetail()}
                  className="mt-2 text-xs font-medium text-primary hover:text-primary-dim transition-colors"
                >
                  Retry
                </button>
              </div>
            ) : detail ? (
              <EventList events={detail.events} />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function EventList({ events }: { events: SyncEvent[] }) {
  if (events.length === 0) {
    return <div className="text-xs text-on-surface-variant py-2">No events recorded for this run.</div>;
  }

  const errorEvents = events.filter((e) => EVENT_TYPE_TONE[e.eventType] === "error");
  const warnEvents = events.filter((e) => EVENT_TYPE_TONE[e.eventType] === "warning");
  const writtenEvents = events.filter((e) => e.eventType === "written");
  const otherEvents = events.filter((e) =>
    EVENT_TYPE_TONE[e.eventType] === "neutral" &&
    !errorEvents.includes(e) && !warnEvents.includes(e)
  );

  return (
    <div className="space-y-3">
      {/* Summary counts */}
      <div className="flex flex-wrap gap-2 text-xs">
        {writtenEvents.length > 0 && (
          <span className="text-success bg-success/10 px-2 py-0.5 rounded-full">
            {writtenEvents.length} written
          </span>
        )}
        {warnEvents.length > 0 && (
          <span className="text-warning bg-warning/10 px-2 py-0.5 rounded-full">
            {warnEvents.length} warning{warnEvents.length !== 1 ? "s" : ""}
          </span>
        )}
        {errorEvents.length > 0 && (
          <span className="text-error bg-error/10 px-2 py-0.5 rounded-full">
            {errorEvents.length} error{errorEvents.length !== 1 ? "s" : ""}
          </span>
        )}
        {otherEvents.length > 0 && (
          <span className="text-on-surface-variant bg-background-container-high px-2 py-0.5 rounded-full">
            {otherEvents.length} skipped
          </span>
        )}
      </div>

      {/* Error events */}
      {errorEvents.length > 0 && (
        <CollapsibleSection title="Errors" count={errorEvents.length} tone="error" defaultOpen>
          {errorEvents.map((e) => <EventRow key={e.id} event={e} />)}
        </CollapsibleSection>
      )}

      {/* Warning events (superseded, conflicts, missing matches) */}
      {warnEvents.length > 0 && (
        <CollapsibleSection title="Warnings" count={warnEvents.length} tone="warning" defaultOpen={warnEvents.length <= 5}>
          {warnEvents.map((e) => <EventRow key={e.id} event={e} />)}
        </CollapsibleSection>
      )}

      {/* Written events */}
      {writtenEvents.length > 0 && (
        <CollapsibleSection title="Written" count={writtenEvents.length} tone="success">
          {writtenEvents.map((e) => <EventRow key={e.id} event={e} />)}
        </CollapsibleSection>
      )}

      {/* Skipped events */}
      {otherEvents.length > 0 && (
        <CollapsibleSection title="Skipped" count={otherEvents.length} tone="neutral">
          {otherEvents.map((e) => <EventRow key={e.id} event={e} />)}
        </CollapsibleSection>
      )}
    </div>
  );
}

function CollapsibleSection({
  title, count, tone, defaultOpen = false, children
}: {
  title: string;
  count: number;
  tone: "success" | "warning" | "error" | "neutral";
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toneClass = {
    success: "text-success hover:text-success/80",
    warning: "text-warning hover:text-warning/80",
    error: "text-error hover:text-error/80",
    neutral: "text-on-surface-variant hover:text-on-surface"
  }[tone];

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 text-xs font-medium transition-colors ${toneClass}`}
      >
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        {open ? "Hide" : "Show"} {title} ({count})
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {children}
        </div>
      )}
    </div>
  );
}

function EventRow({ event }: { event: SyncEvent }) {
  const tone = EVENT_TYPE_TONE[event.eventType];
  const toneClasses = {
    success: "bg-success/5 border-success/20 text-success",
    warning: "bg-warning/5 border-warning/20 text-warning",
    error: "bg-error/5 border-error/20 text-error",
    neutral: "bg-background-container/50 border-outline-variant/20 text-on-surface-variant"
  }[tone];

  return (
    <div className={`border rounded-lg px-3 py-2 text-xs ${toneClasses}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <span className="font-medium text-on-surface">
            {event.bookTitle ?? "Unknown book"}
          </span>
          <span className="ml-2 opacity-70">{EVENT_TYPE_LABELS[event.eventType]}</span>
          {event.direction && (
            <span className="ml-2 opacity-60 font-mono text-[10px]">{event.direction}</span>
          )}
        </div>
        <span className="flex-shrink-0 opacity-60">{formatRelativeTime(event.createdAt)}</span>
      </div>
      {event.decision && (
        <div className="mt-1 opacity-70">{event.decision}</div>
      )}
    </div>
  );
}
