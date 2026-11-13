import { useState, type FormEvent } from "react";
import { SectionCard } from "./FormControls";
import { SettingsField } from "./SettingsControls";

export default function ChangePassword({ onPasswordChanged, onSessionEnded }: { onPasswordChanged: () => void; onSessionEnded: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputClassName = "w-full bg-background-container-low border border-outline-variant/30 rounded-lg px-3 py-2 text-on-surface text-sm focus:outline-none focus:border-primary/50 disabled:opacity-50";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
      });
      if (response.status === 401) {
        onSessionEnded();
        return;
      }
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error ?? "Unable to change password. Please try again.");
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      onPasswordChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to change password. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <SectionCard title="Change password" description="Change the shared admin password. All sessions will be signed out, including this one.">
        <SettingsField wide label="Current password">
          <input className={inputClassName} type="password" autoComplete="current-password" required disabled={saving}
            value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        </SettingsField>
        <SettingsField wide label="New password" hint="Use at least 8 characters.">
          <input className={inputClassName} type="password" autoComplete="new-password" required minLength={8} disabled={saving}
            value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        </SettingsField>
        <SettingsField wide label="Confirm new password">
          <input className={inputClassName} type="password" autoComplete="new-password" required minLength={8} disabled={saving}
            value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
        </SettingsField>
        <div className="flex flex-col gap-3 pt-2 border-t border-outline-variant/15 sm:flex-row sm:items-center sm:justify-between">
          <div role="alert" className="text-error text-sm">{error}</div>
          <button type="submit" disabled={saving}
            className="bg-primary-dim hover:bg-primary disabled:opacity-50 text-on-surface text-sm font-semibold rounded-xl px-4 py-2 transition-colors">
            {saving ? "Changing password..." : "Change password"}
          </button>
        </div>
      </SectionCard>
    </form>
  );
}
