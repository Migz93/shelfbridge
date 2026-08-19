import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BookOpen, Headphones, AlertTriangle, GitCompare, Download } from "lucide-react";
import { apiGet } from "../lib/api";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { formatRelativeTime, formatDateShort } from "../lib/utils";
import { RunSyncButton } from "../components/RunSyncButton";
import { SearchBar } from "../components/SearchBar";
import type { DashboardResponse, BookSummary, SyncRun } from "../../shared/types";

const FAST_REFRESH_MS = 2_500;
const IDLE_REFRESH_MS = 15_000;

export default function Dashboard() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(background = false) {
    setLoading((cur) => cur || !background);
    try {
      const result = await apiGet<DashboardResponse>("/api/dashboard");
      setData(result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const hasRunningSync = data?.recentActivity.some((r) => r.status === "running") ?? false;
  const getIntervalMs = useCallback(
    () => (hasRunningSync ? FAST_REFRESH_MS : IDLE_REFRESH_MS),
    [hasRunningSync]
  );
  const { refreshNow } = useLiveRefresh(async () => { await load(true); }, { getIntervalMs });

  useEffect(() => { void load(); }, []);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-on-surface-variant text-sm">Loading dashboard...</div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="p-6">
        <div className="bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm">{error}</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center">
        <h1 className="font-headline font-bold text-2xl text-on-surface flex-shrink-0">Dashboard</h1>
        <div className="w-full flex-1 sm:flex sm:justify-center">
          <div className="w-full sm:max-w-160">
            <SearchBar
              value={searchQuery}
              onChange={setSearchQuery}
              onSubmit={(q) => { if (q.trim()) void navigate(`/books?q=${encodeURIComponent(q.trim())}`); }}
              placeholder="Search books…"
            />
          </div>
        </div>
        <div className="w-full sm:w-auto">
          <RunSyncButton onStarted={refreshNow} />
        </div>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm mb-4">{error}</div>
      )}

      <div className="flex flex-col gap-5">
        {data && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
            {/* Stat chips */}
            <div className="flex flex-col gap-1.5 flex-1 justify-between">
              <div className="flex gap-2 flex-wrap sm:flex-nowrap flex-1">
                <StatChip icon={<BookOpen size={12} />} label="Books Tracked" value={data.stats.book.totalBooks} to="/books" compact />
                <StatChip icon={<AlertTriangle size={12} />} label="Not in Chaptarr" value={data.stats.book.notInChaptarr} to="/books?action=add-to-chaptarr" accent="warning" compact />
                <StatChip icon={<Download size={12} />} label="Grab in Chaptarr" value={data.stats.book.grabInChaptarr} to="/books?action=grab-in-chaptarr" accent="warning" compact />
                <StatChip icon={<GitCompare size={12} />} label="Needs Review" value={data.stats.book.needsReview} to="/books?action=id-review" accent="error" compact />
              </div>
              <div className="flex gap-2 flex-wrap sm:flex-nowrap flex-1">
                <StatChip icon={<Headphones size={12} />} label="Audiobooks Tracked" value={data.stats.audiobook.totalBooks} to="/audiobooks" compact />
                <StatChip icon={<AlertTriangle size={12} />} label="Not in Chaptarr" value={data.stats.audiobook.notInChaptarr} to="/audiobooks?action=add-to-chaptarr" accent="warning" compact />
                <StatChip icon={<Download size={12} />} label="Grab in Chaptarr" value={data.stats.audiobook.grabInChaptarr} to="/audiobooks?action=grab-in-chaptarr" accent="warning" compact />
                <StatChip icon={<GitCompare size={12} />} label="Needs Review" value={data.stats.audiobook.needsReview} to="/audiobooks?action=id-review" accent="error" compact />
              </div>
            </div>

            {/* Recent sync activity */}
            <Link
              to="/history"
              className="sm:w-160 flex-shrink-0 bg-background-container rounded-xl border border-outline-variant/20 px-4 py-3 hover:bg-background-container-high transition-colors group"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-on-surface-variant uppercase tracking-wide">Recent Syncs</span>
                <span className="text-xs text-primary sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">View all →</span>
              </div>
              {data.recentActivity.length > 0 ? (
                <div className="space-y-1.5">
                  {data.recentActivity.slice(0, 4).map((run) => (
                    <CompactSyncRow key={run.id} run={run} />
                  ))}
                </div>
              ) : (
                <p className="text-on-surface-variant text-xs">No sync activity yet.</p>
              )}
            </Link>
          </div>
        )}

        {/* Recently added books */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-headline font-semibold text-base text-on-surface">Recently Added</h2>
            <Link to="/books" className="text-sm text-primary hover:text-primary-dim">View All</Link>
          </div>
          {data && data.recentlyAdded.length > 0 ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-2">
              {data.recentlyAdded.map((book) => (
                <BookCoverCard key={book.id} book={book} />
              ))}
            </div>
          ) : (
            <div className="bg-background-container rounded-2xl border border-outline-variant/20 flex items-center justify-center py-10">
              <p className="text-on-surface-variant text-sm">
                No books tracked yet. Run a sync to populate.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatChip({
  icon, label, value, to, accent, compact
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  to: string;
  accent?: "warning" | "error";
  compact?: boolean;
}) {
  const accentClass = accent === "warning"
    ? "text-warning"
    : accent === "error"
      ? "text-error"
      : "text-primary";

  return (
    <Link
      to={to}
      className={`flex-1 flex flex-col items-center justify-center gap-0.5 bg-background-container hover:bg-background-container-high rounded-xl px-3 border border-outline-variant/20 transition-colors text-center min-w-0 ${compact ? "h-full py-1" : "py-2.5"}`}
    >
      <div className={`flex items-center gap-1.5 ${accentClass}`}>
        {icon}
        <span className={`font-headline font-bold text-on-surface leading-none ${compact ? "text-sm" : "text-lg"}`}>{value}</span>
      </div>
      <span className="text-on-surface-variant text-xs truncate">{label}</span>
    </Link>
  );
}

function CompactSyncRow({ run }: { run: SyncRun }) {
  const dot = {
    success: "bg-success",
    error: "bg-error",
    running: "bg-warning animate-pulse"
  }[run.status];

  const statusColor = {
    success: "text-success",
    error: "text-error",
    running: "text-warning"
  }[run.status];

  const label = run.profileName ? run.profileName : "All users";
  const summary = run.changesWritten > 0
    ? `${run.changesWritten} written`
    : run.status === "running"
      ? "running…"
      : "no changes";

  return (
    <div className="flex items-center gap-2 text-xs min-w-0">
      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
      <span className="text-on-surface truncate flex-1">{label}: {summary}</span>
      <span className={`flex-shrink-0 ${statusColor}`}>{formatRelativeTime(run.startedAt)}</span>
    </div>
  );
}

function BookCoverCard({ book }: { book: BookSummary }) {
  const healthDots: Record<string, string> = {
    synced: "bg-success",
    missing: "bg-warning",
    pending_download: "bg-warning",
    pending: "bg-on-surface-variant/50",
    error: "bg-error"
  };
  const healthDot = healthDots[book.syncHealth] ?? "bg-on-surface-variant/50";

  return (
    <Link to={`/books/${book.id}`} className="group block">
      <div className="relative aspect-[2/3] rounded-lg overflow-hidden bg-background-container-high transition-transform duration-300 group-hover:scale-105">
        {book.coverUrl ? (
          <img
            src={book.coverUrl}
            alt={book.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center p-2 text-center">
            <BookOpen size={16} className="text-on-surface-variant mb-1" />
            <span className="text-on-surface-variant text-[10px] leading-tight line-clamp-3">{book.title}</span>
          </div>
        )}
        <div
          className="absolute inset-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity duration-300"
          style={{ background: "linear-gradient(180deg, rgba(13,14,18,0.15) 0%, rgba(13,14,18,0.9) 100%)" }}
        />
        <div className={`absolute top-1 right-1 w-2 h-2 rounded-full ${healthDot} ring-1 ring-background`} />
        <div className="absolute inset-x-0 bottom-0 px-1.5 pb-1.5 opacity-100 translate-y-0 sm:opacity-0 sm:translate-y-1 transition-all duration-300 sm:group-hover:opacity-100 sm:group-hover:translate-y-0">
          <p className="text-white text-[10px] font-semibold leading-tight line-clamp-2">{book.title}</p>
          {book.author && (
            <p className="text-white/60 text-[9px] leading-tight mt-0.5 truncate">{book.author}</p>
          )}
          {book.lastModifiedAt && (
            <p className="text-white/50 text-[9px] mt-0.5">{formatDateShort(book.lastModifiedAt)}</p>
          )}
        </div>
      </div>
    </Link>
  );
}
