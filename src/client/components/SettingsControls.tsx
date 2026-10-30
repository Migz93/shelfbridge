import type { ReactNode } from "react";

const rowClassName = "-mx-3 -my-2 rounded-lg px-3 py-2 transition-colors hover:bg-background-container-high has-[:disabled]:hover:bg-transparent";

export function SettingsField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className={`grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] sm:items-center ${rowClassName}`}>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-on-surface">{label}</span>
        {hint && <span className="block text-xs text-on-surface-variant mt-0.5">{hint}</span>}
      </span>
      <span className="block min-w-0">{children}</span>
    </label>
  );
}

export function SettingsToggle({
  label,
  hint,
  checked,
  onChange,
  disabled = false
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-6 cursor-pointer has-[:disabled]:cursor-not-allowed ${rowClassName}`}>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-on-surface">{label}</span>
        {hint && <span className="block text-xs text-on-surface-variant mt-0.5">{hint}</span>}
      </span>
      <span className="relative block shrink-0">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span className={`block w-10 h-6 rounded-full transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-on-surface peer-disabled:opacity-50 ${checked ? "bg-primary-dim" : "bg-outline-variant"}`} />
        <span className={`absolute top-1 w-4 h-4 rounded-full transition-all peer-disabled:opacity-50 ${checked ? "bg-on-surface translate-x-5" : "bg-on-surface-variant translate-x-1"}`} />
      </span>
    </label>
  );
}
