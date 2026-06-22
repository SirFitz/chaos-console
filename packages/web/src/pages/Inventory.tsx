// packages/web/src/pages/Inventory.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Layer, Role, ServiceStatus } from "@chaos/shared";
import * as api from "../api.js";
import { groupByLayerAndGroup, matchesFilter, type LayerBucket } from "../lib/grouping.js";
import { statusSignature } from "../lib/status.js";
import { useLivePoll } from "../lib/useLivePoll.js";
import { useOptimisticRows, type RowPatch } from "../lib/useOptimisticRows.js";
import { usePublishLiveStatus } from "../lib/liveStatus.js";
import { ServiceStatusPill } from "../components/StatusPill.js";
import { ScaleControl } from "../components/ScaleControl.js";
import { RowMenu } from "../components/RowMenu.js";
import { HealthChip } from "../components/HealthChip.js";
import { Button, Skeleton } from "../components/ui.js";
import { isOperator } from "../auth.js";

const POLL_MS = 10_000;

interface InventoryData {
  rows: ServiceStatus[];
  /** Per-layer failures, so one bad account degrades a layer, not the page. */
  errors: Partial<Record<Layer, string>>;
  /** Platform ids whose kind is eks_ssm — those carry a backend-health chip. */
  eksPlatformIds: string[];
}

/** Detect rows whose live state changed since the previous poll, to flash them. */
function useChangedRows(rows: ServiceStatus[]): Set<string> {
  const prev = useRef<Map<string, string>>(new Map());
  const [changed, setChanged] = useState<Set<string>>(new Set());

  useEffect(() => {
    const next = new Map<string, string>();
    const hits = new Set<string>();
    for (const r of rows) {
      const key = `${r.platformId}:${r.name}`;
      const sig = statusSignature(r);
      next.set(key, sig);
      const before = prev.current.get(key);
      if (before !== undefined && before !== sig) hits.add(key);
    }
    prev.current = next;
    if (hits.size > 0) {
      setChanged(hits);
      const t = setTimeout(() => setChanged(new Set()), 260);
      return () => clearTimeout(t);
    }
  }, [rows]);

  return changed;
}

const COLS = "uppercase tracking-wide text-[0.6875rem] font-semibold text-ink-faint";

export function Inventory({
  role,
  onAct,
  onNetwork,
  onOpenService,
}: {
  role: Role;
  onAct: (svc: ServiceStatus) => void;
  onNetwork: (svc: ServiceStatus) => void;
  /** Navigate to a service's dedicated detail page (row name click-through). */
  onOpenService: (svc: ServiceStatus) => void;
}): React.ReactElement {
  const [filter, setFilter] = useState("");
  const canAct = isOperator(role);

  const fetcher = useCallback(async (): Promise<InventoryData> => {
    const platforms = await api.listPlatforms();
    const errors: Partial<Record<Layer, string>> = {};
    const lists = await Promise.all(
      platforms.map(async (p) => {
        try {
          return await api.services(p.id);
        } catch (e) {
          errors[p.layer] = e instanceof Error ? e.message : "failed to load layer";
          return [] as ServiceStatus[];
        }
      }),
    );
    const eksPlatformIds = platforms.filter((p) => p.kind === "eks_ssm").map((p) => p.id);
    return { rows: lists.flat(), errors, eksPlatformIds };
  }, []);

  const poll = useLivePoll(fetcher, POLL_MS);
  usePublishLiveStatus({ lastUpdated: poll.lastUpdated, isPolling: poll.isPolling, refresh: poll.refresh });

  // Overlay in-flight optimistic actions on top of the polled rows. A poll that
  // resolves mid-action can't clobber an optimistic value: the override is held
  // until the action settles, then released as fresh data lands (or rolled back
  // on failure). See useOptimisticRows.
  const errors = poll.data?.errors ?? {};
  const eksPlatformIds = poll.data?.eksPlatformIds ?? [];
  const polled = poll.data?.rows ?? [];
  const optimistic = useOptimisticRows(polled, poll.refresh);
  const rows = optimistic.rows;
  const changed = useChangedRows(rows);

  const visible = useMemo(() => rows.filter((r) => matchesFilter(r, filter)), [rows, filter]);
  const grouped = useMemo(() => groupByLayerAndGroup(visible), [visible]);

  return (
    <section className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <input
            placeholder="Filter by name, group, or flow"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter services"
            className="h-8 w-full rounded-md border border-border-strong bg-panel pl-3 pr-3 text-sm text-ink placeholder:text-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          />
        </div>
        <Button size="sm" variant="secondary" busy={poll.isPolling} onClick={() => void poll.refresh()}>
          Refresh
        </Button>
      </div>

      {poll.loading ? (
        <InventorySkeleton />
      ) : (
        <LayerSections
          grouped={grouped}
          errors={errors}
          eksPlatformIds={eksPlatformIds}
          changed={changed}
          role={role}
          canAct={canAct}
          totalRows={rows.length}
          filtered={filter.length > 0}
          onAct={onAct}
          onNetwork={onNetwork}
          onOpenService={onOpenService}
          onAction={optimistic.run}
        />
      )}
    </section>
  );
}

