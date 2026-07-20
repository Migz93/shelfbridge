import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Layers,
  Minus,
  Search
} from "lucide-react";
import { apiDelete, apiGet, apiPost } from "../lib/api";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { formatRelativeTime, formatDateShort, hardcoverStatusLabel, statusLabel } from "../lib/utils";
import { RunSyncButton } from "../components/RunSyncButton";
import { SearchBar } from "../components/SearchBar";
import type { AppSettings, BookDetail, BookDuplicateCandidate, BookFacets, BookRelationship, BookSummary, BooksPageResponse } from "../../shared/types";

const PAGE_SIZE = 48;
const BOOKS_REFRESH_MS = 30_000;

type StatusFilter = "all" | "UNREAD" | "READING" | "READ" | "ABANDONED";
type SourceFilter = "all" | "hardcover" | "goodreads" | "on-disk";
type ChaptarrFilter = "in" | "out" | null;
type ActionFilter = "add-to-chaptarr" | "grab-in-chaptarr" | "review-in-grimmory" | "fix-chaptarr-id" | "id-review" | "probable-duplicates" | "abs-runtime-mismatch" | null;
type SourceKey = "GR" | "HA" | "GO" | "CH" | "AB";
type BookDetailLocationState = {
  returnTo?: string;
};

const SOURCE_BADGE_STYLE: Record<SourceKey, string> = {
  GR: "bg-[#11131c]/90 text-[#aeb8ff] ring-[#7986cb]/60",
  HA: "bg-[#0d1b19]/90 text-[#8be4dc] ring-[#4db6ac]/60",
  GO: "bg-[#211010]/90 text-[#ffb4b4] ring-[#ef9a9a]/60",
  CH: "bg-[#1a1208]/90 text-[#ffd580] ring-[#e6ac00]/60",
  AB: "bg-[#0d1220]/90 text-[#b0c4ff] ring-[#6488e8]/60"
};

const SOURCE_BADGE_LABEL: Record<SourceKey, string> = {
  GR: "Grimmory",
  HA: "Hardcover",
  GO: "Goodreads",
  CH: "Chaptarr",
  AB: "Audiobookshelf"
};

const BOOK_STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "UNREAD", label: "To Read" },
  { value: "READING", label: "Reading" },
  { value: "READ", label: "Read" },
  { value: "ABANDONED", label: "DNF" }
];

const AUDIOBOOK_STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "UNREAD", label: "To Listen" },
  { value: "READING", label: "Listening" },
  { value: "READ", label: "Listened" },
  { value: "ABANDONED", label: "DNF" }
];

const ACTION_OPTIONS: { value: NonNullable<ActionFilter>; label: string }[] = [
  { value: "add-to-chaptarr", label: "Add to Chaptarr" },
  { value: "grab-in-chaptarr", label: "Grab in Chaptarr" },
  { value: "review-in-grimmory", label: "Review in Grimmory" },
  { value: "fix-chaptarr-id", label: "Bad Chaptarr ID" },
  { value: "id-review", label: "ID Review" },
  { value: "probable-duplicates", label: "Possible Duplicates" },
  { value: "abs-runtime-mismatch", label: "ABS Runtime Mismatch" },
];

const ACTION_EXPLANATIONS: Record<NonNullable<ActionFilter>, string> = {
  "add-to-chaptarr":      "In Hardcover or Goodreads but not yet in Chaptarr",
  "grab-in-chaptarr":     "Monitored in Chaptarr but no file downloaded yet",
  "review-in-grimmory":   "File in Chaptarr but not matched in Grimmory",
  "fix-chaptarr-id":      "Chaptarr ID does not match Chaptarr's own record",
  "id-review":            "Conflicting external identifiers detected across sources",
  "probable-duplicates":  "Loose title and author match; review source IDs before merging",
  "abs-runtime-mismatch": "Audiobookshelf item matched but runtime validation failed — progress sync disabled",
};


export default function Books() {
  return <CatalogPage mediaType="book" title="Books" />;
}

export function Audiobooks() {
  return <CatalogPage mediaType="audiobook" title="Audiobooks" />;
}

