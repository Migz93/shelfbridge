import { useEffect, useState } from "react";
import { NavLink, Link } from "react-router-dom";
import { LayoutDashboard, BookOpen, Headphones, Users, History, Settings, Server, ExternalLink, Download, LogOut } from "lucide-react";
import { apiGet } from "../lib/api";
import { SETTINGS_CHANGED_EVENT } from "../lib/settingsEvents";
import type { AboutInfo, AppSettings } from "../../shared/types";

const NAV_ITEMS = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/books", icon: BookOpen, label: "Books" },
  { to: "/audiobooks", icon: Headphones, label: "Audiobooks" },
  { to: "/users", icon: Users, label: "Users" },
  { to: "/history", icon: History, label: "Sync History" },
  { to: "/settings", icon: Settings, label: "Settings" }
];

interface SidebarProps {
  mobileOpen: boolean;
  onMobileClose: () => void;
  onLogout: () => void;
}

export default function Sidebar({ mobileOpen, onMobileClose, onLogout }: SidebarProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    function refreshSettings() {
      apiGet<AppSettings>("/api/settings").then(setSettings).catch(() => null);
    }

    refreshSettings();
    window.addEventListener(SETTINGS_CHANGED_EVENT, refreshSettings);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, refreshSettings);
  }, []);

  const externalLinks: { href: string; icon: React.ElementType; label: string }[] = [];
  if (settings?.grimmory.baseUrl.trim()) {
    externalLinks.push({ href: settings.grimmory.baseUrl, icon: ExternalLink, label: "Grimmory" });
  }
  if (settings?.download.baseUrl.trim()) {
    externalLinks.push({ href: settings.download.baseUrl, icon: Download, label: "Shelfmark" });
  }
  if (settings?.chaptarr.baseUrl.trim()) {
    externalLinks.push({ href: settings.chaptarr.baseUrl, icon: ExternalLink, label: "Chaptarr" });
  }
  if (settings?.audiobookshelf.baseUrl.trim()) {
    externalLinks.push({ href: settings.audiobookshelf.baseUrl, icon: Headphones, label: "Audiobookshelf" });
  }

  return (
    <aside
      className={`fixed inset-y-0 left-0 w-64 flex flex-col bg-background-container-low border-r border-outline-variant/20 z-40 transition-transform duration-300
        md:translate-x-0 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-6 py-5 border-b border-outline-variant/20">
        <img
          src="/logo.webp"
          alt=""
          aria-hidden="true"
          className="w-8 h-8 rounded-lg object-cover flex-shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="font-headline font-bold text-on-surface text-sm leading-tight">ShelfBridge</div>
          <div className="text-on-surface-variant text-xs leading-tight">Bookshelf Sync</div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            onClick={onMobileClose}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? "bg-primary-dim text-on-surface"
                  : "text-on-surface-variant hover:bg-background-container-high hover:text-on-surface"
              }`
            }
          >
            <Icon size={18} strokeWidth={1.75} />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* External menu links (conditionally shown via settings) */}
      {externalLinks.length > 0 && (
        <div className="px-3 pb-2 border-t border-outline-variant/20 pt-2 space-y-0.5">
          {externalLinks.map(({ href, icon: Icon, label }) => (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={onMobileClose}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-on-surface-variant hover:bg-background-container-high hover:text-on-surface"
            >
              <Icon size={18} strokeWidth={1.75} />
              {label}
            </a>
          ))}
        </div>
      )}

      <VersionFooter onMobileClose={onMobileClose} onLogout={onLogout} />
    </aside>
  );
}

function VersionFooter({ onMobileClose, onLogout }: { onMobileClose: () => void; onLogout: () => void }) {
  const [info, setInfo] = useState<AboutInfo | null>(null);

  useEffect(() => {
    apiGet<AboutInfo>("/api/settings/about").then(setInfo).catch(() => null);
  }, []);

  const subLabel = info
    ? info.buildChannel === "stable"
      ? `v${info.version}`
      : info.commitSha === "local"
        ? "local"
        : info.commitSha.slice(0, 7)
    : "...";

  return (
    <div className="px-3 pb-3 space-y-1">
      <button
        type="button"
        onClick={() => {
          onMobileClose();
          onLogout();
        }}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-on-surface-variant hover:bg-background-container-high hover:text-on-surface"
      >
        <LogOut size={18} strokeWidth={1.75} />
        Sign out
      </button>
      <Link
        to="/settings?tab=about"
        onClick={onMobileClose}
        className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-background-container-high transition-colors group"
      >
        <div className="w-8 h-8 rounded-lg bg-background-container-highest flex items-center justify-center flex-shrink-0">
          <Server size={16} strokeWidth={1.75} className="text-on-surface-variant group-hover:text-on-surface transition-colors" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-on-surface leading-tight">ShelfBridge</div>
          <div className="text-xs text-on-surface-variant leading-tight mt-0.5 font-mono">{subLabel}</div>
        </div>
      </Link>
    </div>
  );
}
