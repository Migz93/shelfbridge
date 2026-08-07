import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, ClipboardCopy, Eye, Pause, Play, Pencil, RefreshCw, X } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { notifySettingsChanged } from "../lib/settingsEvents";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { useModalA11y } from "../lib/useModalA11y";
import { formatRelativeTime } from "../lib/utils";
import { Field, SaveBar, SectionCard, SelectInput, TextInput, ToggleField } from "../components/FormControls";
import type { AboutInfo, AppSettings, JobInfo, LogEntry, LogsPageResponse, TestResult } from "../../shared/types";

type Tab = "general" | "grimmory" | "download" | "chaptarr" | "audiobookshelf" | "logs" | "jobs" | "about";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "grimmory", label: "Grimmory" },
  { id: "download", label: "Shelfmark" },
  { id: "chaptarr", label: "Chaptarr" },
  { id: "audiobookshelf", label: "Audiobookshelf" },
  { id: "logs", label: "Logs" },
  { id: "jobs", label: "Jobs" },
  { id: "about", label: "About" }
];

export default function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (TABS.some((t) => t.id === searchParams.get("tab")) ? searchParams.get("tab") : "general") as Tab;
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function setTab(tab: Tab) { setSearchParams({ tab }, { replace: true }); }

  async function loadSettings() {
    setLoading(true);
    try {
      const result = await apiGet<AppSettings>("/api/settings");
      setSettings(result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadSettings(); }, []);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="font-headline font-bold text-2xl text-on-surface">Settings</h1>
      </div>

      {/* Mobile: dropdown */}
      <div className="md:hidden mb-6">
        <select
          value={activeTab}
          onChange={(e) => setTab(e.target.value as Tab)}
          className="w-full bg-background-container-high border border-outline-variant/20 rounded-xl px-4 py-2.5 text-sm font-medium text-on-surface focus:outline-none focus:border-primary/50"
        >
          {TABS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </div>

      {/* Desktop: pill bar */}
      <div className="hidden md:block mb-6">
        <div className="flex p-1 bg-background-container-high rounded-xl gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 text-sm font-medium rounded-lg px-4 py-2 transition-all whitespace-nowrap ${
                activeTab === t.id
                  ? "bg-background-container text-on-surface shadow-sm"
                  : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm mb-4">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="text-on-surface-variant text-sm">Loading settings...</div>
        </div>
      ) : settings ? (
        <>
          {activeTab === "general" && <GeneralTab settings={settings} onSave={loadSettings} />}
          {activeTab === "grimmory" && <GrimmoryTab settings={settings} onSave={loadSettings} />}
          {activeTab === "download" && <DownloadTab settings={settings} onSave={loadSettings} />}
          {activeTab === "chaptarr" && <ChaptarrTab settings={settings} onSave={loadSettings} />}
          {activeTab === "audiobookshelf" && <AudiobookshelfTab settings={settings} onSave={loadSettings} />}
          {activeTab === "logs" && <LogsTab />}
          {activeTab === "jobs" && <JobsTab />}
          {activeTab === "about" && <AboutTab />}
        </>
      ) : null}
    </div>
  );
}

