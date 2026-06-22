// packages/web/src/lib/useOptimisticRows.ts
//
// Optimistic overlay for the inventory rows (DESIGN.md: "Optimistic feedback on
// actions, then reconcile from the next poll").
//
// The flow for a mutating action is:
//   1. apply the new state to the row IMMEDIATELY (an override patch),
//   2. send the request,
//   3. on success → wait for one fresh poll to land, THEN drop the override so
//      the change is handed off to live data with no flicker,
//      on failure  → drop the override at once (rolling back to the exact prior
//      row) and re-throw so the caller can surface the error.
//
// The override is held for the whole life of the request, so an inventory poll
// that resolves WHILE the action is in flight cannot clobber the optimistic
// value: the merge always re-applies the override on top of whatever polling
// produced. Only after the request settles do we release it.
import { useCallback, useMemo, useRef, useState } from "react";
import type { ServiceStatus } from "@chaos/shared";

/** The fields an optimistic action may pre-empt on a row. */
export type RowPatch = Partial<Pick<ServiceStatus, "desired" | "running" | "pending" | "state">>;

/** Stable identity for a row across polls. */
export function rowKey(s: Pick<ServiceStatus, "platformId" | "name">): string {
  return `${s.platformId}:${s.name}`;
}

export interface OptimisticRows {
  /** Polled rows with any in-flight optimistic patches merged on top. */
  rows: ServiceStatus[];
  /**
   * Apply `patch` to the row optimistically, run `mutate`, then reconcile:
   * success holds the patch until a fresh poll lands; failure rolls back
   * immediately and re-throws. `mutate` is the actual API call.
   */
  run: (key: string, patch: RowPatch, mutate: () => Promise<unknown>) => Promise<void>;
}

export function useOptimisticRows(
  polled: ServiceStatus[],
  refresh: () => Promise<void>,
): OptimisticRows {
  // Map of rowKey -> patch for actions currently in flight. A bump counter forces
  // a re-merge when the map mutates (the Map identity is kept stable via ref).
  const overrides = useRef<Map<string, RowPatch>>(new Map());
  const [gen, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  // Re-merge whenever fresh data arrives (`polled` identity changes each poll) or
  // an override is added/removed (`gen` bumps). The override Map itself is a
  // stable ref, read inside; `gen` is what ties re-merges to its mutations.
  const rows = useMemo(() => {
    if (overrides.current.size === 0) return polled;
    return polled.map((r) => {
      const patch = overrides.current.get(rowKey(r));
      return patch ? { ...r, ...patch } : r;
    });
  }, [polled, gen]);

  const run = useCallback(
    async (key: string, patch: RowPatch, mutate: () => Promise<unknown>): Promise<void> => {
      overrides.current.set(key, patch);
      rerender();
      try {
        await mutate();
        // Success: pull a guaranteed-fresh poll (refresh() chains past any
        // in-flight, pre-action poll), then release the override in the same beat
        // that post-action truth arrives — no stale flash between the two.
        await refresh();
        overrides.current.delete(key);
        rerender();
      } catch (e) {
        // Failure: roll back to the exact prior row at once, then surface it.
        overrides.current.delete(key);
        rerender();
        throw e;
      }
    },
    [refresh, rerender],
  );

  return { rows, run };
}
