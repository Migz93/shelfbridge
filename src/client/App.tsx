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

  async function refreshAuth() {
    const status = await apiGet<AuthStatus>("/api/auth/status");
    setAuth(status);
    return status;
  }

  useEffect(() => {
    void refreshAuth().catch(() => setAuth({ configured: true, authenticated: false }));
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
