// packages/web/src/components/Sidebar.tsx
import React from "react";
import type { Role } from "@chaos/shared";
import type { Route } from "../router.js";
import { Button, Chip } from "./ui.js";

interface NavItem {
  route: Route;
  label: string;
  badge?: number;
}

function ProductMark(): React.ReactElement {
  return (
    <div className="flex items-center gap-2.5 px-3 py-4">
      <span
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-ink text-[0.7rem] font-semibold tracking-tight text-surface"
        aria-hidden="true"
      >
        CC
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-ink">Chaos</span>
        <span className="text-xs text-ink-faint">Console</span>
      </span>
    </div>
  );
}

export function Sidebar({
  route,
  navigate,
  role,
  username,
  chaosCount,
  onLogout,
  onNavigate,
}: {
  route: Route;
  navigate: (r: Route) => void;
  role: Role;
  username: string;
  chaosCount: number | null;
  onLogout: () => void;
  /** Called after navigation, e.g. to close the mobile drawer. */
  onNavigate?: () => void;
}): React.ReactElement {
  const items: NavItem[] = [
    { route: "inventory", label: "Inventory" },
    { route: "chaos", label: "Active chaos", badge: chaosCount ?? undefined },
    { route: "audit", label: "Audit" },
    // The terminal runs commands as root on the manager box — operators only.
    ...(role === "operator" ? [{ route: "terminal" as const, label: "Terminal" }] : []),
  ];

  const go = (r: Route) => {
    navigate(r);
    onNavigate?.();
  };

  return (
    <div className="flex h-full flex-col bg-rail">
      <ProductMark />
      <nav className="flex flex-col gap-0.5 px-2" aria-label="Primary">
        {items.map((it) => {
          const active = route === it.route;
          return (
            <a
              key={it.route}
              href={`#/${it.route}`}
              aria-current={active ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                go(it.route);
              }}
              className={`group flex items-center justify-between rounded-md px-3 py-1.5 text-sm transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-rail ${
                active
                  ? "bg-panel font-medium text-ink shadow-[0_1px_0_var(--border)]"
                  : "text-ink-soft hover:bg-panel/60 hover:text-ink"
              }`}
            >
              <span>{it.label}</span>
              {typeof it.badge === "number" && it.badge > 0 && (
                <span className="tnum inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-chaos-soft px-1.5 text-xs font-semibold text-chaos">
                  {it.badge}
                </span>
              )}
            </a>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-border px-3 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="truncate text-sm text-ink" title={username}>
            {username}
          </span>
          <Chip tone={role === "operator" ? "accent" : "neutral"}>{role}</Chip>
        </div>
        <Button variant="ghost" size="sm" className="w-full justify-center" onClick={onLogout}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
