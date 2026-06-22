// packages/web/src/pages/ActiveChaos.tsx
import React, { useCallback, useState } from "react";
import type { ChaosItem, Role } from "@chaos/shared";
import * as api from "../api.js";
import { ApiError, type ChaosActive } from "../api.js";
import { isOperator } from "../auth.js";
import { isChaosActive } from "../lib/chaos.js";
import { formatMeasurement, toMeasurement, type Measurement } from "../lib/verify.js";
import { useLivePoll } from "../lib/useLivePoll.js";
import { usePublishLiveStatus } from "../lib/liveStatus.js";
import { Button, Skeleton, Spinner } from "../components/ui.js";

const POLL_MS = 10_000;

export function ActiveChaos({ role }: { role: Role }): React.ReactElement {
  const canAct = isOperator(role);
  const [clearing, setClearing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const poll = useLivePoll(api.chaosActive, POLL_MS);
  usePublishLiveStatus({ lastUpdated: poll.lastUpdated, isPolling: poll.isPolling, refresh: poll.refresh });

  const rows = poll.data ?? [];
  // Only platforms with live chaos or an error are worth showing; a clear
  // platform is silence, not a row that reads "no chaos" (DESIGN.md empty state).
  const shown = rows.filter((r) => isChaosActive(r) || r.error);

  const clear = useCallback(
    async (platform: string) => {
      setClearing(platform);
      setActionError(null);
      try {
        await api.act(platform, "net-clear", {});
        await poll.refresh();
      } catch (e) {
        setActionError(e instanceof ApiError ? e.message : "clear failed");
      } finally {
        setClearing(null);
      }
    },
    [poll],
  );

  if (poll.loading) {
    return (
      <section className="space-y-3">
        {[0, 1].map((r) => (
          <div key={r} className="rounded-lg border border-border bg-panel px-4 py-3.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-2.5 h-3.5 w-2/3" />
          </div>
        ))}
      </section>
    );
  }

  return (
    <section className="space-y-3">
      {actionError && (
        <p className="rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-xs text-bad" role="alert">
          {actionError}
        </p>
      )}

      {shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-panel px-6 py-12 text-center">
          <p className="text-sm font-medium text-ink">No active chaos.</p>
          <p className="mt-1 text-xs text-ink-faint">
            Injected packet chaos shows up here while it is live. Start one from a service in Inventory.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-panel">
          {shown.map((r) => (
            <ChaosEntry
              key={r.platform}
              row={r}
              canAct={canAct}
              clearing={clearing === r.platform}
              onClear={() => void clear(r.platform)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ChaosEntry({
  row,
  canAct,
  clearing,
  onClear,
}: {
  row: ChaosActive;
  canAct: boolean;
  clearing: boolean;
  onClear: () => void;
}): React.ReactElement {
  return (
    <div>
      <div className="flex items-start gap-3 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {row.error ? (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true" />
                Degraded
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-chaos-soft px-2 py-0.5 text-xs font-medium text-chaos">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-chaos" aria-hidden="true" />
                Chaos active
              </span>
            )}
            <span className="tnum font-mono text-xs text-ink-faint">{row.platform}</span>
          </div>

          {row.error ? (
            <p className="mt-2 text-sm text-bad" role="alert">
              Could not read status: {row.error}
            </p>
          ) : (
            <ul className="mt-2 space-y-2.5">
              {row.items.map((it, i) => (
                <ChaosItemRow key={i} platform={row.platform} kind={row.kind} item={it} canAct={canAct} />
              ))}
            </ul>
          )}
        </div>

        {canAct && !row.error && (
          <Button size="sm" variant="danger" busy={clearing} onClick={onClear} className="shrink-0">
            Clear
          </Button>
        )}
      </div>

      {!row.error && row.raw != null && (
        <details className="group border-t border-border">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2 text-xs font-medium text-ink-soft transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-panel">
            <svg
              viewBox="0 0 12 12"
              className="h-2.5 w-2.5 shrink-0 text-ink-faint transition-transform duration-150 ease-out group-open:rotate-90"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M4.5 3L7.5 6L4.5 9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Details
          </summary>
          <pre className="scroll-quiet tnum overflow-x-auto whitespace-pre-wrap break-words border-t border-border bg-rail/40 px-4 py-2.5 font-mono text-[0.6875rem] leading-relaxed text-ink-soft">
            {rawText(row.raw)}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * One chaos item line: the configured summary (+ backend tag), and — for EKS
 * items — an operator "Verify" affordance that runs the net-verify probe and
 * renders the measured loss/latency alongside what was configured. ECS items
 * carry an inline note that empirical verification is EKS-only.
 */
function ChaosItemRow({
  platform,
  kind,
  item,
  canAct,
}: {
  platform: string;
  kind: ChaosActive["kind"];
  item: ChaosItem;
  canAct: boolean;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [measured, setMeasured] = useState<Measurement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isEks = kind === "eks_ssm";
  // The net-verify probe is an L4 packet measurement (ICMP to a pod). It is
  // meaningless for an L7 path fault, which lives in ingress-nginx, not the
  // pod's network — so gate it off ingress-nginx items.
  const isPathFault = item.backend === "ingress-nginx";
  // The probe pings a pod of a specific service; without one we cannot measure.
  const canVerify = canAct && isEks && !isPathFault && !!item.service;

  const verify = useCallback(async () => {
    if (!item.service) return;
    setBusy(true);
    setError(null);
    try {
      const { outcome } = await api.act(platform, "net-verify", { service: item.service });
      const m = toMeasurement(outcome.result);
      if (!m) throw new Error("probe returned no measurement");
      setMeasured(m);
    } catch (e) {
      setMeasured(null);
      setError(e instanceof ApiError ? e.message : "probe failed");
    } finally {
      setBusy(false);
    }
  }, [platform, item.service]);

  return (
    <li className="text-sm text-ink">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span>{item.summary}</span>
        {item.backend && (
          <span className="rounded border border-border bg-rail px-1.5 py-0.5 text-[0.6875rem] font-medium uppercase tracking-wide text-ink-soft">
            {item.backend}
          </span>
        )}
      </div>

      {/* Verify affordance + measurement live on their own line, so the summary
          above never shifts when a probe runs (DESIGN.md: no layout shift). */}
      {canVerify ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <Button
            size="sm"
            variant="secondary"
            busy={busy}
            onClick={() => void verify()}
            aria-label={`Verify packet chaos on ${item.service}`}
          >
            {measured || error ? "Re-verify" : "Verify"}
          </Button>
          {busy && (
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-faint">
              <Spinner className="h-3 w-3 text-ink-faint" />
              measuring (a few seconds)
            </span>
          )}
          {!busy && measured && (
            <span className="tnum text-xs font-medium text-chaos" role="status">
              {formatMeasurement(measured)}
            </span>
          )}
          {!busy && error && (
            <span className="text-xs text-bad" role="alert">
              couldn&apos;t measure: {error}
            </span>
          )}
        </div>
      ) : (
        canAct &&
        !isEks && (
          <p className="mt-1 text-xs text-ink-faint">
            Empirical verification is EKS-only. The subnet ACL rule above is the evidence.
          </p>
        )
      )}
    </li>
  );
}

/** Render the raw net-status payload for the Details fold: kubectl text verbatim, else pretty JSON. */
function rawText(raw: unknown): string {
  if (raw && typeof raw === "object" && typeof (raw as { output?: unknown }).output === "string") {
    return ((raw as { output: string }).output).trim() || "(empty)";
  }
  if (typeof raw === "string") return raw.trim() || "(empty)";
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}
