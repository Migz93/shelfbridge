import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "./lib/api";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Books, { Audiobooks, BookDetailPage } from "./pages/Books";
import Users, { UserDetailPage } from "./pages/Users";
import SyncHistory from "./pages/SyncHistory";
import Settings from "./pages/Settings";
import Login from "./pages/Login";

interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
}

export default function App() {
  return (
    <BrowserRouter>
      <MainApp />
    </BrowserRouter>
  );
}

function MainApp() {
  const navigate = useNavigate();
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authCheckFailed, setAuthCheckFailed] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(false);

  async function refreshAuth() {
    const status = await apiGet<AuthStatus>("/api/auth/status");
    setAuth(status);
    return status;
  }

  // /api/auth/status answers 200 with authenticated: false for a signed-out
  // user, so a rejection here is a 429, 5xx or network failure — not a logout.
  // Show a retryable error instead of the login screen so a valid session
  // isn't treated as ended.
  function checkAuth() {
    setAuthCheckFailed(false);
    setCheckingAuth(true);
    refreshAuth()
      .catch(() => setAuthCheckFailed(true))
      .finally(() => setCheckingAuth(false));
  }

  useEffect(() => {
    checkAuth();
  }, []);

  async function handleAuthenticated() {
    let status: AuthStatus;
    try {
      status = await refreshAuth();
    } catch {
      setAuthCheckFailed(true);
      return;
    }
    if (status.authenticated) navigate("/dashboard", { replace: true });
  }

  async function handleLogout() {
    await apiPost<void>("/api/auth/logout");
    setAuth({ configured: true, authenticated: false });
    navigate("/login", { replace: true });
  }

  // Also covers a check that fails straight after sign-in, when auth is already
  // set from the first check but still reads as signed out.
  if (authCheckFailed) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 px-4 text-center">
        <div className="text-sm text-error">Unable to load ShelfBridge. Please try again.</div>
        <button
          type="button"
          onClick={checkAuth}
          className="rounded-xl bg-primary-dim px-4 py-2 text-sm font-bold text-on-surface transition-colors hover:bg-primary"
        >
          Retry
        </button>
      </div>
    );
  }

  // A retry after a failed check can find auth still holding the stale
  // signed-out status, so keep the loading screen up until it resolves.
  if (!auth || checkingAuth) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-sm text-on-surface-variant">Loading ShelfBridge...</div>
      </div>
    );
  }

  if (!auth.configured) {
    return (
      <Routes>
        <Route path="/setup" element={<Login mode="setup" onAuthenticated={() => void handleAuthenticated()} />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (!auth.authenticated) {
    return (
      <Routes>
        <Route path="/login" element={<Login mode="login" onAuthenticated={() => void handleAuthenticated()} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
      <Routes>
        <Route element={<Layout onLogout={() => void handleLogout()} />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/books" element={<Books />} />
          <Route path="/audiobooks" element={<Audiobooks />} />
          <Route path="/books/:id" element={<BookDetailPage />} />
          <Route path="/audiobooks/:id" element={<BookDetailPage />} />
          <Route path="/users" element={<Users />} />
          <Route path="/users/:id" element={<UserDetailPage />} />
          <Route path="/history" element={<SyncHistory />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
  );
}
