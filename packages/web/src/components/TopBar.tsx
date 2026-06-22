// packages/web/src/components/TopBar.tsx
import React from "react";
import { Button, Chip, LiveDot, RelativeTime } from "./ui.js";
import { useLiveStatus } from "../lib/liveStatus.js";

export function TopBar({
  title,
  username,
  onToggleSidebar,
}: {
  title: string;
  username: string;
  onToggleSidebar: () => void;
}): React.ReactElement {
  const { lastUpdated, isPolling, refresh } = useLiveStatus();

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface px-4">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label="Toggle navigation"
        className="-ml-1 grid h-8 w-8 place-items-center rounded-md text-ink-soft hover:bg-rail hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:hidden"
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 4h12M2 8h12M2 12h12" strokeLinecap="round" />
        </svg>
      </button>

      <h1 className="text-base font-semibold text-ink">{title}</h1>
      <Chip tone="warn" className="hidden sm:inline-flex">
        DEV
      </Chip>

      <div className="ml-auto flex items-center gap-3">
        {/* Fixed-width region so the relative time growing ("3s" -> "59m ago")
            never pushes the Refresh button. Content is right-aligned within. */}
        <span
          className="hidden w-[8.5rem] items-center justify-end gap-1.5 text-xs sm:inline-flex"
          aria-live="polite"
        >
          <LiveDot active={isPolling} />
          <RelativeTime since={lastUpdated} />
        </span>
        <Button size="sm" variant="secondary" busy={isPolling} onClick={() => refresh()}>
          Refresh
        </Button>
        <span className="hidden max-w-[12rem] truncate text-sm text-ink-soft md:inline" aria-hidden="true">
          {username}
        </span>
      </div>
    </header>
  );
}
