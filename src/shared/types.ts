// ─── Connection status ────────────────────────────────────────────────────────

export type ConnectionStatus = "connected" | "failed" | "untested" | "missing";

// ─── Profiles ─────────────────────────────────────────────────────────────────

export interface Profile {
  id: number;
  displayName: string;
  enabled: boolean;
  createdAt: string;
  grimmory: GrimmoryConnectionView | null;
  hardcover: HardcoverConnectionView | null;
  goodreads: GoodreadsConnectionView | null;
  audiobookshelf: AudiobookshelfConnectionView | null;
  syncSettings: SyncSettings | null;
}

export interface ProfileSummary {
  id: number;
  displayName: string;
  enabled: boolean;
  createdAt: string;
  grimmoryStatus: ConnectionStatus;
  hardcoverStatus: ConnectionStatus;
  goodreadsLinked: boolean;
  syncEnabled: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: "success" | "error" | "running" | null;
  bookCount: number;
  missingCount: number;
}

export interface GrimmoryConnectionView {
  id: number;
  baseUrl: string;
  username: string;
  status: ConnectionStatus;
  lastTestedAt: string | null;
  lastSuccessAt: string | null;
}

export interface HardcoverConnectionView {
  id: number;
  hardcoverUsername: string | null;
  syncListId: number | null;
  syncListName: string | null;
  targetShelfName: string | null;
  status: ConnectionStatus;
  lastTestedAt: string | null;
  lastSuccessAt: string | null;
}

export interface AudiobookshelfConnectionView {
  id: number;
  absUsername: string | null;
  status: ConnectionStatus;
  lastTestedAt: string | null;
  lastSuccessAt: string | null;
}

export interface GoodreadsConnectionView {
  id: number;
  goodreadsUserId: string;
  goodreadsUsername: string | null;
  syncShelfName: string | null;
  targetShelfName: string | null;
  enabled: boolean;
  status: ConnectionStatus;
  lastTestedAt: string | null;
  lastSuccessAt: string | null;
}

export interface SyncSettings {
  id: number;
  syncStatusEnabled: boolean;
  syncProgressEnabled: boolean;
  syncShelvesEnabled: boolean;
  syncGoodreadsEnabled: boolean;
  syncGoodreadsStatusEnabled: boolean;
  syncGoodreadsShelvesEnabled: boolean;
  syncWriteTagEnabled: boolean;
  conflictStrategy: "latest_wins" | "grimmory_wins" | "hardcover_wins";
  scheduleEnabled: boolean;
  scheduleCron: string | null;
}

export interface SyncStatus {
  isRunning: boolean;
  runIds: number[];
  profileIds: number[];
  startedAt: string | null;
}

// ─── Shelf mappings ────────────────────────────────────────────────────────────

export interface ShelfMapping {
  id: number;
  profileId: number;
  source: "goodreads" | "hardcover";
  sourceStatus: string;
  grimmoryShelfId: number | null;
  grimmoryShelfName: string | null;
  grimmoryStatus: string | null;
  enabled: boolean;
}

// ─── Books ─────────────────────────────────────────────────────────────────────

export type ReadStatus =
  | "UNREAD"
  | "READING"
  | "READ"
  | "ABANDONED"
  | "RE_READING"
  | "PARTIALLY_READ"
  | "PAUSED"
  | "WONT_READ"
  | "UNSET";

export type SyncHealth = "synced" | "conflict" | "missing" | "superseded" | "pending" | "pending_download" | "error";
export type MatchConfidence = "high" | "medium" | "low" | "none";
export type MediaType = "book" | "physical" | "ebook" | "audiobook" | "mixed" | "unknown";

export interface BookSummary {
  id: number;
  title: string;
  author: string | null;
  coverUrl: string | null;
  mediaType: MediaType;
  userCount: number;
  profileIds: number[];
  grimmoryBookId: number | null;
  grimmoryStatus: ReadStatus | null;
  grimmoryRating: number | null;
  hardcoverBookId: number | null;
  hardcoverStatusId: number | null;
  hardcoverRating: number | null;
  goodreadsBookLink: string | null;
  goodreadsShelf: string | null;
  goodreadsRating: number | null;
  chaptarrBookId: number | null;
  audiobookshelfItemId: string | null;
  matchConfidence: MatchConfidence;
  syncHealth: SyncHealth;
  lastSyncAt: string | null;
  lastModifiedAt: string | null;
  hasSuperseded: boolean;
  needsIdReview: boolean;
}

