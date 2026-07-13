import { useState } from "react";
import type { FormEvent } from "react";
import { apiPost } from "../lib/api";

interface LoginProps {
  mode: "setup" | "login";
  onAuthenticated: () => void;
}

export default function Login({ mode, onAuthenticated }: LoginProps) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isSetup = mode === "setup";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (isSetup && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSaving(true);
    try {
      await apiPost(isSetup ? "/api/auth/setup" : "/api/auth/login", { password });
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4 py-10">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(229,9,20,0.18),transparent_32rem),linear-gradient(135deg,rgba(36,37,43,0.65),transparent_42rem)] pointer-events-none" />
      <form onSubmit={(event) => void submit(event)} className="relative w-full max-w-md rounded-3xl border border-outline-variant/30 bg-background-container-low/90 p-8 shadow-2xl backdrop-blur">
        <div className="flex items-center gap-3 mb-8">
          <img src="/logo.webp" alt="" aria-hidden="true" className="w-11 h-11 rounded-xl object-cover" />
          <div>
            <h1 className="font-headline text-2xl font-bold text-on-surface">ShelfBridge</h1>
            <p className="text-sm text-on-surface-variant">
              {isSetup ? "Create the admin password" : "Sign in to continue"}
            </p>
          </div>
        </div>

        <label className="block text-sm font-semibold text-on-surface mb-2" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={isSetup ? "new-password" : "current-password"}
          className="w-full rounded-xl border border-outline-variant/40 bg-background-container px-4 py-3 text-on-surface outline-none focus:border-primary"
          minLength={isSetup ? 8 : undefined}
          required
        />

        {isSetup && (
          <>
            <label className="block text-sm font-semibold text-on-surface mb-2 mt-5" htmlFor="confirm-password">
              Confirm password
            </label>
            <input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              className="w-full rounded-xl border border-outline-variant/40 bg-background-container px-4 py-3 text-on-surface outline-none focus:border-primary"
              minLength={8}
              required
            />
          </>
        )}

        {error && (
          <div className="mt-5 rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={saving}
          className="mt-7 w-full rounded-xl bg-primary px-4 py-3 text-sm font-bold text-on-surface transition-colors hover:bg-primary-dim disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Please wait..." : isSetup ? "Create password" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
