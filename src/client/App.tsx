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
    refreshAuth().catch(() => setAuthCheckFailed(true));
  }

  useEffect(() => {
    checkAuth();
  }, []);

  async function handleAuthenticated() {
    const status = await refreshAuth();
    if (status.authenticated) navigate("/dashboard", { replace: true });
  }

  async function handleLogout() {
    await apiPost<void>("/api/auth/logout");
    setAuth({ configured: true, authenticated: false });
    navigate("/login", { replace: true });
  }

  if (!auth && authCheckFailed) {
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

  if (!auth) {
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