function LayerSections({
  grouped,
  errors,
  eksPlatformIds,
  changed,
  role,
  canAct,
  totalRows,
  filtered,
  onAct,
  onNetwork,
  onOpenService,
  onAction,
}: {
  grouped: LayerBucket[];
  errors: Partial<Record<Layer, string>>;
  eksPlatformIds: string[];
  changed: Set<string>;
  role: Role;
  canAct: boolean;
  totalRows: number;
  filtered: boolean;
  onAct: (s: ServiceStatus) => void;
  onNetwork: (s: ServiceStatus) => void;
  onOpenService: (s: ServiceStatus) => void;
  onAction: (key: string, patch: RowPatch, mutate: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  const erroredLayers = (Object.keys(errors) as Layer[]).filter((l) => !grouped.some((g) => g.layer === l));

  if (grouped.length === 0 && erroredLayers.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-panel px-6 py-12 text-center">
        <p className="text-sm font-medium text-ink">
          {filtered && totalRows > 0 ? "No services match this filter." : "No services found."}
        </p>
        <p className="mt-1 text-xs text-ink-faint">
          {filtered && totalRows > 0
            ? "Clear the filter to see the full inventory."
            : "Inventory will appear here once platforms report their services."}
        </p>
      </div>
    );
  }

  return (
    <>
      {grouped.map((layer) => (
        <LayerSection
          key={layer.layer}
          layer={layer}
          error={errors[layer.layer]}
          eksPlatformIds={eksPlatformIds}
          changed={changed}
          role={role}
          canAct={canAct}
          onAct={onAct}
          onNetwork={onNetwork}
          onOpenService={onOpenService}
          onAction={onAction}
        />
      ))}
      {/* Layers that fully failed (no rows at all) still get a degraded banner. */}
      {erroredLayers.map((layer) => (
        <section key={layer}>
          <LayerHeading layer={layer} count={0} />
          <DegradedBanner layer={layer} message={errors[layer]!} />
        </section>
      ))}
    </>
  );
}

function LayerHeading({
  layer,
  count,
  eksPlatformIds = [],
}: {
  layer: Layer;
  count: number;
  eksPlatformIds?: string[];
}): React.ReactElement {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h2 className="text-sm font-semibold text-ink">{layer}</h2>
      <span className="tnum text-xs text-ink-faint">{count}</span>
      {eksPlatformIds.length > 0 && (
        <div className="ml-auto flex items-center gap-1.5">
          {eksPlatformIds.map((id) => (
            <HealthChip key={id} platformId={id} />
          ))}
        </div>
      )}
    </div>
  );
}

function DegradedBanner({ layer, message }: { layer: Layer; message: string }): React.ReactElement {
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn"
      role="alert"
    >
      <span className="font-semibold">{layer} degraded</span>
      <span className="text-ink-soft">{message}</span>
    </div>
  );
}

