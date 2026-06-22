// packages/web/test/useOptimisticRows.test.tsx
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ServiceStatus } from "@chaos/shared";
import { useOptimisticRows, rowKey } from "../src/lib/useOptimisticRows.js";

const svc = (o: Partial<ServiceStatus> = {}): ServiceStatus => ({
  platformId: "mi", layer: "MI", name: "payments", mapped: true, desired: 2, running: 2, ...o,
});

describe("useOptimisticRows", () => {
  it("applies the optimistic patch immediately, on top of the polled rows", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(({ rows }) => useOptimisticRows(rows, refresh), {
      initialProps: { rows: [svc({ desired: 2, running: 2 })] },
    });

    // Start an action that never resolves during this assertion window.
    let release: (v: unknown) => void = () => {};
    act(() => {
      void result.current.run(rowKey(svc()), { desired: 3 }, () => new Promise((r) => (release = r)));
    });

    // The merged row shows the optimistic desired right away.
    expect(result.current.rows[0].desired).toBe(3);
    release(undefined);
  });

  it("holds the optimistic value when a poll resolves mid-action (no clobber)", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ rows }) => useOptimisticRows(rows, refresh), {
      initialProps: { rows: [svc({ desired: 2, running: 2 })] },
    });

    let release: (v: unknown) => void = () => {};
    act(() => {
      void result.current.run(rowKey(svc()), { desired: 3 }, () => new Promise((r) => (release = r)));
    });
    expect(result.current.rows[0].desired).toBe(3);

    // A poll lands WHILE the action is still in flight, reporting stale desired:2.
    rerender({ rows: [svc({ desired: 2, running: 2 })] });
    // The optimistic 3 must survive — the in-flight poll cannot clobber it.
    expect(result.current.rows[0].desired).toBe(3);

    release(undefined);
  });

  it("rolls back to the EXACT prior row when the action fails", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const prior = svc({ desired: 2, running: 2, state: "ACTIVE" });
    const { result } = renderHook(({ rows }) => useOptimisticRows(rows, refresh), {
      initialProps: { rows: [prior] },
    });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.run(rowKey(prior), { desired: 9, pending: 1 }, () =>
          Promise.reject(new Error("nope")),
        );
      } catch (e) {
        caught = e;
      }
    });

    // The failure propagates (so the component can surface it)...
    expect(caught).toBeInstanceOf(Error);
    // ...and the row is restored to exactly its prior values — override dropped.
    expect(result.current.rows[0]).toEqual(prior);
    expect(result.current.rows[0].desired).toBe(2);
    expect(result.current.rows[0].pending).toBeUndefined();
    // A refresh was NOT awaited on the failure path (rollback is immediate).
    expect(refresh).not.toHaveBeenCalled();
  });

  it("on success, awaits a fresh poll, then releases the override to live data", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    // Simulate the parent swapping in fresh polled data when refresh() runs.
    const { result, rerender } = renderHook(({ rows }) => useOptimisticRows(rows, refresh), {
      initialProps: { rows: [svc({ desired: 2, running: 2 })] },
    });

    await act(async () => {
      await result.current.run(rowKey(svc()), { desired: 3 }, () => Promise.resolve("ok"));
    });

    // refresh() was awaited as part of the success reconcile.
    expect(refresh).toHaveBeenCalledTimes(1);

    // Now fresh polled data arrives reporting the real desired:3; the override is
    // already released, so live data shows through unchanged.
    rerender({ rows: [svc({ desired: 3, running: 3 })] });
    expect(result.current.rows[0].desired).toBe(3);
    expect(result.current.rows[0].running).toBe(3);
  });

  it("passes polled rows straight through when there are no overrides", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const rows = [svc({ name: "a" }), svc({ name: "b" })];
    const { result } = renderHook(() => useOptimisticRows(rows, refresh));
    // Same array identity (no needless re-mapping) when nothing is in flight.
    expect(result.current.rows).toBe(rows);
  });
});

describe("rowKey", () => {
  it("is platformId:name", () => {
    expect(rowKey(svc({ platformId: "api", name: "gateway" }))).toBe("api:gateway");
  });
});