export type BookDuplicateCandidate = Pick<BookSummary,
  "id" | "title" | "author" | "coverUrl" | "mediaType" | "grimmoryBookId" | "hardcoverBookId" | "goodreadsBookLink" | "chaptarrBookId"
> & {
  seriesName: string | null;
  seriesNumber: string | null;
  mergeEligible: boolean;
};

export interface BookRelationship {
  id: number;
  bookId: number;
  profileId: number;
  profileName: string;
  isbn13: string | null;
  isbn10: string | null;
  title: string;
  author: string | null;
  coverUrl: string | null;
  mediaType: MediaType;
  seriesName: string | null;
  seriesNumber: string | null;
  grimmoryBookId: number | null;
  grimmoryMediaType: MediaType;
  grimmoryStatus: ReadStatus | null;
  grimmoryRating: number | null;
  grimmoryIsbn13: string | null;
  grimmoryIsbn10: string | null;
  grimmoryHardcoverId: string | null;
  grimmoryHardcoverBookId: string | null;
  grimmoryGoodreadsId: string | null;
  grimmoryLastReadTime: string | null;
  grimmoryDateFinished: string | null;
  grimmoryProgress: number | null;
  grimmoryPrimaryFileId: number | null;
  grimmoryPrimaryFilePath: string | null;
  grimmoryBaseUrl: string | null;
  hardcoverBookId: number | null;
  hardcoverMediaType: MediaType;
  hardcoverStatusId: number | null;
  hardcoverRating: number | null;
  hardcoverIsbn13: string | null;
  hardcoverIsbn10: string | null;
  hardcoverEditionId: number | null;
  hardcoverEditionFormat: string | null;
  hardcoverUpdatedAt: string | null;
  hardcoverLastReadDate: string | null;
  hardcoverProgress: number | null;
  hardcoverProgressPages: number | null;
  hardcoverPages: number | null;
  hardcoverSlug: string | null;
  chaptarrBookId: number | null;
  chaptarrMediaType: MediaType;
  chaptarrPrimaryFilePath: string | null;
  audiobookshelfItemId: string | null;
  audiobookshelfDuration: number | null;
  audiobookshelfFilePath: string | null;
  audiobookshelfAsin: string | null;
  audiobookshelfRuntimeValidated: boolean;
  audiobookshelfRuntimeDelta: number | null;
  audiobookshelfProgress: number | null;
  audiobookshelfCurrentTime: number | null;
  audiobookshelfIsFinished: boolean;
  audiobookshelfUpdatedAt: string | null;
  goodreadsBookLink: string | null;
  goodreadsShelf: string | null;
  goodreadsRating: number | null;
  goodreadsBookId: string | null;
  goodreadsIsbn13: string | null;
  goodreadsIsbn10: string | null;
  goodreadsMatchType: string | null;
  goodreadsEnabled: boolean;
  goodreadsReadAt: string | null;
  goodreadsUpdatedAt: string | null;
  lastSyncDecision: string | null;
  matchType: string | null;
  matchConfidence: MatchConfidence;
  syncHealth: SyncHealth;
  lastSyncAt: string | null;
  lastModifiedAt: string | null;
  hasSuperseded: boolean;
  needsIdReview: boolean;
  shelfMemberships: string[];
}

export interface BookDetail extends BookSummary {
  isbn13: string | null;
  isbn10: string | null;
  seriesName: string | null;
  seriesNumber: string | null;
  hardcoverSlug: string | null;
  grimmoryHardcoverId: string | null;
  grimmoryHardcoverBookId: string | null;
  grimmoryGoodreadsId: string | null;
  goodreadsBookId: string | null;
  hardcoverExpected: boolean;
  hasActiveChaptarrIdMismatch: boolean;
  duplicateCandidates: BookDuplicateCandidate[];
  relationships: BookRelationship[];
}