function GeneralTab({ settings, onSave }: { settings: AppSettings; onSave: () => Promise<void> }) {
  const [generalForm, setGeneralForm] = useState(settings.general);
  const [syncForm, setSyncForm] = useState(settings.sync);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setGeneralForm(settings.general);
    setSyncForm(settings.sync);
  }, [settings]);

  async function save() {
    setSaving(true); setError(null); setSuccess(false);
    try {
      await apiPatch("/api/settings", { general: generalForm, sync: syncForm });
      setSuccess(true);
      notifySettingsChanged();
      await onSave();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-5">
      <SectionCard title="Network" description="Reverse proxy support for deployments behind Nginx, Traefik, Caddy, or similar.">
        <div className="text-xs text-on-surface-variant">
          Changes to proxy support require a container restart to take effect.
        </div>
        <ToggleField
          label="Trust Proxy"
          hint="Use the real client IP from X-Forwarded-For headers for rate limiting."
          checked={generalForm.trustProxy}
          onChange={(v) => setGeneralForm((f) => ({ ...f, trustProxy: v }))}
        />
        <SaveBar saving={saving} success={success} error={error} onSave={() => void save()} label="Save Network" />
      </SectionCard>
      <SectionCard title="Sync Behaviour" description="Global defaults for how ShelfBridge syncs data.">
        <ToggleField
          label="Startup Sync"
          hint="Run a profile sync automatically when ShelfBridge starts. Only fires if the sync interval is not set to Disabled."
          checked={syncForm.startupSyncEnabled}
          onChange={(v) => setSyncForm((f) => ({ ...f, startupSyncEnabled: v }))}
        />
        <Field label="Default Conflict Strategy" hint="How to resolve conflicts when both sides have changed.">
          <SelectInput value={syncForm.conflictStrategy} onChange={(v) => setSyncForm((f) => ({ ...f, conflictStrategy: v as typeof syncForm.conflictStrategy }))}>
            <option value="latest_wins">Latest update wins</option>
            <option value="grimmory_wins">Grimmory always wins</option>
            <option value="hardcover_wins">Hardcover always wins</option>
          </SelectInput>
        </Field>
        <SaveBar saving={saving} success={success} error={error} onSave={() => void save()} label="Save Sync" />
      </SectionCard>
      <SectionCard title="History Retention" description="How long sync run history is kept before the Maintenance job removes it.">
        <Field label="Retention Period (days)" hint="Sync runs older than this many days will be pruned by the daily Maintenance job.">
          <TextInput
            type="number"
            value={String(syncForm.historyRetentionDays)}
            onChange={(v) => {
              const n = parseInt(v, 10);
              if (!Number.isNaN(n) && n > 0) setSyncForm((f) => ({ ...f, historyRetentionDays: n }));
            }}
            placeholder="7"
          />
        </Field>
        <SaveBar saving={saving} success={success} error={error} onSave={() => void save()} label="Save History" />
      </SectionCard>
    </div>
  );
}

function GrimmoryTab({ settings, onSave }: { settings: AppSettings; onSave: () => Promise<void> }) {
  const [form, setForm] = useState(settings.grimmory);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const isEmpty = !form.baseUrl.trim();

  async function save() {
    setSaving(true); setError(null); setSuccess(false);
    try {
      await apiPatch("/api/settings", { grimmory: form });
      setSuccess(true);
      notifySettingsChanged();
      await onSave();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  async function test() {
    setTesting(true); setTestResult(null);
    try {
      const result = await apiPost<TestResult>("/api/settings/grimmory/test", { baseUrl: form.baseUrl });
      setTestResult(result);
    } catch (e) { setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) }); }
    finally { setTesting(false); }
  }

  return (
    <div className="space-y-5">
      {isEmpty && (
        <div className="bg-warning/10 border border-warning/30 rounded-xl px-4 py-3 text-warning text-sm">
          Enter the global Grimmory base URL before adding users. All profiles will use this URL unless overridden.
        </div>
      )}
      <SectionCard title="Grimmory Server" description="Global connection settings for your Grimmory instance.">
        <Field label="Base URL" hint="Example: http://grimmory:8080">
          <TextInput
            value={form.baseUrl}
            onChange={(v) => setForm((f) => ({ ...f, baseUrl: v }))}
            placeholder="http://grimmory:8080"
          />
        </Field>
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-outline-variant/15">
          <div className="flex items-center gap-3 flex-wrap">
            <button
              disabled={testing || !form.baseUrl}
              onClick={() => void test()}
              className="bg-background-container-high hover:bg-background-bright disabled:opacity-50 text-on-surface text-sm font-medium rounded-xl px-4 py-2 transition-colors border border-outline-variant/20"
            >
              {testing ? "Testing..." : "Test Server"}
            </button>
            {testResult && (
              <span className={`text-xs font-medium ${testResult.ok ? "text-success" : "text-error"}`}>
                {testResult.message}
              </span>
            )}
          </div>
          <SaveBar saving={saving} success={success} error={error} onSave={() => void save()} label="Save Grimmory" />
        </div>
      </SectionCard>
    </div>
  );
}

