// packages/web/src/pages/AuditView.tsx
import React, { useCallback, useRef, useState } from "react";
import type { AuditRecord } from "@chaos/shared";
import * as api from "../api.js";
import { useLivePoll } from "../lib/useLivePoll.js";
import { describeAuditAction } from "../lib/auditText.js";
import { usePublishLiveStatus } from "../lib/liveStatus.js";
import { Button, Chip, Skeleton } from "../components/ui.js";

const POLL_MS = 15_000;
const COLS = "uppercase tracking-wide text-[0.6875rem] font-semibold text-ink-faint";

export function AuditView(): React.ReactElement {
  const [platform, setPlatform] = useState("");
  const [user, setUser] = useState("");
  const [limit, setLimit] = useState("100");

  // The live poll reads the *applied* filters from refs, so background refreshes
  // don't re-query on every keystroke (only Apply commits new filters).
  const applied = useRef({ platform: "", user: "", limit: "100" });

  const fetcher = useCallback(async (): Promise<AuditRecord[]> => {
    const a = applied.current;
    return api.audit({
      platform: a.platform.trim() || undefined,
      user: a.user.trim() || undefined,
      limit: a.limit.trim() ? Number(a.limit) : undefined,
    });
  }, []);

  const poll = useLivePoll(fetcher, POLL_MS);
  usePublishLiveStatus({ lastUpdated: poll.lastUpdated, isPolling: poll.isPolling, refresh: poll.refresh });

  const rows = poll.data ?? [];

  function apply() {
    applied.current = { platform, user, limit };
    void poll.refresh();
  }

  const field =
    "h-8 w-full rounded-md border border-border-strong bg-panel px-2.5 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

  return (
    <section className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <div className="w-40">
          <label htmlFor="aud-platform" className="mb-1 block text-xs font-medium text-ink-soft">
            Platform
          </label>
          <input id="aud-platform" className={field} value={platform} onChange={(e) => setPlatform(e.target.value)} />
        </div>
        <div className="w-40">
          <label htmlFor="aud-user" className="mb-1 block text-xs font-medium text-ink-soft">
            User
          </label>
          <input id="aud-user" className={field} value={user} onChange={(e) => setUser(e.target.value)} />
        </div>
        <div className="w-24">
          <label htmlFor="aud-limit" className="mb-1 block text-xs font-medium text-ink-soft">
            Limit
          </label>
          <input id="aud-limit" className={`${field} tnum`} inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </div>
        <Button type="submit" variant="primary" size="md" busy={poll.isPolling}>
          Apply
        </Button>
      </form>

      {poll.loading ? (
        <div className="overflow-hidden rounded-lg border border-border bg-panel">
          {[0, 1, 2, 3].map((r) => (
            <div key={r} className="flex items-center gap-4 border-b border-border/70 px-4 py-2.5 last:border-0">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="ml-auto h-3.5 w-16" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-panel px-6 py-12 text-center">
          <p className="text-sm font-medium text-ink">No audit records.</p>
          <p className="mt-1 text-xs text-ink-faint">Actions and their outcomes are recorded here as they happen.</p>
        </div>
      ) : (
        <div className="scroll-quiet overflow-x-auto rounded-lg border border-border bg-panel">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-rail/60">
                <th className={`px-4 py-2 text-left ${COLS}`}>Time</th>
                <th className={`px-3 py-2 text-left ${COLS}`}>User</th>
                <th className={`px-3 py-2 text-left ${COLS}`}>Platform</th>
                <th className={`px-3 py-2 text-left ${COLS}`}>Action</th>
                <th className={`px-3 py-2 text-left ${COLS}`}>Target</th>
                <th className={`px-3 py-2 text-left ${COLS}`}>Mode</th>
                <th className={`px-3 py-2 text-left ${COLS}`}>Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/70 last:border-0 hover:bg-rail/40">
                  <td className="tnum whitespace-nowrap px-4 py-2 font-mono text-xs text-ink-soft">{formatTs(r.ts)}</td>
                  <td className="px-3 py-2 text-ink">{r.user}</td>
                  <td className="tnum px-3 py-2 font-mono text-xs text-ink-soft">{r.platform}</td>
                  <td className="px-3 py-2 font-medium text-ink">{describeAuditAction(r)}</td>
                  <td className="tnum px-3 py-2 font-mono text-xs text-ink-soft">{r.target ?? "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      {r.dryRun && <Chip>dry-run</Chip>}
                      {r.confirm && <Chip tone="accent">confirm</Chip>}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {r.result === "error" ? (
                      <span className="inline-flex items-center gap-1.5 rounded-md bg-bad-soft px-2 py-0.5 text-xs font-medium text-bad">
                        <span className="h-1.5 w-1.5 rounded-full bg-bad" aria-hidden="true" />
                        {r.error ?? "error"}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-md bg-ok-soft px-2 py-0.5 text-xs font-medium text-ok">
                        <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" />
                        success
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
