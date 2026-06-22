// packages/web/src/lib/useLivePoll.ts
import { useCallback, useEffect, useRef, useState } from "react";

export interface LivePoll<T> {
  /** Latest successful data. Stays populated across refetches (never blanked). */
  data: T | undefined;
  /** Last error from a fetch, or null. Prior data is kept alongside it. */
  error: unknown;
  /** True only during the very first load, before any data exists. */
  loading: boolean;
  /** True while a background refresh is in flight (drives the live pulse). */
  isPolling: boolean;
  /** Epoch ms of the last successful fetch, or null. Drives "updated Ns ago". */
  lastUpdated: number | null;
  /** Trigger an out-of-band refetch (e.g. immediately after an action). */
  refresh: () => Promise<void>;
}

/**
 * Live polling hook (DESIGN.md "live data" rules):
 *   - fetches immediately, then every `intervalMs`,
 *   - KEEPS prior data while refetching — the table never blanks,
 *   - surfaces lastUpdated + an isPolling flag for the live indicator,
 *   - refresh() lets callers reconcile right after an action.
 *
 * `fetcher` is read from a ref, so the polling interval is set up once and is
 * never torn down by a changing fetcher identity (only `intervalMs` restarts it).
 */
export function useLivePoll<T>(fetcher: () => Promise<T>, intervalMs = 10_000): LivePoll<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [isPolling, setIsPolling] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const alive = useRef(true);
  // The promise of the poll currently in flight, or null.
  const inFlight = useRef<Promise<void> | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // One fetch: pull, update in place, never blank the prior data on error.
  const fetchOnce = useCallback((): Promise<void> => {
    setIsPolling(true);
    const p = (async () => {
      try {
        const next = await fetcherRef.current();
        if (!alive.current) return;
        setData(next);
        setError(null);
        setLastUpdated(Date.now());
      } catch (e) {
        if (!alive.current) return;
        setError(e);
        // Intentionally keep prior `data` so the surface stays live, not blank.
      } finally {
        if (alive.current) {
          setIsPolling(false);
          // The first resolution (success OR error) ends the initial loading state.
          setLoading(false);
        }
        inFlight.current = null;
      }
    })();
    inFlight.current = p;
    return p;
  }, []);

  // The interval tick coalesces: if a poll is already running, skip this tick
  // rather than stacking overlapping fetches.
  const tick = useCallback((): void => {
    if (inFlight.current) return;
    void fetchOnce();
  }, [fetchOnce]);

  // refresh() is the post-action / manual reconcile. It GUARANTEES a fetch that
  // reflects state as of the call: if a (possibly stale, pre-action) poll is in
  // flight, it chains a fresh fetch after it; otherwise it fetches now. It
  // resolves only once that fresh data has landed — so an optimistic caller can
  // hold its override until reconcile() truly returns post-action truth, with no
  // stale frame in between.
  const refresh = useCallback((): Promise<void> => {
    const prior = inFlight.current;
    return prior ? prior.then(() => fetchOnce()) : fetchOnce();
  }, [fetchOnce]);

  useEffect(() => {
    alive.current = true;
    void fetchOnce();
    const t = setInterval(tick, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [intervalMs, fetchOnce, tick]);

  return { data, error, loading, isPolling, lastUpdated, refresh };
}
