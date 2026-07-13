import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function SectionCard({
  title,
  description,
  children,
  wide = false
}: {
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`bg-background-container rounded-2xl border border-outline-variant/20 p-5 ${wide ? "w-full" : ""}`}>
      <div className="mb-4">
        <h3 className="font-headline font-semibold text-base text-on-surface">{title}</h3>
        {description && <p className="text-on-surface-variant text-sm mt-1">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-on-surface mb-1.5">{label}</label>
      {hint && <div className="text-xs text-on-surface-variant mb-1.5">{hint}</div>}
      {children}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = "text"
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-background-container-low border border-outline-variant/30 rounded-lg px-3 py-2 text-on-surface text-sm placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary/50"
    />
  );
}

export function PasswordInput({
  configured,
  onChange,
  placeholder
}: {
  configured?: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="password"
      placeholder={configured ? "••••••••••••••" : (placeholder ?? "")}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-background-container-low border border-outline-variant/30 rounded-lg px-3 py-2 text-on-surface text-sm placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary/50"
    />
  );
}

export function SelectInput({ value, onChange, children }: { value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-background-container-low border border-outline-variant/30 rounded-lg px-3 py-2 text-on-surface text-sm focus:outline-none focus:border-primary/50"
    >
      {children}
    </select>
  );
}

export function ToggleField({
  label,
  hint,
  checked,
  onChange
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <div className="relative flex-shrink-0 mt-0.5">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only" />
        <div className={`w-10 h-6 rounded-full transition-colors ${checked ? "bg-primary-dim" : "bg-outline-variant"}`} />
        <div className={`absolute top-1 w-4 h-4 rounded-full transition-all ${checked ? "bg-on-surface translate-x-5" : "bg-on-surface-variant translate-x-1"}`} />
      </div>
      <div>
        <span className="text-sm font-medium text-on-surface">{label}</span>
        {hint && <div className="text-xs text-on-surface-variant mt-0.5">{hint}</div>}
      </div>
    </label>
  );
}

export function SaveBar({
  saving,
  success,
  error,
  onSave,
  onBack,
  label = "Save"
}: {
  saving: boolean;
  success: boolean;
  error: string | null;
  onSave: () => void;
  onBack?: () => void;
  label?: string;
}) {
  const saveBtn = (
    <button
      disabled={saving}
      onClick={onSave}
      className="flex items-center gap-2 bg-primary-dim hover:bg-primary disabled:opacity-50 text-on-surface text-sm font-semibold rounded-xl px-4 py-2 transition-colors"
    >
      {saving ? "Saving..." : label}
      {!saving && <ChevronRight size={15} />}
    </button>
  );

  if (onBack) {
    return (
      <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-1 bg-background-container-high hover:bg-background-bright text-on-surface text-sm font-semibold rounded-xl px-4 py-2 transition-colors border border-outline-variant/20"
        >
          <ChevronLeft size={15} /> Back
        </button>
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          {success && <span className="text-success text-sm">Saved</span>}
          {error && <span className="text-error text-sm">{error}</span>}
          {saveBtn}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 pt-2 border-t border-outline-variant/15 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        {success && <span className="text-success text-sm">Saved</span>}
        {error && <span className="text-error text-sm">{error}</span>}
      </div>
      {saveBtn}
    </div>
  );
}

export function ConnectionBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; cls: string }> = {
    connected: { label: "Connected", cls: "text-success bg-success/10 border-success/20" },
    failed: { label: "Failed", cls: "text-error bg-error/10 border-error/20" },
    untested: { label: "Untested", cls: "text-warning bg-warning/10 border-warning/20" },
    missing: { label: "Not configured", cls: "text-on-surface-variant bg-background-container-high border-outline-variant/20" }
  };
  const { label, cls } = cfg[status] ?? cfg["missing"]!;
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${cls}`}>{label}</span>
  );
}