function DownloadTab({ settings, onSave }: { settings: AppSettings; onSave: () => Promise<void> }) {
  const [form, setForm] = useState(settings.download);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true); setError(null); setSuccess(false);
    try {
      await apiPatch("/api/settings", { download: form });
      setSuccess(true);
      notifySettingsChanged();
      await onSave();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-5">
      <SectionCard title="Shelfmark" description="Base URL for your Shelfmark instance.">
        <Field label="Base URL">
          <TextInput
            value={form.baseUrl}
            onChange={(v) => setForm((f) => ({ ...f, baseUrl: v }))}
            placeholder="https://shelfmark.example.com"
          />
        </Field>
        <SaveBar saving={saving} success={success} error={error} onSave={() => void save()} label="Save Shelfmark" />
      </SectionCard>
    </div>
  );
}

// ─── Chaptarr tab ─────────────────────────────────────────────────────────────

function ChaptarrTab({ settings, onSave }: { settings: AppSettings; onSave: () => Promise<void> }) {
  const [form, setForm] = useState({
    baseUrl: settings.chaptarr.baseUrl,
    apiKey: "",
  });
  const [apiKeyConfigured, setApiKeyConfigured] = useState(settings.chaptarr.apiKeyConfigured);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const isConfigured = !!(form.baseUrl.trim() && (form.apiKey.trim() || apiKeyConfigured));

  useEffect(() => {
    setForm({ baseUrl: settings.chaptarr.baseUrl, apiKey: "" });
    setApiKeyConfigured(settings.chaptarr.apiKeyConfigured);
  }, [settings]);

  async function save() {
    setSaving(true); setSaveError(null); setSuccess(false);
    try {
      await apiPatch("/api/settings", {
        chaptarr: {
          baseUrl: form.baseUrl,
          ...(form.apiKey.trim() ? { apiKey: form.apiKey } : {})
        }
      });
      setSuccess(true);
      if (form.apiKey.trim()) {
        setApiKeyConfigured(true);
        setForm((f) => ({ ...f, apiKey: "" }));
      }
      notifySettingsChanged();
      await onSave();
    } catch (e) { setSaveError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  async function test() {
    setTesting(true); setTestResult(null);
    try {
      const result = await apiPost<TestResult>("/api/settings/chaptarr/test", {
        baseUrl: form.baseUrl,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey } : {})
      });
      setTestResult(result);
    } catch (e) { setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) }); }
    finally { setTesting(false); }
  }

  return (
    <div className="space-y-5">
      <SectionCard title="Chaptarr Connection" description="URL and API key for your Chaptarr instance. Found under Settings → General in Chaptarr.">
        <Field label="Base URL" hint="Example: http://chaptarr:8787">
          <TextInput
            value={form.baseUrl}
            onChange={(v) => setForm((f) => ({ ...f, baseUrl: v }))}
            placeholder="http://chaptarr:8787"
          />
        </Field>
        <Field label="API Key" hint="Copy from Chaptarr → Settings → General → Security">
          <input
            type="password"
            autoComplete="off"
            value={form.apiKey}
            onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
            placeholder={apiKeyConfigured ? "••••••••••••••" : "Paste your API key"}
            className="w-full bg-background-container-low border border-outline-variant/30 rounded-xl px-4 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none focus:border-primary/50 transition-colors font-mono"
          />
        </Field>
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-outline-variant/15 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <button
              disabled={testing || !isConfigured}
              onClick={() => void test()}
              className="bg-background-container-high hover:bg-background-bright disabled:opacity-50 text-on-surface text-sm font-medium rounded-xl px-4 py-2 transition-colors border border-outline-variant/20"
            >
              {testing ? "Testing..." : "Test Connection"}
            </button>
            {testResult && (
              <span className={`text-xs font-medium ${testResult.ok ? "text-success" : "text-error"}`}>
                {testResult.message}
              </span>
            )}
          </div>
          <SaveBar saving={saving} success={success} error={saveError} onSave={() => void save()} label="Save Chaptarr" />
        </div>
      </SectionCard>

    </div>
  );
}