function CatalogPage({ mediaType, title }: { mediaType: "book" | "audiobook"; title: string }) {
  const statusOptions = mediaType === "audiobook" ? AUDIOBOOK_STATUS_OPTIONS : BOOK_STATUS_OPTIONS;
  const [searchParams, setSearchParams] = useSearchParams();
  const status = (searchParams.get("status") ?? "all") as StatusFilter;
  const rawChaptarr = searchParams.get("chaptarr");
  const chaptarr: ChaptarrFilter = rawChaptarr === "in" || rawChaptarr === "out" ? rawChaptarr : null;
  const rawAction = searchParams.get("action");
  const action: ActionFilter = ACTION_OPTIONS.some((o) => o.value === rawAction) ? rawAction as ActionFilter : null;

  // Multi-select filter state stored as comma-separated URL params.
  const VALID_SOURCES = new Set<SourceFilter>(["hardcover", "goodreads", "on-disk"]);
  const rawSource = searchParams.get("source") ?? "";
  const rawExcludeSource = searchParams.get("excludeSource") ?? "";
  const rawProfileId = searchParams.get("profileId") ?? "";
  const rawExcludeProfileId = searchParams.get("excludeProfileId") ?? "";
  const includedSources = new Set<SourceFilter>(
    rawSource.split(",").filter((s): s is SourceFilter => VALID_SOURCES.has(s as SourceFilter))
  );
  const excludedSources = new Set<SourceFilter>(
    rawExcludeSource.split(",").filter((s): s is SourceFilter => VALID_SOURCES.has(s as SourceFilter))
  );
  const includedProfileIds = new Set<number>(
    rawProfileId.split(",").map(Number).filter((n) => !isNaN(n) && n > 0)
  );
  const excludedProfileIds = new Set<number>(
    rawExcludeProfileId.split(",").map(Number).filter((n) => !isNaN(n) && n > 0)
  );
  const sortBy = "updated-desc";
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const q = searchParams.get("q") ?? "";

  function setParam(updates: Record<string, string | null>, resetPage = false) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(updates)) {
        if (v === null) next.delete(k); else next.set(k, v);
      }
      if (resetPage) next.delete("page");
      return next;
    }, { replace: true });
  }

  const [searchInput, setSearchInput] = useState(q);

  // Debounce: commit searchInput to URL after 300ms of no typing
  useEffect(() => {
    const timer = setTimeout(() => {
      setParam({ q: searchInput.trim() || null }, true);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Sync input when URL q changes (e.g. browser back/forward)
  useEffect(() => { setSearchInput(q); }, [q]);

  const [data, setData] = useState<BooksPageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(background = false) {
    setLoading((c) => c || !background);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sortBy, mediaType });
    if (includedProfileIds.size > 0) params.set("profileId", [...includedProfileIds].join(","));
    if (excludedProfileIds.size > 0) params.set("excludeProfileId", [...excludedProfileIds].join(","));
    if (status !== "all") params.set("status", status);
    if (includedSources.size > 0) params.set("source", [...includedSources].join(","));
    if (excludedSources.size > 0) params.set("excludeSource", [...excludedSources].join(","));
    if (chaptarr) params.set("chaptarr", chaptarr);
    if (action) params.set("action", action);
    if (q) params.set("q", q);
    try {
      const result = await apiGet<BooksPageResponse>(`/api/books?${params}`);
      setData(result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const getIntervalMs = useCallback(() => BOOKS_REFRESH_MS, []);
  const { refreshNow } = useLiveRefresh(async () => { await load(true); }, { getIntervalMs });
  useEffect(() => { void load(); }, [status, rawSource, rawExcludeSource, chaptarr, action, rawProfileId, rawExcludeProfileId, page, q]);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;
  const facets: BookFacets | undefined = data?.facets;

  function toggleSourceChip(s: SourceFilter) {
    if (s === "all") {
      setParam({ source: null, excludeSource: null }, true);
      return;
    }
    const inc = new Set(includedSources);
    const exc = new Set(excludedSources);
    if (inc.has(s)) { inc.delete(s); exc.add(s); }
    else if (exc.has(s)) { exc.delete(s); }
    else { inc.add(s); }
    setParam({
      source: inc.size > 0 ? [...inc].join(",") : null,
      excludeSource: exc.size > 0 ? [...exc].join(",") : null,
    }, true);
  }

  function toggleProfileChip(id: number) {
    const inc = new Set(includedProfileIds);
    const exc = new Set(excludedProfileIds);
    if (inc.has(id)) { inc.delete(id); exc.add(id); }
    else if (exc.has(id)) { exc.delete(id); }
    else { inc.add(id); }
    setParam({
      profileId: inc.size > 0 ? [...inc].join(",") : null,
      excludeProfileId: exc.size > 0 ? [...exc].join(",") : null,
    }, true);
  }

  function cycleChaptarr() {
    if (chaptarr === null) setParam({ chaptarr: "in" }, true);
    else if (chaptarr === "in") setParam({ chaptarr: "out" }, true);
    else setParam({ chaptarr: null }, true);
  }

  function toggleAction(next: NonNullable<ActionFilter>) {
    setParam({ action: action === next ? null : next }, true);
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center">
        <h1 className="font-headline font-bold text-2xl text-on-surface flex-shrink-0">{title}</h1>
        <div className="w-full flex-1 sm:flex sm:justify-center">
          <div className="w-full sm:max-w-160">
            <SearchBar
              value={searchInput}
              onChange={setSearchInput}
              onSubmit={(v) => setParam({ q: v.trim() || null }, true)}
              placeholder="Search by title or author…"
            />
          </div>
        </div>
        <div className="w-full sm:w-auto">
          <RunSyncButton
            onStarted={refreshNow}
            onError={(message) => setError(message)}
          />
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-start gap-x-8 gap-y-2 mb-4">
        {/* Left column: main filters */}
        <div className="flex-1 min-w-0 space-y-2">
          {/* Sources row */}
          {facets && (
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
              <span className="text-[11px] font-medium text-on-surface-variant/50 uppercase tracking-wide sm:w-16 sm:shrink-0 sm:text-right">Sources</span>
              <div className="flex items-center gap-2 flex-wrap">
                <FilterChip
                  label="All"
                  active={includedSources.size === 0 && excludedSources.size === 0}
                  count={facets.sourceAllCount}
                  onClick={() => toggleSourceChip("all")}
                />
                <FilterChip
                  label="Hardcover"
                  active={includedSources.has("hardcover")}
                  subtracting={excludedSources.has("hardcover")}
                  count={facets.hardcoverCount}
                  onClick={() => toggleSourceChip("hardcover")}
                />
                <FilterChip
                  label="Goodreads"
                  active={includedSources.has("goodreads")}
                  subtracting={excludedSources.has("goodreads")}
                  count={facets.goodreadsCount}
                  onClick={() => toggleSourceChip("goodreads")}
                />
                <FilterChip
                  label="On Disk"
                  active={includedSources.has("on-disk")}
                  subtracting={excludedSources.has("on-disk")}
                  count={facets.onDiskCount}
                  onClick={() => toggleSourceChip("on-disk")}
                />
              </div>
            </div>
          )}

          {/* Profile row */}
          {facets && facets.profiles.length > 0 && (
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
              <span className="text-[11px] font-medium text-on-surface-variant/50 uppercase tracking-wide sm:w-16 sm:shrink-0 sm:text-right">Users</span>
              <div className="flex items-center gap-2 flex-wrap">
                <FilterChip
                  label="All"
                  active={includedProfileIds.size === 0 && excludedProfileIds.size === 0}
                  count={facets.allCount}
                  onClick={() => setParam({ profileId: null, excludeProfileId: null }, true)}
                />
                {facets.profiles.map((p) => (
                  <FilterChip
                    key={p.profileId}
                    label={p.displayName}
                    active={includedProfileIds.has(p.profileId)}
                    subtracting={excludedProfileIds.has(p.profileId)}
                    count={p.count}
                    onClick={() => toggleProfileChip(p.profileId)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Status row */}
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
            <span className="text-[11px] font-medium text-on-surface-variant/50 uppercase tracking-wide sm:w-16 sm:shrink-0 sm:text-right">Status</span>
            <div className="flex items-center gap-2 flex-wrap">
              {statusOptions.map((opt) => (
                <FilterChip
                  key={opt.value}
                  label={opt.label}
                  active={status === opt.value}
                  count={opt.value === "all" ? facets?.statusAllCount : facets?.status[opt.value]}
                  onClick={() => setParam({ status: opt.value === "all" ? null : opt.value }, true)}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Right column: Presence + Actions */}
        <div className="flex w-full flex-col items-start gap-2 shrink-0 sm:w-auto sm:items-end">
          {facets && (facets.chaptarrInCount > 0 || facets.chaptarrOutCount > 0) && (
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <FilterChip
                  label="Chaptarr"
                  active={chaptarr === "in"}
                  subtracting={chaptarr === "out"}
                  count={chaptarr === "out" ? facets.chaptarrOutCount : facets.chaptarrInCount}
                  onClick={cycleChaptarr}
                />
              </div>
              <span className="text-[11px] font-medium text-on-surface-variant/50 uppercase tracking-wide sm:w-16 sm:shrink-0">Presence</span>
            </div>
          )}
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
            <div className="flex flex-wrap gap-2 sm:justify-end">
              <FilterChip
                label="Add to Chaptarr"
                active={action === "add-to-chaptarr"}
                count={facets?.addToChaptarrCount}
                onClick={() => toggleAction("add-to-chaptarr")}
              />
              <FilterChip
                label="Grab in Chaptarr"
                active={action === "grab-in-chaptarr"}
                count={facets?.grabInChaptarrCount}
                onClick={() => toggleAction("grab-in-chaptarr")}
              />
              <FilterChip
                label="Review in Grimmory"
                active={action === "review-in-grimmory"}
                count={facets?.reviewInGrimmoryCount}
                onClick={() => toggleAction("review-in-grimmory")}
              />
            </div>
            <span className="text-[11px] font-medium text-on-surface-variant/50 uppercase tracking-wide sm:w-16 sm:shrink-0">Actions</span>
          </div>
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {facets && facets.fixChaptarrIdCount > 0 && (
                <FilterChip
                  label="Bad Chaptarr ID"
                  active={action === "fix-chaptarr-id"}
                  count={facets.fixChaptarrIdCount}
                  onClick={() => toggleAction("fix-chaptarr-id")}
                />
              )}
              <FilterChip
                label="ID Review"
                active={action === "id-review"}
                count={facets?.idReviewCount}
                onClick={() => toggleAction("id-review")}
              />
              <FilterChip
                label="Possible Duplicates"
                active={action === "probable-duplicates"}
                count={facets?.probableDuplicateCount}
                onClick={() => toggleAction("probable-duplicates")}
              />
            </div>
            <span className="text-[11px] font-medium text-on-surface-variant/50 uppercase tracking-wide sm:w-16 sm:shrink-0">Review</span>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm mb-4">{error}</div>
      )}

      {/* Grid */}
      {loading && !data ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-on-surface-variant text-sm">Loading books...</div>
        </div>
      ) : data && data.items.length > 0 ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 mb-6">
            {data.items.map((book) => (
              <BookCard key={book.id} book={book} activeAction={action} pageMediaType={mediaType} />
            ))}
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3">
              <button disabled={page <= 1} onClick={() => setParam({ page: String(page - 1) })}
                className="p-2 rounded-lg border border-outline-variant/20 text-on-surface-variant hover:text-on-surface hover:bg-background-container-high disabled:opacity-40 transition-colors">
                <ChevronLeft size={18} />
              </button>
              <span className="text-on-surface-variant text-sm">Page {page} of {totalPages}</span>
              <button disabled={page >= totalPages} onClick={() => setParam({ page: String(page + 1) })}
                className="p-2 rounded-lg border border-outline-variant/20 text-on-surface-variant hover:text-on-surface hover:bg-background-container-high disabled:opacity-40 transition-colors">
                <ChevronRight size={18} />
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="bg-background-container rounded-2xl border border-outline-variant/20 flex flex-col items-center justify-center py-16 text-center gap-3">
          <BookOpen size={24} className="text-on-surface-variant" />
          <p className="text-on-surface-variant text-sm max-w-xs">
            {data?.total === 0 && status === "all" && !action && !chaptarr
              ? "No books yet. Add users and run a sync to populate your library."
              : "No books match the current filters."}
          </p>
        </div>
      )}

    </div>
  );
}

function BookCard({
  book,
  activeAction,
  pageMediaType
}: {
  book: BookSummary;
  activeAction: ActionFilter;
  pageMediaType: "book" | "audiobook";
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  const location = useLocation();
  const healthColor: Record<string, string> = {
    synced: "text-success",
    pending_download: "text-warning",
    missing: "text-error",
    pending: "text-on-surface-variant",
    error: "text-error"
  };

  return (
    <Link
      to={pageMediaType === "audiobook" ? `/audiobooks/${book.id}` : `/books/${book.id}`}
      state={{ returnTo: `${location.pathname}${location.search}` } satisfies BookDetailLocationState}
      className="group text-left w-full"
    >
      <div className={`relative ${pageMediaType === "audiobook" ? "aspect-square" : "aspect-[2/3]"} rounded-xl overflow-hidden bg-background-container-high transition-transform duration-300 group-hover:scale-105`}>
        {book.coverUrl && !coverFailed ? (
          <img
            src={book.coverUrl}
            alt={book.title}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={() => setCoverFailed(true)}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center p-3 text-center">
            <BookOpen size={24} className="text-on-surface-variant mb-2" />
            <span className="text-on-surface-variant text-xs leading-tight line-clamp-3">{book.title}</span>
          </div>
        )}

        {/* Gradient overlay */}
        <div
          className="absolute inset-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity duration-300"
          style={{ background: "linear-gradient(180deg, rgba(13, 14, 18, 0.2) 0%, var(--overlay-poster) 100%)" }}
        />

        {/* Sync health icon — top right */}
        <div className={`absolute top-1.5 right-1.5 ${healthColor[book.syncHealth] ?? "text-on-surface-variant"}`}>
          {book.syncHealth === "synced" ? (
            <div className="relative">
              <div className="absolute inset-[3px] rounded-full bg-(--poster-halo-success)" />
              <CheckCircle size={18} className="relative drop-shadow-[0_0_4px_rgba(0,0,0,1)]" />
            </div>
          ) : book.syncHealth === "pending_download" ? (
            <div className="relative">
              <div className="absolute inset-[3px] rounded-full bg-(--poster-halo-warning)" />
              <Clock size={18} className="relative drop-shadow-[0_0_4px_rgba(0,0,0,1)]" />
            </div>
          ) : book.syncHealth === "missing" || book.syncHealth === "error" ? (
            <div className="relative">
              <div className="absolute inset-[3px] rounded-full bg-(--poster-halo-error)" />
              <AlertTriangle size={18} className="relative drop-shadow-[0_0_4px_rgba(0,0,0,1)]" />
            </div>
          ) : (
            <div className="relative w-[18px] h-[18px] rounded-full bg-background-container-highest border border-outline-variant/40 flex items-center justify-center drop-shadow-[0_0_4px_rgba(0,0,0,1)]">
              <span className="text-[8px] font-bold">!</span>
            </div>
          )}
        </div>

        {/* Source badges — top left */}
        <div className="absolute top-1.5 left-1.5 flex flex-col gap-0.5">
          {book.grimmoryBookId && (
            <SourceBadge source="GR" />
          )}
          {book.hardcoverBookId && (
            <SourceBadge source="HA" />
          )}
          {book.goodreadsBookLink && (
            <SourceBadge source="GO" />
          )}
          {book.chaptarrBookId && (
            <SourceBadge source="CH" />
          )}
          {book.audiobookshelfItemId && (
            <SourceBadge source="AB" />
          )}
        </div>

        {/* Hover overlay */}
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-start px-2 pb-2 opacity-100 translate-y-0 sm:opacity-0 sm:translate-y-1 transition-all duration-300 sm:group-hover:opacity-100 sm:group-hover:translate-y-0">
          {book.grimmoryStatus && (
            <span className="text-white/70 text-xs font-medium leading-tight">{statusLabel(book.grimmoryStatus)}</span>
          )}
          <span className="text-white text-base font-bold leading-tight line-clamp-2 mt-0.5" style={{ wordBreak: "break-word" }}>
            {book.title}
          </span>
          {book.author && <span className="text-white/70 text-xs mt-0.5">{book.author}</span>}
          <span className="text-white/60 text-xs mt-0.5">{book.userCount} {book.userCount === 1 ? "user" : "users"}</span>
          {book.lastModifiedAt && <span className="text-white/50 text-xs mt-1">Updated {formatRelativeTime(book.lastModifiedAt)}</span>}
        </div>
      </div>
      {activeAction && (
        <p className="mt-1.5 px-0.5 text-[10px] leading-snug text-on-surface-variant/70">
          {ACTION_EXPLANATIONS[activeAction]}
        </p>
      )}
    </Link>
  );
}

export function BookDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const bookId = Number(id);
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [writingId, setWritingId] = useState<"goodreads" | "hardcover" | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dismissingDuplicateId, setDismissingDuplicateId] = useState<number | null>(null);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [dismissingChaptarrId, setDismissingChaptarrId] = useState(false);
  const [chaptarrDismissError, setChaptarrDismissError] = useState<string | null>(null);
  const [coverFailed, setCoverFailed] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const detailMediaType = detail?.mediaType ?? "book";
  const isAudiobookDetail = detailMediaType === "audiobook";
  const fallbackListPath = isAudiobookDetail ? "/audiobooks" : "/books";
  const locationState = location.state as BookDetailLocationState | null;
  const returnTo = locationState?.returnTo ?? fallbackListPath;

  useEffect(() => {
    setCoverFailed(false);
  }, [detail?.coverUrl]);

  useEffect(() => {
    apiGet<AppSettings>("/api/settings").then((s) => {
      setAppSettings(s);
    }).catch(() => null);
  }, []);

  async function loadDetail() {
    if (!Number.isFinite(bookId)) {
      setError("Invalid book id.");
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await apiGet<BookDetail>(`/api/books/${bookId}`);
      setDetail(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadDetail(); }, [bookId]);

  async function writeGrimmoryId(relationshipId: number, source: "goodreads" | "hardcover") {
    setWritingId(source);
    setWriteError(null);
    try {
      await apiPost(`/api/books/${bookId}/relationships/${relationshipId}/write-grimmory-id`, { source });
      const updated = await apiGet<BookDetail>(`/api/books/${bookId}`);
      setDetail(updated);
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : String(err));
    } finally {
      setWritingId(null);
    }
  }

  async function deleteBook() {
    if (!detail || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await apiDelete(`/api/books/${bookId}`);
      void navigate(returnTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }

  async function dismissDuplicate(duplicateId: number) {
    setDismissingDuplicateId(duplicateId);
    setDuplicateError(null);
    try {
      await apiPost(`/api/books/${bookId}/duplicates/${duplicateId}/dismiss`, {});
      const updated = await apiGet<BookDetail>(`/api/books/${bookId}`);
      setDetail(updated);
    } catch (err) {
      setDuplicateError(err instanceof Error ? err.message : String(err));
    } finally {
      setDismissingDuplicateId(null);
    }
  }

  async function dismissChaptarrIdMismatch() {
    if (dismissingChaptarrId) return;
    setDismissingChaptarrId(true);
    setChaptarrDismissError(null);
    try {
      await apiPost(`/api/books/${bookId}/chaptarr-id-mismatch/dismiss`, {});
      const updated = await apiGet<BookDetail>(`/api/books/${bookId}`);
      setDetail(updated);
    } catch (err) {
      setChaptarrDismissError(err instanceof Error ? err.message : String(err));
    } finally {
      setDismissingChaptarrId(false);
    }
  }

  const detailSourceLinks = detail ? buildDetailSourceLinks(detail, appSettings) : null;

  return (
    <div className="min-h-screen">
      <div className="px-4 py-5 sm:px-6 lg:px-8">
        <Link
          to={returnTo}
          className="inline-flex items-center gap-2 text-sm font-medium text-on-surface-variant hover:text-on-surface transition-colors"
        >
          <ArrowLeft size={16} />
          {isAudiobookDetail ? "Audiobooks" : "Books"}
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-96 text-on-surface-variant text-sm">Loading book...</div>
      ) : error ? (
        <div className="px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl rounded-xl border border-error/25 bg-error/10 px-4 py-3 text-sm text-error">{error}</div>
        </div>
      ) : detail ? (
        <div>
          <div className="relative overflow-hidden border-b border-outline-variant/20">
            {detail.coverUrl && !coverFailed && (
              <img
                src={detail.coverUrl}
                alt=""
                aria-hidden="true"
                className="absolute inset-0 h-full w-full object-cover opacity-20 blur-2xl scale-110"
                onError={() => setCoverFailed(true)}
              />
            )}
            <div className="absolute inset-0 bg-[linear-gradient(90deg,var(--color-background)_0%,rgba(13,14,18,0.88)_48%,rgba(13,14,18,0.96)_100%)]" />

            <div className="relative px-4 pb-8 sm:px-6 lg:px-8">
              <div className="max-w-7xl mx-auto grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)] items-start">
                <div className="mx-auto lg:mx-0 w-48 sm:w-56 lg:w-60">
                  <div className={`${isAudiobookDetail ? "aspect-square" : "aspect-[2/3]"} rounded-2xl overflow-hidden bg-background-container-high shadow-2xl ring-1 ring-white/10`}>
                    {detail.coverUrl && !coverFailed ? (
                      <img src={detail.coverUrl} alt={detail.title} className="h-full w-full object-cover" onError={() => setCoverFailed(true)} />
                    ) : (
                      <div className="h-full w-full flex flex-col items-center justify-center p-6 text-center">
                        <BookOpen size={36} className="text-on-surface-variant mb-3" />
                        <span className="text-on-surface-variant text-sm leading-tight">{detail.title}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="min-w-0 pb-1">
                  <h1 className="font-headline font-extrabold text-4xl sm:text-5xl text-on-surface leading-tight max-w-4xl">
                    {detail.title}
                  </h1>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-on-surface-variant">
                    {detail.author && <span className="text-lg">{detail.author}</span>}
                    {detail.seriesName && (
                      <span className="text-sm">
                        {detail.seriesName}{detail.seriesNumber ? ` #${detail.seriesNumber}` : ""}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-4">
                    <SourcePresenceBadge label="Grimmory" present={!!detail.grimmoryBookId} href={detailSourceLinks?.grimmory} />
                    <SourcePresenceBadge label="Hardcover" present={!!detail.hardcoverBookId} expected={detail.hardcoverExpected} href={detailSourceLinks?.hardcover} />
                    <SourcePresenceBadge label="Goodreads" present={!!detail.goodreadsBookLink} expected={false} href={detailSourceLinks?.goodreads} />
                    <SourcePresenceBadge label="Chaptarr" present={!!detail.chaptarrBookId} href={detailSourceLinks?.chaptarr} />
                    {detail.mediaType === "audiobook" && (
                      <SourcePresenceBadge label="Audiobookshelf" present={!!detail.audiobookshelfItemId} href={detailSourceLinks?.audiobookshelf} />
                    )}
                  </div>

                  <div className="mt-6 flex flex-wrap gap-2">
                    {appSettings?.download.baseUrl && (
                      <button
                        onClick={() => {
                          const query = [detail.title, detail.author].filter(Boolean).join(" ");
                          const params = new URLSearchParams({ query, limit: "40", sort: "relevance", page: "1", content_type: detailMediaType === "audiobook" ? "audiobook" : "ebook", provider: "hardcover" });
                          window.open(`${appSettings.download.baseUrl.replace(/\/$/, "")}/search?${params.toString()}`, "_blank", "noopener,noreferrer");
                        }}
                        className="inline-flex items-center gap-2 rounded-lg bg-primary-dim hover:bg-primary px-3 py-2 text-sm font-semibold text-on-surface transition-colors"
                      >
                        <Search size={15} />
                        Search Shelfmark
                      </button>
                    )}
                    {confirmDelete ? (
                      <>
                        <button
                          onClick={() => void deleteBook()}
                          disabled={deleting}
                          className="inline-flex items-center gap-2 rounded-lg border border-error/35 bg-error/14 hover:bg-error/20 disabled:opacity-50 px-3 py-2 text-sm font-semibold text-error transition-colors"
                        >
                          {deleting ? "Deleting..." : "Are you sure?"}
                        </button>
                        <button
                          onClick={() => setConfirmDelete(false)}
                          disabled={deleting}
                          className="inline-flex items-center gap-2 rounded-lg border border-outline-variant/25 bg-background-container-high hover:bg-background-container-highest disabled:opacity-50 px-3 py-2 text-sm font-medium text-on-surface transition-colors"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(true)}
                        disabled={deleting}
                        className="inline-flex items-center gap-2 rounded-lg border border-error/30 bg-error/12 hover:bg-error/18 disabled:opacity-50 px-3 py-2 text-sm font-semibold text-error transition-colors"
                      >
                        Delete Book
                      </button>
                    )}
                  </div>
                  {confirmDelete && (
                    <p className="mt-2 text-xs text-on-surface-variant">
                      This only removes the book and its stored data from ShelfBridge. It does not delete anything from Grimmory, Hardcover, Goodreads, or Chaptarr.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="px-4 py-8 sm:px-6 lg:px-8">
            <div className="max-w-7xl mx-auto space-y-6">
              <div className="grid items-stretch gap-6 xl:grid-cols-[minmax(0,1fr)_450px]">
                <MatchSummaryPanel detail={detail} />

                <DrawerSection title="Sync" stretch>
                  <DrawerRow label="Media Type" value={mediaTypeLabel(detail.mediaType)} />
                  <DrawerRow label="Health" value={syncHealthLabel(detail.syncHealth)} highlight={detail.syncHealth === "synced"} />
                  <DrawerRow label="Match Confidence" value={detail.matchConfidence} />
                  <DrawerRow label="Needs ID Review" value={detail.needsIdReview ? "Yes" : "No"} />
                  <DrawerRow label="Has Superseded" value={detail.hasSuperseded ? "Yes" : "No"} />
                  <DrawerRow label="Last Sync" value={formatRelativeTime(detail.lastSyncAt)} />
                  <DrawerRow label="Last Modified" value={formatRelativeTime(detail.lastModifiedAt)} />
                </DrawerSection>
              </div>

              {detail.hasSuperseded && (
                <div className="bg-warning/10 border border-warning/20 rounded-xl px-4 py-3 text-xs leading-relaxed text-warning">
                  This book has superseded events. A write was skipped because the incoming data was older than what was already stored.
                </div>
              )}

              {detail.hasActiveChaptarrIdMismatch && (
                <section className="rounded-lg border border-warning/25 bg-warning/8 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
                      <div>
                        <div className="text-[11px] font-medium text-warning/80 uppercase tracking-wide">Bad Chaptarr ID</div>
                        <h2 className="mt-1 font-headline text-lg font-bold text-on-surface">Dismiss Chaptarr warning</h2>
                      </div>
                    </div>
                    <button
                      onClick={() => void dismissChaptarrIdMismatch()}
                      disabled={dismissingChaptarrId}
                      className="inline-flex items-center gap-2 rounded-lg border border-warning/30 bg-background-container px-3 py-2 text-sm font-semibold text-warning transition-colors hover:bg-background-container-high disabled:opacity-50"
                    >
                      <CheckCircle size={16} />
                      {dismissingChaptarrId ? "Dismissing..." : "Dismiss"}
                    </button>
                  </div>
                  {chaptarrDismissError && (
                    <div className="mt-3 rounded-lg border border-error/25 bg-error/10 px-3 py-2 text-xs text-error">
                      {chaptarrDismissError}
                    </div>
                  )}
                </section>
              )}

              {detail.duplicateCandidates.length > 0 && (
                <DuplicateReviewSection
                  bookId={detail.id}
                  candidates={detail.duplicateCandidates}
                  dismissingId={dismissingDuplicateId}
                  error={duplicateError}
                  onDismiss={(candidateId) => void dismissDuplicate(candidateId)}
                />
              )}

              <section>
                <div className="mb-3 text-[11px] font-medium text-on-surface-variant/60 uppercase tracking-wide">Users</div>
                <div className="grid gap-4 2xl:grid-cols-2">
                  {detail.relationships.map((relationship) => (
                    <UserBookRelationshipCard
                      key={relationship.id}
                      relationship={relationship}
                      writing={writingId}
                      error={writeError}
                      onWrite={(source) => void writeGrimmoryId(relationship.id, source)}
                    />
                  ))}
                </div>
              </section>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center h-96 text-on-surface-variant text-sm">Could not load book details.</div>
      )}
    </div>
  );
}

type RelTab = "hardcover" | "goodreads" | "grimmory" | "audiobookshelf";

function UserBookRelationshipCard({
  relationship,
  writing,
  error,
  onWrite
}: {
  relationship: BookRelationship;
  writing: "goodreads" | "hardcover" | null;
  error: string | null;
  onWrite: (source: "goodreads" | "hardcover") => void;
}) {
  const hasHardcover = !!relationship.hardcoverBookId;
  const hasGoodreads = relationship.goodreadsEnabled && !!(relationship.goodreadsBookLink || relationship.goodreadsShelf);
  const hasGrimmory = !!relationship.grimmoryBookId;
  const hasAbs = !!relationship.audiobookshelfItemId;

  const tabs: RelTab[] = [
    ...(hasHardcover ? ["hardcover" as RelTab] : []),
    ...(hasGoodreads ? ["goodreads" as RelTab] : []),
    ...(hasGrimmory ? ["grimmory" as RelTab] : []),
    ...(hasAbs ? ["audiobookshelf" as RelTab] : []),
  ];

  const [activeTab, setActiveTab] = useState<RelTab>(tabs[0] ?? "hardcover");

  const tabLabels: Record<RelTab, string> = { hardcover: "Hardcover", goodreads: "Goodreads", grimmory: "Grimmory", audiobookshelf: "Audiobookshelf" };

  const hasMore = relationship.needsIdReview
    || relationship.lastSyncDecision
    || relationship.shelfMemberships.length > 0;

  return (
    <section className="rounded-lg border border-outline-variant/20 bg-background-container p-3">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <h2 className="font-headline text-base font-bold text-on-surface truncate">{relationship.profileName}</h2>
        <div className="text-right text-xs text-on-surface-variant">
          <div className={relationship.syncHealth === "synced" ? "text-success font-semibold" : "text-on-surface"}>
            {syncHealthLabel(relationship.syncHealth)}
          </div>
          <div>{formatRelativeTime(relationship.lastModifiedAt)}</div>
        </div>
      </div>

      {tabs.length === 0 ? (
        <div className="text-xs text-on-surface-variant">No activity recorded for this user.</div>
      ) : (
        <>
          <div className="mb-3 flex gap-1 border-b border-outline-variant/20 pb-0">
            {tabs.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-t-md transition-colors ${
                  activeTab === tab
                    ? "bg-background-container-low text-on-surface border border-b-0 border-outline-variant/30"
                    : "text-on-surface-variant hover:text-on-surface"
                }`}
              >
                {tabLabels[tab]}
              </button>
            ))}
          </div>

          <div className="space-y-2">
            {activeTab === "hardcover" && hasHardcover && (
              <>
                <DrawerRow label="Media Type" value={mediaTypeLabel(relationship.hardcoverMediaType)} />
                <DrawerRow label="Edition ID" value={relationship.hardcoverEditionId ? String(relationship.hardcoverEditionId) : null} mono />
                <DrawerRow label="Edition Format" value={relationship.hardcoverEditionFormat} />
                <DrawerRow label="Status" value={hardcoverStatusLabel(relationship.hardcoverStatusId)} />
                <DrawerRow label="Rating" value={ratingValue(relationship.hardcoverRating)} />
                {hardcoverProgressValue(relationship) && (
                  <DrawerRow label="Progress" value={hardcoverProgressValue(relationship)} />
                )}
                <DrawerRow label="Last Read" value={formatDateShort(relationship.hardcoverLastReadDate)} />
                <DrawerRow label="Updated" value={formatRelativeTime(relationship.hardcoverUpdatedAt)} />
              </>
            )}
            {activeTab === "goodreads" && hasGoodreads && (
              <>
                <DrawerRow label="Shelf" value={relationship.goodreadsShelf} />
                <DrawerRow label="Rating" value={ratingValue(relationship.goodreadsRating)} />
                <DrawerRow label="Read At" value={formatDateShort(relationship.goodreadsReadAt)} />
                <DrawerRow label="Updated" value={formatDateShort(relationship.goodreadsUpdatedAt)} />
              </>
            )}
            {activeTab === "grimmory" && hasGrimmory && (
              <>
                <DrawerRow label="Media Type" value={mediaTypeLabel(relationship.grimmoryMediaType)} />
                <DrawerRow label="Status" value={statusLabel(relationship.grimmoryStatus)} />
                <DrawerRow label="Rating" value={grimmoryRatingValue(relationship.grimmoryRating)} />
                {progressValue(relationship.grimmoryProgress) && (
                  <DrawerRow label="Progress" value={progressValue(relationship.grimmoryProgress)} />
                )}
                <DrawerRow label="Primary File" value={relationship.grimmoryPrimaryFilePath} />
                <DrawerRow label="Last Read" value={formatDateShort(relationship.grimmoryLastReadTime)} />
                <DrawerRow label="Finished" value={formatDateShort(relationship.grimmoryDateFinished)} />
                {relationship.shelfMemberships.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {relationship.shelfMemberships.map((shelf) => (
                      <span key={shelf} className="inline-flex items-center gap-1 rounded-full border border-outline-variant/25 bg-background-container-high px-2 py-0.5 text-[11px] text-on-surface">
                        <Layers size={11} className="text-on-surface-variant" />
                        {shelf}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
            {activeTab === "audiobookshelf" && hasAbs && (
              <>
                <DrawerRow label="Item ID" value={relationship.audiobookshelfItemId} mono />
                <DrawerRow label="ASIN" value={relationship.audiobookshelfAsin} mono />
                {relationship.audiobookshelfDuration != null && (
                  <DrawerRow label="Duration" value={formatDuration(relationship.audiobookshelfDuration)} />
                )}
                {relationship.audiobookshelfProgress != null && (
                  <DrawerRow label="Progress" value={progressValue(relationship.audiobookshelfProgress)} />
                )}
                {relationship.audiobookshelfCurrentTime != null && relationship.audiobookshelfDuration != null && (
                  <DrawerRow label="Position" value={`${formatDuration(relationship.audiobookshelfCurrentTime)} / ${formatDuration(relationship.audiobookshelfDuration)}`} />
                )}
                <DrawerRow label="Finished" value={relationship.audiobookshelfIsFinished ? "Yes" : null} />
                <DrawerRow label="Updated" value={formatRelativeTime(relationship.audiobookshelfUpdatedAt)} />
                <DrawerRow label="File Path" value={relationship.audiobookshelfFilePath} />
                <DrawerRow
                  label="Runtime Validated"
                  value={relationship.audiobookshelfRuntimeValidated ? "Yes" : relationship.audiobookshelfItemId ? "No" : null}
                  highlight={relationship.audiobookshelfRuntimeValidated}
                />
                {relationship.audiobookshelfRuntimeDelta != null && (
                  <DrawerRow label="Runtime Delta" value={`${relationship.audiobookshelfRuntimeDelta}s`} />
                )}
              </>
            )}
          </div>
        </>
      )}

      {hasMore && (
        <details className="mt-3 group">
          <summary className="cursor-pointer select-none text-[11px] text-on-surface-variant hover:text-on-surface list-none flex items-center gap-1">
            <ChevronRight size={12} className="group-open:rotate-90 transition-transform" />
            More
          </summary>
          <div className="mt-2 space-y-3">
            <IdReviewActions relationship={relationship} writing={writing} error={error} onWrite={onWrite} />
            {relationship.shelfMemberships.length > 0 && activeTab !== "grimmory" && (
              <ShelfMemberships shelves={relationship.shelfMemberships} />
            )}
            {relationship.lastSyncDecision && (
              <DrawerSection title="Last Sync Decision">
                <div className="text-xs leading-relaxed text-on-surface-variant">{relationship.lastSyncDecision}</div>
              </DrawerSection>
            )}
          </div>
        </details>
      )}
    </section>
  );
}

function DuplicateReviewSection({
  bookId,
  candidates,
  dismissingId,
  error,
  onDismiss
}: {
  bookId: number;
  candidates: BookDuplicateCandidate[];
  dismissingId: number | null;
  error: string | null;
  onDismiss: (candidateId: number) => void;
}) {
  return (
    <section className="rounded-lg border border-warning/25 bg-warning/8 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[11px] font-medium text-warning/80 uppercase tracking-wide">Possible Duplicates</div>
          <h2 className="mt-1 font-headline text-lg font-bold text-on-surface">
            Review similar books
          </h2>
        </div>
        <span className="rounded-full border border-warning/25 bg-background-container px-2.5 py-1 text-xs font-semibold text-warning">
          {candidates.length}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {candidates.map((candidate) => (
          <div key={candidate.id} className="flex min-w-0 gap-3 rounded-md border border-outline-variant/20 bg-background-container p-2">
            <Link
              to={`/books/${candidate.id}`}
              state={{ returnTo: `/books/${bookId}` }}
              className="h-24 w-16 shrink-0 overflow-hidden rounded bg-background-container-high ring-1 ring-outline-variant/20"
            >
              {candidate.coverUrl ? (
                <img src={candidate.coverUrl} alt={candidate.title} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-on-surface-variant">
                  <BookOpen size={18} />
                </div>
              )}
            </Link>

            <div className="min-w-0 flex-1">
              <Link
                to={`/books/${candidate.id}`}
                state={{ returnTo: `/books/${bookId}` }}
                className="line-clamp-2 text-sm font-semibold leading-snug text-on-surface hover:text-primary"
              >
                {candidate.title}
              </Link>
              <div className="mt-1 text-xs text-on-surface-variant truncate">{candidate.author}</div>
              {candidate.seriesName && (
                <div className="mt-1 text-[11px] text-on-surface-variant/80 truncate">
                  {candidate.seriesName}{candidate.seriesNumber ? ` #${candidate.seriesNumber}` : ""}
                </div>
              )}
              <button
                onClick={() => onDismiss(candidate.id)}
                disabled={dismissingId === candidate.id}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-outline-variant/25 bg-background-container-high px-2.5 py-1.5 text-xs font-semibold text-on-surface hover:bg-background-container-highest disabled:opacity-50 transition-colors"
              >
                <Minus size={13} />
                {dismissingId === candidate.id ? "Dismissing..." : "Not duplicate"}
              </button>
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-error/25 bg-error/10 px-3 py-2 text-xs text-error">
          {error}
        </div>
      )}
    </section>
  );
}

function ratingValue(value: number | null | undefined, scale = 5): string | null {
  return value != null ? `${value}/${scale}` : null;
}

function grimmoryRatingValue(value: number | null | undefined): string | null {
  if (value == null) return null;
  return `${value}/10`;
}

function normalizePercent(value: number): number {
  if (!Number.isFinite(value)) return value;
  return value <= 1 ? value * 100 : value;
}

function progressValue(value: number | null | undefined): string | null {
  return value != null ? `${Math.round(normalizePercent(value))}%` : null;
}

function mediaTypeLabel(value: string | null | undefined): string | null {
  if (value === "book") return "Book";
  if (value === "audiobook") return "Audiobook";
  if (value === "ebook") return "Ebook";
  if (value === "physical") return "Physical";
  if (value === "mixed") return "Mixed";
  return null;
}

function hardcoverProgressValue(detail: BookRelationship): string | null {
  if (detail.hardcoverProgress != null) return `${Math.round(normalizePercent(detail.hardcoverProgress))}%`;
  if (detail.hardcoverProgressPages != null && detail.hardcoverPages != null) {
    return `${detail.hardcoverProgressPages}/${detail.hardcoverPages} pages`;
  }
  if (detail.hardcoverProgressPages != null) return `${detail.hardcoverProgressPages} pages`;
  return null;
}

function syncHealthLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const MATCH_TYPE_LABELS: Record<string, string> = {
  "hardcover_book_id":     "Matched to Hardcover by book ID",
  "hardcover_slug":        "Matched to Hardcover by slug",
  "goodreads_id":          "Matched to Hardcover via Goodreads ID",
  "isbn13":                "Matched by ISBN-13",
  "isbn10":                "Matched by ISBN-10",
  "title_author":          "Matched by title and author",
  "title_author_relaxed":  "Matched by title and author (approximate)",
};

const GOODREADS_MATCH_TYPE_LABELS: Record<string, string> = {
  "isbn13":       "Goodreads linked by ISBN-13",
  "isbn10":       "Goodreads linked by ISBN-10",
  "goodreads_id": "Goodreads linked by Goodreads ID",
  "title_author": "Goodreads linked by title and author",
};

function MatchSummaryPanel({ detail }: { detail: BookDetail }) {
  const bullets: string[] = [];

  for (const rel of detail.relationships) {
    if (rel.matchType && MATCH_TYPE_LABELS[rel.matchType]) {
      bullets.push(MATCH_TYPE_LABELS[rel.matchType]!);
    }
    if (rel.goodreadsMatchType && GOODREADS_MATCH_TYPE_LABELS[rel.goodreadsMatchType]) {
      bullets.push(GOODREADS_MATCH_TYPE_LABELS[rel.goodreadsMatchType]!);
    }
    if (rel.grimmoryGoodreadsId && rel.goodreadsBookId && rel.grimmoryGoodreadsId === rel.goodreadsBookId) {
      bullets.push("Grimmory linked via Goodreads ID in metadata");
    }
    if (rel.grimmoryHardcoverBookId) {
      bullets.push("Hardcover linked via Grimmory's stored Hardcover book ID");
    }
  }

  const uniqueBullets = [...new Set(bullets)];

  return (
    <DrawerSection title="How This Book Was Matched" stretch>
      {uniqueBullets.length > 0 ? (
        <ul className="space-y-1.5 mb-3">
          {uniqueBullets.map((bullet) => (
            <li key={bullet} className="flex items-start gap-2 text-xs text-on-surface">
              <span className="text-on-surface-variant mt-0.5 flex-shrink-0">→</span>
              {bullet}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-on-surface-variant mb-3">No match information available.</p>
      )}
      <details className="group">
        <summary className="cursor-pointer text-xs text-on-surface-variant hover:text-on-surface transition-colors select-none list-none flex items-center gap-1">
          <span className="group-open:rotate-90 transition-transform inline-block">›</span>
          Raw identifiers
        </summary>
        <div className="mt-2">
          <IdentifiersList detail={detail} />
        </div>
      </details>
    </DrawerSection>
  );
}

interface IdentifierEntry {
  label: string;
  value: string;
  sources: SourceKey[];
}

function identifierEntries(detail: BookDetail): IdentifierEntry[] {
  const entries: IdentifierEntry[] = [];
  if (detail.isbn13) entries.push({ label: "ISBN-13", value: detail.isbn13, sources: [] });
  if (detail.isbn10) entries.push({ label: "ISBN-10", value: detail.isbn10, sources: [] });
  if (detail.goodreadsBookId) entries.push({ label: "Goodreads ID", value: detail.goodreadsBookId, sources: ["GO"] });
  if (detail.hardcoverBookId) entries.push({ label: "Hardcover ID", value: String(detail.hardcoverBookId), sources: ["HA"] });
  if (detail.hardcoverSlug) entries.push({ label: "HC Slug", value: detail.hardcoverSlug, sources: ["HA"] });
  return entries;
}

function IdentifiersList({ detail }: { detail: BookDetail }) {
  const entries = identifierEntries(detail);
  if (entries.length === 0) return <p className="text-xs text-on-surface-variant">No identifiers available.</p>;
  return (
    <div className="space-y-1.5">
      {entries.map((entry) => {
        const matched = entry.sources.length >= 2;
        return (
          <div key={entry.label} className="flex items-center justify-between gap-3 text-xs">
            <span className="text-on-surface-variant flex-shrink-0">{entry.label}</span>
            <div className="flex items-center gap-1.5 min-w-0">
              <span className={`font-mono truncate ${matched ? "text-success font-semibold" : "text-on-surface"}`}>
                {entry.value}
              </span>
              {entry.sources.length > 0 && (
                <div className="flex gap-0.5 flex-shrink-0">
                  {entry.sources.map((src) => (
                    <SourceBadge key={src} source={src} matched={matched} />
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}


function IdReviewActions({
  relationship,
  writing,
  error,
  onWrite
}: {
  relationship: BookRelationship;
  writing: "goodreads" | "hardcover" | null;
  error: string | null;
  onWrite: (source: "goodreads" | "hardcover") => void;
}) {
  const canWriteGoodreads = Boolean(
    relationship.goodreadsBookId &&
    relationship.grimmoryGoodreadsId !== relationship.goodreadsBookId
  );
  const hardcoverSourceId = relationship.hardcoverBookId === null ? null : String(relationship.hardcoverBookId);
  const canWriteHardcover = Boolean(
    hardcoverSourceId &&
    relationship.grimmoryHardcoverBookId !== hardcoverSourceId
  );

  if (!relationship.needsIdReview && !canWriteGoodreads && !canWriteHardcover) return null;

  return (
    <DrawerSection title="ID Review">
      <div className="space-y-2">
        {relationship.matchType && (
          <DrawerRow label="Grimmory Match" value={relationship.matchType.replaceAll("_", " ")} />
        )}
        {relationship.goodreadsBookId && (
          <DrawerRow
            label="Goodreads IDs"
            value={`Source ${relationship.goodreadsBookId} / Grimmory ${relationship.grimmoryGoodreadsId ?? "unset"}`}
            mono
          />
        )}
        {hardcoverSourceId && (
          <DrawerRow
            label="Hardcover IDs"
            value={`Source ${hardcoverSourceId} / Grimmory ${relationship.grimmoryHardcoverBookId ?? "unset"}`}
            mono
          />
        )}
        {(canWriteGoodreads || canWriteHardcover) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {canWriteGoodreads && (
              <button
                disabled={writing !== null}
                onClick={() => onWrite("goodreads")}
                className="px-3 py-1.5 rounded-lg bg-primary-dim hover:bg-primary disabled:opacity-50 text-on-surface text-xs font-semibold transition-colors"
              >
                {writing === "goodreads" ? "Writing..." : "Set Goodreads as Main"}
              </button>
            )}
            {canWriteHardcover && (
              <button
                disabled={writing !== null}
                onClick={() => onWrite("hardcover")}
                className="px-3 py-1.5 rounded-lg bg-primary-dim hover:bg-primary disabled:opacity-50 text-on-surface text-xs font-semibold transition-colors"
              >
                {writing === "hardcover" ? "Writing..." : "Set Hardcover as Main"}
              </button>
            )}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-error/25 bg-error/10 px-2.5 py-2 text-[11px] text-error leading-snug">
            {error}
          </div>
        )}
      </div>
    </DrawerSection>
  );
}

function ShelfMemberships({ shelves }: { shelves: string[] }) {
  return (
    <DrawerSection title="Library Shelves">
      {shelves.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {shelves.map((shelf) => (
            <span key={shelf} className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/25 bg-background-container-high px-2.5 py-1 text-xs text-on-surface">
              <Layers size={12} className="text-on-surface-variant" />
              {shelf}
            </span>
          ))}
        </div>
      ) : (
        <div className="text-xs text-on-surface-variant">No shelf memberships recorded.</div>
      )}
    </DrawerSection>
  );
}

function SourceBadge({ source, matched = false }: { source: SourceKey; matched?: boolean }) {
  return (
    <span
      title={SOURCE_BADGE_LABEL[source]}
      className={`inline-flex min-w-[18px] items-center justify-center text-[9px] font-bold px-1 py-0.5 rounded shadow-[0_1px_4px_rgba(0,0,0,0.9)] ring-1 ${
        matched ? "bg-[#07130d]/90 text-success ring-success/50" : SOURCE_BADGE_STYLE[source]
      }`}
    >
      {source}
    </span>
  );
}

function buildDetailSourceLinks(detail: BookDetail, settings: AppSettings | null): {
  grimmory?: string;
  hardcover?: string;
  goodreads?: string;
  chaptarr?: string;
  audiobookshelf?: string;
} {
  const grimmoryBaseUrl = detail.relationships
    .map((relationship) => relationship.grimmoryBaseUrl?.trim() ?? "")
    .find(Boolean) ?? settings?.grimmory.baseUrl.trim();
  const chaptarrBaseUrl = settings?.chaptarr.baseUrl.trim();
  const audiobookshelfBaseUrl = settings?.audiobookshelf.baseUrl.trim();

  return {
    grimmory: grimmoryBaseUrl && detail.grimmoryBookId ? `${grimmoryBaseUrl.replace(/\/$/, "")}/book/${detail.grimmoryBookId}` : undefined,
    hardcover: detail.hardcoverSlug
      ? `https://hardcover.app/books/${detail.hardcoverSlug}`
      : detail.grimmoryHardcoverId
      ? `https://hardcover.app/books/${detail.grimmoryHardcoverId}`
      : detail.grimmoryHardcoverBookId
      ? `https://hardcover.app/books/${detail.grimmoryHardcoverBookId}`
      : undefined,
    goodreads: detail.goodreadsBookLink
      ?? (detail.grimmoryGoodreadsId ? `https://www.goodreads.com/book/show/${detail.grimmoryGoodreadsId}` : undefined),
    chaptarr: chaptarrBaseUrl && detail.chaptarrBookId ? `${chaptarrBaseUrl.replace(/\/$/, "")}/book/${detail.chaptarrBookId}` : undefined,
    audiobookshelf: audiobookshelfBaseUrl && detail.audiobookshelfItemId ? `${audiobookshelfBaseUrl.replace(/\/$/, "")}/item/${detail.audiobookshelfItemId}` : undefined
  };
}

function FilterChip({
  label,
  active,
  subtracting = false,
  count,
  onClick
}: {
  label: string;
  active: boolean;
  subtracting?: boolean;
  count?: number;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors border ${
        subtracting
          ? "bg-error/10 text-error border-error/40 hover:bg-error/15"
          : active
          ? "bg-primary-dim text-on-surface border-primary-dim"
          : "bg-background-container border-outline-variant/20 text-on-surface-variant hover:text-on-surface hover:border-outline-variant/40"
      }`}
      title={subtracting ? `${label} is being subtracted` : undefined}
    >
      {subtracting && <Minus size={14} strokeWidth={3} />}
      {label}
      {count !== undefined && (
        <span className={`text-xs ${subtracting ? "text-error/80" : active ? "text-on-surface" : "text-on-surface-variant/60"}`}>{count}</span>
      )}
    </button>
  );
}

function SourcePresenceBadge({
  label,
  present,
  expected = true,
  href
}: {
  label: string;
  present: boolean;
  expected?: boolean;
  href?: string;
}) {
  const sharedClassName = "inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border transition-colors";
  if (present) {
    if (href) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={`${sharedClassName} text-success bg-success/10 border-success/20 hover:bg-success/16 hover:border-success/35`}
          title={`Open ${label}`}
        >
          <span className="text-[10px]">✓</span>
          {label}
          <ExternalLink size={11} />
        </a>
      );
    }
    return (
      <span className={`${sharedClassName} text-success bg-success/10 border-success/20`}>
        <span className="text-[10px]">✓</span>
        {label}
      </span>
    );
  }
  if (!expected) {
    if (href) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={`${sharedClassName} text-on-surface-variant/70 bg-transparent border-outline-variant/30 hover:text-on-surface hover:border-outline-variant/50 hover:bg-background-container-high/50`}
          title={`Open ${label}`}
        >
          <span className="text-[10px]">—</span>
          {label}
          <ExternalLink size={11} />
        </a>
      );
    }
    return (
      <span className={`${sharedClassName} text-on-surface-variant/50 bg-transparent border-outline-variant/30`}>
        <span className="text-[10px]">—</span>
        {label}
      </span>
    );
  }
  return (
    <span className={`${sharedClassName} text-error bg-error/10 border-error/20`}>
      <span className="text-[10px]">✗</span>
      {label}
    </span>
  );
}

function DrawerSection({ title, children, stretch = false }: { title: string; children: React.ReactNode; stretch?: boolean }) {
  return (
    <div className={stretch ? "h-full flex flex-col" : undefined}>
      <div className="text-[11px] font-medium text-on-surface-variant/60 uppercase tracking-wide mb-2">{title}</div>
      <div className={`bg-background-container-low rounded-lg p-3 space-y-1.5 ${stretch ? "flex-1" : ""}`}>{children}</div>
    </div>
  );
}

function DrawerRow({ label, value, mono = false, highlight = false }: { label: string; value: string | null | undefined; mono?: boolean; highlight?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-on-surface-variant flex-shrink-0">{label}</span>
      <span className={`text-right ${mono ? "font-mono" : ""} ${highlight ? "text-success font-semibold" : "text-on-surface"}`}>{value}</span>
    </div>
  );
}
