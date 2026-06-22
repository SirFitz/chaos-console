// packages/web/src/pages/ServiceDetail.tsx
//
// A per-service detail page (#/service/:platformId/:name). One service, its own
// page, so the inventory tables stay uncluttered. It shows, live while open:
//   - header: name, platform/layer, a live StatusPill + ReplicaMeter, DEV
//   - a hand-rolled network chart (EKS only) fed by a NEAR-LIVE streaming probe:
//     one continuous ping pod emits a 1s sample, and this page tails its logs
//     every ~2.5s — loss % (trailing window) and latency over time, with a Live
//     toggle + manual Refresh. ECS services get a short EKS-only note instead.
//   - the active chaos on this service (with the EKS Verify affordance)
//   - the action/audit timeline for this service (client-filtered by target)
// All accumulation is client-side; the probe pod is the only server-side object,
// and it is started on mount + stopped on unmount (and self-terminates if orphaned).
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuditRecord, ChaosItem, Kind, Layer, Role, ServiceStatus } from "@chaos/shared";
import * as api from "../api.js";
import { ApiError } from "../api.js";
import { isOperator } from "../auth.js";
import { describeAuditAction } from "../lib/auditText.js";
import { toMeasurement, type Measurement } from "../lib/verify.js";
import {
  appendRawSamples,
  deriveChartSamples,
  parseProbeStart,
  parseProbeTail,
  type RawSample,
} from "../lib/stream.js";
import { useLivePoll } from "../lib/useLivePoll.js";
import { usePublishLiveStatus } from "../lib/liveStatus.js";
import { StatusPill } from "../components/StatusPill.js";
import { ReplicaMeter } from "../components/ReplicaMeter.js";
import { deriveStatus } from "../lib/status.js";
import { NetworkChart, type ChartSample } from "../components/NetworkChart.js";
import { Button, Chip, Skeleton, Spinner } from "../components/ui.js";

const STATUS_POLL_MS = 10_000;
const SIDE_POLL_MS = 12_000;
// The streaming probe emits one sample/sec; we tail its logs a little slower than
// that (each tail asks for a ~6s window, so overlapping ticks just re-dedupe).
const TAIL_POLL_MS = 2_500;
/** Rolling raw buffer: keep at most this many 1s samples (~2 minutes). */
const MAX_RAW_SAMPLES = 120;

/** Resolve the named service from a platform's service list (or null). */
function findService(rows: ServiceStatus[] | undefined, name: string): ServiceStatus | null {
  return rows?.find((r) => r.name === name) ?? null;
}

/**
 * The NEAR-LIVE streaming engine for the chart. On mount (EKS + operator) it
 * launches one continuous ping pod via net-probe-start, then tails its logs every
 * ~2.5s (net-probe-tail), appending the returned 1s samples to a rolling raw
 * buffer. The chart's ChartSample[] (latency + a trailing-window loss%) is derived
 * from that buffer. The probe pod is torn down on unmount (net-probe-stop,
 * best-effort) and self-terminates if orphaned. A Live toggle pauses/resumes the
 * tail loop; Refresh tails once on demand. Errors surface without dropping the
 * series (the chart stays live). All three actions are reads (never audited).
 */
function useNetworkSamples(
  platformId: string,
  service: string,
  enabled: boolean,
): {
  samples: ChartSample[];
  busy: boolean;
  live: boolean;
  setLive: (v: boolean) => void;
  error: string | null;
  refreshNow: () => void;
} {
  const [raw, setRaw] = useState<RawSample[]>([]);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const alive = useRef(true);
  // Coalesce: never stack a tail while one is in flight (the loop + manual Refresh).
  const inFlight = useRef(false);
  // The resolved target pod IP from net-probe-start, carried onto each ChartSample.
  const target = useRef<string | null>(null);

  // One tail tick: read the trailing window and merge new 1s samples in. A tail
  // that races the pod coming up (podMissing) is benign — we just keep polling.
  const tailOnce = useCallback(async () => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const { outcome } = await api.act(platformId, "net-probe-tail", { service });
      if (!alive.current) return;
      const { samples } = parseProbeTail(outcome.result);
      if (samples.length > 0) setRaw((prev) => appendRawSamples(prev, samples, MAX_RAW_SAMPLES));
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "tail failed");
    } finally {
      if (alive.current) setBusy(false);
      inFlight.current = false;
    }
  }, [enabled, platformId, service]);

  const refreshNow = useCallback(() => void tailOnce(), [tailOnce]);

  // Start the probe on mount (operator + EKS gated by `enabled`), tear it down on
  // unmount. The mount effect also kicks an immediate first tail so the chart
  // fills without waiting a full interval. Reading tailOnce from a ref keeps this
  // effect mount-once (it must not re-run when tailOnce's identity changes).
  const tailRef = useRef(tailOnce);
  tailRef.current = tailOnce;
  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    void (async () => {
      try {
        const { outcome } = await api.act(platformId, "net-probe-start", { service });
        if (!alive.current) return;
        target.current = parseProbeStart(outcome.result).target;
        void tailRef.current();
      } catch (e) {
        if (!alive.current) return;
        setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "probe failed to start");
      }
    })();
    return () => {
      alive.current = false;
      // Best-effort teardown; the probe also self-terminates if this never lands.
      void api.act(platformId, "net-probe-stop", { service }).catch(() => undefined);
    };
  }, [enabled, platformId, service]);

  // The tail loop, gated by Live. Paused (Live off) just stops scheduling; the
  // probe pod keeps running so resuming picks the stream straight back up.
  useEffect(() => {
    if (!enabled || !live) return;
    const id = setInterval(() => void tailRef.current(), TAIL_POLL_MS);
    return () => clearInterval(id);
  }, [enabled, live]);

  const samples = useMemo(() => deriveChartSamples(raw, LOSS_WINDOW, target.current), [raw]);

  return { samples, busy, live, setLive, error, refreshNow };
}

