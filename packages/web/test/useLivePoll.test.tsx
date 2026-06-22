// packages/web/test/useLivePoll.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLivePoll } from "../src/lib/useLivePoll.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useLivePoll", () => {
  it("fetches immediately and exposes the data + lastUpdated", async () => {
    const fetcher = vi.fn().mockResolvedValue(["a"]);
    const { result } = renderHook(() => useLivePoll(fetcher, 10_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(["a"]);
    expect(result.current.loading).toBe(false);
    expect(result.current.lastUpdated).toBeGreaterThan(0);
  });

  it("refetches on the interval", async () => {
    const fetcher = vi.fn().mockResolvedValue(["a"]);
    renderHook(() => useLivePoll(fetcher, 10_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("keeps the prior data when a later poll fails (never blanks)", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(["good"])
      .mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useLivePoll(fetcher, 10_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.data).toEqual(["good"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    // data is unchanged, but the error surfaces alongside it
    expect(result.current.data).toEqual(["good"]);
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it("refresh() triggers an out-of-band refetch (post-action reconcile)", async () => {
    const fetcher = vi.fn().mockResolvedValue(["a"]);
    const { result } = renderHook(() => useLivePoll(fetcher, 60_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.refresh();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refresh() guarantees a FRESH fetch — chained after a poll already in flight", async () => {
    // First call resolves slowly (the in-flight, pre-action poll); the chained
    // refresh fetch returns the post-action truth and is the value we end on.
    let releaseFirst: (v: string[]) => void = () => {};
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => new Promise<string[]>((r) => (releaseFirst = r)))
      .mockResolvedValue(["fresh"]);
    const { result } = renderHook(() => useLivePoll(fetcher, 60_000));
    // The immediate initial fetch is now in flight (unresolved).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Kick a refresh WHILE the first fetch is still pending: it must not just join
    // the stale in-flight one — it chains a second, fresh fetch after it.
    let refreshDone = false;
    await act(async () => {
      const p = result.current.refresh().then(() => {
        refreshDone = true;
      });
      // refresh hasn't resolved yet — it's waiting on the in-flight poll first.
      expect(refreshDone).toBe(false);
      releaseFirst(["stale"]);
      await p;
    });
    // A second (fresh) fetch ran, and we end on its data — not the stale one.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual(["fresh"]);
  });

  it("stops polling after unmount", async () => {
    const fetcher = vi.fn().mockResolvedValue(["a"]);
    const { unmount } = renderHook(() => useLivePoll(fetcher, 10_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const calls = fetcher.mock.calls.length;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetcher.mock.calls.length).toBe(calls);
  });
});