// ─── Audiobookshelf tab ───────────────────────────────────────────────────────

function AudiobookshelfTab({ settings, onSave }: { settings: AppSettings; onSave: () => Promise<void> }) {
  const [form, setForm] = useState({ baseUrl: settings.audiobookshelf.baseUrl });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  useEffect(() => {
    setForm({ baseUrl: settings.audiobookshelf.baseUrl });
  }, [settings]);

  async function save() {
    setSaving(true); setSaveError(null); setSuccess(false);
    try {
      await apiPatch("/api/settings", { audiobookshelf: { baseUrl: form.baseUrl } });
      setSuccess(true);
      notifySettingsChanged();
      await onSave();
    } catch (e) { setSaveError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  async function test() {
    setTesting(true); setTestResult(null);
    try {
      const result = await apiPost<TestResult>("/api/settings/audiobookshelf/test", { baseUrl: form.baseUrl });
      setTestResult(result);
    } catch (e) { setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) }); }
    finally { setTesting(false); }
  }

  return (
    <div className="space-y-5">
      <SectionCard title="Audiobookshelf Server" description="Global base URL for your Audiobookshelf instance. Each user configures their own API key under their profile.">
        <Field label="Base URL" hint="Example: http://audiobookshelf:13378">
          <TextInput
            value={form.baseUrl}
            onChange={(v) => { setForm((f) => ({ ...f, baseUrl: v })); setTestResult(null); }}
            placeholder="http://audiobookshelf:13378"
          />
        </Field>
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-outline-variant/15 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <button
              disabled={testing || !form.baseUrl.trim()}
              onClick={() => void test()}
              className="bg-background-container-high hover:bg-background-bright disabled:opacity-50 text-on-surface text-sm font-medium rounded-xl px-4 py-2 transition-colors border border-outline-variant/20"
            >
              {testing ? "Testing..." : "Test Server"}
            </button>
            {testResult && (
              <span className={`text-xs font-medium ${testResult.ok ? "text-success" : "text-error"}`}>
                {testResult.message}
              </span>
            )}
          </div>
          <SaveBar saving={saving} success={success} error={saveError} onSave={() => void save()} label="Save Audiobookshelf" />
        </div>
      </SectionCard>
    </div>
  );
}

// ─── Logs tab ─────────────────────────────────────────────────────────────────

type LogFilter = "debug" | "info" | "warn" | "error";

const LEVEL_BADGE: Record<LogFilter, string> = {
  debug: "text-on-surface-variant bg-background-container",
  info:  "text-on-surface bg-primary-dim",
  warn:  "text-warning bg-warning/10",
  error: "text-error bg-error/10"
};

