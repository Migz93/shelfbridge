import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  BookOpen,
  CheckCircle,
  Clock3,
  List,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserRound,
  X,
  XCircle
} from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { useModalA11y } from "../lib/useModalA11y";
import { formatRelativeTime } from "../lib/utils";
import { ConnectionBadge, Field, PasswordInput, SelectInput, TextInput, ToggleField } from "../components/FormControls";
import { RunSyncButton } from "../components/RunSyncButton";
import type { GoodreadsShelfMapping, HardcoverList, HardcoverListMapping, GrimmoryShelfSummary, Profile, ProfileSummary, SyncSettings, TestResult } from "../../shared/types";

const USERS_FAST_MS = 3_000;
const USERS_IDLE_MS = 30_000;
const GOODREADS_DEFAULT_SHELVES = ["read", "currently-reading", "to-read", "did-not-finish"];
const HARDCOVER_PAT_URL = "https://hardcover.app/account/api/keys/new?scope=read%3Ame+read%3Alibrary+read%3Alists+read%3Acatalog%3Adata+write%3Alibrary+write%3Alists";

export default function Users() {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [syncingId, setSyncingId] = useState<number | null>(null);

  async function load(background = false) {
    setLoading((c) => c || !background);
    try {
      const result = await apiGet<ProfileSummary[]>("/api/profiles");
      setProfiles(result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const hasRunning = profiles.some((p) => p.lastSyncStatus === "running");
  const getIntervalMs = useCallback(() => (hasRunning ? USERS_FAST_MS : USERS_IDLE_MS), [hasRunning]);
  const { refreshNow } = useLiveRefresh(async () => { await load(true); }, { getIntervalMs });

  useEffect(() => { void load(); }, []);

  async function syncProfile(id: number) {
    setSyncingId(id);
    try {
      await apiPost("/api/sync/run", { profileId: id });
      await refreshNow();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncingId(null);
    }
  }

  if (loading && profiles.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-on-surface-variant text-sm">Loading users...</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-headline font-bold text-2xl text-on-surface">Users</h1>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center justify-center gap-2 bg-primary-dim hover:bg-primary text-on-surface text-sm font-semibold rounded-xl px-4 py-2 transition-colors"
          >
            <Plus size={15} /> Add User
          </button>
          <RunSyncButton
            onStarted={refreshNow}
            onError={(message) => setError(message)}
          />
        </div>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm mb-4">{error}</div>
      )}

      {profiles.length === 0 ? (
        <div className="bg-background-container rounded-2xl border border-outline-variant/20 flex flex-col items-center justify-center py-20 px-6 text-center gap-5">
          <div className="w-16 h-16 rounded-2xl bg-background-container-high flex items-center justify-center border border-outline-variant/20">
            <UserRound size={24} className="text-primary" />
          </div>
          <div>
            <p className="text-on-surface font-headline font-semibold text-lg mb-2">No users configured</p>
            <p className="text-on-surface-variant text-sm leading-6 max-w-md">
              Add a user to connect their Grimmory account, with optional Hardcover and Goodreads sources.
            </p>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="bg-primary-dim hover:bg-primary text-on-surface text-sm font-semibold rounded-xl px-5 py-3 transition-colors"
          >
            Add First User
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {profiles.map((profile) => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              syncing={syncingId === profile.id}
              onSync={() => void syncProfile(profile.id)}
            />
          ))}
        </div>
      )}

      {showAdd && (
        <AddUserModal
          onClose={() => setShowAdd(false)}
          onSaved={async () => { setShowAdd(false); await refreshNow(); }}
        />
      )}

    </div>
  );
}