/** Trailing samples the loss% is averaged over (~10s on a 1s feed). */
const LOSS_WINDOW = 10;

export function ServiceDetail({
  platformId,
  name,
  role,
  onBack,
  onOpenActions,
}: {
  platformId: string;
  name: string;
  role: Role;
  /** Navigate back to the inventory list. */
  onBack: () => void;
  /** Open the action/chaos drawer for this service (operators). */
  onOpenActions?: (s: ServiceStatus) => void;
}): React.ReactElement {
  const canAct = isOperator(role);

  // Platform meta (kind + layer) — fetched once; gates the network chart.
  const [kind, setKind] = useState<Kind | null>(null);
  const [layer, setLayer] = useState<Layer | null>(null);
  useEffect(() => {
    let on = true;
    api
      .listPlatforms()
      .then((ps) => {
        if (!on) return;
        const p = ps.find((x) => x.id === platformId);
        if (p) {
          setKind(p.kind);
          setLayer(p.layer);
        }
      })
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [platformId]);

  // Live status for this one service (filtered from the platform's list).
  const statusFetcher = useCallback(() => api.services(platformId), [platformId]);
  const statusPoll = useLivePoll(statusFetcher, STATUS_POLL_MS);
  usePublishLiveStatus({
    lastUpdated: statusPoll.lastUpdated,
    isPolling: statusPoll.isPolling,
    refresh: statusPoll.refresh,
  });
  const service = findService(statusPoll.data, name);
  const isEks = kind === "eks_ssm";

  return (
    <section className="space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-ink-soft transition-colors duration-150 ease-out hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      >
        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M7.5 3L4.5 6L7.5 9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Inventory
      </button>

      <ServiceHeader
        platformId={platformId}
        name={name}
        layer={layer}
        kind={kind}
        service={service}
        loading={statusPoll.loading}
        canAct={canAct}
        onOpenActions={service && onOpenActions ? () => onOpenActions(service) : undefined}
      />

      <Section title="Network" subtitle={isEks ? "Live packet measurement (loss and latency)" : undefined}>
        {kind === null ? (
          <Skeleton className="h-40 w-full rounded-lg" />
        ) : isEks ? (
          <NetworkPanel platformId={platformId} service={name} canAct={canAct} />
        ) : (
          <EcsNetworkNote />
        )}
      </Section>

      <Section title="Active chaos">
        <ServiceChaos platformId={platformId} name={name} canAct={canAct} />
      </Section>

      <Section title="Action timeline">
        <ServiceTimeline platformId={platformId} name={name} />
      </Section>
    </section>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {subtitle && <span className="text-xs text-ink-faint">{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

function ServiceHeader({
  platformId,
  name,
  layer,
  kind,
  service,
  loading,
  canAct,
  onOpenActions,
}: {
  platformId: string;
  name: string;
  layer: Layer | null;
  kind: Kind | null;
  service: ServiceStatus | null;
  loading: boolean;
  canAct: boolean;
  onOpenActions?: () => void;
}): React.ReactElement {
  return (
    <header className="rounded-lg border border-border bg-panel px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {/* The TopBar already renders the page <h1> (the service name), so
                this prominent echo is a styled label, not a second heading. */}
            <span className="truncate text-lg font-semibold text-ink">{name}</span>
            <Chip>DEV</Chip>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
            <span className="tnum font-mono">{platformId}</span>
            <span aria-hidden="true">·</span>
            <span>{layer ?? "—"} layer</span>
            <span aria-hidden="true">·</span>
            <span>{kind === "eks_ssm" ? "EKS" : kind === "ecs" ? "ECS" : "—"}</span>
            {service?.group && (
              <>
                <span aria-hidden="true">·</span>
                <span>{service.group}</span>
              </>
            )}
            {service?.flow && (
              <>
                <span aria-hidden="true">·</span>
                <span className="tnum font-mono">{service.flow}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {loading && !service ? (
            <Skeleton className="h-5 w-40 rounded-md" />
          ) : service ? (
            <>
              <StatusPill
                status={deriveStatus(service)}
                title={service.state ? `provider: ${service.state}` : undefined}
              />
              <ReplicaMeter s={service} />
            </>
          ) : (
            <span className="text-xs text-ink-faint">Not reporting</span>
          )}
          {canAct && onOpenActions && (
            <Button size="sm" variant="secondary" onClick={onOpenActions}>
              Actions
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}

/** The EKS network panel: a near-live streamed chart + Live toggle + Refresh. */
function NetworkPanel({
  platformId,
  service,
  canAct,
}: {
  platformId: string;
  service: string;
  canAct: boolean;
}): React.ReactElement {
  const { samples, busy, live, setLive, error, refreshNow } = useNetworkSamples(platformId, service, canAct);

  if (!canAct) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-panel px-6 py-10 text-center">
        <p className="text-sm font-medium text-ink">Live measurement is operator-only.</p>
        <p className="mt-1 text-xs text-ink-faint">
          The probe runs one short-lived pod that pings this service once a second. Sign in as an
          operator to stream it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <p className="text-xs text-ink-faint">
        Active ping probe (packet loss % + latency), streamed about once a second. A healthy, idle
        service reads near zero; inject packet chaos to see the lines respond. This is not application
        throughput.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={refreshNow}
          aria-label={`Refresh ${service} stream now`}
        >
          {busy ? "Refreshing" : "Refresh"}
        </Button>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-border-strong text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          />
          Live
        </label>
        {live && (
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-faint" role="status">
            <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ok" />
            </span>
            streaming live
          </span>
        )}
        {!busy && error && (
          <span className="text-xs text-bad" role="alert">
            couldn&apos;t stream: {error}
          </span>
        )}
      </div>

      <NetworkChart samples={samples} />
    </div>
  );
}

/** ECS services do not support live measurement; their packet chaos is a NACL deny. */
function EcsNetworkNote(): React.ReactElement {
  return (
    <div className="rounded-lg border border-dashed border-border bg-panel px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink">Live network measurement is EKS-only.</p>
      <p className="mt-1 text-xs text-ink-faint">
        This service runs on ECS, where packet chaos is a subnet ACL deny rule rather than an in-pod
        fault. There is no pod to ping, so loss and latency are not measured here. The active chaos
        below shows the ACL rule as the evidence.
      </p>
    </div>
  );
}

/** Active chaos on this service, filtered from the platform's chaos row. */
function ServiceChaos({
  platformId,
  name,
  canAct,
}: {
  platformId: string;
  name: string;
  canAct: boolean;
}): React.ReactElement {
  const poll = useLivePoll(api.chaosActive, SIDE_POLL_MS);
  const row = poll.data?.find((r) => r.platform === platformId);
  const kind = row?.kind;
  // The platform's items, narrowed to the ones that name this service. ECS NACL
  // blocks may carry no service, so they are never attributed to one service.
  const items = useMemo(
    () => (row?.items ?? []).filter((it) => it.service === name),
    [row, name],
  );

  if (poll.loading) {
    return <Skeleton className="h-12 w-full rounded-lg" />;
  }

  if (row?.error) {
    return (
      <p className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn" role="alert">
        Could not read chaos status: {row.error}
      </p>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-panel px-6 py-8 text-center">
        <p className="text-sm font-medium text-ink">No active chaos on this service.</p>
        <p className="mt-1 text-xs text-ink-faint">
          Injected packet chaos targeting this service shows up here while it is live.
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-panel">
      {items.map((it, i) => (
        <li key={i} className="px-4 py-3">
          <ServiceChaosItem platformId={platformId} kind={kind} item={it} canAct={canAct} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One chaos item for this service: the configured summary (+ backend tag) and,
 * for EKS L4 faults, an operator Verify affordance that runs net-verify and
 * shows the measured loss/latency. Mirrors the Active chaos page idiom.
 */
function ServiceChaosItem({
  platformId,
  kind,
  item,
  canAct,
}: {
  platformId: string;
  kind: Kind | undefined;
  item: ChaosItem;
  canAct: boolean;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [measured, setMeasured] = useState<Measurement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isEks = kind === "eks_ssm";
  // The net-verify probe is L4 (ICMP to a pod): meaningless for an L7 path fault
  // that lives in ingress-nginx, so gate it off ingress-nginx items.
  const isPathFault = item.backend === "ingress-nginx";
  const canVerify = canAct && isEks && !isPathFault && !!item.service;

  const verify = useCallback(async () => {
    if (!item.service) return;
    setBusy(true);
    setError(null);
    try {
      const { outcome } = await api.act(platformId, "net-verify", { service: item.service });
      const m = toMeasurement(outcome.result);
      if (!m) throw new Error("probe returned no measurement");
      setMeasured(m);
    } catch (e) {
      setMeasured(null);
      setError(e instanceof ApiError ? e.message : "probe failed");
    } finally {
      setBusy(false);
    }
  }, [platformId, item.service]);

  return (
    <div className="text-sm text-ink">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-chaos" aria-hidden="true" />
          {item.summary}
        </span>
        {item.backend && (
          <span className="rounded border border-border bg-rail px-1.5 py-0.5 text-[0.6875rem] font-medium uppercase tracking-wide text-ink-soft">
            {item.backend}
          </span>
        )}
      </div>

      {canVerify ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void verify()}
            aria-label={`Verify packet chaos on ${item.service}`}
          >
            {measured || error ? "Re-verify" : "Verify"}
          </Button>
          {busy && (
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-faint">
              <Spinner className="h-3 w-3 text-ink-faint" />
              sampling (~30s over SSM)
            </span>
          )}
          {!busy && measured && (
            <span className="tnum text-xs font-medium text-chaos" role="status">
              {formatMeasured(measured)}
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
    </div>
  );
}

/** The audit/action timeline for this service (client-filtered by target, newest first). */
function ServiceTimeline({ platformId, name }: { platformId: string; name: string }): React.ReactElement {
  const fetcher = useCallback(() => api.audit({ platform: platformId }), [platformId]);
  const poll = useLivePoll(fetcher, SIDE_POLL_MS);

  // The audit API has no target filter, so narrow client-side to this service,
  // newest first. Records are returned newest-first by the server, but sort
  // defensively so order never depends on that.
  const rows = useMemo(() => {
    const mine = (poll.data ?? []).filter((r) => r.target === name);
    return [...mine].sort((a, b) => b.ts.localeCompare(a.ts));
  }, [poll.data, name]);

  if (poll.loading) {
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-panel">
        {[0, 1, 2].map((r) => (
          <div key={r} className="flex items-center gap-4 border-b border-border/70 px-4 py-2.5 last:border-0">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="ml-auto h-3.5 w-16" />
          </div>
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-panel px-6 py-8 text-center">
        <p className="text-sm font-medium text-ink">No actions recorded for this service.</p>
        <p className="mt-1 text-xs text-ink-faint">
          Scaling, restarts, and chaos you run against this service are recorded here as they happen.
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-panel">
      {rows.map((r) => (
        <TimelineRow key={r.id} record={r} />
      ))}
    </ul>
  );
}

function TimelineRow({ record }: { record: AuditRecord }): React.ReactElement {
  const failed = record.result === "error";
  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      <span
        className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${failed ? "bg-bad" : "bg-ok"}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-medium text-ink">{describeAuditAction(record)}</span>
          <span className="text-xs text-ink-faint">
            {record.user}
            <span aria-hidden="true"> · </span>
            <span className="tnum">{formatTs(record.ts)}</span>
          </span>
          {record.dryRun && <Chip>dry-run</Chip>}
          {record.confirm && <Chip tone="accent">confirm</Chip>}
        </div>
        {failed && (
          <p className="mt-0.5 text-xs text-bad" role="alert">
            {record.error ?? "error"}
          </p>
        )}
      </div>
      <span
        className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${
          failed ? "bg-bad-soft text-bad" : "bg-ok-soft text-ok"
        }`}
      >
        {failed ? "error" : "success"}
      </span>
    </li>
  );
}

/** Round to one decimal, dropping a trailing ".0". */
function n1(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** Compact measured readout for the inline Verify, e.g. "60% loss · 204 ms · 20 pings". */
function formatMeasured(m: Measurement): string {
  const loss = m.lossPercent === null ? "loss unknown" : `${n1(m.lossPercent)}% loss`;
  const rtt = m.rttMs === null ? "no replies" : `${n1(m.rttMs)} ms`;
  const pings = `${m.sampled} ping${m.sampled === 1 ? "" : "s"}`;
  return `${loss} · ${rtt} · ${pings}`;
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