function LogsTab() {
  const [data, setData] = useState<LogsPageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<LogFilter>("debug");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [activeLog, setActiveLog] = useState<LogEntry | null>(null);
  const logModalRef = useModalA11y(activeLog !== null, () => setActiveLog(null));
  const [copied, setCopied] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        filter,
        page: String(page),
        pageSize: String(pageSize),
        ...(debouncedSearch ? { search: debouncedSearch } : {})
      });
      const result = await apiGet<LogsPageResponse>(`/api/settings/logs?${params.toString()}`);
      setData(result);
    } finally {
      setLoading(false);
    }
  }, [filter, page, pageSize, debouncedSearch]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (autoRefresh) {
      intervalRef.current = setInterval(() => { void load(); }, 5000);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, load]);

  useEffect(() => { setPage(1); }, [filter, pageSize]);

  function copyLog(entry: LogEntry) {
    const text = `${entry.timestamp} [${entry.level.toUpperCase()}]: ${entry.message}${entry.meta !== undefined ? " " + JSON.stringify(entry.meta) : ""}`;
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const results = data?.results ?? [];
  const pageInfo = data?.pageInfo;

  return (
    <>
      {/* Detail modal */}
      {activeLog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
          onClick={() => setActiveLog(null)}
        >
          <div
            ref={logModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="log-details-title"
            tabIndex={-1}
            className="bg-background-container-high rounded-2xl border border-outline-variant/30 w-full max-w-2xl p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 id="log-details-title" className="font-semibold text-on-surface">Log Details</h3>
              <button onClick={() => setActiveLog(null)} className="text-on-surface-variant hover:text-on-surface">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex gap-2">
                <span className="text-on-surface-variant w-24 flex-shrink-0">Timestamp</span>
                <span className="text-on-surface font-mono">{activeLog.timestamp}</span>
              </div>
              <div className="flex gap-2 items-center">
                <span className="text-on-surface-variant w-24 flex-shrink-0">Level</span>
                <span className={`px-2 py-0.5 rounded text-xs font-semibold uppercase ${LEVEL_BADGE[activeLog.level]}`}>{activeLog.level}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-on-surface-variant w-24 flex-shrink-0">Message</span>
                <span className="text-on-surface break-all">{activeLog.message}</span>
              </div>
              {activeLog.meta !== undefined && (
                <div className="flex gap-2">
                  <span className="text-on-surface-variant w-24 flex-shrink-0">Meta</span>
                  <pre className="text-on-surface font-mono text-xs bg-background-container rounded-lg p-3 overflow-auto max-h-64 flex-1 whitespace-pre-wrap break-all">
                    {JSON.stringify(activeLog.meta, null, 2)}
                  </pre>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => copyLog(activeLog)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary-dim text-on-surface text-sm hover:bg-primary transition-colors"
              >
                <ClipboardCopy size={14} />
                {copied ? "Copied!" : "Copy"}
              </button>
              <button
                onClick={() => setActiveLog(null)}
                className="px-3 py-1.5 rounded-lg bg-background-container text-on-surface text-sm hover:bg-background-container-high transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <SectionCard title="Logs" description="Application logs. Also written to the data directory on the host.">
        {data?.windowed && (
          <p className="text-xs text-on-surface-variant">
            Showing a recent window of up to 500 entries from the latest 1 MB of the current log file.
          </p>
        )}
        {/* Controls */}
        <div className="flex flex-wrap gap-2 items-center">
          <input
            type="text"
            placeholder="Search logs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-[160px] px-3 py-1.5 rounded-lg bg-background-container border border-outline-variant/30 text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary/50"
          />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as LogFilter)}
            className="px-3 py-1.5 rounded-lg bg-background-container border border-outline-variant/30 text-sm text-on-surface focus:outline-none focus:border-primary/50"
          >
            <option value="debug">Debug (all)</option>
            <option value="info">Info+</option>
            <option value="warn">Warn+</option>
            <option value="error">Error only</option>
          </select>
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            className="px-3 py-1.5 rounded-lg bg-background-container border border-outline-variant/30 text-sm text-on-surface focus:outline-none focus:border-primary/50"
          >
            <option value={25}>25 / page</option>
            <option value={50}>50 / page</option>
            <option value={100}>100 / page</option>
          </select>
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors ${
              autoRefresh
                ? "bg-primary-dim border-primary-dim text-on-surface"
                : "bg-background-container border-outline-variant/30 text-on-surface-variant"
            }`}
          >
            {autoRefresh ? <Pause size={14} /> : <Play size={14} />}
            {autoRefresh ? "Pause" : "Resume"}
          </button>
          <button
            onClick={() => void load()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-background-container border border-outline-variant/30 text-sm text-on-surface-variant hover:text-on-surface transition-colors"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {/* Log table */}
        <div className="bg-background-container-low rounded-xl border border-outline-variant/20 overflow-hidden">
          {loading && !data ? (
            <div className="flex items-center justify-center h-48 text-on-surface-variant text-sm">Loading logs...</div>
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-on-surface-variant text-sm">
              No log entries match the current filter.
              {filter !== "debug" && (
                <button onClick={() => setFilter("debug")} className="text-primary text-xs hover:underline">Show all logs</button>
              )}
            </div>
          ) : (
            <div className="divide-y divide-outline-variant/10">
              {results.map((entry, i) => (
                <div key={i} className="flex items-start gap-3 px-4 py-2 text-xs font-mono hover:bg-background-container/50 group">
                  <span className="text-on-surface-variant/60 flex-shrink-0 w-[7.5rem] truncate pt-0.5">
                    {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                  <span className={`flex-shrink-0 w-12 text-center px-1 py-0.5 rounded text-[10px] font-bold uppercase ${LEVEL_BADGE[entry.level]}`}>
                    {entry.level}
                  </span>
                  <span className="text-on-surface flex-1 break-all leading-relaxed">{entry.message}</span>
                  <div className="flex gap-1 flex-shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                    {entry.meta !== undefined && (
                      <button
                        onClick={() => setActiveLog(entry)}
                        className="p-1 text-on-surface-variant hover:text-primary transition-colors"
                        title="View details"
                      >
                        <Eye size={13} />
                      </button>
                    )}
                    <button
                      onClick={() => copyLog(entry)}
                      className="p-1 text-on-surface-variant hover:text-primary transition-colors"
                      title="Copy"
                    >
                      <ClipboardCopy size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pagination */}
        {pageInfo && pageInfo.total > 0 && (
          <div className="flex flex-col gap-3 text-xs text-on-surface-variant sm:flex-row sm:items-center sm:justify-between">
            <span>
              {pageInfo.total === 0
                ? "No results"
                : `${(pageInfo.page - 1) * pageInfo.pageSize + 1}–${Math.min(pageInfo.page * pageInfo.pageSize, pageInfo.total)} of ${pageInfo.total}`}
            </span>
            <div className="flex gap-1">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="p-1.5 rounded-lg bg-background-container disabled:opacity-40 hover:bg-background-container-high transition-colors"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="px-2 py-1">Page {page} / {pageInfo.pages}</span>
              <button
                disabled={page >= pageInfo.pages}
                onClick={() => setPage((p) => p + 1)}
                className="p-1.5 rounded-lg bg-background-container disabled:opacity-40 hover:bg-background-container-high transition-colors"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </SectionCard>
    </>
  );
}

// Preset interval values for the Sync job (in minutes). 0 = Disabled.
const PROFILE_SYNC_PRESETS: { value: number; label: string }[] = [
  { value: 0,    label: "Disabled" },
  { value: 1,    label: "Every minute" },
  { value: 2,    label: "Every 2 minutes" },
  { value: 5,    label: "Every 5 minutes" },
  { value: 10,   label: "Every 10 minutes" },
  { value: 15,   label: "Every 15 minutes" },
  { value: 30,   label: "Every 30 minutes" },
  { value: 60,   label: "Every hour" },
  { value: 120,  label: "Every 2 hours" },
  { value: 240,  label: "Every 4 hours" },
  { value: 360,  label: "Every 6 hours" },
  { value: 720,  label: "Every 12 hours" },
  { value: 1440, label: "Every 24 hours" }
];

const JOBS_FAST_REFRESH_MS = 2_500;
const JOBS_IDLE_REFRESH_MS = 15_000;
const JOBS_FAST_REFRESH_WINDOW_MS = 30_000;

function JobsTab() {
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [editingJob, setEditingJob] = useState<JobInfo | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const scheduleModalRef = useModalA11y(editingJob !== null, () => setEditingJob(null));
  const [saving, setSaving] = useState(false);
  const [fastRefreshUntil, setFastRefreshUntil] = useState<number | null>(null);

  async function load(background = false) {
    setLoading((current) => current || !background);
    try {
      const result = await apiGet<JobInfo[]>("/api/settings/jobs");
      setJobs(result);
    } finally {
      setLoading(false);
    }
  }

  const hasRunningJob = jobs.some((job) => job.isRunning);
  const shouldUseFastRefresh = hasRunningJob || (fastRefreshUntil !== null && fastRefreshUntil > Date.now());
  const getIntervalMs = useCallback(
    () => (shouldUseFastRefresh ? JOBS_FAST_REFRESH_MS : JOBS_IDLE_REFRESH_MS),
    [shouldUseFastRefresh]
  );
  const { refreshNow } = useLiveRefresh(async () => { await load(true); }, { getIntervalMs });

  async function runJob(id: string) {
    setRunningId(id);
    setFastRefreshUntil(Date.now() + JOBS_FAST_REFRESH_WINDOW_MS);
    try {
      await apiPost(`/api/settings/jobs/${id}/run`);
      await refreshNow();
    } finally {
      setRunningId(null);
    }
  }

  function openEdit(job: JobInfo) {
    if (job.intervalDescription === "Disabled") {
      setEditValue("0");
      setEditingJob(job);
      return;
    }
    const match = job.intervalDescription.match(/Every (\d+)/i);
    const current = match ? Number(match[1]) : 60;
    const inMinutes = job.intervalDescription.toLowerCase().includes("hour") ? current * 60 : current;
    const closest = PROFILE_SYNC_PRESETS.find((p) => p.value === inMinutes) ?? PROFILE_SYNC_PRESETS.find((p) => p.value === 60)!;
    setEditValue(String(closest.value));
    setEditingJob(job);
  }

  async function saveSchedule() {
    if (!editingJob) return;
    setSaving(true);
    try {
      await apiPatch(`/api/settings/jobs/${editingJob.id}`, { intervalMinutes: Number(editValue) });
      setEditingJob(null);
      setFastRefreshUntil(Date.now() + JOBS_FAST_REFRESH_WINDOW_MS);
      await refreshNow();
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <>
      {/* Edit schedule modal */}
      {editingJob && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div
            ref={scheduleModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-schedule-title"
            tabIndex={-1}
            className="bg-background-container rounded-2xl border border-outline-variant/20 w-full max-w-md shadow-2xl"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-outline-variant/20">
              <h2 id="edit-schedule-title" className="font-headline font-semibold text-on-surface">Edit Schedule</h2>
              <button onClick={() => setEditingJob(null)} className="text-on-surface-variant hover:text-on-surface transition-colors">
                <X size={18} />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <div className="text-sm font-medium text-on-surface mb-1">{editingJob.name}</div>
                <div className="text-xs text-on-surface-variant">Current: {editingJob.intervalDescription}</div>
              </div>
              <div>
                <label className="text-sm font-medium text-on-surface block mb-2">New Frequency</label>
                <select
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="w-full bg-background-container-low border border-outline-variant/30 rounded-xl px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary"
                >
                  {PROFILE_SYNC_PRESETS.map((p) => (
                    <option key={p.value} value={String(p.value)}>{p.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-outline-variant/20">
              <button
                onClick={() => setEditingJob(null)}
                className="text-sm font-medium text-on-surface-variant hover:text-on-surface px-4 py-2 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                disabled={saving}
                onClick={() => void saveSchedule()}
                className="bg-primary-dim hover:bg-primary disabled:opacity-50 text-on-surface text-sm font-semibold rounded-xl px-4 py-2 transition-colors"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      <SectionCard
        title="Jobs"
        description="Background jobs and their next scheduled execution. Set the Sync job interval to activate scheduled profile syncs."
      >
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="text-on-surface-variant text-sm">Loading jobs...</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-outline-variant/20">
                  <th className="text-left text-xs font-medium text-on-surface-variant uppercase tracking-wide pb-3 pr-4">Job Name</th>
                  <th className="text-left text-xs font-medium text-on-surface-variant uppercase tracking-wide pb-3 pr-4">Next Execution</th>
                  <th className="text-left text-xs font-medium text-on-surface-variant uppercase tracking-wide pb-3 pr-4">Last Run</th>
                  <th className="pb-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/10">
                {jobs.map((job) => {
                  const isActive = runningId === job.id || job.isRunning;
                  return (
                    <tr key={job.id}>
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-on-surface">{job.name}</span>
                          {isActive && <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />}
                        </div>
                        <div className="text-xs text-on-surface-variant mt-0.5">{job.intervalDescription}</div>
                      </td>
                      <td className="py-3 pr-4 text-on-surface-variant">
                        {job.nextRunAt ? formatRelativeTime(job.nextRunAt) : (job.nextRunLabel ?? "—")}
                      </td>
                      <td className="py-3 pr-4">
                        {isActive ? (
                          <div>
                            <span className="text-primary text-xs font-medium">Running now</span>
                            {job.lastRunAt && (
                              <div className="mt-0.5 text-xs text-on-surface-variant">
                                Previous {formatRelativeTime(job.lastRunAt)}
                                {job.lastRunStatus ? ` · ${job.lastRunStatus}` : ""}
                              </div>
                            )}
                          </div>
                        ) : job.lastRunAt ? (
                          <div>
                            <span className="text-on-surface-variant">{formatRelativeTime(job.lastRunAt)}</span>
                            {job.lastRunStatus && (
                              <span className={`ml-2 text-xs font-medium ${job.lastRunStatus === "success" ? "text-success" : "text-error"}`}>
                                {job.lastRunStatus}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-on-surface-variant">—</span>
                        )}
                      </td>
                      <td className="py-3">
                        <div className="flex items-center justify-end gap-2">
                          {/* Only the Sync job has a configurable interval */}
                          {job.id === "profile-sync" && (
                            <button
                              onClick={() => openEdit(job)}
                              className="flex items-center gap-1.5 text-on-surface-variant hover:text-on-surface hover:bg-background-container-high text-xs font-medium rounded-lg px-3 py-1.5 transition-colors border border-outline-variant/20"
                            >
                              <Pencil size={13} />
                              Edit
                            </button>
                          )}
                          <button
                            disabled={isActive}
                            onClick={() => void runJob(job.id)}
                            className="flex items-center gap-1.5 bg-primary-dim hover:bg-primary disabled:opacity-50 text-on-surface text-xs font-medium rounded-lg px-3 py-1.5 transition-colors border border-primary-dim"
                          >
                            <Play size={13} />
                            {isActive ? "Running..." : "Run Now"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  );
}

function AboutTab() {
  const [info, setInfo] = useState<AboutInfo | null>(null);

  useEffect(() => {
    apiGet<AboutInfo>("/api/settings/about").then(setInfo).catch(() => null);
  }, []);

  return (
    <SectionCard title="About ShelfBridge">
      <InfoRow label="Version"><span className="font-mono text-sm text-on-surface">{info?.version ?? "..."}</span></InfoRow>
      <InfoRow label="Build Channel"><span className="text-sm text-on-surface capitalize">{info?.buildChannel ?? "..."}</span></InfoRow>
      {info?.buildChannel !== "stable" && (
        <InfoRow label="Commit">
          <code className="text-sm text-on-surface bg-background-container-high px-2 py-0.5 rounded font-mono">{info?.commitSha ?? "..."}</code>
        </InfoRow>
      )}
      <InfoRow label="Data Directory">
        <code className="text-sm text-on-surface bg-background-container-high px-2 py-0.5 rounded">{info?.dataDir ?? "..."}</code>
      </InfoRow>
      <InfoRow label="Timezone">
        <code className="text-sm text-on-surface bg-background-container-high px-2 py-0.5 rounded">{info?.tz ?? "..."}</code>
      </InfoRow>
      <InfoRow label="DB Schema Version">
        <span className="text-sm text-on-surface">{info?.dbVersion ?? "..."}</span>
      </InfoRow>
    </SectionCard>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-1 sm:grid sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm font-medium text-on-surface-variant">{label}</dt>
      <dd className="text-sm text-on-surface sm:col-span-2 mt-1 sm:mt-0">{children}</dd>
    </div>
  );
}