function LayerSection({
  layer,
  error,
  eksPlatformIds,
  changed,
  role,
  canAct,
  onAct,
  onNetwork,
  onOpenService,
  onAction,
}: {
  layer: LayerBucket;
  error?: string;
  eksPlatformIds: string[];
  changed: Set<string>;
  role: Role;
  canAct: boolean;
  onAct: (s: ServiceStatus) => void;
  onNetwork: (s: ServiceStatus) => void;
  onOpenService: (s: ServiceStatus) => void;
  onAction: (key: string, patch: RowPatch, mutate: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  const count = layer.groups.reduce((n, g) => n + g.services.length, 0);
  // The EKS platforms that actually have rows in *this* layer get a health chip
  // in the header. Preserves the listPlatforms order; dedupes if a layer somehow
  // spans more than one platform.
  const eksHere = useMemo(() => {
    const present = new Set<string>();
    for (const g of layer.groups) for (const s of g.services) present.add(s.platformId);
    return eksPlatformIds.filter((id) => present.has(id));
  }, [layer, eksPlatformIds]);
  return (
    <section>
      <LayerHeading layer={layer.layer} count={count} eksPlatformIds={eksHere} />
      {error && (
        <div className="mb-2">
          <DegradedBanner layer={layer.layer} message={error} />
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-border bg-panel">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-rail/60">
              <th className={`px-4 py-2 text-left ${COLS}`}>Service</th>
              <th className={`px-3 py-2 text-left ${COLS}`}>Status</th>
              <th className={`px-3 py-2 text-left ${COLS}`}>{canAct ? "Replicas / scale" : "Replicas"}</th>
              <th className={`hidden px-3 py-2 text-left md:table-cell ${COLS}`}>Flow</th>
              {canAct && <th className={`px-3 py-2 text-right ${COLS}`}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {layer.groups.map((g) => (
              <React.Fragment key={g.group}>
                <tr>
                  <td
                    colSpan={canAct ? 5 : 4}
                    className="bg-rail/30 px-4 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-ink-faint"
                  >
                    {g.group}
                  </td>
                </tr>
                {g.services.map((s) => {
                  const key = `${s.platformId}:${s.name}`;
                  return (
                    <tr
                      key={key}
                      className={`group border-b border-border/70 transition-colors duration-200 ease-out last:border-0 hover:bg-rail/40 ${
                        changed.has(key) ? "animate-status-in [--flash:var(--accent-soft)]" : ""
                      }`}
                    >
                      <td className="px-4 py-2">
                        <button
                          type="button"
                          onClick={() => onOpenService(s)}
                          className="rounded-sm text-left font-medium text-ink transition-colors duration-150 ease-out hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
                          aria-label={`Open ${s.name} detail`}
                        >
                          {s.name}
                        </button>
                        <div className="tnum font-mono text-[0.6875rem] text-ink-faint">{s.platformId}</div>
                      </td>
                      <td className="px-3 py-2">
                        <ServiceStatusPill s={s} />
                      </td>
                      <td className="px-3 py-2">
                        <ScaleControl service={s} role={role} onAction={onAction} />
                      </td>
                      <td className="hidden px-3 py-2 text-ink-soft md:table-cell">
                        {s.flow ? <span className="tnum font-mono text-xs">{s.flow}</span> : <span className="text-ink-faint">—</span>}
                      </td>
                      {canAct && (
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button size="sm" variant="secondary" onClick={() => onNetwork(s)}>
                              Network
                            </Button>
                            <RowMenu service={s} onAct={onAct} onAction={onAction} />
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function InventorySkeleton(): React.ReactElement {
  return (
    <div className="space-y-6">
      {[0, 1].map((s) => (
        <section key={s}>
          <Skeleton className="mb-2 h-4 w-16" />
          <div className="overflow-hidden rounded-lg border border-border bg-panel">
            {[0, 1, 2, 3].map((r) => (
              <div key={r} className="flex items-center gap-4 border-b border-border/70 px-4 py-2.5 last:border-0">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-5 w-20 rounded-md" />
                <Skeleton className="ml-auto h-4 w-24" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
