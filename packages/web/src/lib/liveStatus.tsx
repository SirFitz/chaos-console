// packages/web/src/lib/liveStatus.tsx
//
// A tiny channel so the active page can publish its live-poll status
// (lastUpdated / isPolling / refresh) up to the top bar, and the top bar's
// global Refresh can drive the page. Keeps each page self-contained while the
// shell reflects the live truth of whatever is on screen.
import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

export interface LiveStatus {
  lastUpdated: number | null;
  isPolling: boolean;
  refresh: () => void;
}

interface LiveStatusChannel extends LiveStatus {
  /** A page calls this each render to publish its current poll status. */
  publish: (s: LiveStatus) => void;
}

const Ctx = createContext<LiveStatusChannel | null>(null);

export function LiveStatusProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [status, setStatus] = useState<LiveStatus>({
    lastUpdated: null,
    isPolling: false,
    refresh: () => undefined,
  });
  const refreshRef = useRef<() => void>(() => undefined);

  const publish = useCallback((s: LiveStatus) => {
    refreshRef.current = s.refresh;
    setStatus((prev) =>
      prev.lastUpdated === s.lastUpdated && prev.isPolling === s.isPolling ? prev : s,
    );
  }, []);

  const refresh = useCallback(() => refreshRef.current(), []);

  const value = useMemo<LiveStatusChannel>(
    () => ({ ...status, refresh, publish }),
    [status, refresh, publish],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Top bar reads this. */
export function useLiveStatus(): LiveStatus {
  const ctx = useContext(Ctx);
  return ctx ?? { lastUpdated: null, isPolling: false, refresh: () => undefined };
}

/**
 * A page calls this with its useLivePoll result to publish its status to the
 * top bar. Safe to call when no provider is mounted (tests rendering a page
 * directly) — it simply no-ops.
 */
export function usePublishLiveStatus(s: LiveStatus): void {
  const ctx = useContext(Ctx);
  const publish = ctx?.publish;
  React.useEffect(() => {
    publish?.(s);
    // Re-publish whenever the live status changes. (react-hooks lint is not
    // configured in this repo; deps are listed explicitly for correctness.)
  }, [publish, s.lastUpdated, s.isPolling, s.refresh]);
}