function ProfileCard({
  profile, syncing, onSync
}: {
  profile: ProfileSummary;
  syncing: boolean;
  onSync: () => void;
}) {
  const syncTone = profile.lastSyncStatus === "success"
    ? "text-success"
    : profile.lastSyncStatus === "error"
      ? "text-error"
      : profile.lastSyncStatus === "running"
        ? "text-warning"
        : "text-on-surface-variant";

  return (
    <div className={`bg-background-container rounded-2xl border border-outline-variant/20 p-5 flex flex-col gap-5 transition-colors hover:border-outline-variant/35 ${!profile.enabled ? "opacity-60" : ""}`}>
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl border border-outline-variant/20 bg-background-container-high text-primary">
            <UserRound size={21} />
          </div>
          <div className="min-w-0">
            <div className="font-headline text-lg font-semibold text-on-surface truncate">{profile.displayName}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant">
              <span>{profile.enabled ? "Enabled" : "Disabled"}</span>
              {profile.lastSyncAt && (
                <span className="inline-flex items-center gap-1">
                  <Clock3 size={12} /> Last sync {formatRelativeTime(profile.lastSyncAt)}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <ConnectionPanel name="Grimmory" status={profile.grimmoryStatus} />
        <ConnectionPanel name="Hardcover" status={profile.hardcoverStatus} />
        <ConnectionPanel name="Goodreads" status={profile.goodreadsLinked ? "connected" : "missing"} />
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-xl bg-background-container-low px-4 py-3 border border-outline-variant/20">
          <div className="text-xs text-on-surface-variant">Books</div>
          <div className="mt-1 font-headline text-lg font-bold text-on-surface">{profile.bookCount}</div>
        </div>
        <div className="rounded-xl bg-background-container-low px-4 py-3 border border-outline-variant/20">
          <div className="text-xs text-on-surface-variant">Sync Status</div>
          <div className={`mt-1 font-medium capitalize ${syncTone}`}>{profile.lastSyncStatus ?? "Not synced"}</div>
        </div>
      </div>

      <div className="flex flex-col gap-2 mt-auto">
        <button
          disabled={syncing}
          onClick={onSync}
          className="flex-1 flex items-center justify-center gap-2 bg-primary-dim hover:bg-primary disabled:opacity-50 text-on-surface text-sm font-semibold rounded-xl px-4 py-3 transition-colors"
        >
          {syncing ? <RefreshCw size={15} className="animate-spin" /> : <Play size={15} />}
          {syncing ? "Syncing..." : "Sync Now"}
        </button>
        <Link
          to={`/users/${profile.id}`}
          className="flex-1 flex items-center justify-center gap-2 bg-background-container-low hover:bg-background-container-high text-on-surface text-sm font-semibold rounded-xl px-4 py-3 transition-colors border border-outline-variant/20"
        >
          Edit User
        </Link>
      </div>
    </div>
  );
}

function ConnectionPanel({ name, status }: { name: string; status: string }) {
  return (
    <div className="rounded-xl border border-outline-variant/20 bg-background-container-low px-4 py-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-on-surface-variant">{name}</div>
      <ConnectionBadge status={status} />
    </div>
  );
}

type AddTab = "profile" | "grimmory" | "hardcover" | "goodreads";

function AddUserModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const [tab, setTab] = useState<AddTab>("profile");
  const [profileId, setProfileId] = useState<number | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [grimmoryUsername, setGrimmoryUsername] = useState("");
  const [grimmoryPassword, setGrimmoryPassword] = useState("");
  const [hardcoverToken, setHardcoverToken] = useState("");
  const [goodreadsId, setGoodreadsId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const ADD_TABS: { id: AddTab; label: string }[] = [
    { id: "profile", label: "Profile" },
    { id: "grimmory", label: "Grimmory" },
    { id: "hardcover", label: "Hardcover" },
    { id: "goodreads", label: "Goodreads" }
  ];

  async function createProfile() {
    if (!displayName.trim()) { setError("Display name is required"); return; }
    setSaving(true); setError(null);
    try {
      const result = await apiPost<{ id: number }>("/api/profiles", { displayName: displayName.trim() });
      setProfileId(result.id);
      setTab("grimmory");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  async function saveGrimmory() {
    if (!profileId) return;
    if (!grimmoryUsername.trim() || !grimmoryPassword) { setError("Username and password are required"); return; }
    setSaving(true); setError(null);
    try {
      await apiPatch(`/api/profiles/${profileId}`, { grimmory: { username: grimmoryUsername, password: grimmoryPassword } });
      setTab("hardcover");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  async function testGrimmory() {
    if (!profileId) return;
    setTesting(true); setTestResult(null);
    try {
      const result = await apiPost<TestResult>(`/api/profiles/${profileId}/test/grimmory`, {
        username: grimmoryUsername,
        password: grimmoryPassword
      });
      setTestResult(result);
    } catch (e) { setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) }); }
    finally { setTesting(false); }
  }

  async function saveHardcover() {
    if (!profileId) return;
    setSaving(true); setError(null);
    try {
      if (hardcoverToken.trim()) {
        await apiPatch(`/api/profiles/${profileId}`, { hardcover: { apiToken: hardcoverToken } });
      }
      setTab("goodreads");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  async function saveGoodreads() {
    if (!profileId) return;
    setSaving(true); setError(null);
    try {
      if (goodreadsId.trim()) {
        await apiPatch(`/api/profiles/${profileId}`, { goodreads: { goodreadsUserId: goodreadsId, enabled: true } });
      }
      await onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  return (
    <ModalShell title="Add User" onClose={onClose}>
      <div className="px-6 pb-4">
        <p className="mb-4 max-w-xl text-sm leading-6 text-on-surface-variant">
          Create the profile first, then add each connection. Optional services can be skipped and configured later.
        </p>
        <div className="grid grid-cols-2 gap-2 rounded-2xl bg-background-container-high p-1.5 sm:grid-cols-4">
          {ADD_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => { if (profileId || t.id === "profile") setTab(t.id); }}
              disabled={!profileId && t.id !== "profile"}
              className={`rounded-xl px-3 py-2.5 text-sm font-semibold transition-all disabled:opacity-40 ${
                tab === t.id ? "bg-background-container text-on-surface shadow-sm" : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 pb-5 min-h-[290px]">
        {error && <div className="bg-error/10 border border-error/30 rounded-xl px-4 py-3 text-error text-sm mb-4">{error}</div>}

        {tab === "profile" && (
          <div className="rounded-2xl border border-outline-variant/20 bg-background-container-low p-5 space-y-5">
            <ModalSectionTitle title="Profile details" description="This is the name shown across ShelfBridge." />
            <Field label="Display Name" hint="A friendly name for this user (e.g. their first name).">
              <TextInput value={displayName} onChange={setDisplayName} placeholder="Alice" />
            </Field>
            {profileId && <div className="rounded-xl border border-success/20 bg-success/10 px-4 py-3 text-sm font-medium text-success">Profile created. Configure connections below.</div>}
          </div>
        )}

        {tab === "grimmory" && (
          <div className="rounded-2xl border border-outline-variant/20 bg-background-container-low p-5 space-y-5">
            <ModalSectionTitle title="Grimmory login" description="Used to write shelves, status, and progress during sync." />
            <Field label="Username">
              <TextInput value={grimmoryUsername} onChange={setGrimmoryUsername} />
            </Field>
            <Field label="Password">
              <PasswordInput onChange={setGrimmoryPassword} />
            </Field>
            <div className="flex items-center gap-3 flex-wrap">
              <button
                disabled={testing || !profileId}
                onClick={() => void testGrimmory()}
                className="bg-background-container-high hover:bg-background-bright disabled:opacity-50 text-on-surface text-sm font-medium rounded-xl px-4 py-2 transition-colors border border-outline-variant/20"
              >
                {testing ? "Testing..." : "Test Login"}
              </button>
              {testResult && (
                <span className={`text-xs font-medium flex items-center gap-1 ${testResult.ok ? "text-success" : "text-error"}`}>
                  {testResult.ok ? <CheckCircle size={12} /> : <XCircle size={12} />} {testResult.message}
                </span>
              )}
            </div>
          </div>
        )}

        {tab === "hardcover" && (
          <div className="rounded-2xl border border-outline-variant/20 bg-background-container-low p-5 space-y-5">
            <ModalSectionTitle title="Hardcover connection" description="Optional. Add this only for users who sync with Hardcover." />
            <div className="text-sm leading-6 text-on-surface-variant bg-background-container rounded-xl px-4 py-3 border border-outline-variant/20">
              Optional. Paste only the token value, or leave this blank to skip Hardcover. {" "}
              <a href={HARDCOVER_PAT_URL} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                Create hardcover API token
              </a>
              .
            </div>
            <Field label="API Token" hint="The preselected token permissions cover library, progress, and list sync.">
              <PasswordInput onChange={setHardcoverToken} placeholder="Enter Hardcover API token, or leave blank" />
            </Field>
          </div>
        )}

        {tab === "goodreads" && (
          <div className="rounded-2xl border border-outline-variant/20 bg-background-container-low p-5 space-y-5">
            <ModalSectionTitle title="Goodreads import" description="Optional read-only shelf import for users who still have Goodreads data." />
            <div className="text-sm leading-6 text-on-surface-variant bg-background-container rounded-xl px-4 py-3 border border-outline-variant/20">
              Optional. Goodreads is a read-only source — data flows into Grimmory only.
              Enter the numeric Goodreads user ID or profile slug.
            </div>
            <Field label="Goodreads User ID" hint="Optional — leave blank to skip.">
              <TextInput value={goodreadsId} onChange={setGoodreadsId} placeholder="e.g. 12345678 or 12345678-alice" />
            </Field>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-outline-variant/15 px-6 py-5 sm:flex-row">
        <button
          onClick={onClose}
          className="flex-1 bg-background-container-high hover:bg-background-bright text-on-surface text-sm font-medium rounded-xl py-3 transition-colors border border-outline-variant/20"
        >
          {profileId ? "Done" : "Cancel"}
        </button>
        <button
          disabled={saving}
          onClick={() => void (tab === "profile" ? createProfile() : tab === "grimmory" ? saveGrimmory() : tab === "hardcover" ? saveHardcover() : saveGoodreads())}
          className="flex-1 bg-primary-dim hover:bg-primary disabled:opacity-50 text-on-surface text-sm font-semibold rounded-xl py-3 transition-colors"
        >
          {saving ? "Saving..." : tab === "goodreads" ? "Finish" : "Next"}
        </button>
      </div>
    </ModalShell>
  );
}

type EditTab = "general" | "grimmory" | "hardcover" | "goodreads" | "audiobookshelf";

export function UserDetailPage() {
  const params = useParams();
  const profileId = Number(params.id);
  const [tab, setTab] = useState<EditTab>("general");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [summary, setSummary] = useState<ProfileSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [success, setSuccess] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [grimmoryUsername, setGrimmoryUsername] = useState("");
  const [grimmoryPassword, setGrimmoryPassword] = useState("");
  const [hardcoverEnabled, setHardcoverEnabled] = useState(false);
  const [hardcoverToken, setHardcoverToken] = useState("");
  const [hardcoverSyncListId, setHardcoverSyncListId] = useState<number | null>(null);
  const [hardcoverSyncListName, setHardcoverSyncListName] = useState<string | null>(null);
  const [hardcoverTargetShelfName, setHardcoverTargetShelfName] = useState<string | null>(null);
  const [hardcoverOwnedImportEnabled, setHardcoverOwnedImportEnabled] = useState(false);
  const [hardcoverListMappings, setHardcoverListMappings] = useState<Record<string, string>>({});
  const [hardcoverListNames, setHardcoverListNames] = useState<Record<string, string>>({});
  const [hardcoverMappingsLoaded, setHardcoverMappingsLoaded] = useState(false);
  const [goodreadsId, setGoodreadsId] = useState("");
  const [goodreadsEnabled, setGoodreadsEnabled] = useState(false);
  const [goodreadsSyncShelfName, setGoodreadsSyncShelfName] = useState<string | null>(null);
  const [goodreadsTargetShelfName, setGoodreadsTargetShelfName] = useState<string | null>(null);
  const [goodreadsShelfMappings, setGoodreadsShelfMappings] = useState<Record<string, string>>({});
  const [goodreadsMappingsLoaded, setGoodreadsMappingsLoaded] = useState(false);
  const [absApiKey, setAbsApiKey] = useState("");
  const [absEnabled, setAbsEnabled] = useState(false);
  const [syncSettings, setSyncSettings] = useState<Partial<SyncSettings>>({});

  async function loadProfile() {
    if (!Number.isFinite(profileId)) {
      setError("User not found");
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [p, summaries] = await Promise.all([
        apiGet<Profile>(`/api/profiles/${profileId}`),
        apiGet<ProfileSummary[]>("/api/profiles")
      ]);
      setProfile(p);
      setSummary(summaries.find((s) => s.id === profileId) ?? null);
      setDisplayName(p.displayName);
      setEnabled(p.enabled);
      setGrimmoryUsername(p.grimmory?.username ?? "");
      setHardcoverEnabled(Boolean(p.hardcover));
      setHardcoverSyncListId(p.hardcover?.syncListId ?? null);
      setHardcoverSyncListName(p.hardcover?.syncListName ?? null);
      setHardcoverTargetShelfName(p.hardcover?.targetShelfName ?? null);
      setHardcoverOwnedImportEnabled(p.hardcover?.ownedImportEnabled ?? false);
      setGoodreadsId(p.goodreads?.goodreadsUserId ?? "");
      setGoodreadsEnabled(p.goodreads?.enabled ?? false);
      setGoodreadsSyncShelfName(p.goodreads?.syncShelfName ?? null);
      setGoodreadsTargetShelfName(p.goodreads?.targetShelfName ?? null);
      setAbsEnabled(Boolean(p.audiobookshelf));
      setAbsApiKey("");
      setSyncSettings(p.syncSettings ?? {});
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProfile();
  }, [profileId]);

  const EDIT_TABS: { id: EditTab; label: string }[] = [
    { id: "general", label: "General" },
    { id: "grimmory", label: "Grimmory" },
    { id: "hardcover", label: "Hardcover" },
    { id: "goodreads", label: "Goodreads" },
    { id: "audiobookshelf", label: "Audiobookshelf" }
  ];

  async function save() {
    setSaving(true); setError(null); setSuccess(false);
    try {
      const patch: Record<string, unknown> = { displayName, enabled };
      if (grimmoryPassword) patch["grimmory"] = { username: grimmoryUsername, password: grimmoryPassword };
      else if (grimmoryUsername !== profile?.grimmory?.username) patch["grimmory"] = { username: grimmoryUsername };
      if (
        hardcoverEnabled !== Boolean(profile?.hardcover) ||
        hardcoverToken ||
        hardcoverSyncListId !== (profile?.hardcover?.syncListId ?? null) ||
        hardcoverSyncListName !== (profile?.hardcover?.syncListName ?? null) ||
        hardcoverTargetShelfName !== (profile?.hardcover?.targetShelfName ?? null) ||
        hardcoverOwnedImportEnabled !== (profile?.hardcover?.ownedImportEnabled ?? false)
      ) {
        patch["hardcover"] = {
          enabled: hardcoverEnabled,
          ...(hardcoverToken ? { apiToken: hardcoverToken } : {}),
          syncListId: hardcoverSyncListId,
          syncListName: hardcoverSyncListName,
          targetShelfName: hardcoverTargetShelfName,
          ownedImportEnabled: hardcoverOwnedImportEnabled
        };
      }
      if (
        goodreadsId ||
        goodreadsEnabled !== (profile?.goodreads?.enabled ?? false) ||
        goodreadsSyncShelfName !== (profile?.goodreads?.syncShelfName ?? null) ||
        goodreadsTargetShelfName !== (profile?.goodreads?.targetShelfName ?? null)
      ) {
        patch["goodreads"] = {
          goodreadsUserId: goodreadsId,
          enabled: goodreadsEnabled,
          syncShelfName: goodreadsSyncShelfName,
          targetShelfName: goodreadsTargetShelfName
        };
      }
      if (!absEnabled && Boolean(profile?.audiobookshelf)) {
        patch["audiobookshelf"] = { enabled: false };
      } else if (absApiKey.trim()) {
        patch["audiobookshelf"] = { apiKey: absApiKey };
      }
      if (Object.keys(syncSettings).length) {
        const { id: _id, ...syncSettingsPatch } = syncSettings;
        if (Object.keys(syncSettingsPatch).length) patch["syncSettings"] = syncSettingsPatch;
      }
      await apiPatch(`/api/profiles/${profileId}`, patch);
      if (hardcoverMappingsLoaded) {
        const mappings = Object.entries(hardcoverListMappings)
          .filter(([, shelfName]) => shelfName.trim())
          .map(([listId, shelfName]) => ({
            hardcoverListId: parseInt(listId, 10),
            hardcoverListName: hardcoverListNames[listId] ?? listId,
            grimmoryShelfName: shelfName.trim()
          }));
        if (hardcoverEnabled) await apiPost(`/api/profiles/${profileId}/list-mappings`, { mappings });
      }
      if (goodreadsMappingsLoaded) {
        const mappings = Object.entries(goodreadsShelfMappings)
          .filter(([, shelfName]) => shelfName.trim())
          .map(([goodreadsShelfName, grimmoryShelfName]) => ({
            goodreadsShelfName,
            grimmoryShelfName: grimmoryShelfName.trim()
          }));
        if (goodreadsEnabled) await apiPost(`/api/profiles/${profileId}/goodreads/shelf-mappings`, { mappings });
      }
      setSuccess(true);
      await loadProfile();
    } catch (e) {
      // A 207 PATCH has applied the non-cleanup fields; refresh those values
      // before surfacing the cleanup error so the form cannot remain stale.
      await loadProfile().catch(() => null);
      setError(e instanceof Error ? e.message : String(e));
    }
    finally { setSaving(false); }
  }

  async function testConnection(type: string) {
    setTesting(type);
    try {
      const body: Record<string, string> =
        type === "grimmory" ? { username: grimmoryUsername, ...(grimmoryPassword ? { password: grimmoryPassword } : {}) }
        : type === "hardcover" ? (hardcoverToken ? { apiToken: hardcoverToken } : {})
        : type === "goodreads" ? { goodreadsUserId: goodreadsId }
        : type === "audiobookshelf" ? (absApiKey.trim() ? { apiKey: absApiKey } : {})
        : {};
      const result = await apiPost<TestResult>(`/api/profiles/${profileId}/test/${type}`, body);
      setTestResults((r) => ({ ...r, [type]: result }));
      // A successful test is represented by testResults; reloading here would
      // overwrite unrelated unsaved edits in the connection form.
    } catch (e) { setTestResults((r) => ({ ...r, [type]: { ok: false, message: e instanceof Error ? e.message : String(e) } })); }
    finally { setTesting(null); }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-on-surface-variant text-sm">Loading user...</div>
      </div>
    );
  }

  if (!Number.isFinite(profileId) || (!profile && error)) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <div className="bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm">{error ?? "User not found"}</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link to="/users" className="text-sm text-on-surface-variant hover:text-on-surface">Users</Link>
          <h1 className="mt-2 font-headline font-bold text-2xl text-on-surface">{profile?.displayName ?? "User"}</h1>
        </div>
        <button
          disabled={saving}
          onClick={() => void save()}
          className="bg-primary-dim hover:bg-primary disabled:opacity-50 text-on-surface text-sm font-semibold rounded-xl px-5 py-3 transition-colors"
        >
          {saving ? "Saving..." : success ? "Saved!" : "Save Changes"}
        </button>
      </div>

      {error && <div className="bg-error/10 border border-error/30 rounded-lg px-4 py-3 text-error text-sm mb-4">{error}</div>}

      <div className="mb-6">
        <div className="grid grid-cols-2 gap-2 rounded-2xl bg-background-container-high p-1.5 sm:grid-cols-5">
            {EDIT_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-xl px-3 py-2.5 text-center text-sm font-semibold transition-all ${
                  tab === t.id
                    ? "bg-background-container text-on-surface shadow-sm"
                    : "text-on-surface-variant hover:text-on-surface"
                }`}
              >
                {t.label}
              </button>
            ))}
        </div>
      </div>

      <div>
        {tab === "general" && (
          <div className="space-y-5">
            {summary && <UserGeneralOverview summary={summary} />}
            <div className="rounded-2xl border border-outline-variant/20 bg-background-container p-5 space-y-5">
              <SectionTitle title="General" />
              <Field label="Display Name"><TextInput value={displayName} onChange={setDisplayName} /></Field>
              <ToggleField label="Enabled" checked={enabled} onChange={setEnabled} />
              <div className="border-t border-outline-variant/15 pt-5">
                <Field label="Conflict Strategy" hint="How to resolve conflicts when both Hardcover and Grimmory have changed.">
                  <SelectInput
                    value={syncSettings.conflictStrategy ?? "latest_wins"}
                    onChange={(v) => setSyncSettings((s) => ({ ...s, conflictStrategy: v as SyncSettings["conflictStrategy"] }))}
                  >
                    <option value="latest_wins">Latest update wins</option>
                    <option value="grimmory_wins">Grimmory always wins</option>
                    <option value="hardcover_wins">Hardcover always wins</option>
                  </SelectInput>
                </Field>
              </div>
              <div className="border-t border-outline-variant/15 pt-5">
                <ToggleField
                  label="Scheduled Sync"
                  hint="Include this profile in automatic scheduled syncs."
                  checked={Boolean(syncSettings.scheduleEnabled ?? false)}
                  onChange={(v) => setSyncSettings((s) => ({ ...s, scheduleEnabled: v }))}
                />
              </div>
            </div>
          </div>
        )}

        {tab === "grimmory" && (
          <div className="rounded-2xl border border-outline-variant/20 bg-background-container p-5 space-y-5">
            <SectionTitle title="Grimmory" status={profile?.grimmory?.status} />
            <Field label="Username"><TextInput value={grimmoryUsername} onChange={setGrimmoryUsername} /></Field>
            <Field label="Password" hint="Leave blank to keep existing password."><PasswordInput configured={Boolean(profile?.grimmory)} onChange={setGrimmoryPassword} /></Field>
            <TestConnectionRow type="grimmory" testing={testing} testResults={testResults} onTest={() => void testConnection("grimmory")} />
            <div className="border-t border-outline-variant/15 pt-5">
              <ToggleField
                label="Write Tag"
                hint="Tag matched Grimmory books from this user's configured Hardcover or Goodreads source list."
                checked={Boolean(syncSettings.syncWriteTagEnabled ?? false)}
                onChange={(v) => setSyncSettings((s) => ({ ...s, syncWriteTagEnabled: v }))}
              />
            </div>
          </div>
        )}

        {tab === "hardcover" && (
          <div className="rounded-2xl border border-outline-variant/20 bg-background-container p-5">
            <HardcoverTabContent
              profileId={profileId}
              profile={profile}
              hardcoverEnabled={hardcoverEnabled}
              setHardcoverEnabled={setHardcoverEnabled}
              setHardcoverToken={setHardcoverToken}
              syncListId={hardcoverSyncListId}
              syncListName={hardcoverSyncListName}
              setSyncList={(id, name) => { setHardcoverSyncListId(id); setHardcoverSyncListName(name); }}
              targetShelfName={hardcoverTargetShelfName}
              setTargetShelfName={setHardcoverTargetShelfName}
              ownedImportEnabled={hardcoverOwnedImportEnabled}
              setOwnedImportEnabled={setHardcoverOwnedImportEnabled}
              listMappings={hardcoverListMappings}
              setListMappings={setHardcoverListMappings}
              setListNames={setHardcoverListNames}
              setMappingsLoaded={setHardcoverMappingsLoaded}
              syncSettings={syncSettings}
              setSyncSettings={setSyncSettings}
              testing={testing}
              testResults={testResults}
              onTest={(type) => void testConnection(type)}
            />
          </div>
        )}

        {tab === "goodreads" && (
          <div className="rounded-2xl border border-outline-variant/20 bg-background-container p-5">
            <GoodreadsTabContent
              profileId={profileId}
              profile={profile}
              goodreadsId={goodreadsId}
              setGoodreadsId={setGoodreadsId}
              goodreadsEnabled={goodreadsEnabled}
              setGoodreadsEnabled={setGoodreadsEnabled}
              syncShelfName={goodreadsSyncShelfName}
              setSyncShelfName={setGoodreadsSyncShelfName}
              targetShelfName={goodreadsTargetShelfName}
              setTargetShelfName={setGoodreadsTargetShelfName}
              shelfMappings={goodreadsShelfMappings}
              setShelfMappings={setGoodreadsShelfMappings}
              setMappingsLoaded={setGoodreadsMappingsLoaded}
              syncSettings={syncSettings}
              setSyncSettings={setSyncSettings}
              testing={testing}
              testResults={testResults}
              onTest={(type) => void testConnection(type)}
            />
          </div>
        )}

        {tab === "audiobookshelf" && (
          <div className="rounded-2xl border border-outline-variant/20 bg-background-container p-5 space-y-5">
            <SectionTitle title="Audiobookshelf" status={profile?.audiobookshelf?.status} detail={profile?.audiobookshelf?.absUsername ?? undefined} />
            {!absEnabled && Boolean(profile?.audiobookshelf) && (
              <div className="bg-warning/10 border border-warning/30 rounded-xl px-4 py-3 text-warning text-sm">
                Saving will remove this user's Audiobookshelf connection and delete their local sync data.
              </div>
            )}
            <ToggleField
              label="Enable Audiobookshelf"
              hint="Connect this user's Audiobookshelf account for listening progress sync."
              checked={absEnabled}
              onChange={setAbsEnabled}
            />
            {absEnabled && (
              <>
                <Field label="API Key" hint="Generate a user API key in Audiobookshelf → Settings → Users. Enable 'Act on behalf of user' if using an admin key.">
                  <PasswordInput
                    configured={Boolean(profile?.audiobookshelf)}
                    onChange={setAbsApiKey}
                  />
                </Field>
                <TestConnectionRow type="audiobookshelf" testing={testing} testResults={testResults} onTest={() => void testConnection("audiobookshelf")} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function UserGeneralOverview({ summary }: { summary: ProfileSummary }) {
  const syncTone = summary.lastSyncStatus === "success"
    ? "text-success"
    : summary.lastSyncStatus === "error"
      ? "text-error"
      : summary.lastSyncStatus === "running"
        ? "text-warning"
        : "text-on-surface-variant";

  return (
    <div className="rounded-2xl border border-outline-variant/20 bg-background-container p-5">
      <div className="mb-5 flex items-start gap-4">
        <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl border border-outline-variant/20 bg-background-container-high text-primary">
          <UserRound size={21} />
        </div>
        <div>
          <h2 className="font-headline text-lg font-semibold text-on-surface">Overview</h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            {summary.lastSyncAt ? `Last sync ${formatRelativeTime(summary.lastSyncAt)}` : "This user has not synced yet."}
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <ConnectionPanel name="Grimmory" status={summary.grimmoryStatus} />
        <ConnectionPanel name="Hardcover" status={summary.hardcoverStatus} />
        <ConnectionPanel name="Goodreads" status={summary.goodreadsLinked ? "connected" : "missing"} />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <OverviewStat icon={<ShieldCheck size={16} />} label="Profile" value={summary.enabled ? "Enabled" : "Disabled"} />
        <OverviewStat icon={<BookOpen size={16} />} label="Books" value={String(summary.bookCount)} />
        <OverviewStat icon={<Clock3 size={16} />} label="Sync Status" value={summary.lastSyncStatus ?? "Not synced"} valueClassName={`capitalize ${syncTone}`} />
      </div>
    </div>
  );
}

function OverviewStat({
  icon,
  label,
  value,
  valueClassName = "text-on-surface"
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-xl border border-outline-variant/20 bg-background-container-low px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
        <span className="text-primary">{icon}</span>
        {label}
      </div>
      <div className={`font-headline text-lg font-bold ${valueClassName}`}>{value}</div>
    </div>
  );
}

function HardcoverTabContent({
  profileId,
  profile,
  hardcoverEnabled,
  setHardcoverEnabled,
  setHardcoverToken,
  syncListId,
  syncListName,
  setSyncList,
  targetShelfName,
  setTargetShelfName,
  ownedImportEnabled,
  setOwnedImportEnabled,
  listMappings,
  setListMappings,
  setListNames,
  setMappingsLoaded,
  syncSettings,
  setSyncSettings,
  testing,
  testResults,
  onTest
}: {
  profileId: number;
  profile: Profile | null;
  hardcoverEnabled: boolean;
  setHardcoverEnabled: (v: boolean) => void;
  setHardcoverToken: (v: string) => void;
  syncListId: number | null;
  syncListName: string | null;
  setSyncList: (id: number | null, name: string | null) => void;
  targetShelfName: string | null;
  setTargetShelfName: (v: string | null) => void;
  ownedImportEnabled: boolean;
  setOwnedImportEnabled: (v: boolean) => void;
  listMappings: Record<string, string>;
  setListMappings: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setListNames: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setMappingsLoaded: (loaded: boolean) => void;
  syncSettings: Partial<SyncSettings>;
  setSyncSettings: React.Dispatch<React.SetStateAction<Partial<SyncSettings>>>;
  testing: string | null;
  testResults: Record<string, TestResult>;
  onTest: (type: string) => void;
}) {
  const [hcLists, setHcLists] = useState<HardcoverList[] | null>(null);
  const [loadingLists, setLoadingLists] = useState(false);
  const [grimmoryShelfNames, setGrimmoryShelfNames] = useState<string[]>([]);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    // Load existing saved mappings
    apiGet<{ mappings: HardcoverListMapping[] }>(`/api/profiles/${profileId}/list-mappings`).then(({ mappings }) => {
      const initial: Record<string, string> = {};
      for (const m of mappings) initial[String(m.hardcoverListId)] = m.grimmoryShelfName;
      setListMappings(initial);
      setMappingsLoaded(true);
    }).catch(() => null);

    // Fetch Grimmory shelf suggestions
    apiGet<{ shelves: GrimmoryShelfSummary[] }>(`/api/profiles/${profileId}/grimmory/shelves`).then(({ shelves }) => {
      setGrimmoryShelfNames(shelves.map((s) => s.name));
    }).catch(() => null);

    // Auto-load HC lists if connected
    if (profile?.hardcover) void refreshLists();
  }, [profileId]);

  async function refreshLists() {
    setLoadingLists(true);
    try {
      const { lists } = await apiGet<{ lists: HardcoverList[] }>(`/api/profiles/${profileId}/hardcover/lists`);
      setHcLists(lists);
      setListNames(Object.fromEntries(lists.map((list) => [String(list.id), list.name])));
    } catch (err) {
      setHcLists([]);
    } finally {
      setLoadingLists(false);
    }
  }

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Hardcover"
        status={profile?.hardcover?.status}
        detail={profile?.hardcover?.hardcoverUsername ? `@${profile.hardcover.hardcoverUsername}` : undefined}
      />
      <ToggleField label="Enable Hardcover" checked={hardcoverEnabled} onChange={setHardcoverEnabled} />

      {hardcoverEnabled && (<>
      <Field label="API Token" hint="Paste only the token value. Leave blank to keep the existing token.">
        <PasswordInput configured={Boolean(profile?.hardcover)} onChange={setHardcoverToken} />
      </Field>
      {(!profile?.hardcover || profile.hardcover.usesLegacyToken) && (
        <a href={HARDCOVER_PAT_URL} target="_blank" rel="noreferrer" className="inline-block text-sm text-primary hover:underline">
          Create hardcover API token
        </a>
      )}
      <TestConnectionRow type="hardcover" testing={testing} testResults={testResults} onTest={() => onTest("hardcover")} />

      <div className="border-t border-outline-variant/15 pt-5 space-y-4">
        <ToggleField
          label="Sync Read State"
          hint="Sync read status bidirectionally between Hardcover and Grimmory when Hardcover is connected."
          checked={Boolean(syncSettings.syncStatusEnabled ?? true)}
          onChange={(v) => setSyncSettings((s) => ({ ...s, syncStatusEnabled: v }))}
        />
        <ToggleField
          label="Sync Progress"
          hint="Sync reading progress percentages bidirectionally between Hardcover and Grimmory when Hardcover is connected."
          checked={Boolean(syncSettings.syncProgressEnabled ?? true)}
          onChange={(v) => setSyncSettings((s) => ({ ...s, syncProgressEnabled: v }))}
        />
        <ToggleField
          label="Owned Import"
          hint="Also check your Hardcover Owned list. When an owned edition's format (book vs. audiobook) differs from your current edition, track both separately."
          checked={ownedImportEnabled}
          onChange={setOwnedImportEnabled}
        />
      </div>

      <div className="border-t border-outline-variant/15 pt-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <List size={15} className="text-on-surface-variant" />
              <span className="text-sm font-medium text-on-surface">List Mappings</span>
            </div>
            <button
              disabled={loadingLists || !hardcoverEnabled || !profile?.hardcover}
              onClick={() => void refreshLists()}
              className="flex items-center gap-1.5 text-xs text-on-surface-variant hover:text-on-surface bg-background-container-high hover:bg-background-bright border border-outline-variant/20 rounded-lg px-3 py-2 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={11} className={loadingLists ? "animate-spin" : ""} />
              {loadingLists ? "Loading..." : "Refresh Lists"}
            </button>
          </div>

          <div className="text-sm leading-6 text-on-surface-variant mb-4">
            Choose an optional import list, an optional destination shelf for all matched books, and then any per-list mappings you want to keep in sync.
          </div>

          {!profile?.hardcover ? (
            <div className="text-sm text-on-surface-variant bg-background-container rounded-xl px-4 py-3 border border-outline-variant/20">
              Connect Hardcover first to configure list mappings.
            </div>
          ) : hcLists === null ? (
            <div className="text-sm text-on-surface-variant">Loading your Hardcover lists...</div>
          ) : (
            <div className="space-y-3">
              <SourceMappingRow
                label="Import List"
                description="Optionally only import books on this list."
              >
                <SelectInput
                  value={syncListId ? String(syncListId) : ""}
                  onChange={(value) => {
                    if (!value) {
                      setSyncList(null, null);
                      return;
                    }
                    const selected = hcLists.find((list) => String(list.id) === value);
                    setSyncList(parseInt(value, 10), selected?.name ?? syncListName ?? value);
                  }}
                >
                  <option value="">Disabled</option>
                  {syncListId && syncListName && !hcLists.some((list) => list.id === syncListId) && (
                    <option value={String(syncListId)}>{syncListName}</option>
                  )}
                  {hcLists.map((list) => (
                    <option key={list.id} value={String(list.id)}>{list.name}</option>
                  ))}
                </SelectInput>
              </SourceMappingRow>
              <SourceMappingRow
                label="Send to Shelf"
                description="Optionally send all matched books to a Grimmory shelf."
              >
                <ShelfCombobox
                  value={targetShelfName ?? ""}
                  onChange={(v) => setTargetShelfName(v.trim() ? v : null)}
                  suggestions={grimmoryShelfNames}
                  placeholder="Grimmory shelf name..."
                  disabledLabel="Disabled"
                />
              </SourceMappingRow>
              {hcLists.length === 0 ? (
                <div className="text-sm text-on-surface-variant bg-background-container rounded-xl px-4 py-3 border border-outline-variant/20">
                  No lists found on your Hardcover account.
                </div>
              ) : hcLists.map((list) => (
                <SourceMappingRow
                  key={list.id}
                  label={list.name}
                  description="Optionally sync this Hardcover list to a Grimmory shelf."
                >
                  <ShelfCombobox
                    value={listMappings[String(list.id)] ?? ""}
                    onChange={(v) => setListMappings((m) => ({ ...m, [String(list.id)]: v }))}
                    suggestions={grimmoryShelfNames}
                    placeholder="Disabled"
                    disabledLabel="Disabled"
                  />
                </SourceMappingRow>
              ))}
            </div>
          )}
      </div>
      </>)}
    </div>
  );
}

function GoodreadsTabContent({
  profileId,
  profile,
  goodreadsId,
  setGoodreadsId,
  goodreadsEnabled,
  setGoodreadsEnabled,
  syncShelfName,
  setSyncShelfName,
  targetShelfName,
  setTargetShelfName,
  shelfMappings,
  setShelfMappings,
  setMappingsLoaded,
  syncSettings,
  setSyncSettings,
  testing,
  testResults,
  onTest
}: {
  profileId: number;
  profile: Profile | null;
  goodreadsId: string;
  setGoodreadsId: (v: string) => void;
  goodreadsEnabled: boolean;
  setGoodreadsEnabled: (v: boolean) => void;
  syncShelfName: string | null;
  setSyncShelfName: (v: string | null) => void;
  targetShelfName: string | null;
  setTargetShelfName: (v: string | null) => void;
  shelfMappings: Record<string, string>;
  setShelfMappings: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setMappingsLoaded: (loaded: boolean) => void;
  syncSettings: Partial<SyncSettings>;
  setSyncSettings: React.Dispatch<React.SetStateAction<Partial<SyncSettings>>>;
  testing: string | null;
  testResults: Record<string, TestResult>;
  onTest: (type: string) => void;
}) {
  const [grShelves, setGrShelves] = useState<string[] | null>(null);
  const [loadingShelves, setLoadingShelves] = useState(false);
  const [grimmoryShelfNames, setGrimmoryShelfNames] = useState<string[]>([]);
  const initialized = useRef(false);

  const shelfOptions = Array.from(new Set([...GOODREADS_DEFAULT_SHELVES, ...(grShelves ?? [])])).sort();

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    apiGet<{ mappings: GoodreadsShelfMapping[] }>(`/api/profiles/${profileId}/goodreads/shelf-mappings`).then(({ mappings }) => {
      const initial: Record<string, string> = {};
      for (const m of mappings) initial[m.goodreadsShelfName] = m.grimmoryShelfName;
      setShelfMappings(initial);
      setMappingsLoaded(true);
    }).catch(() => null);

    apiGet<{ shelves: GrimmoryShelfSummary[] }>(`/api/profiles/${profileId}/grimmory/shelves`).then(({ shelves }) => {
      setGrimmoryShelfNames(shelves.map((s) => s.name));
    }).catch(() => null);

    if (profile?.goodreads) void refreshShelves();
  }, [profileId]);

  async function refreshShelves() {
    setLoadingShelves(true);
    try {
      const { shelves } = await apiGet<{ shelves: string[] }>(`/api/profiles/${profileId}/goodreads/shelves`);
      setGrShelves(shelves);
    } catch {
      setGrShelves([]);
    } finally {
      setLoadingShelves(false);
    }
  }

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Goodreads"
        status={profile?.goodreads?.status}
        detail={profile?.goodreads?.goodreadsUsername ?? undefined}
      />
      <ToggleField label="Enable Goodreads" checked={goodreadsEnabled} onChange={setGoodreadsEnabled} />

      {goodreadsEnabled && (<>
      <Field label="Goodreads User ID or Profile Slug">
        <TextInput value={goodreadsId} onChange={setGoodreadsId} placeholder="e.g. 12345678 or 12345678-alice" />
      </Field>
      <TestConnectionRow type="goodreads" testing={testing} testResults={testResults} onTest={() => onTest("goodreads")} />

      <div className="border-t border-outline-variant/15 pt-5 space-y-4">
        <ToggleField
          label="Sync Read State"
          hint="When the Goodreads shelf changes, update the matching book's read status and rating in Grimmory."
          checked={Boolean(syncSettings.syncGoodreadsStatusEnabled ?? false)}
          onChange={(v) => setSyncSettings((s) => ({ ...s, syncGoodreadsStatusEnabled: v }))}
        />
      </div>

      <div className="border-t border-outline-variant/15 pt-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <List size={15} className="text-on-surface-variant" />
              <span className="text-sm font-medium text-on-surface">Shelf Mappings</span>
            </div>
            <button
              disabled={loadingShelves || !profile?.goodreads}
              onClick={() => void refreshShelves()}
              className="flex items-center gap-1.5 text-xs text-on-surface-variant hover:text-on-surface bg-background-container-high hover:bg-background-bright border border-outline-variant/20 rounded-lg px-3 py-2 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={11} className={loadingShelves ? "animate-spin" : ""} />
              {loadingShelves ? "Loading..." : "Refresh Shelves"}
            </button>
          </div>

          <div className="text-sm leading-6 text-on-surface-variant mb-4">
            Choose an optional import shelf, an optional destination shelf for all matched books, and then any per-shelf mappings you want to keep in sync.
          </div>

          {!profile?.goodreads ? (
            <div className="text-sm text-on-surface-variant bg-background-container rounded-xl px-4 py-3 border border-outline-variant/20">
              Connect Goodreads first to configure shelf mappings.
            </div>
          ) : grShelves === null ? (
            <div className="text-sm text-on-surface-variant">Loading your Goodreads shelves...</div>
          ) : (
            <div className="space-y-3">
              <SourceMappingRow
                label="Import Shelf"
                description="Optionally only import books on this shelf."
              >
                <SelectInput value={syncShelfName ?? ""} onChange={(value) => setSyncShelfName(value || null)}>
                  <option value="">Disabled</option>
                  {syncShelfName && !shelfOptions.includes(syncShelfName) && (
                    <option value={syncShelfName}>{syncShelfName}</option>
                  )}
                  {shelfOptions.map((shelf) => (
                    <option key={shelf} value={shelf}>{shelf}</option>
                  ))}
                </SelectInput>
              </SourceMappingRow>
              <SourceMappingRow
                label="Send to Shelf"
                description="Optionally send all matched books to a Grimmory shelf."
              >
                <ShelfCombobox
                  value={targetShelfName ?? ""}
                  onChange={(v) => setTargetShelfName(v.trim() ? v : null)}
                  suggestions={grimmoryShelfNames}
                  placeholder="Grimmory shelf name..."
                  disabledLabel="Disabled"
                />
              </SourceMappingRow>
              {grShelves.length === 0 ? (
                <div className="text-sm text-on-surface-variant bg-background-container rounded-xl px-4 py-3 border border-outline-variant/20">
                  No custom shelves found on your Goodreads account.
                </div>
              ) : grShelves.map((shelf) => (
                <SourceMappingRow
                  key={shelf}
                  label={shelf}
                  description="Optionally sync this Goodreads shelf to a Grimmory shelf."
                >
                  <ShelfCombobox
                    value={shelfMappings[shelf] ?? ""}
                    onChange={(v) => setShelfMappings((m) => ({ ...m, [shelf]: v }))}
                    suggestions={grimmoryShelfNames}
                    placeholder="Disabled"
                    disabledLabel="Disabled"
                  />
                </SourceMappingRow>
              ))}
            </div>
          )}
      </div>
      </>)}
    </div>
  );
}

function SourceMappingRow({
  label,
  description,
  children
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-3 rounded-xl border border-outline-variant/20 bg-background-container px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
      <div>
        <div className="text-sm font-medium text-on-surface">{label}</div>
        <div className="mt-1 text-xs leading-5 text-on-surface-variant">{description}</div>
      </div>
      {children}
    </div>
  );
}

function ShelfCombobox({
  value,
  onChange,
  suggestions,
  placeholder = "Grimmory shelf name...",
  disabledLabel
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  placeholder?: string;
  disabledLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const filtered = value.trim()
    ? suggestions.filter((s) => s.toLowerCase().includes(value.toLowerCase()))
    : suggestions;

  return (
    <div className="relative flex-1">
      <input
        type="text"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(Boolean(disabledLabel) || suggestions.length > 0)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        className="w-full bg-background-container-low border border-outline-variant/30 rounded-lg px-3 py-2 text-on-surface text-sm placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary/50"
      />
      {open && (Boolean(disabledLabel) || filtered.length > 0) && (
        <div className="absolute z-20 left-0 right-0 top-full mt-0.5 bg-background-container border border-outline-variant/20 rounded-lg shadow-xl max-h-32 overflow-auto">
          {disabledLabel && (
            <button
              type="button"
              onMouseDown={() => { onChange(""); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm text-on-surface-variant hover:bg-background-container-high transition-colors"
            >
              {disabledLabel}
            </button>
          )}
          {filtered.slice(0, 8).map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={() => { onChange(s); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm text-on-surface hover:bg-background-container-high transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ModalSectionTitle({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h3 className="font-headline text-lg font-semibold text-on-surface">{title}</h3>
      <p className="mt-1 text-sm leading-6 text-on-surface-variant">{description}</p>
    </div>
  );
}

function SectionTitle({ title, status, detail }: { title: string; status?: string; detail?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="font-headline text-lg font-semibold text-on-surface">{title}</h3>
      {status === "connected" && <CheckCircle size={15} className="text-success" />}
      {status === "failed" && <XCircle size={15} className="text-error" />}
      {detail && <span className="text-sm font-medium text-on-surface-variant">{detail}</span>}
    </div>
  );
}

function TestConnectionRow({
  type, testing, testResults, onTest
}: {
  type: string;
  testing: string | null;
  testResults: Record<string, TestResult>;
  onTest: () => void;
}) {
  const result = testResults[type];
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <button
        disabled={testing === type}
        onClick={onTest}
        className="bg-background-container-high hover:bg-background-bright disabled:opacity-50 text-on-surface text-sm font-medium rounded-xl px-4 py-2 transition-colors border border-outline-variant/20"
      >
        {testing === type ? "Testing..." : "Test Connection"}
      </button>
      {result && (
        <span className={`text-xs font-medium flex items-center gap-1 ${result.ok ? "text-success" : "text-error"}`}>
          {result.ok ? <CheckCircle size={11} /> : <XCircle size={11} />} {result.message}
        </span>
      )}
    </div>
  );
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const modalRef = useModalA11y(true, onClose);
  const titleId = useId();

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bg-background-container rounded-2xl w-full max-w-4xl max-h-[90vh] border border-outline-variant/20 shadow-xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-5">
          <h2 id={titleId} className="font-headline text-xl font-semibold text-on-surface">{title}</h2>
          <button onClick={onClose} className="p-2 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-background-container-high transition-colors">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