export interface BooksPageResponse {
  items: BookSummary[];
  total: number;
  facets: BookFacets;
}

export interface BookFacets {
  status: Record<string, number>;
  statusAllCount: number;
  profiles: { profileId: number; displayName: string; count: number }[];
  allCount: number;
  sourceAllCount: number;
  hardcoverCount: number;
  goodreadsCount: number;
  onDiskCount: number;
  chaptarrInCount: number;
  chaptarrOutCount: number;
  addToChaptarrCount: number;
  grabInChaptarrCount: number;
  reviewInGrimmoryCount: number;
  fixChaptarrIdCount: number;
  idReviewCount: number;
  probableDuplicateCount: number;
  absRuntimeMismatchCount: number;
}

// ─── Sync ──────────────────────────────────────────────────────────────────────

export type SyncRunStatus = "running" | "success" | "error";
export type SyncEventType = "written" | "skipped_no_change" | "superseded" | "conflict" | "missing_match" | "credential_failure" | "api_failure";

export interface SyncRun {
  id: number;
  profileId: number | null;
  profileName: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: SyncRunStatus;
  summary: string;
  error: string | null;
  dryRun: boolean;
  changesWritten: number;
  changesSkipped: number;
  changesSuperseded: number;
}

export interface SyncRunDetail extends SyncRun {
  events: SyncEvent[];
}

export interface SyncEvent {
  id: number;
  syncRunId: number;
  profileId: number | null;
  bookTitle: string | null;
  eventType: SyncEventType;
  direction: string | null;
  decision: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface SyncHistoryPageResponse {
  results: SyncRun[];
  pageInfo: {
    page: number;
    pageSize: number;
    total: number;
    pages: number;
  };
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export interface DashboardResponse {
  stats: {
    totalBooks: number;
    missingInGrimmory: number;
    needsReview: number;
    pendingDownload: number;
  };
  recentlyAdded: BookSummary[];
  recentActivity: SyncRun[];
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export interface AppSettings {
  general: {
    trustProxy: boolean;
  };
  grimmory: {
    baseUrl: string;
    addMenuLink: boolean;
  };
  download: {
    baseUrl: string;
    addMenuLink: boolean;
  };
  sync: {
    startupSyncEnabled: boolean;
    historyRetentionDays: number;
    conflictStrategy: "latest_wins" | "grimmory_wins" | "hardcover_wins";
  };
  chaptarr: {
    baseUrl: string;
    apiKeyConfigured: boolean;
  };
  audiobookshelf: {
    baseUrl: string;
  };
}

export interface JobInfo {
  id: string;
  name: string;
  intervalDescription: string;
  nextRunAt: string | null;
  nextRunLabel?: string;
  lastRunAt: string | null;
  lastRunStatus: "success" | "error" | null;
  isRunning: boolean;
}

export interface AboutInfo {
  version: string;
  buildChannel: string;
  commitSha: string;
  dataDir: string;
  tz: string;
  dbVersion: number;
}

// ─── Hardcover lists & shelf mappings ─────────────────────────────────────────

export interface HardcoverList {
  id: number;
  name: string;
  slug: string | null;
}

export interface GrimmoryShelfSummary {
  id: number;
  name: string;
}

export interface HardcoverListMapping {
  id: number;
  hardcoverListId: number;
  hardcoverListName: string;
  grimmoryShelfName: string;
  grimmoryShelfId: number | null;
  enabled: boolean;
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  meta?: unknown;
}

export interface LogsPageResponse {
  results: LogEntry[];
  pageInfo: {
    page: number;
    pageSize: number;
    pages: number;
    total: number;
  };
}

// ─── API helpers ──────────────────────────────────────────────────────────────

export interface TestResult {
  ok: boolean;
  message: string;
  username?: string;
}

export interface GrimmoryShelf {
  id: number;
  name: string;
}

export interface GoodreadsShelfMapping {
  id: number;
  goodreadsShelfName: string;
  grimmoryShelfName: string;
  grimmoryShelfId: number | null;
  enabled: boolean;
}
